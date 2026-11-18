// Build-input fingerprint for `.revkit/start-failed.json` (#251).
//
// A "start-failed" record suppresses MCP auto-respawn only while the
// consumer's inputs are unchanged. The fingerprint is a cheap,
// deterministic hash over the files that drive a cold-start build:
//
//   - The repo-root file list from `git ls-files -co
//     --exclude-standard` (tracked + untracked-not-ignored) when the
//     directory is a git working tree.
//   - A fallback walk of the tree otherwise, skipping `.revkit/`,
//     `node_modules/`, `.git/` and common dist/cache dirs at every
//     level.
//   - For each listed file: the repo-relative POSIX path, the file
//     size and the mtime in integer milliseconds.
//   - A small set of "always-mixed" config files whose change must
//     flip the hash even if they are gitignored (`FINGERPRINT_
//     CONFIG_FILES`, defaults to `package.json`).
//   - revkit's own CLI version, so an upgrade of revkit invalidates
//     every record written by a prior version (#251 round 4 test 4).
//
// The hash is SHA-256, hex-encoded; the mix order is stable across
// platforms because we normalise paths to forward slashes and mtimes
// to integer milliseconds.
//
// **Known limit.** A same-size, same-mtime edit of an existing file
// is NOT detected by this fingerprint. We DO NOT hash file contents:
// walking every byte of a large consumer tree on every MCP
// `ensureDaemon` call is too expensive for what is effectively a
// cache-key. If an edit manages to preserve both size and mtime
// (`touch -r a b` style surgery, or a byte-identical overwrite
// restored to its prior mtime), the record stays active and MCP
// keeps suppressing. The manual escape is `rm
// .revkit/start-failed.json`, or running `revkit serve` or `revkit
// build` directly — both clear the record on success and are
// documented in SKILL.md.
//
// Symlinks under the walk are NOT followed: `revkit check` refuses
// them under content dirs. We `lstat` and record a stable
// `symlink`/`other` token so swapping one for a real file still
// flips the hash.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { VERSION } from "../version.ts";

/** Directory names skipped by the non-git fallback walk at EVERY
 * level. The git-listing path doesn't need them — `git ls-files -co
 * --exclude-standard` already respects `.gitignore` — but the
 * fallback walk hits them in a non-git consumer scaffold. Exported
 * so a sibling test can assert that growing this list is a
 * deliberate decision. */
export const FINGERPRINT_WALK_SKIP: readonly string[] = Object.freeze([
  ".revkit",
  "node_modules",
  ".git",
  "dist",
  ".astro",
  ".vite",
]);

/** Config files always mixed into the digest, even if they are
 * gitignored or absent from the listing. Belt-and-braces: for the
 * normal case `git ls-files -co` already includes `package.json`,
 * so these bytes duplicate — the duplication is intentional so a
 * weird `.gitignore` can never silence a `package.json` change. */
export const FINGERPRINT_CONFIG_FILES: readonly string[] = Object.freeze([
  "package.json",
]);

/** Legacy export name retained so a `FINGERPRINT_INPUT_ROOTS`
 * reference in the CHANGELOG / SKILL documentation parses. The
 * current fingerprint covers the whole repo-root listing, not just
 * these dirs, but changes under any of them still flip the hash. */
export const FINGERPRINT_INPUT_ROOTS: readonly string[] = Object.freeze([
  "docs",
  "vocab",
  "plots",
]);

/** Options for `computeInputFingerprint`. `version` is exposed so
 * tests can prove that an upgrade of revkit flips the hash
 * (#251 round 4 test 4); production callers leave it at the
 * default. */
export interface ComputeInputFingerprintOptions {
  readonly version?: string;
}

/** Compute a deterministic hash over the consumer's build inputs
 * under `repoRoot`. Returns a lowercase hex SHA-256 digest.
 *
 * Returns `undefined` only when `repoRoot` itself is absent or
 * unreadable; in that case the caller treats the suppression record
 * as stale (we cannot prove the inputs still match what failed, so
 * prefer "clear and proceed" over "block forever"). */
export function computeInputFingerprint(
  repoRoot: string,
  options: ComputeInputFingerprintOptions = {},
): string | undefined {
  if (!existsSync(repoRoot)) return undefined;
  const version = options.version ?? VERSION;
  const hash = createHash("sha256");
  // revkit's own version first so an upgrade of the CLI invalidates
  // every previously-written record.
  hash.update(`revkit-version:${version}\x00`);

  // The authoritative file list — git when available, a fallback
  // walk otherwise. Both return repo-relative forward-slash paths,
  // sorted lexically so the mix order is reproducible.
  const listing = listRepoFiles(repoRoot);
  hash.update(`listing-source:${listing.source}\x00`);
  hash.update(`file-count:${listing.files.length}\x00`);
  for (const rel of listing.files) {
    const full = join(repoRoot, rel);
    hash.update(`path:${rel}\x00`);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      hash.update("stat-failed\x00");
      continue;
    }
    if (st.isFile()) {
      hash.update(`file\x00${st.size}\x00${Math.floor(st.mtimeMs)}\x00`);
    } else if (st.isSymbolicLink()) {
      // A symlink under a content tree is refused by `revkit check`
      // on the build path; include a stable token so swapping it
      // for a real file still flips the hash.
      hash.update("symlink\x00");
    } else if (st.isDirectory()) {
      // A directory name present in the git listing is unusual
      // (git tracks files, not dirs) but tolerate it with a token.
      hash.update("dir\x00");
    } else {
      hash.update("other\x00");
    }
  }

  // Always-mixed config files. For the normal case git ls-files -co
  // already lists `package.json`, so this is defense-in-depth
  // against a weird `.gitignore` that hides it from the listing.
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
      // Falls through to the absent branch below.
    }
    hash.update("absent\x00");
  }

  return hash.digest("hex");
}

interface RepoFileListing {
  readonly source: "git" | "walk";
  readonly files: readonly string[];
}

/** List every file under `repoRoot` that the fingerprint cares
 * about. Prefers `git ls-files -co --exclude-standard` (tracked +
 * untracked-not-ignored) so a repo's own `.gitignore` is respected;
 * falls back to a filesystem walk that skips the directories named
 * in `FINGERPRINT_WALK_SKIP`.
 *
 * The returned paths are repo-relative, normalised to forward
 * slashes, and sorted so the hash order is stable. */
function listRepoFiles(repoRoot: string): RepoFileListing {
  const gitDir = join(repoRoot, ".git");
  if (existsSync(gitDir)) {
    try {
      const raw = execFileSync(
        "git",
        ["-C", repoRoot, "ls-files", "-co", "--exclude-standard"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const files = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // Git emits POSIX-style forward slashes; still normalise
        // defensively in case a hostile line sneaks a backslash in.
        .map((line) => line.split(/[/\\]+/).join("/"));
      files.sort();
      return { source: "git", files };
    } catch {
      // Fall through to the walk fallback.
    }
  }
  const out: string[] = [];
  walkTree(repoRoot, repoRoot, out);
  out.sort();
  return { source: "walk", files: out };
}

function walkTree(root: string, cur: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(cur);
  } catch {
    return;
  }
  for (const name of entries) {
    // Apply the skip list at EVERY level — a nested `node_modules`
    // or a build output under a subdir still needs to be skipped.
    if (FINGERPRINT_WALK_SKIP.includes(name)) continue;
    const full = join(cur, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTree(root, full, out);
      continue;
    }
    if (st.isFile() || st.isSymbolicLink()) {
      out.push(toRel(full, root));
    }
  }
}

function toRel(full: string, repoRoot: string): string {
  const rel = relativePath(repoRoot, full);
  // Normalise to forward slashes so Linux / macOS agree on the hash.
  return rel.split(/[/\\]+/).join("/");
}
