// Anchor ↔ PR-comment mapping (ADR-0025, M3 part 1).
//
// A review-core `Anchor` is `(path, startLine..endLine, quote,
// revision, commit?)`. GitHub's REST review-comment shape is
// `(path, line, start_line?, side, commit_id, subject_type?)`:
//
//   subject_type: "line" (default)
//     - line: the RIGHT-side new-file line number the comment sits on
//     - start_line?: for a multi-line range, the FIRST new-file line
//     - side: "RIGHT" for a comment on the new file, "LEFT" for the old
//
//   subject_type: "file"
//     - path only; no line number; the comment applies to the whole
//       file. Used when the reviewer wants to leave a note about a
//       block that isn't inside any of the PR's diff hunks.
//
// This module is pure: it takes a parsed patch (from `./patch.ts`) and
// a review-core anchor, and returns a request payload — no network,
// no globals. Both directions live here so the round-trip is easy to
// reason about and to test.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { Anchor } from "./anchor.ts";
import { parsePatch, rangeIsOnRightSide, type Hunk } from "./patch.ts";

/** A file in the PR's file list — the subset the mapper needs. Callers
 * shape a GitHub `pull_request_files` response into this before calling
 * the mapper, so the mapper stays independent of the REST envelope. */
export interface PrFile {
  readonly filename: string;
  /** Only set for a rename; the OLD path. GitHub sends this on a rename
   * even when there's no content change (`status: "renamed"`). */
  readonly previousFilename?: string;
  /** The unified-diff patch fragment. Empty/undefined for binary files
   * and for files GitHub declined to send a patch for (huge diffs). */
  readonly patch?: string;
  readonly status?: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
}

/** The comment-side of a line PR review comment (`subject_type: "line"`). */
export interface PrLineComment {
  readonly subjectType: "line";
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT" | "LEFT";
  readonly startLine?: number;
  readonly startSide?: "RIGHT" | "LEFT";
}

/** The comment-side of a file-level PR review comment
 * (`subject_type: "file"`). `path` only; no line. */
export interface PrFileComment {
  readonly subjectType: "file";
  readonly path: string;
}

export type PrCommentTarget = PrLineComment | PrFileComment;

/** The outcome of mapping an anchor to a PR-comment target. `kind:
 * "line"` and `kind: "file"` are successful mappings; `kind: "reject"`
 * says the anchor cannot be commented on with this PR's diff (e.g.
 * a deleted file we haven't allowed a file-level comment on). */
export type AnchorMapResult =
  | { readonly kind: "line"; readonly target: PrLineComment }
  | { readonly kind: "file"; readonly target: PrFileComment; readonly reason: FileFallbackReason }
  | { readonly kind: "reject"; readonly reason: string };

/** Why an anchor fell back to a file-level comment. Recorded so the
 * caller can print a diagnostic and prepend it to the comment body.
 *
 * `no-patch` covers both binaries and diffs GitHub declined to send
 * (typically too-large): the REST envelope makes no reliable
 * distinction on its own — both come back with the `patch` field
 * absent — so the mapper doesn't invent one. The `PrFile.status`
 * field a caller has in hand may narrow it (`added` + no patch is
 * usually a binary; `modified` + `changes > 0` + no patch is
 * usually truncated), but that inference belongs at the call site.
 *
 * `renamed-file-old-path` fires when the anchor's `path` matches a
 * file's `previousFilename`. The anchor's lines refer to the BASE
 * revision (the old file); mapping them onto the NEW file's RIGHT
 * side would silently place the comment on unrelated content. The
 * safe outcome is a file-level comment on the new path noting the
 * original range. */
export type FileFallbackReason =
  | "no-patch"
  | "range-outside-hunk"
  | "range-crosses-hunk-boundary"
  | "deleted-file"
  | "renamed-file-old-path";

/** Options for `anchorToPrComment`. `allowFileFallback` defaults to
 * `true` (ADR-0025's file-level fallback). Pass `false` when the
 * caller only wants a strict line mapping. */
export interface AnchorMapOptions {
  readonly allowFileFallback?: boolean;
}

/**
 * Map a review-core anchor to a PR-comment target.
 *
 * The mapping rules, in order:
 *   1. Find the file in `files` by `anchor.path` (current name) OR by
 *      `previousFilename === anchor.path` (renames).
 *   2. If the anchor's path matches the OLD name of a renamed file
 *      (i.e. it refers to base-revision lines), fall back to a
 *      file-level comment on the NEW path. Do NOT map old-name
 *      lines onto new-file RIGHT-side lines: the hunk header is a
 *      new-file coordinate, so equal line numbers name unrelated
 *      content (PR-43 blocker 4).
 *   3. If the file is patchless / deleted, fall back to a
 *      file-level comment on the RESOLVED filename.
 *   4. Parse the patch. If every line in `anchor.startLine..endLine`
 *      is on the RIGHT side of some hunk, emit a line comment (with
 *      `startLine` when the range spans more than one line). If the
 *      range extends outside a hunk OR crosses a gap between two
 *      hunks, fall back to a file-level comment — do NOT clamp to
 *      the nearest hunk line (ADR-0025 safety: never map to the
 *      wrong lines).
 */
export function anchorToPrComment(
  anchor: Pick<Anchor, "path" | "startLine" | "endLine">,
  files: readonly PrFile[],
  options: AnchorMapOptions = {},
): AnchorMapResult {
  const allowFileFallback = options.allowFileFallback ?? true;

  const file = findFile(files, anchor.path);
  if (file === undefined) {
    return {
      kind: "reject",
      reason: `anchor path '${anchor.path}' is not in this PR's file list`,
    };
  }
  // The RESOLVED filename is what GitHub sees post-rename. A rename
  // comment must reference the new name, not the old one.
  const resolvedPath = file.filename;

  // BLOCKER 4 (PR-43): anchor made against the OLD name of a renamed
  // file. The anchor's lines describe base-revision content; mapping
  // them onto the new file's RIGHT side would put the comment on
  // whatever happens to sit at those line numbers post-rename —
  // often unrelated. File-level fallback on the NEW path, preamble
  // records the old range on the old path.
  if (file.previousFilename !== undefined && anchor.path === file.previousFilename) {
    if (!allowFileFallback) {
      return {
        kind: "reject",
        reason: `anchor path '${anchor.path}' is the OLD name of renamed file '${resolvedPath}'; ` +
          `old-side lines cannot map to new-file RIGHT-side lines`,
      };
    }
    return {
      kind: "file",
      target: { subjectType: "file", path: resolvedPath },
      reason: "renamed-file-old-path",
    };
  }

  if (file.status === "removed") {
    if (!allowFileFallback) {
      return {
        kind: "reject",
        reason: `file '${resolvedPath}' is deleted in this PR; line comments not addressable`,
      };
    }
    return {
      kind: "file",
      target: { subjectType: "file", path: resolvedPath },
      reason: "deleted-file",
    };
  }

  const patch = file.patch ?? "";
  let hunks: Hunk[] | null;
  try {
    hunks = parsePatch(patch);
  } catch (err) {
    // A malformed patch is surfaced as a rejection rather than a
    // silent file fallback: the caller wants to see this fail, not
    // to quietly downgrade every anchor to file-level.
    return {
      kind: "reject",
      reason: `failed to parse patch for '${resolvedPath}': ${(err as Error).message}`,
    };
  }

  if (hunks === null) {
    if (!allowFileFallback) {
      return {
        kind: "reject",
        reason: `file '${resolvedPath}' has no patch (binary or too large); line comments not addressable`,
      };
    }
    // GitHub's REST envelope makes no reliable distinction between
    // "binary" and "declined patch (huge)" — both come back with
    // `patch` absent. Report one reason for both; the caller may
    // narrow via `PrFile.status`/`.changes` if it has them.
    return {
      kind: "file",
      target: { subjectType: "file", path: resolvedPath },
      reason: "no-patch",
    };
  }

  const inRange = rangeIsOnRightSide(hunks, anchor.startLine, anchor.endLine);
  if (!inRange) {
    if (!allowFileFallback) {
      return {
        kind: "reject",
        reason: `anchor lines ${anchor.startLine}..${anchor.endLine} in '${resolvedPath}' fall outside diff hunks`,
      };
    }
    // Distinguish "entirely outside any hunk" from "crosses a
    // boundary" — the second is the multi-line-crossing case the
    // ADR calls out. Both fall back safely; the reason is a
    // diagnostic for the caller to record in the comment body.
    const reason = anchorSpansHunkBoundary(hunks, anchor.startLine, anchor.endLine)
      ? "range-crosses-hunk-boundary"
      : "range-outside-hunk";
    return {
      kind: "file",
      target: { subjectType: "file", path: resolvedPath },
      reason,
    };
  }

  const isSingleLine = anchor.startLine === anchor.endLine;
  const target: PrLineComment = isSingleLine
    ? { subjectType: "line", path: resolvedPath, line: anchor.endLine, side: "RIGHT" }
    : {
        subjectType: "line",
        path: resolvedPath,
        line: anchor.endLine,
        side: "RIGHT",
        startLine: anchor.startLine,
        startSide: "RIGHT",
      };
  return { kind: "line", target };
}

/** True iff the range touches at least one hunk AND touches at least
 * one line NOT on any hunk's RIGHT side. Distinguishes "crosses a
 * boundary" (some inside, some outside) from "entirely outside" so
 * the caller can log the right reason. */
function anchorSpansHunkBoundary(hunks: readonly Hunk[], start: number, end: number): boolean {
  let insideCount = 0;
  let outsideCount = 0;
  for (let n = start; n <= end; n++) {
    let inside = false;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if ((line.kind === "context" || line.kind === "add") && line.newLine === n) {
          inside = true;
          break;
        }
      }
      if (inside) break;
    }
    if (inside) insideCount++;
    else outsideCount++;
    if (insideCount > 0 && outsideCount > 0) return true;
  }
  return false;
}

/** Find a file in the PR's file list. Matches on the current filename
 * OR (for renames) on the previous filename, so an anchor captured
 * against `docs/old.mdx` maps to a file the PR renamed to
 * `docs/new.mdx`. */
export function findFile(files: readonly PrFile[], path: string): PrFile | undefined {
  for (const file of files) {
    if (file.filename === path) return file;
  }
  for (const file of files) {
    if (file.previousFilename === path) return file;
  }
  return undefined;
}

/** A comment prefix that names the intended range in a file-level
 * fallback (ADR-0025 §5.6). The reviewer's actual body is appended
 * after this line by the caller so the reader always sees which
 * lines the block covers even though GitHub can't attach the comment
 * to them. Kept as a helper so every producer emits the same text. */
export function fileFallbackPreamble(
  anchor: Pick<Anchor, "path" | "startLine" | "endLine">,
  reason: FileFallbackReason,
): string {
  const range = anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}-L${anchor.endLine}`;
  return `_[revkit] file-level fallback for \`${anchor.path}\` ${range} (${reason}) — see line range in source_`;
}

// --- Reverse direction: GitHub comment → anchor hint --- //

/** The GitHub-side of a review comment the adapter converts back into
 * an anchor hint. Only the fields the mapper needs, so the adapter
 * can flatten a REST or GraphQL response into the same shape.
 *
 * `line`/`startLine` are the LATEST positions (post-move); `originalLine`
 * is where the comment was on the commit it was originally made against.
 * Callers that want a stable historical anchor use `originalLine`;
 * callers that want the current position use `line`. */
export interface PrCommentSource {
  readonly path: string;
  readonly line?: number | null;
  readonly startLine?: number | null;
  readonly originalLine?: number | null;
  readonly originalStartLine?: number | null;
  readonly side?: "RIGHT" | "LEFT" | null;
  readonly startSide?: "RIGHT" | "LEFT" | null;
  readonly diffSide?: "RIGHT" | "LEFT" | null;
  readonly subjectType?: "line" | "file" | null;
  readonly isOutdated?: boolean | null;
}

/** The outcome of mapping a GitHub comment back to an anchor position.
 *
 * `kind: "line"` — the comment is on RIGHT side, has a resolved `line`
 * and (for a multi-line range) a matching RIGHT `startSide`, so we can
 * hand callers a `(path, startLine, endLine)` tuple whose bounds both
 * name head-revision lines.
 * `kind: "orphan"` — the comment is on LEFT, its position no longer
 * resolves (outdated), its start/end sides disagree, or it's file-level.
 * The caller keeps the thread as `status: "orphaned"`. */
export type PrCommentToAnchorResult =
  | { readonly kind: "line"; readonly path: string; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "orphan"; readonly path: string; readonly reason: OrphanReason };

/** Why a comment could not be mapped to a head-revision line range.
 * `mixed-sides` is the case where `startSide !== side` (a range whose
 * two ends live on different revisions — GitHub emits this shape for
 * some cross-side selections; there is no single line span in the
 * current head that both bounds name). */
export type OrphanReason =
  | "left-side"
  | "outdated"
  | "file-level"
  | "unresolved-line"
  | "mixed-sides";

/**
 * Map a GitHub review comment back to a review-core anchor position.
 *
 * The rules (strict on purpose — an anchor that both bounds don't
 * confirm as head-revision lines is a wrong-place risk, so orphan
 * rather than guess):
 *
 * 1. `subjectType === "file"` → orphan, `file-level`.
 * 2. `side === "LEFT"` (or `diffSide === "LEFT"` when only that is
 *    present) → orphan, `left-side`.
 * 3. `isOutdated === true` → orphan, `outdated`.
 * 4. `line` missing / null → orphan, `unresolved-line`.
 * 5. `startLine` present AND `startSide !== side` (or `startSide` is
 *    `LEFT`) → orphan, `mixed-sides`. A multi-line RIGHT/LEFT range
 *    has its two ends on DIFFERENT revisions; the RIGHT end names a
 *    head line but the LEFT start names a base line, so no single
 *    `[startLine..endLine]` on the head captures the range.
 * 6. Otherwise: `startLine ?? line` .. `line`, both on the RIGHT.
 *
 * The caller keeps orphaned threads (ADR-0006) and can still show the
 * reviewer's body — only the anchor is unavailable.
 */
export function prCommentToAnchor(comment: PrCommentSource): PrCommentToAnchorResult {
  if (comment.subjectType === "file") {
    return { kind: "orphan", path: comment.path, reason: "file-level" };
  }
  const side = comment.side ?? comment.diffSide ?? "RIGHT";
  if (side === "LEFT") {
    return { kind: "orphan", path: comment.path, reason: "left-side" };
  }
  if (comment.isOutdated === true) {
    return { kind: "orphan", path: comment.path, reason: "outdated" };
  }
  const endLine = comment.line;
  if (endLine === null || endLine === undefined) {
    return { kind: "orphan", path: comment.path, reason: "unresolved-line" };
  }
  const startLine = comment.startLine ?? null;
  const startSide = comment.startSide ?? null;
  if (startLine !== null) {
    // A multi-line range. At this point `side === "RIGHT"` (we
    // returned above on LEFT). The two ends must both be RIGHT — a
    // mixed range (start on LEFT, end on RIGHT) doesn't name a
    // head-side span. `startSide === null` is treated as "assumed
    // same as side" (GraphQL sometimes omits it on single-side
    // ranges); anything else must equal `RIGHT`. Orphan otherwise
    // (BLOCKER 3, PR-43).
    if (startSide !== null && startSide !== "RIGHT") {
      return { kind: "orphan", path: comment.path, reason: "mixed-sides" };
    }
    return { kind: "line", path: comment.path, startLine, endLine };
  }
  return { kind: "line", path: comment.path, startLine: endLine, endLine };
}
