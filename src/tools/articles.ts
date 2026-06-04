import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import type { Paged } from "../lexware/types.js";
import {
  articleInputShape,
  articleUpdateShape,
  pageParam,
  sizeParam,
  versionParam,
} from "./schemas.js";
import { DESTRUCTIVE, RO, WRITE, deepMergePatch, pagedResult, text } from "./shared.js";

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
        page: pageParam,
        size: sizeParam,
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
        "Update an existing article. Read-modify-write: the current article is fetched and your fields are " +
        "merged over it, so omitted fields aren't wiped and you can change just the price. Pass `version` for " +
        "optimistic locking (omit to use the latest); a stale version is rejected with 409.",
      inputSchema: {
        id: z.string(),
        version: versionParam("get-article"),
        ...articleUpdateShape,
      },
      annotations: WRITE,
    },
    async ({ id, version, ...fields }) => {
      // Read-modify-write: lexoffice PUT replaces the whole article, so merge over the current one.
      const current = await client.get<Record<string, unknown>>(`/v1/articles/${encodeURIComponent(id)}`);
      const body = deepMergePatch(current, {
        ...fields,
        version: version ?? (current.version as number),
      });
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

/**
 * Destructive delete for articles. Registered with the finalize tier (off by
 * default) so an irreversible delete is never enabled by drafts alone.
 */
export function registerArticleDeleteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "delete-article",
      description: "Delete an article (product/service) by id. This is irreversible.",
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      await client.request<unknown>("DELETE", `/v1/articles/${encodeURIComponent(id)}`, {
        idempotent: true,
      });
      return {
        structuredContent: { id, deleted: true },
        content: text(`Deleted article ${id}.`),
      };
    },
  );
}
