import { describe, expect, it } from "vitest";
import { deepMergePatch, mergeAddresses } from "../src/tools/shared.js";

describe("deepMergePatch (read-modify-write)", () => {
  it("preserves base fields the patch omits", () => {
    const base = { id: "1", files: ["f1"], voucherNumber: "RE-1", version: 2 };
    const out = deepMergePatch(base, { remark: "edited" });
    expect(out.files).toEqual(["f1"]);
    expect(out.voucherNumber).toBe("RE-1");
    expect(out.remark).toBe("edited");
  });

  it("overrides scalars and replaces arrays wholesale", () => {
    const base = { items: [{ a: 1 }, { a: 2 }], status: "open" };
    const out = deepMergePatch(base, { items: [{ a: 9 }], status: "paid" });
    expect(out.items).toEqual([{ a: 9 }]);
    expect(out.status).toBe("paid");
  });

  it("merges nested objects so siblings survive", () => {
    const base = { company: { name: "Acme", vatRegistrationId: "OLD" } };
    const out = deepMergePatch(base, { company: { vatRegistrationId: "IE3336483DH" } });
    expect(out.company).toEqual({ name: "Acme", vatRegistrationId: "IE3336483DH" });
  });

  it("ignores undefined (omission keeps base) but applies explicit null (clears)", () => {
    const base = { a: "keep", b: "clearme" };
    const out = deepMergePatch(base, { a: undefined, b: null });
    expect(out.a).toBe("keep");
    expect(out.b).toBeNull();
  });

  it("does not mutate the base object", () => {
    const base = { nested: { x: 1 } };
    const out = deepMergePatch(base, { nested: { y: 2 } });
    expect(base).toEqual({ nested: { x: 1 } });
    expect(out.nested).toEqual({ x: 1, y: 2 });
  });
});

describe("mergeAddresses (index-wise contact address merge)", () => {
  it("merges a partial billing[0] into the existing address, keeping street/zip/city", () => {
    const current = {
      billing: [{ street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "DE" }],
    };
    const out = mergeAddresses(current, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([
      { street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "IE" },
    ]);
  });

  it("adds a billing address when none exists yet", () => {
    const out = mergeAddresses({}, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([{ countryCode: "IE" }]);
  });

  it("preserves shipping and untouched extra entries when only billing[0] is patched", () => {
    const current = {
      billing: [
        { city: "Berlin", countryCode: "DE" },
        { city: "Munich", countryCode: "DE" },
      ],
      shipping: [{ city: "Hamburg", countryCode: "DE" }],
    };
    const out = mergeAddresses(current, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([
      { city: "Berlin", countryCode: "IE" },
      { city: "Munich", countryCode: "DE" },
    ]);
    expect(out.shipping).toEqual([{ city: "Hamburg", countryCode: "DE" }]);
  });
});
