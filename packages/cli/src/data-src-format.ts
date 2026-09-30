// Browser-safe helpers for the `data-src` attribute value.
//
// Kept separate from `rehype-data-src.ts` because the rail bundle
// (browser target) imports these functions AND cannot pull in
// `node:url` / `node:path`. The plugin (server target) imports the
// same names from this file.
//
// Path validation matches `review-core`'s `anchorPathSchema` (a
// duplicate rule set, kept in step by the shared test
// `isValidRepoRelativePath`): repo-relative, no `..` / `.` segments,
// no absolute prefix, no control characters or disallowed
// punctuation, 512-char cap. The rail (and `check-dist`) discard a
// `data-src` value whose path fails this check.

/** Format the `data-src` attribute value. Path is repo-relative,
 * POSIX-normalised (the plugin normalises before calling). Line
 * numbers are 1-indexed inclusive. */
export function formatDataSrc(
  repoRelPath: string,
  startLine: number,
  endLine: number,
): string {
  return `${repoRelPath}:${startLine}-${endLine}`;
}

/** Structural predicate: is `path` a valid repo-relative anchor
 * path? Kept in step with `review-core`'s `anchorPathSchema` so the
 * rail, `check-dist`, and the daemon apply the same rule. */
export function isValidRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  // Control chars, `:`, `*`, `?`, `<`, `>`, `|`, `"` all refused.
  // (`:` is not allowed because `data-src` uses the LAST `:` to
  // split path from line range — a path with `:` would ambiguate.)
  for (let i = 0; i < path.length; i++) {
    const cc = path.charCodeAt(i);
    if (cc < 0x20) return false;
    if (
      cc === 0x3a /* : */ ||
      cc === 0x2a /* * */ ||
      cc === 0x3f /* ? */ ||
      cc === 0x3c /* < */ ||
      cc === 0x3e /* > */ ||
      cc === 0x7c /* | */ ||
      cc === 0x22 /* " */
    ) {
      return false;
    }
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "." || part === "..") return false;
  }
  return true;
}

/** Parse a `data-src` string back into `{path, startLine, endLine}`.
 * Strict — a malformed value (bad path, bad range, containment
 * violation) returns undefined so callers can fall back rather than
 * emit a broken anchor. Because our path validator refuses `:`,
 * the range's LAST `:` is unambiguously the separator; we take the
 * last colon as the split point either way, so a legacy fixture
 * with an accidental `:` in a path still fails validation cleanly
 * rather than silently anchoring to the wrong file. */
export function parseDataSrc(
  value: string,
): { path: string; startLine: number; endLine: number } | undefined {
  const colon = value.lastIndexOf(":");
  if (colon <= 0 || colon === value.length - 1) return undefined;
  const path = value.slice(0, colon);
  const range = value.slice(colon + 1);
  const dash = range.indexOf("-");
  if (dash <= 0 || dash === range.length - 1) return undefined;
  const startLine = Number.parseInt(range.slice(0, dash), 10);
  const endLine = Number.parseInt(range.slice(dash + 1), 10);
  if (!Number.isInteger(startLine) || startLine <= 0) return undefined;
  if (!Number.isInteger(endLine) || endLine < startLine) return undefined;
  if (!isValidRepoRelativePath(path)) return undefined;
  return { path, startLine, endLine };
}
