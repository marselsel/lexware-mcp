import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../src/auth.js";

const TOKEN = "a".repeat(40);

function run(authHeader?: string) {
  const mw = bearerAuthMiddleware(TOKEN);
  const req = { headers: authHeader ? { authorization: authHeader } : {} } as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }) as unknown as Response);
  const set = vi.fn();
  const res = { status, set } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  mw(req, res, next);
  return { status, json, set, next };
}

describe("bearerAuthMiddleware", () => {
  it("401s when the header is missing", () => {
    const { status, next } = run();
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a wrong token", () => {
    const { status, next } = run("Bearer wrong");
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the Bearer prefix is missing", () => {
    const { status, next } = run(TOKEN);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() on the correct token", () => {
    const { status, next } = run(`Bearer ${TOKEN}`);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("sets a WWW-Authenticate challenge on a 401 (RFC 9110)", () => {
    const { set } = run("Bearer wrong");
    expect(set).toHaveBeenCalledWith("WWW-Authenticate", expect.stringContaining("Bearer"));
  });
});
