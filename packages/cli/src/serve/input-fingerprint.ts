// Build-input fingerprint for `.revkit/start-failed.json` (#251).
//
// A "start-failed" record suppresses MCP auto-respawn only while the
// consumer's inputs are unchanged. The fingerprint is a cheap,
// deterministic hash over the files that drive a cold-start build:
//
//   - The repo-root file list from
//     `git ls-files -z -co --exclude-standard -- :(exclude).revkit`
//     (tracked + untracked-not-ignored, with `.revkit/` excluded)
//     when the directory is a git working tree. NUL-terminated
//     output is split on NUL and paths are NEVER trimmed, so a
//     non-ASCII name (`docs/über.mdx`) survives verbatim and names
//     with leading or trailing spaces are covered too (#251 round 5
//     BLOCKER 1).
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
// **Fail-closed on a git listing error (#251 round 5 (a)).** We pass
// a generous `maxBuffer` so a very large repo listing is not truncated.
// If `git ls-files` still fails (OOM, permission issue, a corrupt
// index), we DO NOT silently fall back to the filesystem walk — the
// walk ignores `.gitignore`, so the hash would then include generated
// output and flap on every retry. Instead we return `undefined`,
// which the caller treats as "clear and proceed" (clears any stale
// start-failed record and lets ensureDaemon respawn). The fallback
// walk runs only when `.git/` is absent (no `.gitignore` to honour).
//
// **`.revkit/` exclusion (#251 round 5 BLOCKER 2).** Both paths skip
// `.revkit/` — the git branch via a pathspec, the fallback via
// `FINGERPRINT_WALK_SKIP`. The daemon writes `.revkit/start-failed.json`
// and `.revkit/serve.json` DURING the failure path; including those
// in the fingerprint would guarantee the hash flipped every time the
// daemon wrote a record, so ensureDaemon would see a mismatch and
// respawn even without a user edit.
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
 * Returns `undefined` when `repoRoot` is absent, OR when a git
 * working tree is present but `git ls-files` failed (fail-closed per
 * the module header, round 5 (a)). The caller treats an undefined
 * current fingerprint as a mismatch, so a stale suppression record
 * is cleared and ensureDaemon respawns — better than silently
 * hashing a non-gitignore-aware walk that would flap on generated
 * output. */
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
  // sorted lexically so the mix order is reproducible. The git
  // branch fails CLOSED (returns undefined from this function) on
  // a listing error; see the module header.
  const listing = listRepoFiles(repoRoot);
  if (listing === undefined) return undefined;
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

/** `execFileSync` maxBuffer for the git listing. Node's default is
 * 1 MiB — a large consumer repo's listing can exceed that with a
 * truncated-stdout `ENOBUFS`, which would then fail-close the
 * fingerprint on every call (round 5 (a)). 256 MiB is enough for
 * every repo we expect to see here (tens of millions of paths) and
 * still bounded so a runaway git never consumes unbounded memory. */
const GIT_LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

/** List every file under `repoRoot` that the fingerprint cares
 * about. Prefers `git ls-files -z -co --exclude-standard` (tracked +
 * untracked-not-ignored) so a repo's own `.gitignore` is respected,
 * with a `:(exclude).revkit` pathspec so the daemon's own state
 * directory never contributes to the hash (#251 round 5 BLOCKER 2).
 * `-z` turns off path quoting (`\303\274…`) and NUL-terminates each
 * entry — we split on NUL and NEVER trim, so a name like
 * `docs/über.mdx` or a path with trailing whitespace survives intact
 * (#251 round 5 BLOCKER 1).
 *
 * Returns `undefined` when a `.git/` exists but `git ls-files`
 * failed (fail-closed, round 5 (a)). Falls back to a filesystem walk
 * ONLY when no `.git/` is present — the walk skips the directories
 * named in `FINGERPRINT_WALK_SKIP` but does not read `.gitignore`,
 * so it is unsafe in a git working tree that has generated output
 * tracked but ignored.
 *
 * The returned paths are repo-relative, normalised to forward
 * slashes, and sorted so the hash order is stable. */
function listRepoFiles(repoRoot: string): RepoFileListing | undefined {
  const gitDir = join(repoRoot, ".git");
  if (existsSync(gitDir)) {
    try {
      const raw = execFileSync(
        "git",
        [
          "-C",
          repoRoot,
          "ls-files",
          "-z",
          "-co",
          "--exclude-standard",
          "--",
          ":(exclude).revkit",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: GIT_LS_FILES_MAX_BUFFER,
        },
      );
      // NUL-terminated output: split on \0, drop the empty trailing
      // element after the last NUL, and do NOT trim — a leading or
      // trailing whitespace character IS part of the filename.
      const files = raw
        .split("\0")
        .filter((entry) => entry.length > 0)
        // Git emits POSIX-style forward slashes; still normalise
        // defensively in case a hostile line sneaks a backslash in.
        .map((entry) => entry.split(/[/\\]+/).join("/"));
      files.sort();
      return { source: "git", files };
    } catch {
      // Fail CLOSED — see the module header on why we do NOT fall
      // back to the non-gitignore-aware walk here.
      return undefined;
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
