import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerArticleWriteTools } from "../src/tools/articles.js";
import { registerContactDraftTools } from "../src/tools/contacts.js";
import { registerDocumentDraftTools } from "../src/tools/documents.js";
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
      addresses: { billing: [{ countryCode: "IE" }] }, // ONLY the country changes
    });

    expect(get).toHaveBeenCalledWith("/v1/contacts/c1");
    const body = putBody(request);
    expect(body.emailAddresses).toEqual({ business: ["billing@db.de"] }); // preserved
    expect(body.company).toEqual({ name: "Deutsche Bahn AG", vatRegistrationId: "IE3336483DH" }); // merged, name kept
    expect(body.roles).toEqual({ vendor: {} }); // preserved
    const addresses = body.addresses as { billing: Array<Record<string, string>> };
    // street/zip/city preserved, only countryCode updated (element-wise address merge)
    expect(addresses.billing[0]).toEqual({
      street: "Europaplatz 1",
      zip: "10557",
      city: "Berlin",
      countryCode: "IE",
    });
    expect(body.version).toBe(4);
  });
});

describe("update-article (read-modify-write)", () => {
  it("GETs first, then PUTs the merged article, preserving fields and merging price", async () => {
    const current = {
      id: "a1",
      organizationId: "org",
      version: 3,
      title: "Widget",
      type: "PRODUCT",
      unitName: "piece",
      articleNumber: "W-1",
      gtin: "1234567890123",
      description: "A widget",
      price: { leadingPrice: "NET", taxRate: 19, netPrice: 10, grossPrice: 11.9 },
    };
    const request = vi.fn(async () => ({ id: "a1", version: 4 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerArticleWriteTools, client)["update-article"]({
      id: "a1",
      version: 3,
      price: { netPrice: 12 }, // change only one price component
    });

    expect(get).toHaveBeenCalledWith("/v1/articles/a1");
    const body = putBody(request);
    expect(body.title).toBe("Widget"); // preserved
    expect(body.articleNumber).toBe("W-1"); // preserved
    expect(body.price).toEqual({ leadingPrice: "NET", taxRate: 19, netPrice: 12, grossPrice: 11.9 }); // merged
    expect(body.version).toBe(3);
  });
});

describe("update-draft-<type> (read-modify-write)", () => {
  it("GETs first, then PUTs the merged invoice, preserving lineItems/address when only title changes", async () => {
    const current = {
      id: "i1",
      organizationId: "org",
      version: 1,
      voucherDate: "2026-06-01T00:00:00.000+02:00",
      address: { contactId: "c1", name: "Acme" },
      lineItems: [
        { type: "custom", name: "Item", quantity: 1, unitPrice: { currency: "EUR", netAmount: 100 } },
      ],
      totalPrice: { currency: "EUR", totalNetAmount: 100 },
      taxConditions: { taxType: "net" },
      title: "Invoice",
      introduction: "Intro",
    };
    const request = vi.fn(async () => ({ id: "i1", version: 2 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerDocumentDraftTools, client)["update-draft-invoice"]({
      id: "i1",
      version: 1,
      title: "Invoice (rev 2)",
    });

    expect(get).toHaveBeenCalledWith("/v1/invoices/i1");
    const body = putBody(request);
    expect(body.lineItems).toEqual(current.lineItems); // preserved
    expect(body.address).toEqual({ contactId: "c1", name: "Acme" }); // preserved
    expect(body.taxConditions).toEqual({ taxType: "net" }); // preserved
    expect(body.introduction).toBe("Intro"); // preserved
    expect(body.title).toBe("Invoice (rev 2)"); // updated
    expect(body.version).toBe(1);
  });
});
