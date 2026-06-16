import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerArticleWriteTools } from "../src/tools/articles.js";
import { registerContactDraftTools } from "../src/tools/contacts.js";
import { registerDocumentDraftTools, registerDocumentReadTools } from "../src/tools/documents.js";
import { invoiceInputShape } from "../src/tools/schemas.js";
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

describe("invoice draft: paymentConditions set at creation (the API has no PUT/update for invoices)", () => {
  const sample = {
    voucherDate: "2026-06-16T00:00:00.000+02:00",
    address: { contactId: "c1" },
    lineItems: [
      { type: "custom", name: "Item", quantity: 1, unitPrice: { currency: "EUR", netAmount: 100 } },
    ],
    totalPrice: { currency: "EUR" },
    taxConditions: { taxType: "net" },
    shippingConditions: { shippingType: "service" },
    paymentConditions: {
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    },
  };

  it("the invoice input schema retains paymentConditions instead of stripping it", () => {
    const parsed = z.object(invoiceInputShape).parse(sample);
    expect(parsed.paymentConditions).toEqual({
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    });
  });

  it("create-draft-invoice forwards paymentConditions in the POST body to /v1/invoices", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;

    await handlersFor((s, c) => registerDocumentDraftTools(s, c, true), client)["create-draft-invoice"](
      sample,
    );

    const call = post.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(call[0]).toBe("/v1/invoices");
    expect(call[1].paymentConditions).toEqual({
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    });
  });
});

describe("update-voucher contact + status handling", () => {
  it("A1: setting contactId drops a custom contactName and forces useCollectiveContact:false", async () => {
    const current = {
      id: "v1",
      contactName: "Sammellieferant",
      useCollectiveContact: true,
      voucherStatus: "open",
      files: ["f1"],
      version: 1,
    };
    const request = vi.fn(async () => ({ id: "v1", version: 2 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v1", contactId: "contact-9" });
    const body = putBody(request);
    expect(body.contactId).toBe("contact-9");
    expect(body.contactName).toBeUndefined();
    expect(body.useCollectiveContact).toBe(false);
    expect(body.files).toEqual(["f1"]); // RMW still preserves the receipt
  });

  it("B1: a payment-derived voucherStatus (paid) is omitted from the PUT", async () => {
    const current = { id: "v2", voucherStatus: "paid", files: [], version: 3 };
    const request = vi.fn(async () => ({ id: "v2", version: 4 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v2", remark: "note" });
    const body = putBody(request);
    expect(body.voucherStatus).toBeUndefined();
    expect(body.remark).toBe("note");
  });

  it("B5: an explicit voucherStatus (voided) is kept for a void attempt", async () => {
    const current = { id: "v3", voucherStatus: "open", files: [], version: 1 };
    const request = vi.fn(async () => ({ id: "v3", version: 2 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v3", voucherStatus: "voided" });
    const body = putBody(request);
    expect(body.voucherStatus).toBe("voided");
  });
});

describe("get-vouchers (batch read)", () => {
  it("fetches each id and collects failures into errors instead of throwing", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/bad")) throw new Error("Lexware API 404: not found");
      return { id: path.split("/").pop(), voucherStatus: "open" };
    });
    const client = { get } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    const res = (await handlers["get-vouchers"]({ ids: ["a", "bad", "b"] })) as {
      structuredContent: { vouchers: unknown[]; errors: Array<{ id: string }> };
    };
    expect(res.structuredContent.vouchers).toHaveLength(2);
    expect(res.structuredContent.errors.map((e) => e.id)).toEqual(["bad"]);
  });
});

describe("get-document dispatch + get-voucher-file", () => {
  it("get-document routes by voucherType and rejects unknown types", async () => {
    const get = vi.fn(async (path: string) => ({ path }));
    const client = { get } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["get-document"]({ id: "x", voucherType: "purchaseinvoice" });
    expect(get).toHaveBeenCalledWith("/v1/vouchers/x");
    await handlers["get-document"]({ id: "y", voucherType: "quotation" });
    expect(get).toHaveBeenCalledWith("/v1/quotations/y");
    await expect(handlers["get-document"]({ id: "z", voucherType: "bogus" })).rejects.toThrow(
      /Unknown voucherType/,
    );
  });

  it("get-voucher-file resolves the voucher's file id and downloads it", async () => {
    const get = vi.fn(async () => ({ files: ["file-7"] }));
    const getBinary = vi.fn(async () => ({ data: Buffer.from("%PDF-1.6"), contentType: "application/pdf" }));
    const client = { get, getBinary } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    const res = (await handlers["get-voucher-file"]({ id: "v1", fileIndex: 0 })) as {
      structuredContent: { fileId: string };
    };
    expect(get).toHaveBeenCalledWith("/v1/vouchers/v1");
    expect(getBinary).toHaveBeenCalledWith("/v1/files/file-7");
    expect(res.structuredContent.fileId).toBe("file-7");
  });
});

const docBody = {
  voucherDate: "2026-06-01T00:00:00.000+02:00",
  address: { contactId: "c1" },
  lineItems: [{ type: "custom", name: "x" }],
  totalPrice: { currency: "EUR" },
  taxConditions: { taxType: "net" },
  shippingConditions: { shippingType: "none" },
};

describe("create-draft finalize gating + precedingSalesVoucherId", () => {
  it("creates a draft and passes precedingSalesVoucherId as a query", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentDraftTools(s, c, true), client);
    await handlers["create-draft-invoice"]({ ...docBody, precedingSalesVoucherId: "q9" });
    const call = post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(call[0]).toBe("/v1/invoices");
    expect(call[2]).toEqual({ precedingSalesVoucherId: "q9" });
    expect(call[1].finalize).toBeUndefined(); // finalize stripped from the body
  });

  it("finalize:true is rejected when the finalize capability is off", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentDraftTools(s, c, false), client);
    await expect(
      handlers["create-draft-invoice"]({ ...docBody, finalize: true, confirm_finalize: true }),
    ).rejects.toThrow(/LEXWARE_ENABLE_FINALIZE/);
    expect(post).not.toHaveBeenCalled();
  });

  it("finalize:true requires confirm_finalize even when enabled", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentDraftTools(s, c, true), client);
    await expect(handlers["create-draft-invoice"]({ ...docBody, finalize: true })).rejects.toThrow(
      /confirm_finalize/,
    );
  });

  it("finalize:true + confirm + capability POSTs ?finalize=true", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentDraftTools(s, c, true), client);
    const res = (await handlers["create-draft-invoice"]({
      ...docBody,
      finalize: true,
      confirm_finalize: true,
    })) as { structuredContent: { finalized: boolean } };
    expect((post.mock.calls[0] as [string, unknown, Record<string, unknown>])[2]).toEqual({ finalize: true });
    expect(res.structuredContent.finalized).toBe(true);
  });
});

describe("render-*-pdf and get-document-file download /file", () => {
  const mkClient = () =>
    ({ getBinary: vi.fn(async () => ({ data: Buffer.from("%PDF"), contentType: "application/pdf" })) }) as unknown as LexwareClient;

  it("render-invoice-pdf hits /v1/invoices/{id}/file", async () => {
    const client = mkClient();
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["render-invoice-pdf"]({ id: "i9" });
    expect(client.getBinary).toHaveBeenCalledWith("/v1/invoices/i9/file");
  });

  it("get-document-file hits /v1/{resourceType}/{id}/file", async () => {
    const client = mkClient();
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["get-document-file"]({ resourceType: "credit-notes", id: "c3" });
    expect(client.getBinary).toHaveBeenCalledWith("/v1/credit-notes/c3/file");
  });
});
