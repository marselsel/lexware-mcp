import type { Paged } from "../lexware/types.js";

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 25;

/** Tool annotations, shared so semantics can't drift across tool files. */
export const RO = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;
export const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;
/** Read-only and purely local (no external reach), e.g. building a deeplink string. */
export const LOCAL_RO = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;

/** Wrap a string as MCP text content. */
export function text(message: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text: message }];
}

/** Standard result for a paged list tool: the Paged envelope + a one-line summary. */
export function pagedResult<T>(result: Paged<T>, noun: string) {
  return {
    structuredContent: result,
    content: text(
      `Found ${result.totalElements} ${noun}; showing page ${result.number + 1}/${result.totalPages}.`,
    ),
  };
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-modify-write merge: overlay `patch` onto `base`, recursing into nested
 * objects so a partial sub-object (e.g. `{ company: { vatRegistrationId } }`)
 * updates one field without wiping its siblings (`company.name`). Arrays and
 * scalars replace wholesale; an `undefined` patch value leaves the base untouched
 * (callers preserve a field by simply omitting it); an explicit `null` clears it.
 *
 * Lexware/lexoffice `PUT` replaces the WHOLE resource, so update tools must GET the
 * current object and merge the caller's fields over it — otherwise omitted fields
 * (attached files, addresses, voucherNumber, …) would be silently wiped and
 * required fields would 406.
 */
export function deepMergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing) ? deepMergePatch(existing, value) : value;
  }
  return out;
}

/**
 * Merge a contact's address collection (`{ billing: [...], shipping: [...] }`) by
 * INDEX, deep-merging each address object — unlike {@link deepMergePatch}, which
 * replaces arrays wholesale. This lets a partial patch (e.g. just `countryCode`)
 * update the matching existing address instead of wiping its street/zip/city.
 * lexoffice requires `countryCode` in every address object, so element-wise merge
 * keeps the existing address valid. Existing entries the patch doesn't reach are
 * preserved.
 */
export function mergeAddresses(current: unknown, patch: unknown): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const pat = isPlainObject(patch) ? patch : {};
  const out: Record<string, unknown> = { ...cur };
  for (const [key, value] of Object.entries(pat)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const base = Array.isArray(cur[key]) ? (cur[key] as unknown[]) : [];
      const merged = value.map((entry, i) =>
        isPlainObject(entry) && isPlainObject(base[i]) ? deepMergePatch(base[i], entry) : entry,
      );
      // Keep existing addresses beyond the patch length (e.g. a second billing address).
      out[key] = base.length > value.length ? merged.concat(base.slice(value.length)) : merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}
