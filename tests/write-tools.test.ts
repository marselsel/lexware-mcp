import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerContactDraftTools } from "../src/tools/contacts.js";
import { registerVoucherWriteTools } from "../src/tools/vouchers.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

/** Register a tool group against a fake server and return its handlers by name. */
function handlersFor(
  register: (s: McpServer, c: LexwareClient) => void,
  client: LexwareClient,
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool(cfg: { name: string }, handler: Handler) {
      handlers[cfg.name] = handler;
      return server;
    },
  } as unknown as McpServer;
  register(server, client);
  return handlers;
}

/** The body argument of the (single) client.request("PUT", path, { body }) call. */
function putBody(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = request.mock.calls[0] as [string, string, { body: Record<string, unknown> }];
  expect(call[0]).toBe("PUT");
  return call[2].body;
}

describe("update-voucher (read-modify-write)", () => {
  it("GETs first, then PUTs the merged object, preserving files/number/status", async () => {
    const current = {
      id: "v1",
      organizationId: "org",
      type: "purchaseinvoice",
      voucherStatus: "unchecked",
      voucherNumber: "RE-2024-1",
      voucherDate: "2026-06-12T00:00:00.000+02:00",
      totalGrossAmount: 119,
      totalTaxAmount: 19,
      taxType: "gross",
      voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "old" }],
      files: ["file-1"],
      version: 2,
    };
    const request = vi.fn(async () => ({ id: "v1", version: 3 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({
      id: "v1",
      version: 2,
      voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "new" }],
    });

    expect(get).toHaveBeenCalledWith("/v1/vouchers/v1");
    const body = putBody(request);
    expect(body.files).toEqual(["file-1"]); // attached receipt preserved
    expect(body.voucherNumber).toBe("RE-2024-1"); // not wiped → no missing_entity
    expect(body.voucherStatus).toBe("unchecked"); // not wiped → no invalid_value
    expect(body.voucherItems).toEqual([
      { amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "new" },
    ]); // only change applied
    expect(body.version).toBe(2); // caller's version
  });

  it("falls back to the current version when the caller omits it", async () => {
    const current = { id: "v1", type: "purchaseinvoice", voucherDate: "x", files: [], version: 7 };
    const request = vi.fn(async () => ({ id: "v1", version: 8 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;

    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v1", remark: "note" });

    const body = putBody(request);
    expect(body.version).toBe(7);
    expect(body.remark).toBe("note");
  });
});

describe("update-contact (read-modify-write)", () => {
  it("preserves emailAddresses/roles and merges company.vatRegistrationId without wiping the name", async () => {
    const current = {
      id: "c1",
      organizationId: "org",
      version: 4,
      roles: { vendor: {} },
      company: { name: "Deutsche Bahn AG" },
      emailAddresses: { business: ["billing@db.de"] },
      addresses: { billing: [{ street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "DE" }] },
    };
    const request = vi.fn(async () => ({ id: "c1", version: 5 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerContactDraftTools, client)["update-contact"]({
      id: "c1",
      version: 4,
      company: { vatRegistrationId: "IE3336483DH" },
      addresses: { billing: [{ street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "IE" }] },
    });

    expect(get).toHaveBeenCalledWith("/v1/contacts/c1");
    const body = putBody(request);
    expect(body.emailAddresses).toEqual({ business: ["billing@db.de"] }); // preserved
    expect(body.company).toEqual({ name: "Deutsche Bahn AG", vatRegistrationId: "IE3336483DH" }); // merged, name kept
    expect(body.roles).toEqual({ vendor: {} }); // preserved
    const addresses = body.addresses as { billing: Array<{ countryCode: string }> };
    expect(addresses.billing[0].countryCode).toBe("IE"); // updated
    expect(body.version).toBe(4);
  });
});
