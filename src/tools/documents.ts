import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { type Paged, VOUCHER_STATUSES, VOUCHER_TYPES, type VoucherlistEntry } from "../lexware/types.js";
import { genericDocumentInputShape, invoiceInputShape, quotationInputShape } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, LOCAL_RO, RO, WRITE, pagedResult, text } from "./shared.js";

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
}

const DOC_TYPES: DocType[] = [
  { key: "invoice", path: "invoices", label: "invoice", schema: invoiceInputShape, finalize: true },
  { key: "quotation", path: "quotations", label: "quotation", schema: quotationInputShape, finalize: true },
  { key: "credit-note", path: "credit-notes", label: "credit note", schema: genericDocumentInputShape, finalize: true },
  { key: "order-confirmation", path: "order-confirmations", label: "order confirmation", schema: genericDocumentInputShape, finalize: true },
  { key: "delivery-note", path: "delivery-notes", label: "delivery note", schema: genericDocumentInputShape, finalize: true },
  { key: "dunning", path: "dunnings", label: "dunning", schema: genericDocumentInputShape, finalize: true },
  { key: "down-payment-invoice", path: "down-payment-invoices", label: "down payment invoice", schema: null, finalize: false },
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

  server.registerTool(
    {
      name: "get-voucher",
      description:
        "Get a single bookkeeping voucher by id. Note: voucherlist rows of type 'invoice' resolve via get-invoice, 'quotation' via get-quotation, etc. — only manually-booked vouchers resolve here.",
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
