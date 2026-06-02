import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { DESTRUCTIVE, RO, text, WRITE } from "./shared.js";

/** Read tools for event subscriptions (webhooks). Always registered. */
export function registerEventSubscriptionReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "list-event-subscriptions",
      description: "List webhook event subscriptions configured for this organization.",
      annotations: RO,
    },
    async () => {
      const data = await client.get<unknown>("/v1/event-subscriptions");
      return { structuredContent: { data }, content: text("Retrieved event subscriptions.") };
    },
  );

  server.registerTool(
    {
      name: "get-event-subscription",
      description: "Get a single event subscription by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const sub = await client.get<Record<string, unknown>>(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
      return { structuredContent: sub, content: text(`Event subscription ${id} retrieved.`) };
    },
  );
}

/** Non-destructive write tools for event subscriptions. Registered with the drafts tier. */
export function registerEventSubscriptionWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-event-subscription",
      description:
        "Subscribe a callback URL to a Lexware event type (webhook), e.g. eventType 'invoice.created'. The callback URL must serve a Grade-A HTTPS certificate.",
      inputSchema: {
        eventType: z.string().describe("e.g. 'invoice.created', 'invoice.status.changed'."),
        callbackUrl: z.string().url().describe("HTTPS endpoint that will receive events."),
      },
      annotations: WRITE,
    },
    async ({ eventType, callbackUrl }) => {
      const created = await client.post<{ subscriptionId?: string; id?: string }>(
        "/v1/event-subscriptions",
        { eventType, callbackUrl },
      );
      const id = created.subscriptionId ?? created.id ?? "";
      return {
        structuredContent: created,
        content: text(`Created event subscription ${id} for ${eventType}.`),
      };
    },
  );
}

/**
 * Destructive delete for event subscriptions. Registered with the finalize tier
 * (off by default) so an irreversible delete is never enabled by drafts alone.
 */
export function registerEventSubscriptionDeleteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "delete-event-subscription",
      description: "Delete (unsubscribe) an event subscription by id. This is irreversible.",
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      await client.request<unknown>("DELETE", `/v1/event-subscriptions/${encodeURIComponent(id)}`, { idempotent: true });
      return {
        structuredContent: { id, deleted: true },
        content: text(`Deleted event subscription ${id}.`),
      };
    },
  );
}
