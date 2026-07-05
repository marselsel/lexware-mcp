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
  /** The parsed Lexware error body (e.g. an IssueList), preserved for inspection. */
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "LexwareApiError";
    this.status = status;
    this.kind = LexwareApiError.classify(status);
    this.body = body;
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

/** True for a {@link LexwareApiError} representing a 404 Not Found. */
export function isNotFound(err: unknown): boolean {
  return err instanceof LexwareApiError && err.kind === "not_found";
}

/** Max IssueList entries rendered into a message before we summarize the remainder. */
const MAX_ISSUES = 25;
/** Max characters of a raw error body rendered into a message (truncate, never drop). */
const MAX_BODY_CHARS = 2000;

/** Clamp a string to at most `max` chars, appending an ellipsis when truncated. */
function clampText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Build a safe, helpful message from a Lexware error response body.
 *
 * Lexware returns either `{ message, ... }` or an `IssueList` validation payload
 * (lexoffice legacy). Each IssueList entry looks like
 * `{ i18nKey, source, type, additionalData, args }` where **`source`** is the
 * offending field path (e.g. `voucherItems[0].taxRatePercent`) and **`i18nKey`**
 * is the reason — both far more useful than the generic `type`
 * ("validation_failure"). We surface `source` + `i18nKey` + `type` per issue, and
 * fall back to the raw JSON so a Lexware detail is never silently swallowed.
 */
export function describeErrorBody(status: number, statusText: string, body: unknown): string {
  const parts: string[] = [];

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string" && b.message.trim()) parts.push(b.message.trim());
  }

  const issues = pickIssueList(body);
  if (issues) {
    for (const issue of issues.slice(0, MAX_ISSUES)) {
      const detail = describeIssue(issue);
      if (detail) parts.push(detail);
    }
    if (issues.length > MAX_ISSUES) parts.push(`…and ${issues.length - MAX_ISSUES} more`);
  } else if (typeof body === "string" && body.trim()) {
    // Truncate a long plain-text body (e.g. an HTML 5xx page) rather than dropping
    // it — otherwise all upstream diagnostic detail would be lost.
    parts.push(clampText(body.trim(), MAX_BODY_CHARS));
  }

  // Safety net: never silently drop a structured Lexware body we couldn't summarize.
  if (parts.length === 0 && body && typeof body === "object") {
    const raw = safeJson(body);
    if (raw) parts.push(raw);
  }

  const detail = parts.join(" | ");
  return detail ? `Lexware API ${status}: ${detail}` : `Lexware API ${status} ${statusText}`.trim();
}

/** Locate the IssueList: a top-level array, or under IssueList/issueList/details/errors. */
function pickIssueList(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const list = b.IssueList ?? b.issueList ?? b.details ?? b.errors;
    if (Array.isArray(list)) return list;
  }
  return undefined;
}

/** Render one IssueList entry as "source: i18nKey/type", keeping every signal-bearing sub-field. */
function describeIssue(issue: unknown): string | undefined {
  if (!issue || typeof issue !== "object") return undefined;
  const i = issue as Record<string, unknown>;
  const where = firstString(i.source, i.field, i.path);
  const why = [i.i18nKey, i.message, i.type]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .filter((x, idx, arr) => arr.indexOf(x) === idx);
  const detail = [where, why.join("/")].filter(Boolean).join(": ");
  return detail || undefined;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** Compact JSON for the fallback, capped so a huge body can't bloat the message. */
function safeJson(v: unknown): string | undefined {
  try {
    const s = JSON.stringify(v);
    if (!s) return undefined;
    return s.length <= 1500 ? s : `${s.slice(0, 1500)}…`;
  } catch {
    return undefined;
  }
}
