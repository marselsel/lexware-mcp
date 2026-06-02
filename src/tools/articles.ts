import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import type { Paged } from "../lexware/types.js";
import { articleInputShape } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, RO, WRITE, pagedResult, text } from "./shared.js";

/** Read tools for articles (products/services). Always registered. */
export function registerArticleReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "list-articles",
      description:
        "List articles (products/services). Optional filters; results are paged (use page/size to fetch more).",
      inputSchema: {
        articleNumber: z.string().optional(),
        gtin: z.string().optional(),
        type: z.enum(["PRODUCT", "SERVICE"]).optional(),
        page: z.number().int().min(0).default(0),
        size: z.number().int().min(1).max(250).default(DEFAULT_PAGE_SIZE),
      },
      annotations: RO,
    },
    async ({ articleNumber, gtin, type, page, size }) => {
      const result = await client.get<Paged<Record<string, unknown>>>("/v1/articles", {
        articleNumber,
        gtin,
        type,
        page,
        size,
      });
      return pagedResult(result, "article(s)");
    },
  );

  server.registerTool(
    {
      name: "get-article",
      description: "Get a single article by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const article = await client.get<Record<string, unknown>>(`/v1/articles/${encodeURIComponent(id)}`);
      return {
        structuredContent: article,
        content: text(`Article ${id}: ${(article.title as string) ?? ""}`),
      };
    },
  );
}

/** Write tools for articles. Registered with the drafts tier. */
export function registerArticleWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-article",
      description: "Create a new article (product or service).",
      inputSchema: articleInputShape,
      annotations: WRITE,
    },
    async (input) => {
      const created = await client.post<{ id: string }>("/v1/articles", input);
      return { structuredContent: created, content: text(`Created article ${created.id}.`) };
    },
  );

  server.registerTool(
    {
      name: "update-article",
      description:
        "Update an existing article. Pass the current `version` (optimistic locking) from get-article; a stale version is rejected with 409.",
      inputSchema: {
        id: z.string(),
        version: z.number().int().describe("Current version from get-article."),
        ...articleInputShape,
      },
      annotations: WRITE,
    },
    async ({ id, ...body }) => {
      const updated = await client.request<{ id: string; version: number }>(
        "PUT",
        `/v1/articles/${encodeURIComponent(id)}`,
        { body, idempotent: false },
      );
      return {
        structuredContent: updated,
        content: text(`Updated article ${id} (now version ${updated.version}).`),
      };
    },
  );
}
