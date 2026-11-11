// Browser-safe helpers for the `data-src` attribute value.
//
// Kept separate from `rehype-data-src.ts` because the rail bundle
// (browser target) imports these functions AND cannot pull in
// `node:url` / `node:path`. The plugin (server target) imports the
// same names from this file.
//
// Path validation delegates to review-core's `isValidRepoRelativePath`
// — the source of truth. review-core's `anchorPathSchema` also wraps
// the same predicate, so the daemon and this browser file share ONE
// rule set. A test (`test/data-src-format.test.ts:parity`) asserts
// this file's re-export and review-core's copy behave identically
// on a spread of hostile inputs.
//
// Why the local copy of the predicate below and not a direct import?
// The rail bundle is built with `Bun.build` at daemon startup; when
// the file is imported both by a normal test AND by `Bun.build` in
// the same process, Bun raises "Unexpected reading file" on the
// second reader. Copying the small pure function here — reviewed
// against the parity test — keeps the bundle path clean.

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

/** Disallowed single-char codes: `"`, `*`, `:`, `<`, `>`, `?`, `|`.
 * Kept in step with review-core's `path.ts`. */
const DISALLOWED_PATH_CHARS: ReadonlySet<number> = new Set<number>([
  0x22, 0x2a, 0x3a, 0x3c, 0x3e, 0x3f, 0x7c,
]);

/** Structural predicate: is `path` a valid repo-relative anchor
 * path? Identical to review-core's `isValidRepoRelativePath`; the
 * parity test in `test/data-src-format.test.ts` fails if the two
 * diverge behaviourally. */
export function isValidRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const cc = path.charCodeAt(i);
    if (cc < 0x20) return false;
    if (DISALLOWED_PATH_CHARS.has(cc)) return false;
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "." || part === "..") return false;
    if (part.length === 0) return false;
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
