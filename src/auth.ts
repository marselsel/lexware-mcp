import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express middleware enforcing a static bearer token on a route.
 *
 * Uses a constant-time comparison to avoid leaking the token via timing. The
 * token length is treated as non-secret (lengths are compared first, which
 * `timingSafeEqual` requires anyway).
 */
export function bearerAuthMiddleware(token: string): RequestHandler {
  const expected = Buffer.from(token, "utf8");
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const provided =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const providedBuf = Buffer.from(provided, "utf8");
    const ok =
      providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
    if (!ok) {
      // RFC 9110 §11.6.1: a 401 MUST carry a WWW-Authenticate challenge so clients
      // know a bearer token is expected (mirrors the OAuth path's behaviour).
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
