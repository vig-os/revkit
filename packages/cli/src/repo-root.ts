// Repo-root resolution. The check needs to know where the workspace root
// is so relative paths in diagnostics stay stable regardless of the
// process cwd, and so path-scoped rules (`site/src/content/**`, `plots/**`)
// resolve against one anchor. `git rev-parse` is preferred; a
// non-git checkout (a Nix-store copy the flake builds during hook
// evaluation) falls back to walking up for the nearest `package.json`
// carrying the workspace root marker.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Marker written in the workspace root's package.json (`"name": "revkit"`,
 * the private workspace root). Kept as a constant so a rename shows up as
 * a compile-time change instead of a silent miss. */
const ROOT_MARKER_NAME = "revkit";

/** Walk up from `startDir` looking for a package.json whose `name`
 * matches ROOT_MARKER_NAME. Returns the absolute directory. Throws with
 * a message that names the start dir so the caller can tell why the walk
 * gave up. */
export function findRepoRootByPackageJson(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    const pkgPath = resolve(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (
          parsed !== null && typeof parsed === "object"
          && (parsed as { name?: unknown }).name === ROOT_MARKER_NAME
        ) {
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
        `revkit check: could not find the workspace root (package.json with name "${ROOT_MARKER_NAME}") walking up from ${startDir}.`,
      );
    }
    current = parent;
  }
}
