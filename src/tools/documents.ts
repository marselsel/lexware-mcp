import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { embeddedResource, type McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { type Paged, VOUCHER_STATUSES, VOUCHER_TYPES, type VoucherlistEntry } from "../lexware/types.js";
import {
  genericDocumentInputShape,
  invoiceInputShape,
  jsonBool,
  jsonNum,
  jsonObj,
  pageParam,
  quotationInputShape,
  sizeParam,
} from "./schemas.js";
import { LOCAL_RO, RO, WRITE, pagedResult, text } from "./shared.js";

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
  { key: "order-confirmation", path: "order-confirmations", label: "order confirmation", schema: genericDocumentInputShape, finalize: true, renderable: true },
  { key: "delivery-note", path: "delivery-notes", label: "delivery note", schema: genericDocumentInputShape, finalize: true, renderable: true },
  { key: "dunning", path: "dunnings", label: "dunning", schema: genericDocumentInputShape, finalize: true, renderable: true },
  // down-payment-invoices are GET-only (no create/finalize) but still have a finalized PDF via /{id}/file.
  { key: "down-payment-invoice", path: "down-payment-invoices", label: "down payment invoice", schema: null, finalize: false, renderable: true },
];

/** Document resource paths — the `resourceType` enum for get-document-file. */
const DOC_FILE_PATHS = DOC_TYPES.map((d) => d.path) as [string, ...string[]];

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

/**
 * Map a voucherlist `voucherType` to its REST resource path, so get-document can
 * dispatch a voucherlist row to the right endpoint. Bookkeeping types (purchase
 * and sales invoices/credit-notes) resolve via `/vouchers`; the rest via their endpoint.
 */
const VOUCHERTYPE_TO_PATH: Record<string, string> = {
  invoice: "invoices",
  creditnote: "credit-notes",
  orderconfirmation: "order-confirmations",
  quotation: "quotations",
  deliverynote: "delivery-notes",
  downpaymentinvoice: "down-payment-invoices",
  dunning: "dunnings",
  purchaseinvoice: "vouchers",
  purchasecreditnote: "vouchers",
  salesinvoice: "vouchers",
  salescreditnote: "vouchers",
  voucher: "vouchers",
};

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
        archived: jsonBool(z.boolean().optional()),
        page: pageParam,
        size: sizeParam,
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

  // render-<doctype>-pdf: download a document's finalized PDF.
  for (const doc of DOC_TYPES) {
    if (!doc.renderable) continue;
    server.registerTool(
      {
        name: `render-${doc.key}-pdf`,
        description:
          `Download the finalized PDF of a ${doc.label} (GET /v1/${doc.path}/{id}/file) and return it inline. ` +
          `The document must be FINALIZED — a draft has no file yet. (get-document-file is the generic form.)`,
        inputSchema: { id: z.string() },
        annotations: RO,
      },
      async ({ id }) => {
        const { data, contentType } = await client.getBinary(
          `/v1/${doc.path}/${encodeURIComponent(id)}/file`,
        );
        return {
          structuredContent: { resource: doc.path, id, mimeType: contentType, byteLength: data.length },
          content: [
            ...text(`Downloaded ${doc.label} ${id} PDF (${data.length} bytes).`),
            embeddedResource({
              uri: `lexware://${doc.path}/${id}/file`,
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
        "Get a single bookkeeping voucher by id — the full object, including contactId for referenced contacts (collective vouchers have only contactName) and files[] (ids of attached receipts). Note: voucherlist rows of type 'invoice' resolve via get-invoice, 'quotation' via get-quotation, etc. — only manually-booked vouchers resolve here. There is no festgeschrieben/lock flag in the payload; a locked (filed-VAT-period) voucher only surfaces as an error on a write attempt.",
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
      name: "get-vouchers",
      description:
        "Fetch multiple bookkeeping vouchers by id in one call (each returned in full, like get-voucher) — " +
        "reduces round-trips when you need many. Fetched sequentially through the ~2 requests/second rate limit, " +
        "so a full batch of 50 takes ~25s; page through larger sets. Ids that fail are returned in `errors` " +
        "(not thrown), so one bad id won't fail the batch.",
      inputSchema: {
        ids: jsonObj(z.array(z.string()).min(1).max(50)).describe("Voucher ids to fetch (max 50 per call)."),
      },
      annotations: RO,
    },
    async ({ ids }) => {
      const vouchers: Record<string, unknown>[] = [];
      const errors: { id: string; error: string }[] = [];
      for (const id of ids as string[]) {
        try {
          vouchers.push(await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`));
        } catch (e) {
          errors.push({ id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return {
        structuredContent: { vouchers, errors, count: vouchers.length },
        content: text(
          `Fetched ${vouchers.length}/${(ids as string[]).length} voucher(s)` +
            (errors.length ? `; ${errors.length} failed.` : "."),
        ),
      };
    },
  );

  server.registerTool(
    {
      name: "get-document",
      description:
        "Fetch a financial document by id, auto-dispatching to the correct endpoint from its voucherlist " +
        "`voucherType` — so you don't choose get-invoice vs get-voucher vs get-quotation, etc. Pass the id and " +
        "the voucherType exactly as get-voucherlist returns it (e.g. 'invoice', 'purchaseinvoice', 'quotation').",
      inputSchema: {
        id: z.string(),
        voucherType: z.string().describe("The voucherlist voucherType for this id."),
      },
      annotations: RO,
    },
    async ({ id, voucherType }) => {
      const path = VOUCHERTYPE_TO_PATH[voucherType];
      if (!path) {
        throw new Error(
          `Unknown voucherType "${voucherType}". Known: ${Object.keys(VOUCHERTYPE_TO_PATH).join(", ")}.`,
        );
      }
      const doc = await client.get<Record<string, unknown>>(`/v1/${path}/${encodeURIComponent(id)}`);
      return { structuredContent: doc, content: text(`${voucherType} ${id} retrieved via /${path}.`) };
    },
  );

  server.registerTool(
    {
      name: "get-document-file",
      description:
        "Download the finalized PDF of a document by resource + id (GET /v1/{resourceType}/{id}/file), returned " +
        "inline. The document must be FINALIZED. resourceType is the REST path, e.g. 'invoices', 'credit-notes'.",
      inputSchema: {
        resourceType: z.enum(DOC_FILE_PATHS).describe("Document resource path, e.g. 'invoices', 'credit-notes'."),
        id: z.string(),
      },
      annotations: RO,
    },
    async ({ resourceType, id }) => {
      const { data, contentType } = await client.getBinary(
        `/v1/${resourceType}/${encodeURIComponent(id)}/file`,
      );
      return {
        structuredContent: { resource: resourceType, id, mimeType: contentType, byteLength: data.length },
        content: [
          ...text(`Downloaded ${resourceType} ${id} PDF (${data.length} bytes).`),
          embeddedResource({
            uri: `lexware://${resourceType}/${id}/file`,
            mimeType: contentType,
            blob: data.toString("base64"),
          }),
        ],
      };
    },
  );

  server.registerTool(
    {
      name: "get-voucher-file",
      description:
        "Download the receipt attached to a bookkeeping voucher in one call: resolves the voucher's file id " +
        "and returns the file inline (instead of get-voucher then download-file). Use fileIndex to pick a " +
        "different attachment when a voucher has several.",
      inputSchema: {
        id: z.string().describe("The voucher id."),
        fileIndex: jsonNum(z.number().int().min(0).default(0)).describe("Which attached file (0 = first)."),
      },
      annotations: RO,
    },
    async ({ id, fileIndex }) => {
      const voucher = await client.get<{ files?: string[] }>(`/v1/vouchers/${encodeURIComponent(id)}`);
      const fileId = voucher.files?.[fileIndex as number];
      if (!fileId) {
        throw new Error(`Voucher ${id} has no attached file at index ${fileIndex}.`);
      }
      const { data, contentType } = await client.getBinary(`/v1/files/${encodeURIComponent(fileId)}`);
      return {
        structuredContent: { voucherId: id, fileId, mimeType: contentType, byteLength: data.length },
        content: [
          ...text(`Downloaded voucher ${id} receipt (${data.length} bytes, ${contentType}).`),
          embeddedResource({
            uri: `lexware://files/${fileId}`,
            mimeType: contentType,
            blob: data.toString("base64"),
          }),
        ],
      };
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
export function registerDocumentDraftTools(
  server: McpServer,
  client: LexwareClient,
  finalizeEnabled: boolean,
): void {
  for (const doc of DOC_TYPES) {
    if (!doc.schema) continue;
    server.registerTool(
      {
        name: `create-draft-${doc.key}`,
        description:
          `Create a ${doc.label}. By default a DRAFT (editable, not legally issued). Set finalize=true ` +
          `(+ confirm_finalize; requires LEXWARE_ENABLE_FINALIZE) to issue a LEGALLY BINDING document in one ` +
          `step — IRREVERSIBLE (no void/delete via API). Provide the full document body for a standalone ` +
          `document; with precedingSalesVoucherId the body (line items/contact) is carried over from that ` +
          `preceding voucher — dunnings can ONLY be created this way (pursue from an invoice).`,
        inputSchema: {
          ...optionalShape(doc.schema),
          precedingSalesVoucherId: z
            .string()
            .optional()
            .describe(
              "Create as a follow-up of this preceding sales voucher id (e.g. quotation→order-confirmation→" +
                "invoice, invoice→credit-note/dunning). POSTs ?precedingSalesVoucherId={id}.",
            ),
          finalize: jsonBool(z.boolean().optional()).describe(
            "Issue a legally-binding FINALIZED document (POST ?finalize=true) instead of a draft. IRREVERSIBLE; " +
              "requires LEXWARE_ENABLE_FINALIZE and confirm_finalize=true.",
          ),
          confirm_finalize: z.literal(true).optional().describe("Must be true when finalize=true."),
        },
        annotations: WRITE,
      },
      async ({ finalize, confirm_finalize, precedingSalesVoucherId, ...input }) => {
        const query: Record<string, string | boolean> = {};
        if (precedingSalesVoucherId) query.precedingSalesVoucherId = precedingSalesVoucherId;
        let finalized = false;
        if (finalize) {
          if (!finalizeEnabled) {
            throw new Error(
              "Finalizing is disabled. Set LEXWARE_ENABLE_FINALIZE=true to issue a legally-binding document.",
            );
          }
          if (confirm_finalize !== true) {
            throw new Error(
              "Set confirm_finalize=true to acknowledge this issues a legally binding, irreversible document.",
            );
          }
          query.finalize = true;
          finalized = true;
        }
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, input, query);
        return {
          structuredContent: { ...created, finalized },
          content: text(
            finalized
              ? `FINALIZED ${doc.label} ${created.id} (legally binding). This cannot be undone.`
              : `Created DRAFT ${doc.label} ${created.id} (not finalized).`,
          ),
        };
      },
    );
  }

  // NOTE: there is deliberately no update-draft-<doctype> tool. The Lexware Office
  // REST API exposes only GET and POST for invoices/quotations/credit-notes/
  // order-confirmations/delivery-notes/dunnings — no PUT — so a draft document
  // cannot be patched after creation (a PUT returns 404). Set every field (incl.
  // paymentConditions) at creation via create-draft-*; to change a draft, recreate
  // it and delete the old one in the web app. (Contacts/articles/vouchers DO have
  // PUT and keep their own update tools.)
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
          ...optionalShape(doc.schema),
          precedingSalesVoucherId: z
            .string()
            .optional()
            .describe("Create as a follow-up of this preceding sales voucher id."),
          confirm_finalize: z
            .literal(true)
            .describe("Must be true to acknowledge this issues a legally binding document."),
        },
        annotations: WRITE,
      },
      async ({ confirm_finalize: _confirm, precedingSalesVoucherId, ...input }) => {
        const query: Record<string, string | boolean> = { finalize: true };
        if (precedingSalesVoucherId) query.precedingSalesVoucherId = precedingSalesVoucherId;
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, input, query);
        return {
          structuredContent: { ...created, finalized: true },
          content: text(`FINALIZED ${doc.label} ${created.id} (legally binding). This cannot be undone.`),
        };
      },
    );
  }
}
