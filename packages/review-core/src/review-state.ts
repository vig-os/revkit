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
}

/** Pure reducer: `events → ReviewState`. Called by the daemon on
 * every read that touches pending state (submit endpoint, review-
 * state endpoint, rail catch-up), and on restart's boot-time
 * hydration. Not cached — the caller (daemon) reduces the log once
 * per request; `packages/cli/src/serve/daemon.ts` shows how the
 * result is projected onto route responses. */
export function reduceReviewState(events: readonly ReviewEvent[]): ReviewState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const openByNodeId = new Map<
    string,
    { headSha: string; comments: PendingReviewComment[]; openSeq: number }
  >();
  const terminal: TerminalReview[] = [];
  // commentId → path (to join comment.linked with its comment.created path)
  const commentPath = new Map<string, string>();
  // commentId → threadId
  const commentThread = new Map<string, string>();

  for (const event of ordered) {
    switch (event.kind) {
      case "comment.created": {
        commentPath.set(event.commentId, event.anchor.path);
        commentThread.set(event.commentId, event.threadId);
        break;
      }
      case "comment.replied": {
        commentThread.set(event.commentId, event.threadId);
        // Path taken from the thread's opening comment — we already
        // have it in commentPath under the parent thread's original
        // commentId. Look up on demand at link time.
        break;
      }
      case "review.opened": {
        // Validator refuses duplicates; the append-only log guarantees
        // uniqueness on `reviewNodeId` here.
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
          });
          openByNodeId.delete(event.reviewNodeId);
        }
        break;
      }
      case "comment.linked": {
        // We care ONLY about links marked pending with a
        // reviewNodeId; a plain comment.linked (published review
        // comment import) doesn't project onto the pending set.
        const gh = event.external.github;
        if (gh === undefined) break;
        if (gh.pending !== true) break;
        const reviewNodeId = gh.reviewNodeId;
        if (reviewNodeId === undefined) break;
        const open = openByNodeId.get(reviewNodeId);
        if (open === undefined) break;
        // Path lookup: prefer the comment's own path, else fall back
        // to the thread's opening comment path — a reply's path is
        // inherited from its thread.
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
        if (path === undefined) break;
        const threadId = commentThread.get(event.commentId) ?? "";
        open.comments.push({
          commentId: event.commentId,
          threadId,
          pendingCommentDatabaseId: gh.commentId,
          ...(gh.nodeId !== undefined ? { pendingCommentNodeId: gh.nodeId } : {}),
          path,
        });
        break;
      }
      default:
        // Other kinds don't affect review state.
        break;
    }
  }

  // Sort terminal by seq (already appended in seq order due to the
  // outer sort; explicit for clarity).
  terminal.sort((a, b) => a.at.localeCompare(b.at));

  // Only ONE open pending review is expected, but tolerate zero.
  // If more than one (validator would have caught it upstream), we
  // return the one with the largest openSeq — the most recent one
  // the log records.
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

  return { openPending, terminal };
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
