// Pending-review derived view (M3 part 2b, ADR-0025).
//
// The daemon's "current pending review" is a pure function of the log —
// no in-memory state to drift across restart / crash / external write.
// This mirrors the M2 lesson from PR #53 (delivery modes): stateful
// features are derived from typed events with a restart test.
//
// The events in play:
//   - `review.opened(reviewNodeId, headSha)`             — a pending
//     review was created (find-or-create returned `created`) OR
//     re-linked (returned `reused` and matches the current headSha).
//     The daemon writes THIS event before any `comment.linked` with
//     `external.github.pending: true`.
//   - `review.submitted(reviewNodeId, event, body?)`     — the pending
//     review was submitted with `COMMENT` / `APPROVE` /
//     `REQUEST_CHANGES`. Terminal.
//   - `review.abandoned(reviewNodeId, reason?)`          — the pending
//     review was deleted (head moved, user discarded). Terminal.
//   - `comment.linked` events with `external.github.pending: true` +
//     `reviewNodeId` link local comments to a specific pending review.
//     A comment stays "pending" only while its `reviewNodeId` is
//     still `pending`; once the review submits or is abandoned, the
//     comment is no longer in the pending set.
//
// The validator enforces the lifecycle (`duplicate-review`,
// `review-not-pending`), so this module trusts the log's shape and
// only reduces.

import type { ReviewEvent } from "./events.ts";

/** M3 part 2b round-2: per-comment sync state derived from the log.
 *
 *   - `not-attempted`: no `comment.sync_requested` has fired yet
 *     for this comment. The daemon does not surface a sync line
 *     for it.
 *   - `pending-sync`: a `comment.sync_requested` is the last
 *     sync-track event for this comment; the reconciler has not
 *     yet confirmed or failed it. The rail shows a spinner.
 *   - `synced`: the reconciler emitted `comment.linked` (with
 *     `github.pending: true` + a matching `reviewNodeId`) after
 *     the latest `comment.sync_requested`. The rail shows a
 *     "posted to GitHub" line.
 *   - `failed`: the reconciler emitted `comment.sync_failed`
 *     after the latest `comment.sync_requested`. The rail shows
 *     "not on GitHub — retry".
 *
 * A later `comment.sync_requested` (e.g. after a retry) resets
 * the state back to `pending-sync`. */
export type CommentSyncState =
  | { readonly kind: "not-attempted" }
  | { readonly kind: "pending-sync"; readonly requestedAtSeq: number; readonly fingerprint: SyncFingerprint }
  | {
      readonly kind: "synced";
      readonly requestedAtSeq: number;
      readonly linkedAtSeq: number;
      readonly reviewNodeId: string;
      readonly pendingCommentDatabaseId: number;
      readonly pendingCommentNodeId?: string;
    }
  | { readonly kind: "failed"; readonly requestedAtSeq: number; readonly failedAtSeq: number; readonly reason: string };

/** Data the reconciler needs to fingerprint a pending draft on
 * GitHub against a local `comment.sync_requested` intent. */
export interface SyncFingerprint {
  readonly path: string;
  readonly subjectType: "LINE" | "FILE";
  readonly side?: "RIGHT" | "LEFT";
  readonly line?: number;
  readonly startLine?: number;
  readonly bodyHash: string;
}

/** One entry in the derived pending set — a local comment linked to
 * a still-open pending review. */
export interface PendingReviewComment {
  /** Local `commentId` (idSchema-shaped). */
  readonly commentId: string;
  /** Local `threadId`. */
  readonly threadId: string;
  /** GitHub GraphQL id of the pending review-comment (node id).
   * Absent when the linking event carried only the REST comment id
   * (older / import paths). */
  readonly pendingCommentNodeId?: string;
  /** GitHub REST comment id (integer). Always present. */
  readonly pendingCommentDatabaseId: number;
  /** The comment's own path — captured for the rail / submit UI so
   * consumers don't need to re-join with threads. */
  readonly path: string;
}

/** One open pending review — the head-line of the pending set. */
export interface OpenPendingReview {
  readonly reviewNodeId: string;
  readonly headSha: string;
  /** The comments the review contains, ordered by the `seq` of the
   * `comment.linked` event that placed them. */
  readonly comments: readonly PendingReviewComment[];
}

/** A submitted / abandoned review from the log — surfaced so the
 * daemon (and B4 sync) can show recent history. */
export interface TerminalReview {
  readonly reviewNodeId: string;
  readonly headSha: string;
  readonly outcome:
    | { readonly kind: "submitted"; readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; readonly body?: string }
    | { readonly kind: "abandoned"; readonly reason?: string };
  readonly at: string;
}

/** The derived review state. */
export interface ReviewState {
  /** The single currently-open pending review, or `null` if none.
   * GitHub allows at most one PENDING review per (viewer, PR); the
   * validator refuses a second `review.opened` before a terminal
   * transition, so this field is at most one. */
  readonly openPending: OpenPendingReview | null;
  /** Reviews the log records as terminal (submitted / abandoned).
   * Ordered by seq ascending. */
  readonly terminal: readonly TerminalReview[];
  /** Per-comment sync state (M3 part 2b round-2). Keyed by local
   * commentId. Comments that never got a `comment.sync_requested`
   * do NOT appear here — the rail only surfaces intent-tracked
   * comments in the review panel. */
  readonly commentSync: ReadonlyMap<string, CommentSyncState>;
  /** Convenience: commentIds that are still pending / failed.
   * Submit gates on this being empty. */
  readonly unsyncedCommentIds: readonly string[];
}

/** Pure reducer: `events → ReviewState`. Called by the daemon on
 * every read that touches pending state (submit endpoint, review-
 * state endpoint, rail catch-up), and on restart's boot-time
 * hydration. Not cached — the caller (daemon) reduces the log once
 * per request; `packages/cli/src/serve/daemon.ts` shows how the
 * result is projected onto route responses. */
export function reduceReviewState(events: readonly ReviewEvent[]): ReviewState {
  // BLOCK-fix (M3 part 2b round-2 nit): order by SEQ (server-
  // assigned, strictly increasing), NOT by `ts` (ISO strings tie
  // poorly at sub-second resolution and a clock skew can shuffle
  // events). The store assigns seq monotonically; this is the
  // deterministic order every derived view uses.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const openByNodeId = new Map<
    string,
    { headSha: string; comments: PendingReviewComment[]; openSeq: number; terminalSeq?: number }
  >();
  const terminal: Array<TerminalReview & { seq: number }> = [];
  // commentId → path (to join comment.linked with its comment.created path)
  const commentPath = new Map<string, string>();
  // commentId → threadId
  const commentThread = new Map<string, string>();
  // commentId → last sync state (mutated as we replay).
  const syncState = new Map<string, CommentSyncState>();

  for (const event of ordered) {
    switch (event.kind) {
      case "comment.created": {
        commentPath.set(event.commentId, event.anchor.path);
        commentThread.set(event.commentId, event.threadId);
        break;
      }
      case "comment.replied": {
        commentThread.set(event.commentId, event.threadId);
        break;
      }
      case "review.opened": {
        openByNodeId.set(event.reviewNodeId, {
          headSha: event.headSha,
          comments: [],
          openSeq: event.seq,
        });
        break;
      }
      case "review.submitted": {
        const open = openByNodeId.get(event.reviewNodeId);
        if (open !== undefined) {
          terminal.push({
            reviewNodeId: event.reviewNodeId,
            headSha: open.headSha,
            outcome: {
              kind: "submitted",
              event: event.event,
              ...(event.body !== undefined ? { body: event.body } : {}),
            },
            at: event.ts,
            seq: event.seq,
          });
          openByNodeId.delete(event.reviewNodeId);
        }
        break;
      }
      case "review.abandoned": {
        const open = openByNodeId.get(event.reviewNodeId);
        if (open !== undefined) {
          terminal.push({
            reviewNodeId: event.reviewNodeId,
            headSha: open.headSha,
            outcome: {
              kind: "abandoned",
              ...(event.reason !== undefined ? { reason: event.reason } : {}),
            },
            at: event.ts,
            seq: event.seq,
          });
          openByNodeId.delete(event.reviewNodeId);
        }
        break;
      }
      case "comment.linked": {
        const gh = event.external.github;
        if (gh === undefined) break;
        // Update sync state whenever this link points at a pending
        // draft on the currently-open review.
        if (gh.pending === true && gh.reviewNodeId !== undefined) {
          const open = openByNodeId.get(gh.reviewNodeId);
          if (open !== undefined) {
            const prev = syncState.get(event.commentId);
            const requestedAtSeq =
              prev !== undefined && (prev.kind === "pending-sync" || prev.kind === "failed" || prev.kind === "synced")
                ? prev.requestedAtSeq
                : event.seq;
            syncState.set(event.commentId, {
              kind: "synced",
              requestedAtSeq,
              linkedAtSeq: event.seq,
              reviewNodeId: gh.reviewNodeId,
              pendingCommentDatabaseId: gh.commentId,
              ...(gh.nodeId !== undefined ? { pendingCommentNodeId: gh.nodeId } : {}),
            });
            let path = commentPath.get(event.commentId);
            if (path === undefined) {
              const threadId = commentThread.get(event.commentId);
              if (threadId !== undefined) {
                for (const [cid, tid] of commentThread) {
                  if (tid === threadId && commentPath.has(cid)) {
                    path = commentPath.get(cid);
                    break;
                  }
                }
              }
            }
            if (path !== undefined) {
              const threadId = commentThread.get(event.commentId) ?? "";
              open.comments.push({
                commentId: event.commentId,
                threadId,
                pendingCommentDatabaseId: gh.commentId,
                ...(gh.nodeId !== undefined ? { pendingCommentNodeId: gh.nodeId } : {}),
                path,
              });
            }
          }
        }
        break;
      }
      case "comment.sync_requested": {
        const fingerprint: SyncFingerprint = {
          path: event.path,
          subjectType: event.subjectType,
          bodyHash: event.bodyHash,
          ...(event.side !== undefined ? { side: event.side } : {}),
          ...(event.line !== undefined ? { line: event.line } : {}),
          ...(event.startLine !== undefined ? { startLine: event.startLine } : {}),
        };
        syncState.set(event.commentId, {
          kind: "pending-sync",
          requestedAtSeq: event.seq,
          fingerprint,
        });
        break;
      }
      case "comment.sync_failed": {
        const prev = syncState.get(event.commentId);
        const requestedAtSeq =
          prev !== undefined && (prev.kind === "pending-sync" || prev.kind === "failed" || prev.kind === "synced")
            ? prev.requestedAtSeq
            : event.seq;
        syncState.set(event.commentId, {
          kind: "failed",
          requestedAtSeq,
          failedAtSeq: event.seq,
          reason: event.reason,
        });
        break;
      }
      default:
        // Other kinds don't affect review state.
        break;
    }
  }

  // Terminal ordered by seq ascending. The `seq` field is a
  // derivation detail; strip it from the exposed type.
  terminal.sort((a, b) => a.seq - b.seq);

  let picked: { reviewNodeId: string; headSha: string; comments: PendingReviewComment[]; openSeq: number } | undefined;
  let pickedId: string | undefined;
  for (const [reviewNodeId, entry] of openByNodeId) {
    if (picked === undefined || entry.openSeq > picked.openSeq) {
      picked = { ...entry, reviewNodeId };
      pickedId = reviewNodeId;
    }
  }
  const openPending: OpenPendingReview | null =
    picked !== undefined && pickedId !== undefined
      ? {
          reviewNodeId: pickedId,
          headSha: picked.headSha,
          comments: picked.comments.slice(),
        }
      : null;

  const unsyncedCommentIds: string[] = [];
  for (const [cid, state] of syncState) {
    if (state.kind === "pending-sync" || state.kind === "failed") {
      unsyncedCommentIds.push(cid);
    }
  }
  unsyncedCommentIds.sort();

  const terminalWithoutSeq: TerminalReview[] = terminal.map(({ seq: _seq, ...rest }) => {
    void _seq;
    return rest;
  });

  return { openPending, terminal: terminalWithoutSeq, commentSync: syncState, unsyncedCommentIds };
}

/** A pending review is `stale` when its opened `headSha` differs
 * from the current `headSha` (the reviewer's daemon is looking at a
 * different commit than the review was pinned to). The daemon
 * projects this classification onto `/api/review/state` so the rail
 * can show the banner. Case-insensitive equality on the hex string
 * (`shortSha === longSha[..7]` is NOT accepted — an operator that
 * types a short SHA against a long one has to be intentional; the
 * daemon always passes the same-length SHA it advertised). */
export function isPendingReviewStale(open: OpenPendingReview | null, currentHeadSha: string): boolean {
  if (open === null) return false;
  return open.headSha.toLowerCase() !== currentHeadSha.toLowerCase();
}
