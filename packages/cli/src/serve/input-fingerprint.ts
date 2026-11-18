// Build-input fingerprint for `.revkit/start-failed.json` (#251 B2).
//
// A "start-failed" record suppresses MCP auto-respawn only while the
// consumer's inputs are unchanged. The fingerprint is a cheap,
// deterministic hash over the files that drive a cold-start build:
//
//   - `docs/` tree (every regular file — the source Astro renders).
//   - `vocab/` tree (if present — controlled vocabulary).
//   - `plots/` tree (if present — plot specs + data side files).
//   - `package.json` at the consumer root (version pins / scripts).
//
// For each file we include its repo-relative POSIX path, its size,
// and its mtime in integer milliseconds. We DO NOT hash the
// contents: the fingerprint only needs to detect "the user changed
// something", not prove authenticity, and walking every byte of a
// large docs tree on every MCP tool call is too expensive for what
// is effectively a cache-key. A size+mtime pair is the same shape
// bundlers use for a watchable-input hash and is cheap enough to
// run on every `ensureDaemon`.
//
// The hash is SHA-256, hex-encoded. It collides (as every finite
// hash does) only with probabilistically-impossible content, and it
// is stable across platforms because we normalise to forward slashes
// and to millisecond integers.
//
// Symlinks under these trees are NOT followed: `revkit check`
// refuses them, so a build can never run with them present. We
// `lstat` and treat an unexpected non-regular entry as a stable
// token in the hash — if `revkit check` would refuse the build,
// the fingerprint still changes when the user replaces it with a
// real file.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative as relativePath } from "node:path";

/** The input trees scanned, in order. Exported so the CHANGELOG /
 * SKILL.md wording can name exactly what the fingerprint covers
 * (bullet 3 of the #251 round-3 brief). */
export const FINGERPRINT_INPUT_ROOTS: readonly string[] = Object.freeze([
  "docs",
  "vocab",
  "plots",
]);

/** The config files mixed into the hash besides the input trees. */
export const FINGERPRINT_CONFIG_FILES: readonly string[] = Object.freeze([
  "package.json",
]);

/** Compute a deterministic hash over the build inputs under
 * `repoRoot`. Returns a lowercase hex SHA-256 digest. Missing input
 * trees and missing config files are represented by a stable
 * `"absent"` token — a tree that appears later changes the digest.
 *
 * The fingerprint is `undefined` only when `repoRoot` itself is
 * absent or unreadable; in that case the caller should treat the
 * suppression record as stale (we cannot prove the inputs match
 * what failed, so clear and proceed). */
export function computeInputFingerprint(repoRoot: string): string | undefined {
  if (!existsSync(repoRoot)) return undefined;
  const hash = createHash("sha256");
  for (const root of FINGERPRINT_INPUT_ROOTS) {
    const dir = join(repoRoot, root);
    hash.update(`${root}\x00`);
    if (!existsSync(dir)) {
      hash.update("absent\x00");
      continue;
    }
    const entries = walkTree(dir, repoRoot);
    hash.update(`present:${entries.length}\x00`);
    for (const line of entries) hash.update(`${line}\n`);
  }
  for (const name of FINGERPRINT_CONFIG_FILES) {
    const path = join(repoRoot, name);
    hash.update(`config:${name}\x00`);
    try {
      const st = statSync(path);
      if (st.isFile()) {
        hash.update(`file\x00${st.size}\x00${Math.floor(st.mtimeMs)}\x00`);
        continue;
      }
    } catch {
      // Falls through to the absent branch.
    }
    hash.update("absent\x00");
  }
  return hash.digest("hex");
}

/** Walk `root` (rooted at `repoRoot` for relative-path reporting)
 * and return a sorted array of `kind\0relpath\0size\0mtimeMs`
 * strings. The caller mixes them into the SHA-256 digest in order. */
function walkTree(root: string, repoRoot: string): string[] {
  const lines: string[] = [];
  walk(root, root, repoRoot, lines);
  lines.sort();
  return lines;
}

function walk(root: string, cur: string, repoRoot: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(cur);
  } catch {
    // The tree disappeared mid-scan; record the dir as empty and
    // move on. The fingerprint still changes when the files
    // re-appear.
    out.push(`dir-unreadable\x00${toRel(cur, repoRoot)}`);
    return;
  }
  for (const name of entries) {
    const full = join(cur, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      out.push(`stat-failed\x00${toRel(full, repoRoot)}`);
      continue;
    }
    const rel = toRel(full, repoRoot);
    if (st.isDirectory()) {
      walk(root, full, repoRoot, out);
    } else if (st.isFile()) {
      out.push(`file\x00${rel}\x00${st.size}\x00${Math.floor(st.mtimeMs)}`);
    } else if (st.isSymbolicLink()) {
      // `revkit check` refuses symlinks under docs/; still account
      // for one so swapping it for a real file changes the digest.
      out.push(`symlink\x00${rel}`);
    } else {
      out.push(`other\x00${rel}`);
    }
  }
}

function toRel(full: string, repoRoot: string): string {
  const rel = relativePath(repoRoot, full);
  // Normalise to forward slashes so Linux / macOS agree on the hash.
  return rel.split(/[/\\]+/).join("/");
}
