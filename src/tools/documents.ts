import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { embeddedResource, type McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { type Paged, VOUCHER_STATUSES, VOUCHER_TYPES, type VoucherlistEntry } from "../lexware/types.js";
import { genericDocumentInputShape, invoiceInputShape, quotationInputShape } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, LOCAL_RO, RO, WRITE, deepMergePatch, pagedResult, text } from "./shared.js";

/** A Lexware voucher-document type and how to create it. */
interface DocType {
  /** Tool-name suffix, e.g. "credit-note". */
  key: string;
  /** API path segment, e.g. "credit-notes". */
  path: string;
  /** Human label, e.g. "credit note". */
  label: string;
  /** Create-body schema; null means read-only (no create tools). */
  schema: ZodRawShapeCompat | null;
  /** Whether `?finalize=true` issuing is supported. */
  finalize: boolean;
  /**
   * Whether `GET /v1/{path}/{id}/document` renders a downloadable PDF for this
   * type. Confirmed in the docs for invoice/quotation/credit-note/delivery-note;
   * the others are left false until a read-only live check confirms support.
   */
  renderable: boolean;
}

const DOC_TYPES: DocType[] = [
  { key: "invoice", path: "invoices", label: "invoice", schema: invoiceInputShape, finalize: true, renderable: true },
  { key: "quotation", path: "quotations", label: "quotation", schema: quotationInputShape, finalize: true, renderable: true },
  { key: "credit-note", path: "credit-notes", label: "credit note", schema: genericDocumentInputShape, finalize: true, renderable: true },
  { key: "order-confirmation", path: "order-confirmations", label: "order confirmation", schema: genericDocumentInputShape, finalize: true, renderable: false },
  { key: "delivery-note", path: "delivery-notes", label: "delivery note", schema: genericDocumentInputShape, finalize: true, renderable: true },
  { key: "dunning", path: "dunnings", label: "dunning", schema: genericDocumentInputShape, finalize: true, renderable: false },
  // VERIFY (read-only, live): down-payment-invoices are GET-only (no create/finalize); confirm /document before enabling render.
  { key: "down-payment-invoice", path: "down-payment-invoices", label: "down payment invoice", schema: null, finalize: false, renderable: false },
];

/**
 * Resource segments for the Lexware **web-app permalink**
 * (`{app}/permalink/{resource}/{action}/{id}`). NOTE: these are the
 * concatenated-lowercase web-app forms (`creditnotes`), NOT the hyphenated REST
 * API paths (`credit-notes`). Verify against the live app if extending.
 */
const DEEPLINK_RESOURCES = [
  "invoices",
  "quotations",
  "creditnotes",
  "orderconfirmations",
  "deliverynotes",
  "downpaymentinvoices",
  "dunnings",
  "vouchers",
  "contacts",
] as const;

/** Read tools for financial documents. Always registered. */
export function registerDocumentReadTools(
  server: McpServer,
  client: LexwareClient,
  appBaseUrl: string,
): void {
  server.registerTool(
    {
      name: "get-voucherlist",
      description:
        "Search the voucher list — the primary index of all financial documents (invoices, credit notes, quotations, etc.). voucherType and voucherStatus are required; use 'any' to match all. Results are paged.",
      inputSchema: {
        voucherType: z.enum(VOUCHER_TYPES).default("any"),
        voucherStatus: z.enum(VOUCHER_STATUSES).default("any"),
        contactId: z.string().optional(),
        voucherDateFrom: z.string().optional().describe("ISO date lower bound."),
        voucherDateTo: z.string().optional().describe("ISO date upper bound."),
        archived: z.boolean().optional(),
        page: z.number().int().min(0).default(0),
        size: z.number().int().min(1).max(250).default(DEFAULT_PAGE_SIZE),
      },
      annotations: RO,
    },
    async ({ voucherType, voucherStatus, contactId, voucherDateFrom, voucherDateTo, archived, page, size }) => {
      const result = await client.get<Paged<VoucherlistEntry>>("/v1/voucherlist", {
        voucherType,
        voucherStatus,
        contactId,
        voucherDateFrom,
        voucherDateTo,
        archived,
        page,
        size,
      });
      return pagedResult(result, "voucher(s)");
    },
  );

  // get-<doctype> for every document type (invoices, quotations, credit-notes, …).
  for (const doc of DOC_TYPES) {
    server.registerTool(
      {
        name: `get-${doc.key}`,
        description: `Get a single ${doc.label} by id (full document including line items).`,
        inputSchema: { id: z.string() },
        annotations: RO,
      },
      async ({ id }) => {
        const document = await client.get<Record<string, unknown>>(`/v1/${doc.path}/${encodeURIComponent(id)}`);
        return { structuredContent: document, content: text(`${doc.label} ${id} retrieved.`) };
      },
    );
  }

  // render-<doctype>-pdf: materialize a document as a PDF and return the bytes.
  for (const doc of DOC_TYPES) {
    if (!doc.renderable) continue;
    server.registerTool(
      {
        name: `render-${doc.key}-pdf`,
        description:
          `Render a ${doc.label} to PDF and return the file inline. Calls GET /v1/${doc.path}/{id}/document to ` +
          `materialize the PDF, then downloads it. Note: Lexware generally renders only a finalized document.`,
        inputSchema: { id: z.string() },
        annotations: RO,
      },
      async ({ id }) => {
        // Two-step per the Lexware docs: /document returns a file id, then GET /v1/files/{id} is the binary.
        const { documentFileId } = await client.get<{ documentFileId: string }>(
          `/v1/${doc.path}/${encodeURIComponent(id)}/document`,
        );
        const { data, contentType } = await client.getBinary(
          `/v1/files/${encodeURIComponent(documentFileId)}`,
        );
        return {
          structuredContent: { documentFileId, mimeType: contentType, byteLength: data.length },
          content: [
            ...text(`Rendered ${doc.label} ${id} to PDF (${data.length} bytes).`),
            embeddedResource({
              uri: `lexware://files/${documentFileId}`,
              mimeType: contentType,
              blob: data.toString("base64"),
            }),
          ],
        };
      },
    );
  }

  server.registerTool(
    {
      name: "get-voucher",
      description:
        "Get a single bookkeeping voucher by id — the full object, including contactId for referenced contacts (collective vouchers have only contactName) and files[] (ids of attached receipts). Note: voucherlist rows of type 'invoice' resolve via get-invoice, 'quotation' via get-quotation, etc. — only manually-booked vouchers resolve here.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const voucher = await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`);
      return { structuredContent: voucher, content: text(`Voucher ${id} retrieved.`) };
    },
  );

  server.registerTool(
    {
      name: "get-document-link",
      description:
        "Build a deeplink that opens a document directly in the Lexware web app (works when logged into Lexware). Use this to let the user view/print a document; do not use it to fetch raw PDF bytes.",
      inputSchema: {
        resourceType: z.enum(DEEPLINK_RESOURCES),
        id: z.string(),
        action: z.enum(["view", "edit"]).default("view"),
      },
      annotations: LOCAL_RO,
    },
    async ({ resourceType, id, action }) => {
      // Lexware permalink format: {app}/permalink/{resourceType}/{action}/{id}
      const url = `${appBaseUrl}/permalink/${resourceType}/${action}/${encodeURIComponent(id)}`;
      return { structuredContent: { url }, content: text(`Open in Lexware: ${url}`) };
    },
  );
}

/**
 * Make every field of a create shape optional, for the read-modify-write update
 * tools. The raw-shape values are real zod schemas at runtime, so `.optional()`
 * works; the cast bridges the SDK's compat type.
 */
function optionalShape(shape: ZodRawShapeCompat): ZodRawShapeCompat {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    out[key] = (value as z.ZodTypeAny).optional();
  }
  return out as ZodRawShapeCompat;
}

/** Draft-creation tools for every writable document type. Registered with the drafts tier. */
export function registerDocumentDraftTools(server: McpServer, client: LexwareClient): void {
  for (const doc of DOC_TYPES) {
    if (!doc.schema) continue;
    server.registerTool(
      {
        name: `create-draft-${doc.key}`,
        description: `Create a DRAFT ${doc.label} (not finalized). Editable in Lexware and NOT legally issued until finalized there. Returns the new id.`,
        inputSchema: doc.schema,
        annotations: WRITE,
      },
      async (input) => {
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, input);
        return {
          structuredContent: { ...created, finalized: false },
          content: text(`Created DRAFT ${doc.label} ${created.id} (not finalized).`),
        };
      },
    );
  }

  // update-draft-<doctype>: edit an existing draft document (read-modify-write).
  for (const doc of DOC_TYPES) {
    if (!doc.schema) continue;
    const updateShape = optionalShape(doc.schema);
    server.registerTool(
      {
        name: `update-draft-${doc.key}`,
        description:
          `Update an existing DRAFT ${doc.label} (read-modify-write: the current document is fetched and your ` +
          `fields are merged over it, so untouched fields like title/introduction aren't wiped). Send only what ` +
          `you change. If you send lineItems it REPLACES the whole list — include every line. Pass \`version\` for ` +
          `optimistic locking (omit to use the latest). Only drafts are editable; a finalized document cannot be changed.`,
        inputSchema: {
          id: z.string(),
          version: z
            .number()
            .int()
            .optional()
            .describe(`Current version from get-${doc.key} (optimistic lock). Omit to use the latest.`),
          ...updateShape,
        },
        annotations: WRITE,
      },
      async ({ id, version, ...fields }) => {
        // Read-modify-write: load the current draft and merge the caller's fields over it.
        const current = await client.get<Record<string, unknown>>(
          `/v1/${doc.path}/${encodeURIComponent(id)}`,
        );
        const body = deepMergePatch(current, {
          ...fields,
          version: version ?? (current.version as number),
        });
        const updated = await client.request<{ id: string; version: number }>(
          "PUT",
          `/v1/${doc.path}/${encodeURIComponent(id)}`,
          { body, idempotent: false },
        );
        return {
          structuredContent: { ...updated, finalized: false },
          content: text(`Updated DRAFT ${doc.label} ${id} (now version ${updated.version}).`),
        };
      },
    );
  }
}

/** Finalizing / legally-binding tools for every finalizable document type. Finalize tier. */
export function registerDocumentFinalizeTools(server: McpServer, client: LexwareClient): void {
  for (const doc of DOC_TYPES) {
    if (!doc.schema || !doc.finalize) continue;
    server.registerTool(
      {
        name: `create-finalized-${doc.key}`,
        description: `Create and FINALIZE a ${doc.label} in one step. This issues a LEGALLY BINDING, IRREVERSIBLE document (it cannot be edited or deleted afterwards). Requires confirm_finalize=true. Prefer create-draft-${doc.key} unless the user explicitly wants to issue it now.`,
        inputSchema: {
          ...doc.schema,
          confirm_finalize: z
            .literal(true)
            .describe("Must be true to acknowledge this issues a legally binding document."),
        },
        annotations: WRITE,
      },
      async ({ confirm_finalize: _confirm, ...input }) => {
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, input, { finalize: true });
        return {
          structuredContent: { ...created, finalized: true },
          content: text(`FINALIZED ${doc.label} ${created.id} (legally binding). This cannot be undone.`),
        };
      },
    );
  }
}
