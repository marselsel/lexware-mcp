import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { RO, text } from "./shared.js";

/**
 * Read-only reference + supporting data. Always registered.
 * These help the model build valid documents (tax/country/payment metadata) and
 * inspect payments and recurring templates.
 */
export function registerReferenceReadTools(server: McpServer, client: LexwareClient): void {
  const simpleGet = (name: string, path: string, description: string) =>
    server.registerTool({ name, description, annotations: RO }, async () => {
      const data = await client.get<unknown>(path);
      return {
        structuredContent: { data },
        content: text(`Retrieved ${name.replace(/^get-/, "")}.`),
      };
    });

  simpleGet("get-countries", "/v1/countries", "List countries with tax classification data.");
  simpleGet("get-payment-conditions", "/v1/payment-conditions", "List configured payment conditions.");
  simpleGet("get-posting-categories", "/v1/posting-categories", "List bookkeeping posting categories.");
  simpleGet("get-print-layouts", "/v1/print-layouts", "List available document print layouts.");

  server.registerTool(
    {
      name: "get-payment",
      description: "Get payment information for a voucher/document by its id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const payment = await client.get<Record<string, unknown>>(`/v1/payments/${encodeURIComponent(id)}`);
      return { structuredContent: payment, content: text(`Payment info for ${id} retrieved.`) };
    },
  );

  server.registerTool(
    {
      name: "get-recurring-template",
      description: "Get a recurring-invoice template by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const tmpl = await client.get<Record<string, unknown>>(`/v1/recurring-templates/${encodeURIComponent(id)}`);
      return { structuredContent: tmpl, content: text(`Recurring template ${id} retrieved.`) };
    },
  );
}
