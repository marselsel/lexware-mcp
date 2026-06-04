import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { voucherInputShape } from "./schemas.js";
import { WRITE, text } from "./shared.js";

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
        "Update an existing bookkeeping voucher. Pass the current `version` from get-voucher (optimistic " +
        "locking); a stale version is rejected with 409.",
      inputSchema: {
        id: z.string(),
        // VERIFY: vouchers use the same optimistic-locking `version` as other resources.
        version: z.number().int().describe("Current version from get-voucher."),
        ...voucherInputShape,
      },
      annotations: WRITE,
    },
    async ({ id, ...body }) => {
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
