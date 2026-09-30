// Materialize a safe worktree under `.revkit/review/<pr>-<sha>/`:
// TOOLING files come from the reviewer's TRUSTED base commit, CONTENT
// files come from the PR head (ADR-0025).
//
// **This code path never invokes `git checkout` or `git worktree`**
// — those honour `.gitattributes` filter/smudge drivers, which are
// arbitrary command execution. Instead, we walk each tree with
// `git ls-tree -r -z` and read blobs with `git cat-file blob`. Smudge
// filters never run because we never ask git to write to the working
// tree.
//
// **Rules the materializer enforces** (each blocks a concrete attack):
//
//   1. **Symlinks in the tree.** A blob with mode `120000` is a
//      symlink. The blob's content is the symlink target. We refuse:
//        - an absolute target such as /etc/passwd,
//        - any target whose lexical resolution escapes the worktree
//          root (../../etc/passwd),
//        - any target containing NUL or a control character.
//      The materializer never CREATES a symlink; it writes the file
//      as a regular text file with the target string as its content.
//      That's still refused when the target escapes — a symlink even
//      as data is a bad signal — so the whole materialize aborts.
//
//   2. **Modes.** Only regular files (`100644`, `100755`) are
//      materialized. Gitlinks (`160000`, submodules) and other modes
//      are refused. On disk, files land at mode 0600 (owner-only) —
//      the daemon serves them read-only and never chmods.
//
//   3. **Path shape.** Paths from `git ls-tree` are already POSIX.
//      A path containing `\0`, starting with `/`, containing `..` as
//      a segment, or containing a backslash is refused before it
//      touches the filesystem.
//
//   4. **Path length.** A per-path cap (4096 bytes) so a pathological
//      long path from a hostile PR cannot balloon the writer's
//      buffers. Well above any real repo.
//
//   5. **Total size cap.** The total bytes written across all files
//      is capped at 512 MiB. Beyond that the materialize aborts.
//
// The materializer's output is a directory the daemon and the build
// step can trust as-if it were a local checkout, without any of the
// PR-controlled tooling files.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { GitRunner } from "../git-runner.ts";
import { classifyPath } from "./content-allowlist.ts";
import { runSafeGit, runSafeGitOrThrow, SafeGitError } from "./git-safe.ts";

/** One entry in a git tree, as parsed from `git ls-tree -r -z`. */
export interface TreeEntry {
  readonly mode: string;
  readonly kind: "blob" | "tree" | "commit";
  readonly oid: string;
  readonly path: string;
}

/** The outcome of a materialize call. `bytesWritten` is the sum of
 * blob sizes; the caller can log it. `contentPaths` is the paths
 * that came from the PR head (the caller uses this for `revkit
 * check`). `toolingPaths` is the paths that came from base. */
export interface MaterializeOutcome {
  readonly targetDir: string;
  readonly bytesWritten: number;
  readonly contentPaths: readonly string[];
  readonly toolingPaths: readonly string[];
}

/** Options for `materializeSafeTree`. */
export interface MaterializeOptions {
  /** git runner (the injectable `GitRunner`). */
  readonly runner: GitRunner;
  /** cwd for git commands — the reviewer's repo checkout. */
  readonly cwd: string;
  /** base commit SHA (the trusted toolchain source). */
  readonly baseSha: string;
  /** head commit SHA (the PR content source). */
  readonly headSha: string;
  /** absolute target directory the materialize writes to. Must NOT
   * already exist. */
  readonly targetDir: string;
  /** Optional per-path total-size cap in bytes. Defaults to 512 MiB. */
  readonly totalBytesCap?: number;
  /** Optional per-path length cap. Defaults to 4096. */
  readonly pathBytesCap?: number;
  /** Optional per-blob size cap in bytes. Defaults to 16 MiB —
   * comfortably above any legitimate MDX / JSON / image content
   * revkit tracks, well under a memory-eating unit. Refused blobs
   * abort the materialize (PR #48 round-2 nit on DoS). */
  readonly blobBytesCap?: number;
}

/** Reason a materialize refused. Callers switch on the discriminant
 * to render a specific diagnostic. */
export type MaterializeRefusal =
  | { readonly kind: "symlink-escape"; readonly path: string; readonly target: string }
  | { readonly kind: "unsupported-mode"; readonly path: string; readonly mode: string }
  | { readonly kind: "invalid-path"; readonly path: string; readonly reason: string }
  | { readonly kind: "path-too-long"; readonly path: string; readonly bytes: number; readonly cap: number }
  | { readonly kind: "blob-too-large"; readonly path: string; readonly bytes: number; readonly cap: number }
  | { readonly kind: "total-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "target-exists"; readonly path: string }
  | { readonly kind: "git-error"; readonly message: string };

/** Thrown by `materializeSafeTree` on refusal. Carries the typed
 * reason. */
export class MaterializeError extends Error {
  readonly refusal: MaterializeRefusal;
  constructor(refusal: MaterializeRefusal) {
    super(formatRefusal(refusal));
    this.name = "MaterializeError";
    this.refusal = refusal;
  }
}

/** Render a refusal as a human-readable line. */
export function formatRefusal(refusal: MaterializeRefusal): string {
  switch (refusal.kind) {
    case "symlink-escape":
      return `revkit review: refusing symlink '${refusal.path}' whose target '${refusal.target}' escapes the content root`;
    case "unsupported-mode":
      return `revkit review: refusing unsupported tree mode '${refusal.mode}' at '${refusal.path}' (submodule / gitlink / other)`;
    case "invalid-path":
      return `revkit review: refusing invalid path '${refusal.path}': ${refusal.reason}`;
    case "path-too-long":
      return `revkit review: refusing path '${refusal.path}' (${refusal.bytes} bytes > cap ${refusal.cap})`;
    case "blob-too-large":
      return `revkit review: refusing blob at '${refusal.path}' (${refusal.bytes} bytes > cap ${refusal.cap})`;
    case "total-too-large":
      return `revkit review: PR head materialize exceeds total-size cap (${refusal.bytes} > ${refusal.cap})`;
    case "target-exists":
      return `revkit review: target directory '${refusal.path}' already exists — refusing to overwrite`;
    case "git-error":
      return `revkit review: git error while materializing: ${refusal.message}`;
  }
}

const DEFAULT_TOTAL_BYTES_CAP = 512 * 1024 * 1024;
const DEFAULT_PATH_BYTES_CAP = 4096;
const DEFAULT_BLOB_BYTES_CAP = 16 * 1024 * 1024;

/**
 * Enumerate a commit's tree. Uses `git ls-tree -r -z` so paths with
 * NUL/newline are handled and every path lands as its own record.
 * Refuses immediately on any malformed record.
 */
export async function listTree(
  runner: GitRunner,
  cwd: string,
  commitSha: string,
): Promise<TreeEntry[]> {
  const stdout = await runSafeGitOrThrow(
    runner,
    cwd,
    ["ls-tree", "-r", "-z", commitSha],
    `listTree: git ls-tree ${commitSha} failed`,
  );
  const entries: TreeEntry[] = [];
  // Each record is `<mode> <kind> <oid>\t<path>\0`.
  const records = stdout.split("\0");
  for (const record of records) {
    if (record.length === 0) continue;
    const tabIdx = record.indexOf("\t");
    if (tabIdx === -1) {
      throw new MaterializeError({ kind: "git-error", message: `malformed ls-tree record (no TAB): ${record}` });
    }
    const meta = record.slice(0, tabIdx);
    const path = record.slice(tabIdx + 1);
    const parts = meta.split(" ");
    if (parts.length !== 3) {
      throw new MaterializeError({ kind: "git-error", message: `malformed ls-tree meta: '${meta}'` });
    }
    const mode = parts[0] ?? "";
    const kindStr = parts[1] ?? "";
    const oid = parts[2] ?? "";
    if (kindStr !== "blob" && kindStr !== "tree" && kindStr !== "commit") {
      throw new MaterializeError({ kind: "git-error", message: `unknown ls-tree kind: ${kindStr}` });
    }
    entries.push({ mode, kind: kindStr, oid, path });
  }
  return entries;
}

/**
 * Read a git blob as bytes, going through the hardened wrapper
 * (PR #48 round-2 nit: `readBlob` must not bypass the safe-git
 * config).
 *
 * Two-phase (PR #48 round-2 nit on DoS):
 *   1. `cat-file -s <oid>` returns the blob's declared size — cheap,
 *      no bytes copied. If it exceeds `maxBlobBytes`, refuse without
 *      reading the payload.
 *   2. `cat-file blob <oid>` reads the payload; still capped at
 *      `maxBlobBytes` on the returned buffer as a belt-and-braces
 *      check against a hostile server / cache that lies about size.
 *
 * A single call per blob keeps the interface simple. revkit's
 * content-plus-tooling paths are small (hundreds), so per-call
 * spawn overhead is fine.
 */
export async function readBlob(
  runner: GitRunner,
  cwd: string,
  oid: string,
  maxBlobBytes: number,
): Promise<Buffer> {
  // Phase 1: cheap size check via `cat-file -s`. Never reads the
  // payload, so a 200 MiB blob does not eat a memory buffer just to
  // learn it is over the cap.
  const sizeResult = await runSafeGit(runner, cwd, ["cat-file", "-s", oid]);
  if (sizeResult.exitCode !== 0) {
    throw new SafeGitError(
      `readBlob: git cat-file -s ${oid} failed: ${sizeResult.stderr.trim()}`,
      sizeResult.exitCode,
      sizeResult.stderr,
    );
  }
  const declaredSize = Number.parseInt(sizeResult.stdout.trim(), 10);
  if (!Number.isFinite(declaredSize) || declaredSize < 0) {
    throw new SafeGitError(
      `readBlob: git cat-file -s ${oid} returned invalid size: ${JSON.stringify(sizeResult.stdout)}`,
      0,
      "",
    );
  }
  if (declaredSize > maxBlobBytes) {
    throw new BlobTooLargeError(oid, declaredSize, maxBlobBytes);
  }
  // Phase 2: read the payload. Our GitRunner returns stdout as a
  // string — we treat it as latin1-encoded bytes so every byte
  // round-trips (unlike utf8, which would replace invalid
  // sequences). Buffer.from(str, 'latin1') has the same length as
  // str.length for latin1 strings, so a large PNG round-trips
  // byte-for-byte.
  const result = await runSafeGit(runner, cwd, ["cat-file", "blob", oid]);
  if (result.exitCode !== 0) {
    throw new SafeGitError(
      `readBlob: git cat-file blob ${oid} failed: ${result.stderr.trim()}`,
      result.exitCode,
      result.stderr,
    );
  }
  const buf = Buffer.from(result.stdout, "latin1");
  if (buf.length > maxBlobBytes) {
    throw new BlobTooLargeError(oid, buf.length, maxBlobBytes);
  }
  return buf;
}

/** Thrown when a git blob exceeds the per-blob size cap. Carries the
 * declared size and cap so callers can surface a specific
 * diagnostic. */
export class BlobTooLargeError extends Error {
  readonly oid: string;
  readonly size: number;
  readonly cap: number;
  constructor(oid: string, size: number, cap: number) {
    super(`readBlob: blob ${oid} declared size ${size} exceeds cap ${cap}`);
    this.name = "BlobTooLargeError";
    this.oid = oid;
    this.size = size;
    this.cap = cap;
  }
}

/**
 * Validate a repo-relative POSIX path. Refuses NUL, absolute paths,
 * `..` segments, backslashes, control characters. Returns `undefined`
 * on success, a `reason` string on rejection.
 */
export function validatePath(path: string): string | undefined {
  if (path.length === 0) return "empty path";
  if (path.includes("\0")) return "NUL byte in path";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "..") return "'..' segment in path";
    if (segment === "") return "empty segment (consecutive slashes)";
  }
  // Refuse control characters — a hostile path could carry a
  // \n / \r to break log parsers.
  for (let i = 0; i < path.length; i++) {
    const cc = path.charCodeAt(i);
    if (cc < 0x20 || cc === 0x7f) return "control character in path";
  }
  return undefined;
}

/**
 * Validate a symlink target string (the blob content of a symlink
 * entry). Refuses NUL, control characters, and any target that
 * escapes when lexically joined onto its containing directory.
 * Returns `undefined` on success, a reason on rejection.
 *
 * The check is lexical: we resolve `path/../target` against a
 * synthetic root and reject anything that leaves that root. That's
 * exactly the check a real filesystem would apply against the
 * materialized worktree, without ever touching disk.
 */
export function validateSymlinkTarget(sourcePath: string, target: string): string | undefined {
  if (target.length === 0) return "empty target";
  if (target.includes("\0")) return "NUL byte in target";
  for (let i = 0; i < target.length; i++) {
    const cc = target.charCodeAt(i);
    if (cc < 0x20 || cc === 0x7f) return "control character in target";
  }
  if (target.startsWith("/")) return "absolute target";
  // Refuse `~` — a common attack shape and never a valid checked-in
  // symlink.
  if (target.startsWith("~")) return "target starts with '~'";
  // Lexically resolve `<sourceDir>/<target>` against a synthetic
  // root. If it escapes, refuse.
  const sourceDir = dirname(sourcePath);
  // We prepend a synthetic root marker; if the resolved path does
  // NOT start with that marker, the target escaped.
  const ROOT = "/__revkit_root__";
  const joined = resolvePath(ROOT, sourceDir, target);
  if (joined !== ROOT && !joined.startsWith(`${ROOT}/`)) {
    return `escapes the content root (resolves to ${joined})`;
  }
  return undefined;
}

/**
 * Materialize the safe worktree: TOOLING files from base, CONTENT
 * files from PR head. See the file-level doc for the rule set.
 *
 * `targetDir` must not exist. The materializer creates it (mode
 * 0700) and populates it. On any refusal, the partial output is
 * left in place — the caller (`review/cli.ts`) removes it and
 * surfaces the reason. The refusal path never runs a build.
 */
export async function materializeSafeTree(
  options: MaterializeOptions,
): Promise<MaterializeOutcome> {
  const totalCap = options.totalBytesCap ?? DEFAULT_TOTAL_BYTES_CAP;
  const pathCap = options.pathBytesCap ?? DEFAULT_PATH_BYTES_CAP;
  const blobCap = options.blobBytesCap ?? DEFAULT_BLOB_BYTES_CAP;

  // Refuse an already-existing target so a stale `.revkit/review/<n>-<sha>/`
  // from a previous run does not mask a new refusal.
  try {
    mkdirSync(options.targetDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new MaterializeError({ kind: "target-exists", path: options.targetDir });
    }
    throw error;
  }

  const [baseTree, headTree] = await Promise.all([
    listTree(options.runner, options.cwd, options.baseSha),
    listTree(options.runner, options.cwd, options.headSha),
  ]);

  // Build the union of paths: for each path, choose the tree
  // (head→content, base→tooling) that authoritatively supplies its
  // bytes.
  const byPathHead = new Map<string, TreeEntry>();
  for (const e of headTree) byPathHead.set(e.path, e);
  const byPathBase = new Map<string, TreeEntry>();
  for (const e of baseTree) byPathBase.set(e.path, e);

  const allPaths = new Set<string>([...byPathHead.keys(), ...byPathBase.keys()]);

  const contentPaths: string[] = [];
  const toolingPaths: string[] = [];
  let totalBytes = 0;

  // Sort paths so materialization is deterministic — helps
  // reproducibility and makes a test's assertion on the written
  // set stable.
  const sortedPaths = [...allPaths].sort();
  for (const path of sortedPaths) {
    // Path shape.
    const invalid = validatePath(path);
    if (invalid !== undefined) {
      throw new MaterializeError({ kind: "invalid-path", path, reason: invalid });
    }
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (pathBytes > pathCap) {
      throw new MaterializeError({ kind: "path-too-long", path, bytes: pathBytes, cap: pathCap });
    }

    const cls = classifyPath(path);
    // Content path missing in PR head → skipped entirely (the PR
    // deleted it). Tooling path missing in base → skipped entirely
    // (the PR added it as tooling; refused by the tooling-diff
    // guard already, but defensive here). Content path present in
    // PR head → take PR head. Tooling path present in base → take
    // base.
    const source = cls === "content" ? byPathHead.get(path) : byPathBase.get(path);
    if (source === undefined) continue;

    // Only regular file / symlink blobs. Submodules (mode 160000,
    // kind commit) are refused.
    if (source.kind !== "blob") {
      throw new MaterializeError({ kind: "unsupported-mode", path, mode: source.mode });
    }
    if (source.mode !== "100644" && source.mode !== "100755" && source.mode !== "120000") {
      throw new MaterializeError({ kind: "unsupported-mode", path, mode: source.mode });
    }

    let bytes: Buffer;
    try {
      bytes = await readBlob(options.runner, options.cwd, source.oid, blobCap);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        throw new MaterializeError({
          kind: "blob-too-large",
          path,
          bytes: err.size,
          cap: err.cap,
        });
      }
      throw err;
    }

    if (source.mode === "120000") {
      // Symlink blob: contents are the target string.
      const target = bytes.toString("utf8");
      const badReason = validateSymlinkTarget(path, target);
      if (badReason !== undefined) {
        throw new MaterializeError({ kind: "symlink-escape", path, target });
      }
      // Even a valid symlink is written as a REGULAR FILE holding
      // the target string. A real symlink on disk would be
      // followed by the astro build; a regular file preserves the
      // path for downstream tools that might inspect it but
      // never resolves outside the tree.
      writeMaterialized(options.targetDir, path, bytes);
    } else {
      writeMaterialized(options.targetDir, path, bytes);
    }

    totalBytes += bytes.length;
    if (totalBytes > totalCap) {
      throw new MaterializeError({ kind: "total-too-large", bytes: totalBytes, cap: totalCap });
    }
    if (cls === "content") contentPaths.push(path);
    else toolingPaths.push(path);
  }

  return { targetDir: options.targetDir, bytesWritten: totalBytes, contentPaths, toolingPaths };
}

/** Write `bytes` to `<target>/<path>` as a mode-0600 regular file. */
function writeMaterialized(target: string, relPath: string, bytes: Buffer): void {
  const abs = join(target, relPath);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  writeFileSync(abs, bytes, { mode: 0o600 });
}
