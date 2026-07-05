import { describe, expect, it } from "vitest";
import { describeErrorBody, isNotFound, LexwareApiError } from "../src/lexware/errors.js";

describe("describeErrorBody", () => {
  it("renders an IssueList entry's source + reason", () => {
    const body = {
      IssueList: [{ source: "voucherItems[0].taxRatePercent", i18nKey: "invalid_value", type: "validation_failure" }],
    };
    const msg = describeErrorBody(406, "Not Acceptable", body);
    expect(msg).toContain("voucherItems[0].taxRatePercent");
    expect(msg).toContain("invalid_value");
  });

  it("truncates a long plain-text body instead of dropping it", () => {
    const html = `<html>${"x".repeat(5000)}</html>`;
    const msg = describeErrorBody(502, "Bad Gateway", html);
    // Old behaviour dropped bodies >= 2000 chars entirely, leaving only the status.
    expect(msg).not.toBe("Lexware API 502 Bad Gateway");
    expect(msg).toContain("<html>");
    expect(msg.endsWith("…")).toBe(true);
    expect(msg.length).toBeLessThan(2100);
  });

  it("keeps a short plain-text body verbatim", () => {
    expect(describeErrorBody(500, "Server Error", "boom")).toBe("Lexware API 500: boom");
  });
});

describe("isNotFound", () => {
  it("is true only for a 404 LexwareApiError", () => {
    expect(isNotFound(new LexwareApiError(404, "gone"))).toBe(true);
    expect(isNotFound(new LexwareApiError(409, "conflict"))).toBe(false);
    expect(isNotFound(new Error("plain"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
