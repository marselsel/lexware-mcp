/**
 * Error raised for a failed Lexware API call. The message is safe to surface to
 * the model/user: it carries the HTTP status and Lexware's own (non-sensitive)
 * validation detail, never the API key or raw stack traces.
 */
export class LexwareApiError extends Error {
  /** HTTP status, or 0 for a network/transport error. */
  readonly status: number;
  /** A short category to help the model decide what to do next. */
  readonly kind: "validation" | "auth" | "not_found" | "rate_limited" | "upstream" | "network";

  constructor(status: number, message: string) {
    super(message);
    this.name = "LexwareApiError";
    this.status = status;
    this.kind = LexwareApiError.classify(status);
  }

  private static classify(status: number): LexwareApiError["kind"] {
    if (status === 0) return "network";
    if (status === 400 || status === 406 || status === 422 || status === 409) return "validation";
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    return "upstream";
  }
}

/**
 * Build a safe, helpful message from a Lexware error response body.
 * Lexware returns either `{ message, ... }` or an `IssueList`-style payload; we
 * extract human-readable text and ignore the rest. Falls back to the status text.
 */
export function describeErrorBody(status: number, statusText: string, body: unknown): string {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") parts.push(b.message);
    // Lexware legacy validation payloads use `IssueList`.
    const issues = (b.IssueList ?? b.issueList ?? b.details) as unknown;
    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 10)) {
        if (issue && typeof issue === "object") {
          const i = issue as Record<string, unknown>;
          const t = [i.field, i.message ?? i.type].filter(Boolean).join(": ");
          if (t) parts.push(t);
        }
      }
    }
  } else if (typeof body === "string" && body.trim() && body.length < 500) {
    parts.push(body.trim());
  }
  const detail = parts.join(" | ");
  return detail
    ? `Lexware API ${status}: ${detail}`
    : `Lexware API ${status} ${statusText}`.trim();
}
