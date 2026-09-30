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
 * caller can print a diagnostic and prepend it to the comment body. */
export type FileFallbackReason =
  | "no-patch"
  | "range-outside-hunk"
  | "range-crosses-hunk-boundary"
  | "deleted-file"
  | "binary-file";

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
 *   1. Find the file in `files` by `anchor.path` OR by
 *      `previousFilename === anchor.path` (renames: an anchor made
 *      against the old name still maps).
 *   2. If the file is binary / patchless / deleted, fall back to a
 *      file-level comment on the RESOLVED filename (or the previous
 *      filename for a deleted file).
 *   3. Parse the patch. If every line in `anchor.startLine..endLine`
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
    return {
      kind: "file",
      target: { subjectType: "file", path: resolvedPath },
      reason: patch.startsWith("Binary files ") || patch.startsWith("GIT binary patch") ? "binary-file" : "no-patch",
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
 * `kind: "line"` — the comment is on RIGHT side and has a resolved
 * `line`, so we can hand callers a `(path, startLine, endLine)` tuple.
 * `kind: "orphan"` — the comment is on LEFT, or its position no longer
 * resolves (outdated), or it's file-level; the caller records it as
 * an orphaned or file-scoped thread. */
export type PrCommentToAnchorResult =
  | { readonly kind: "line"; readonly path: string; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "orphan"; readonly path: string; readonly reason: OrphanReason };

export type OrphanReason = "left-side" | "outdated" | "file-level" | "unresolved-line";

/**
 * Map a GitHub review comment back to a review-core anchor position.
 *
 * A LEFT-side comment or a comment whose current `line` is null (marked
 * outdated by GitHub because the range no longer resolves on the head)
 * is returned as `orphan`. The caller keeps the thread — never drops
 * it — under `status: "orphaned"` and can still show the reviewer's
 * body, matching the review-core convention (ADR-0006).
 *
 * File-level comments (subject_type = file, or line missing without an
 * outdated marker) come back as `orphan` with `reason: "file-level"`
 * so the caller can render them under the file rather than a line.
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
    // No current position and no outdated flag — treat as file-level.
    // This happens on GraphQL responses for comments that GitHub
    // considers file-scoped without setting `isOutdated`.
    return { kind: "orphan", path: comment.path, reason: "unresolved-line" };
  }
  const startLine = comment.startLine ?? endLine;
  return { kind: "line", path: comment.path, startLine, endLine };
}
