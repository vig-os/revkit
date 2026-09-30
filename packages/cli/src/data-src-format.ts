// Browser-safe helpers for the `data-src` attribute value.
//
// Kept separate from `rehype-data-src.ts` because the rail bundle
// (browser target) imports these two functions AND cannot pull in
// `node:url` / `node:path`. The plugin (server target) imports the
// same two names from this file.

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

/** Parse a `data-src` string back into `{path, startLine, endLine}`.
 * Strict — a malformed value returns undefined so callers can fall
 * back rather than emit a broken anchor. The rightmost `:` separates
 * the range from the path (a path may itself contain a colon on
 * non-Windows fs, so anchor at the end). */
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
  return { path, startLine, endLine };
}
