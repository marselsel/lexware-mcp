import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import type { Paged } from "../lexware/types.js";
import { contactInputShape } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, RO, WRITE, pagedResult, text } from "./shared.js";

/** Read tools for contacts. Always registered. */
export function registerContactReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "list-contacts",
      description:
        "List/search contacts (customers and vendors). Optional filters; results are paged (use page/size).",
      inputSchema: {
        email: z.string().min(3).optional().describe("Substring match, min 3 chars."),
        name: z.string().min(3).optional().describe("Substring match, min 3 chars."),
        number: z.number().int().optional().describe("Contact number."),
        customer: z.boolean().optional(),
        vendor: z.boolean().optional(),
        page: z.number().int().min(0).default(0),
        size: z.number().int().min(1).max(250).default(DEFAULT_PAGE_SIZE),
      },
      annotations: RO,
    },
    async ({ email, name, number, customer, vendor, page, size }) => {
      const result = await client.get<Paged<Record<string, unknown>>>("/v1/contacts", {
        email,
        name,
        number,
        customer,
        vendor,
        page,
        size,
      });
      return pagedResult(result, "contact(s)");
    },
  );

  server.registerTool(
    {
      name: "get-contact",
      description: "Get a single contact by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const contact = await client.get<Record<string, unknown>>(`/v1/contacts/${encodeURIComponent(id)}`);
      return { structuredContent: contact, content: text(`Contact ${id} retrieved.`) };
    },
  );
}

/** Write tools: create/update a contact. Registered only when the drafts tier is enabled. */
export function registerContactDraftTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-contact",
      description:
        "Create a new contact (customer and/or vendor). Provide roles plus either a person (lastName required) or a company (name required).",
      inputSchema: contactInputShape,
      annotations: WRITE,
    },
    async (input) => {
      if (!input.person && !input.company) {
        throw new Error("Provide either a person (with lastName) or a company (with name).");
      }
      // `version` must be 0 when creating.
      const created = await client.post<{ id: string }>("/v1/contacts", { version: 0, ...input });
      return { structuredContent: created, content: text(`Created contact ${created.id}.`) };
    },
  );

  server.registerTool(
    {
      name: "update-contact",
      description:
        "Update an existing contact. You must pass the current `version` (optimistic locking) — read it first with get-contact; a stale version is rejected with 409.",
      inputSchema: {
        id: z.string(),
        version: z.number().int().describe("Current version from get-contact."),
        ...contactInputShape,
      },
      annotations: WRITE,
    },
    async ({ id, ...body }) => {
      if (!body.person && !body.company) {
        throw new Error("Provide either a person (with lastName) or a company (with name).");
      }
      const updated = await client.request<{ id: string; version: number }>(
        "PUT",
        `/v1/contacts/${encodeURIComponent(id)}`,
        { body, idempotent: false },
      );
      return {
        structuredContent: updated,
        content: text(`Updated contact ${id} (now version ${updated.version}).`),
      };
    },
  );
}
