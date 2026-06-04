import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { voucherInputShape, voucherUpdateShape } from "./schemas.js";
import { WRITE, deepMergePatch, text } from "./shared.js";

/**
 * Write tools for bookkeeping vouchers (manually-booked sales/purchase
 * transactions). Reads live in documents.ts (get-voucher, get-voucherlist).
 * Registered with the drafts tier.
 */
export function registerVoucherWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-voucher",
      description:
        "Create a bookkeeping voucher (a manually-booked sales/purchase transaction). Returns the new id. " +
        "To attach a receipt afterwards, use upload-voucher-file.",
      inputSchema: voucherInputShape,
      annotations: WRITE,
    },
    async (input) => {
      // `version` must be 0 when creating (optimistic locking), mirroring contacts. VERIFY for vouchers.
      const created = await client.post<{ id: string }>("/v1/vouchers", { version: 0, ...input });
      return { structuredContent: created, content: text(`Created voucher ${created.id}.`) };
    },
  );

  server.registerTool(
    {
      name: "update-voucher",
      description:
        "Update a bookkeeping voucher. Read-modify-write: the current voucher is fetched and your fields are " +
        "merged over it, so attached files and untouched fields (voucherNumber, voucherStatus, contact, …) are " +
        "preserved — lexoffice PUT otherwise replaces the whole voucher. Send only what you want to change, " +
        "e.g. { id, voucherItems: [...] }. If you send voucherItems it REPLACES the whole list, so include every " +
        "line. Pass `version` for optimistic locking (a stale version → 409); omit it to apply to the latest.",
      inputSchema: {
        id: z.string(),
        version: z
          .number()
          .int()
          .optional()
          .describe("Current version from get-voucher (optimistic lock). Omit to use the latest."),
        ...voucherUpdateShape,
      },
      annotations: WRITE,
    },
    async ({ id, version, ...fields }) => {
      // Read-modify-write: lexoffice PUT replaces the whole resource, so load the
      // current voucher and merge the caller's fields over it (keeping files etc.).
      const current = await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`);
      const body = deepMergePatch(current, {
        ...fields,
        version: version ?? (current.version as number),
      });
      const updated = await client.request<{ id: string; version: number }>(
        "PUT",
        `/v1/vouchers/${encodeURIComponent(id)}`,
        { body, idempotent: false },
      );
      return {
        structuredContent: updated,
        content: text(`Updated voucher ${id} (now version ${updated.version}).`),
      };
    },
  );

  server.registerTool(
    {
      name: "upload-voucher-file",
      description:
        "Attach a file (receipt/scan) to a bookkeeping voucher via POST /v1/vouchers/{id}/files. Provide " +
        "the file as base64. Keep files small (a few MB): the base64 travels inline in the request.",
      inputSchema: {
        id: z.string().describe("The voucher id to attach the file to."),
        fileBase64: z.string().describe("File contents, base64-encoded."),
        filename: z.string().describe('e.g. "receipt.pdf".'),
        mimeType: z.string().describe('Content type, e.g. "application/pdf" or "image/png".'),
      },
      annotations: WRITE,
    },
    async ({ id, fileBase64, filename, mimeType }) => {
      const bytes = Buffer.from(fileBase64, "base64");
      const result = await client.postMultipart<Record<string, unknown>>(
        `/v1/vouchers/${encodeURIComponent(id)}/files`,
        { bytes, filename, contentType: mimeType },
      );
      return {
        structuredContent: result,
        content: text(`Attached ${filename} to voucher ${id}.`),
      };
    },
  );
}
