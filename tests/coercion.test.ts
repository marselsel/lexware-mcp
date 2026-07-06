import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  articleUpdateShape,
  contactInputShape,
  contactUpdateShape,
  invoiceInputShape,
  voucherInputShape,
} from "../src/tools/schemas.js";

// Mirrors how the MCP SDK validates tool input: z.object(rawShape).parse(args).
const parse = (shape: Record<string, z.ZodTypeAny>, args: unknown) =>
  z.object(shape as z.ZodRawShape).parse(args);

describe("JSON-string coercion (jsonObj) for object/array params", () => {
  it("update-contact accepts addresses + company as JSON strings", () => {
    const parsed = parse(
      { id: z.string(), ...contactUpdateShape },
      {
        id: "c1",
        addresses: JSON.stringify({ billing: [{ countryCode: "IE" }] }),
        company: JSON.stringify({ vatRegistrationId: "IE3336483DH" }),
      },
    ) as Record<string, unknown>;
    expect(parsed.addresses).toEqual({ billing: [{ countryCode: "IE" }] });
    expect(parsed.company).toEqual({ vatRegistrationId: "IE3336483DH" });
  });

  it("update-contact still accepts addresses as a real object", () => {
    const parsed = parse(
      { id: z.string(), ...contactUpdateShape },
      { id: "c1", addresses: { billing: [{ countryCode: "IE" }] } },
    ) as Record<string, unknown>;
    expect(parsed.addresses).toEqual({ billing: [{ countryCode: "IE" }] });
  });

  it("create-contact accepts a stringified company/roles and validates required name", () => {
    const parsed = parse(contactInputShape, {
      roles: JSON.stringify({ vendor: {} }),
      company: JSON.stringify({ name: "Slack Technologies Ltd", vatRegistrationId: "IE3336483DH" }),
    }) as Record<string, { name?: string }>;
    expect(parsed.roles).toEqual({ vendor: {} });
    expect(parsed.company?.name).toBe("Slack Technologies Ltd");
    // A stringified company missing the required `name` still fails validation.
    expect(() => parse(contactInputShape, { roles: { vendor: {} }, company: JSON.stringify({}) })).toThrow();
  });

  it("create-voucher accepts voucherItems as a JSON string", () => {
    const parsed = parse(voucherInputShape, {
      type: "purchaseinvoice",
      voucherDate: "2026-06-12T00:00:00.000+02:00",
      voucherItems: JSON.stringify([{ amount: 1, taxAmount: 0, taxRatePercent: 0, categoryId: "x" }]),
    }) as { voucherItems: Array<{ categoryId: string }> };
    expect(Array.isArray(parsed.voucherItems)).toBe(true);
    expect(parsed.voucherItems[0].categoryId).toBe("x");
  });

  it("leaves an invalid JSON string to fail validation (not a crash)", () => {
    expect(() => parse({ id: z.string(), ...contactUpdateShape }, { id: "c1", addresses: "{not json" })).toThrow();
  });

  it("document tools accept address/lineItems/totalPrice/taxConditions as JSON strings", () => {
    const parsed = parse(invoiceInputShape, {
      voucherDate: "2026-06-01T00:00:00.000+02:00",
      address: JSON.stringify({ contactId: "c1" }),
      lineItems: JSON.stringify([{ type: "custom", name: "Item" }]),
      totalPrice: JSON.stringify({ currency: "EUR" }),
      taxConditions: JSON.stringify({ taxType: "net" }),
      shippingConditions: JSON.stringify({ shippingType: "none" }),
    }) as Record<string, unknown>;
    expect(parsed.address).toEqual({ contactId: "c1" });
    expect(parsed.lineItems).toEqual([{ type: "custom", name: "Item" }]);
    expect((parsed.totalPrice as { currency: string }).currency).toBe("EUR");
  });

  it("update-article accepts price as a JSON string", () => {
    const parsed = parse(
      { id: z.string(), ...articleUpdateShape },
      { id: "a1", price: JSON.stringify({ netPrice: 12 }) },
    ) as Record<string, unknown>;
    expect(parsed.price).toEqual({ netPrice: 12 });
  });

  it("coerces boolean and number scalar params from strings", () => {
    const v = parse(voucherInputShape, {
      type: "purchaseinvoice",
      voucherDate: "2026-06-12T00:00:00.000+02:00",
      useCollectiveContact: "false",
      totalGrossAmount: "11.9",
    }) as Record<string, unknown>;
    expect(v.useCollectiveContact).toBe(false); // jsonBool coercion
    expect(v.totalGrossAmount).toBe(11.9); // jsonNum coercion
  });

  it("keeps line-item optional/alternative flags (incl. from strings) so they reach the API", () => {
    const parsed = parse(invoiceInputShape, {
      voucherDate: "2026-07-06",
      address: { contactId: "c1" },
      totalPrice: { currency: "EUR" },
      taxConditions: { taxType: "net" },
      shippingConditions: { shippingType: "service" },
      lineItems: [
        { type: "custom", name: "Base", unitPrice: { currency: "EUR", netAmount: 100 } },
        // second line item is optional; a string-serialising client sends "true"
        { type: "custom", name: "Add-on", optional: "true", alternative: false, unitPrice: { currency: "EUR", netAmount: 50 } },
      ],
    }) as { lineItems: Array<Record<string, unknown>> };
    expect(parsed.lineItems[0].optional).toBeUndefined(); // omitted → not sent
    expect(parsed.lineItems[1].optional).toBe(true); // "true" coerced and preserved
    expect(parsed.lineItems[1].alternative).toBe(false);
  });
});
