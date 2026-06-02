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
