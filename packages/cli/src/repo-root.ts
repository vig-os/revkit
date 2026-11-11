// Repo-root resolution. The check needs to know where the workspace root
// is so relative paths in diagnostics stay stable regardless of the
// process cwd, and so path-scoped rules (`site/src/content/**`, `plots/**`)
// resolve against one anchor.
//
// Two ways to be a workspace root — the CLI accepts whichever comes
// first walking up from the start directory:
//
//   1. `package.json` whose `name` is "revkit" (the revkit repo itself,
//      dogfooding its own guards).
//   2. `package.json` that carries a top-level `revkit` key (any value —
//      an object, `true`, an empty object — signals opt-in). This is the
//      one-line adoption path for a consumer docs repo scaffolded from
//      the flake template (ADR-0010, D1): drop `{"revkit": {}}` into a
//      `package.json` and the CLI walks the whole tree from that point.
//      A repo that already carries any Node config keeps the marker in
//      the existing manifest; a docs-only repo ships a two-line one.
//
// Nothing walks past the first hit, so a consumer repo with a `revkit`
// key at its own root never accidentally binds to the revkit repo it
// happens to live under during development (a `revkit` key never
// exists in the revkit repo's own root).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Marker written in the revkit repo's own workspace root
 * (`"name": "revkit"`). Kept as a constant so a rename shows up as a
 * compile-time change instead of a silent miss. */
const ROOT_MARKER_NAME = "revkit";

/** Second marker: a top-level `revkit` key in a `package.json` marks
 * that manifest's directory as a workspace root for a consumer repo
 * (ADR-0010, D1). Any value is accepted — the presence of the key IS
 * the opt-in signal — so a repo can pass `{"revkit": {}}` (or extend
 * the key with future config fields) without a schema round-trip. */
const ROOT_MARKER_KEY = "revkit";

/** Does the parsed `package.json` at `pkg` mark its own directory as a
 * revkit workspace root? Reads only the two allow-listed markers so an
 * unrelated package.json (e.g. a downstream node_modules) never matches
 * by accident. */
function isWorkspaceRootManifest(pkg: unknown): boolean {
  if (pkg === null || typeof pkg !== "object") return false;
  const record = pkg as Record<string, unknown>;
  if (record.name === ROOT_MARKER_NAME) return true;
  // A top-level `revkit` key of ANY value counts — the key's presence is
  // the opt-in. `false`/`null` do not count (an author who assigns
  // either meant "no", and a silent yes would be surprising).
  if (ROOT_MARKER_KEY in record) {
    const value = record[ROOT_MARKER_KEY];
    return value !== false && value !== null;
  }
  return false;
}

/** Walk up from `startDir` looking for a `package.json` whose contents
 * mark it as a revkit workspace root. Returns the absolute directory.
 * Throws with a message that names the start dir so the caller can tell
 * why the walk gave up. */
export function findRepoRootByPackageJson(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    const pkgPath = resolve(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (isWorkspaceRootManifest(parsed)) {
          return current;
        }
      } catch {
        // Malformed package.json: skip and keep walking; the next level
        // may still be a valid root.
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `revkit check: could not find the workspace root (package.json with name "${ROOT_MARKER_NAME}" or a top-level "${ROOT_MARKER_KEY}" key) walking up from ${startDir}.`,
      );
    }
    current = parent;
  }
}
