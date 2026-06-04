import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import type { Paged } from "../lexware/types.js";
import { contactInputShape, contactUpdateShape } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, RO, WRITE, deepMergePatch, pagedResult, text } from "./shared.js";

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
        "Update a contact. Read-modify-write: the current contact is fetched and your fields are merged over it, " +
        "so existing addresses, emailAddresses and roles are preserved — lexoffice PUT otherwise replaces the whole " +
        "contact. Nested objects like `company` are merged, so you can set just company.vatRegistrationId (without " +
        "resending the name) or a billing countryCode. Pass `version` for optimistic locking; omit to use the latest.",
      inputSchema: {
        id: z.string(),
        version: z
          .number()
          .int()
          .optional()
          .describe("Current version from get-contact (optimistic lock). Omit to use the latest."),
        ...contactUpdateShape,
      },
      annotations: WRITE,
    },
    async ({ id, version, ...fields }) => {
      // Read-modify-write: load the current contact and merge the caller's fields over
      // it, so omitted addresses/emailAddresses/roles aren't wiped by the full PUT.
      const current = await client.get<Record<string, unknown>>(`/v1/contacts/${encodeURIComponent(id)}`);
      const body = deepMergePatch(current, {
        ...fields,
        version: version ?? (current.version as number),
      });
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
