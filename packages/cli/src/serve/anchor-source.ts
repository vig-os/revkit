// Anchor-source containment + revision computation.
//
// Two paths call these helpers:
//
//   1. `POST /api/threads` in `daemon.ts` — the server-side anchor
//      authority overrides any client-supplied `revision` with
//      `revisionOf(source)` and refuses an anchor whose path is not
//      a file under the repo root (PR #38 review).
//   2. `reanchor-daemon.ts` (M2 item 5b) — the re-anchor service
//      reads the same source when a rebuild fires so the pipeline
//      classifies the anchor against the actual file bytes.
//
// One containment helper (`resolveWithinRoot` from
// `confined-path.ts`) is the ONLY path shape the daemon accepts.
// This file layers a size cap, a directory refusal, and a uniform
// rejection message so the two callers agree on a single behaviour.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { resolveWithinRoot } from "./confined-path.ts";

/** Cap on a source file the daemon will read to compute a revision.
 * 5 MiB is comfortable for even the largest reasonable document; a
 * file over the cap gets the same generic "anchor.path is not a
 * valid anchor target" refusal so the daemon does not become an
 * oracle for which oversized files exist in the repo. (PR #38
 * round-2 review; re-exported here so the re-anchor service names
 * the same constant.) */
export const ANCHOR_SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/** Public alias for callers that talk about "re-anchor" rather than
 * "anchor". Same constant. */
export const REANCHOR_SOURCE_MAX_BYTES = ANCHOR_SOURCE_MAX_BYTES;

/** The single rejection string every failure mode returns — a
 * caller cannot distinguish "missing", "over cap", "symlink escape"
 * or "not a file" from the response body. (PR #38 round-2 review.) */
export const UNIFORM_ANCHOR_REJECTION =
  "anchor.path is not a valid anchor target in the repository";

/** Resolve an anchor's `path` under the repo root, confirm the file
 * exists, and return `revisionOf(sourceContents)` plus the
 * LF-normalised source. See `daemon.ts`'s `resolveAnchorSource`
 * (kept as a re-export for the existing test files that import it
 * from that module). */
export async function resolveAnchorSource(
  anchor: Pick<Anchor, "path">,
  repoRoot: string,
): Promise<
  | { ok: true; revision: string; source: string }
  | { ok: false; reason: string }
> {
  return resolveSourceUnderRoot(anchor.path, repoRoot);
}

/** Same as `resolveAnchorSource` but keyed on a repo-relative path
 * (not a whole anchor). The re-anchoring service iterates paths on
 * a rebuild, so it does not have an anchor object handy. The
 * returned `source` is the LF-normalised string the revision was
 * computed over, so the caller can persist it as a content-
 * addressed snapshot without a second normalisation pass. */
export async function resolveSourceUnderRoot(
  path: string,
  repoRoot: string,
): Promise<
  | { ok: true; revision: string; source: string }
  | { ok: false; reason: string }
> {
  const rootReal = realpathSync(resolvePath(repoRoot));
  const resolved = resolveWithinRoot(rootReal, "/" + path);
  if (!resolved.ok) return { ok: false, reason: UNIFORM_ANCHOR_REJECTION };
  let stat;
  try {
    stat = statSync(resolved.absolutePath);
  } catch {
    return { ok: false, reason: UNIFORM_ANCHOR_REJECTION };
  }
  if (!stat.isFile()) return { ok: false, reason: UNIFORM_ANCHOR_REJECTION };
  if (stat.size > ANCHOR_SOURCE_MAX_BYTES) {
    return { ok: false, reason: UNIFORM_ANCHOR_REJECTION };
  }
  let contents: string;
  try {
    contents = readFileSync(resolved.absolutePath, "utf8");
  } catch {
    return { ok: false, reason: UNIFORM_ANCHOR_REJECTION };
  }
  // Match `revisionOf`'s normalisation so the returned `source` is
  // the exact string the hash was computed over.
  const normalised = contents.replace(/\r\n?/g, "\n");
  const revision = await revisionOf(normalised);
  return { ok: true, revision, source: normalised };
}
