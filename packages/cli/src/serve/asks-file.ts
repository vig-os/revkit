// Per-ask JSON files under `.revkit/asks/<id>.json` (ADR-0007
// acceptance: "Ask/answer history stays local (`.revkit/asks/`,
// gitignored)"). The daemon writes one file per `ask.created` — the
// same Zod-validated spec that landed on the event log — so a tool
// outside the daemon (`revkit ask --keep`, an operator archiving
// history) can read the questions off disk without replaying the
// event log.
//
// **File shape.** Exactly `AskFile` (i.e. `Ask`) — spec only. The id
// is the filename; per ADR-0007 the daemon assigns ids and the body
// carries no `id` field.
//
// **Mode.** Files are created mode 0600 and the enclosing `.revkit/`
// mode 0700 (owned by `serve-state.ts::ensureRevkitDir`). Matches the
// discipline already applied to `serve.json` and `threads.sqlite`.
// Atomic write: `open(tmp, wx, 0o600)` → `write` → `fsync` → `chmod`
// → `rename` — the same shape `writeServeState` uses.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { askFileSchema, isValidId, type AskFile } from "@revkit/review-core";

/** Directory under the repo root that carries per-ask files. Kept as
 * a constant so a rename lands in one place. Matches the gitignore
 * entry (`.revkit/`). */
export const ASKS_DIR = ".revkit/asks";

/** Absolute path to `<repoRoot>/.revkit/asks`. */
export function asksDir(repoRoot: string): string {
  return join(repoRoot, ASKS_DIR);
}

/** Absolute path to `<repoRoot>/.revkit/asks/<id>.json`. Refuses an
 * id that fails `isValidId` (defensive — the daemon already gates on
 * `idSchema` before it reaches this file). */
export function askFilePath(repoRoot: string, id: string): string {
  if (!isValidId(id)) {
    throw new Error(`asks-file: refusing invalid id '${id}' — must match idSchema.`);
  }
  return join(asksDir(repoRoot), `${id}.json`);
}

/** Ensure `.revkit/asks/` exists at mode 0700 (matching `.revkit/`).
 * `ensureRevkitDir` in `serve-state.ts` owns the parent's mode; this
 * function owns the child's. Idempotent. */
export function ensureAsksDir(repoRoot: string): string {
  const dir = asksDir(repoRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Symlink chain we cannot chmod; not fatal.
  }
  return dir;
}

/** Write an `AskFile` for `<id>` atomically at mode 0600. Refuses an
 * existing file (asks are one-shot per id — the caller has already
 * routed through `validateNext`, which refuses `duplicate-ask`).
 * Returns the absolute path. */
export function writeAskFile(repoRoot: string, id: string, spec: AskFile): string {
  // Validate through `askFileSchema` before touching disk so the
  // fields the caller saved and the fields the daemon later parses
  // stay in lock-step. `parse` throws on rejection — this is a
  // programming error at this layer, not a user-input path.
  const parsed = askFileSchema.parse(spec);
  ensureAsksDir(repoRoot);
  const final = askFilePath(repoRoot, id);
  // Refuse to clobber an existing spec — asks are one-shot per id
  // (`validateNext` also rejects `duplicate-ask` on the append side,
  // but the file write happens BEFORE the append, so we cannot lean
  // on that here). Race note: this check + the eventual rename is
  // not atomic, but the daemon is single-writer for this path so
  // two concurrent creators of the same id would already race on
  // the sqlite `duplicate-ask` reject.
  if (existsSync(final)) {
    throw new Error(`asks-file: refusing to overwrite existing '${final}' (id '${id}' already has a spec on disk).`);
  }
  const tmp = `${final}.tmp`;
  // Best-effort cleanup of a stale tmp from a previous crash. `wx`
  // below refuses to overwrite an existing tmp.
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore — the `openSync(tmp, "wx")` below will surface a
      // real error the caller can act on.
    }
  }
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const body = `${JSON.stringify(parsed, null, 2)}\n`;
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Belt-and-braces on the umask (matches `writeServeState`).
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // A filesystem that ignores chmod (some FUSE mounts) still lets
    // the write proceed; the create-with-mode above is the main line.
  }
  renameSync(tmp, final);
  return final;
}

/** Read an `AskFile` off disk. Returns undefined when the file is
 * missing; throws on parse / schema error (the disk shape is not
 * user input at this layer, and silently returning undefined would
 * mask a corrupt file). */
export function readAskFile(repoRoot: string, id: string): AskFile | undefined {
  const path = askFilePath(repoRoot, id);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  return askFileSchema.parse(parsed);
}

/** Remove an ask file. Idempotent — a missing file is not an error
 * (a caller re-running cleanup should be safe). */
export function removeAskFile(repoRoot: string, id: string): void {
  const path = askFilePath(repoRoot, id);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Concurrent removal already unlinked it — not an error.
  }
}

/** List every ask id currently on disk (basename without the `.json`
 * extension). Used by tests and by future cleanup jobs. Silently
 * skips filenames whose basename fails `isValidId` — those cannot
 * have been written by this module. */
export function listAskFiles(repoRoot: string): string[] {
  const dir = asksDir(repoRoot);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidId(id)) continue;
    ids.push(id);
  }
  return ids.sort();
}
