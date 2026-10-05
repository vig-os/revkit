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
  | {
      readonly kind: "pending-sync";
      readonly requestedAtSeq: number;
      readonly fingerprint: SyncFingerprint;
      readonly recoveryReviewNodeId?: string;
    }
  | {
      readonly kind: "synced";
      readonly requestedAtSeq: number;
      readonly linkedAtSeq: number;
      readonly reviewNodeId: string;
      readonly pendingCommentDatabaseId: number;
      readonly pendingCommentNodeId?: string;
      readonly fingerprint?: SyncFingerprint;
      readonly recoveryReviewNodeId?: string;
    }
  | {
      readonly kind: "failed";
      readonly requestedAtSeq: number;
      readonly failedAtSeq: number;
      readonly reason: string;
      /** Round-2: preserved from the latest sync_requested so the
       * reconciler's retry path can look up a matching draft on
       * GitHub. Absent only when a failed event lands with no
       * preceding sync_requested (defensive path). */
      readonly fingerprint?: SyncFingerprint;
      readonly recoveryReviewNodeId?: string;
    }
  | {
      readonly kind: "cancelled";
      readonly requestedAtSeq: number;
      readonly cancelledAtSeq: number;
      readonly recoveryReviewNodeId?: string;
    };

/** Data the reconciler needs to fingerprint a pending draft on
 * GitHub against a local `comment.sync_requested` intent. */
export interface SyncFingerprint {
  readonly path: string;
  readonly subjectType: "LINE" | "FILE";
  readonly side?: "RIGHT" | "LEFT";
  readonly line?: number;
  readonly startLine?: number;
  readonly bodyHash: string;
  readonly replyThreadNodeId?: string;
  readonly knownCommentNodeIds?: readonly string[];
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

/** An agent-authored reply / resolve / reopen that no reviewer has
 * promoted into the pending GitHub review yet (issue #70, option B).
 *
 * These are the drafts the rail badges as "agent draft — not on
 * GitHub" and offers to promote. Derived from the log like everything
 * else in this view: an agent-authored comment or lifecycle event with
 * no LATER `draft.promoted` naming it. A second agent draft on the
 * same thread after a promotion is a new entry, so the rail shows the
 * reviewer exactly the drafts still awaiting their decision. */
export interface AgentDraft {
  /** The thread the draft belongs to. */
  readonly threadId: string;
  /** Which kind of draft this is. */
  readonly target: "comment" | "resolve" | "reopen";
  /** Present iff `target === "comment"`. */
  readonly commentId?: string;
  /** The thread's anchor path, so a consumer can place the draft. */
  readonly path: string;
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
  /** Issue #70: agent-authored drafts awaiting a reviewer's explicit
   * promotion. Never mirrored without one. */
  readonly agentDrafts: readonly AgentDraft[];
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
  // Issue #70: the agent-draft ledger. A draft is REGISTERED when an
  // agent authors it (a comment, or a resolve/reopen on a thread) and
  // RETIRED when a later `draft.promoted` names that same draft. Both
  // sides are keyed by the draft's own identity, so a promotion of one
  // comment on a thread never retires the thread's other drafts.
  const agentDrafts = new Map<string, AgentDraft>();
  // threadId → the path its opening comment anchored on. A reply and a
  // resolve/reopen all belong to that thread, so all three inherit it.
  const threadPath = new Map<string, string>();
  // `${threadId} target` -> the seq of the lifecycle event that
  // registered the draft, so a promotion can prove it is LATER than
  // the draft it retires.
  const lifecycleDraftSeq = new Map<string, number>();

  for (const event of ordered) {
    switch (event.kind) {
      case "comment.created": {
        commentPath.set(event.commentId, event.anchor.path);
        commentThread.set(event.commentId, event.threadId);
        threadPath.set(event.threadId, event.anchor.path);
        registerAgentDraft(agentDrafts, event, event.anchor.path);
        break;
      }
      case "comment.replied": {
        commentThread.set(event.commentId, event.threadId);
        registerAgentDraft(agentDrafts, event, threadPath.get(event.threadId) ?? "");
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
        // Round-3 BLOCK-fix 1 (deleted-on-github recovery): when
        // the review was abandoned because GitHub deleted it, any
        // comment we had SYNCED against that reviewNodeId is now
        // stranded — it's still visible in the log but the draft
        // it was linked to is gone. Revert those comments back to
        // `pending-sync` so the rail can surface the recovery
        // banner and a Re-post lands them on a fresh review.
        if (event.reason === "deleted-on-github") {
          for (const [cid, st] of syncState) {
            if (st.kind === "synced" && st.reviewNodeId === event.reviewNodeId) {
              const fingerprint = syncStateFingerprintForRevert(syncState, cid, st.requestedAtSeq, ordered);
              syncState.set(cid, {
                kind: "pending-sync",
                requestedAtSeq: st.requestedAtSeq,
                ...(fingerprint !== undefined ? { fingerprint } : {
                  // No sync_requested was recorded — synthesise a
                  // minimal fingerprint from the comment's own
                  // metadata. `bodyHash` is empty here; the
                  // reconciler's body-drift check will refuse a
                  // retry until a fresh sync_requested lands. In
                  // practice a synced comment always had a prior
                  // sync_requested, so this branch is defensive.
                  fingerprint: {
                    path: "",
                    subjectType: "FILE",
                    bodyHash: "",
                  },
                }),
                recoveryReviewNodeId: event.reviewNodeId,
              });
            } else if (st.kind === "pending-sync" || st.kind === "failed") {
              syncState.set(cid, { ...st, recoveryReviewNodeId: event.reviewNodeId });
            }
          }
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
            if (prev?.kind === "cancelled") break;
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
              ...(prev !== undefined && (prev.kind === "pending-sync" || prev.kind === "failed") && prev.fingerprint !== undefined
                ? { fingerprint: prev.fingerprint }
                : {}),
              ...(prev !== undefined && "recoveryReviewNodeId" in prev && prev.recoveryReviewNodeId !== undefined
                ? { recoveryReviewNodeId: prev.recoveryReviewNodeId }
                : {}),
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
          ...(event.replyThreadNodeId !== undefined ? { replyThreadNodeId: event.replyThreadNodeId } : {}),
          ...(event.knownCommentNodeIds !== undefined ? { knownCommentNodeIds: event.knownCommentNodeIds } : {}),
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
        if (prev?.kind === "cancelled") break;
        const requestedAtSeq =
          prev !== undefined && (prev.kind === "pending-sync" || prev.kind === "failed" || prev.kind === "synced")
            ? prev.requestedAtSeq
            : event.seq;
        // Preserve the fingerprint from the latest sync_requested
        // so the reconciler's retry can look up a matching draft.
        const preservedFingerprint =
          prev !== undefined && prev.kind === "pending-sync"
            ? prev.fingerprint
            : prev !== undefined && prev.kind === "failed"
              ? prev.fingerprint
              : undefined;
        syncState.set(event.commentId, {
          kind: "failed",
          requestedAtSeq,
          failedAtSeq: event.seq,
          reason: event.reason,
          ...(preservedFingerprint !== undefined ? { fingerprint: preservedFingerprint } : {}),
          ...(prev !== undefined && "recoveryReviewNodeId" in prev && prev.recoveryReviewNodeId !== undefined
            ? { recoveryReviewNodeId: prev.recoveryReviewNodeId }
            : {}),
        });
        break;
      }
      case "comment.sync_cancelled": {
        const prev = syncState.get(event.commentId);
        if (
          prev !== undefined &&
          (prev.kind === "pending-sync" || prev.kind === "failed" || prev.kind === "synced") &&
          prev.requestedAtSeq === event.requestedAtSeq
        ) {
          syncState.set(event.commentId, {
            kind: "cancelled",
            requestedAtSeq: event.requestedAtSeq,
            cancelledAtSeq: event.seq,
            ...(prev.recoveryReviewNodeId !== undefined ? { recoveryReviewNodeId: prev.recoveryReviewNodeId } : {}),
          });
        }
        break;
      }
      case "thread.resolved":
      case "thread.reopened": {
        // An AGENT's lifecycle change is a draft, not an intent: it
        // changes local state and nothing else until a reviewer
        // promotes it (issue #70). A reviewer's own change is not a
        // draft at all — the existing mirror path already authorizes
        // it.
        if (event.actor.kind !== "agent") break;
        const target = event.kind === "thread.resolved" ? "resolve" : "reopen";
        const key = `${event.threadId} ${target}`;
        // The thread's CURRENT lifecycle draft supersedes the other
        // one: an agent resolve that was never promoted is no longer a
        // draft once the thread is reopened — there is nothing left to
        // resolve on GitHub.
        const superseded = `${event.threadId} ${target === "resolve" ? "reopen" : "resolve"}`;
        agentDrafts.delete(superseded);
        lifecycleDraftSeq.delete(superseded);
        agentDrafts.set(key, {
          threadId: event.threadId,
          target,
          path: threadPath.get(event.threadId) ?? "",
        });
        lifecycleDraftSeq.set(key, event.seq);
        break;
      }
      case "draft.promoted": {
        if (event.target === "comment") {
          agentDrafts.delete(`comment ${event.commentId ?? ""}`);
          break;
        }
        const key = `${event.threadId} ${event.target}`;
        const registeredAt = lifecycleDraftSeq.get(key);
        // Retire the draft this promotion names — and only if the
        // promotion is LATER than the draft. A promotion recorded
        // before the draft it claims (only reachable through a
        // hand-built log) leaves the draft unpromoted.
        if (registeredAt !== undefined && event.seq > registeredAt) {
          agentDrafts.delete(key);
        }
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
          comments: picked.comments.filter((comment) => syncState.get(comment.commentId)?.kind !== "cancelled"),
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

  // Issue #70: insertion order is authoring order, so the rail lists
  // the drafts in the sequence the agent wrote them.
  return {
    openPending,
    terminal: terminalWithoutSeq,
    commentSync: syncState,
    unsyncedCommentIds,
    agentDrafts: [...agentDrafts.values()],
  };
}

/** Register an agent-authored comment as an unpromoted draft
 * (issue #70). Keyed by the comment's own id, so promoting one
 * comment of a thread never disturbs the thread's other drafts, and a
 * second agent reply after a promotion is a fresh entry. */
function registerAgentDraft(
  drafts: Map<string, AgentDraft>,
  event: Extract<ReviewEvent, { kind: "comment.created" | "comment.replied" }>,
  path: string,
): void {
  if (event.actor.kind !== "agent") return;
  drafts.set(`comment ${event.commentId}`, {
    threadId: event.threadId,
    target: "comment",
    commentId: event.commentId,
    path,
  });
}

/** Round-3 BLOCK-fix 1: walk the log to recover the fingerprint
 * from the LATEST `comment.sync_requested` for a comment being
 * reverted from `synced` back to `pending-sync` on a
 * `deleted-on-github` abandon. Called only from within the
 * reducer's own event walk, so it re-uses the already-sorted
 * `ordered` view. Returns undefined when no sync_requested was
 * recorded for that comment. */
function syncStateFingerprintForRevert(
  _syncState: ReadonlyMap<string, CommentSyncState>,
  commentId: string,
  requestedAtSeq: number,
  ordered: readonly ReviewEvent[],
): SyncFingerprint | undefined {
  // Prefer a scan from the highest-seq downward that reaches the
  // requestedAtSeq — the fingerprint of the intent that originally
  // produced this sync-then-link cycle.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i]!;
    if (e.kind !== "comment.sync_requested" || e.commentId !== commentId) continue;
    if (e.seq !== requestedAtSeq) continue;
    return {
      path: e.path,
      subjectType: e.subjectType,
      bodyHash: e.bodyHash,
      ...(e.side !== undefined ? { side: e.side } : {}),
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.startLine !== undefined ? { startLine: e.startLine } : {}),
      ...(e.replyThreadNodeId !== undefined ? { replyThreadNodeId: e.replyThreadNodeId } : {}),
      ...(e.knownCommentNodeIds !== undefined ? { knownCommentNodeIds: e.knownCommentNodeIds } : {}),
    };
  }
  // Fallback: any sync_requested for this comment (in case the
  // requestedAtSeq marker drifted through a later re-sync).
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i]!;
    if (e.kind === "comment.sync_requested" && e.commentId === commentId) {
      return {
        path: e.path,
        subjectType: e.subjectType,
        bodyHash: e.bodyHash,
        ...(e.side !== undefined ? { side: e.side } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        ...(e.startLine !== undefined ? { startLine: e.startLine } : {}),
        ...(e.replyThreadNodeId !== undefined ? { replyThreadNodeId: e.replyThreadNodeId } : {}),
        ...(e.knownCommentNodeIds !== undefined ? { knownCommentNodeIds: e.knownCommentNodeIds } : {}),
      };
    }
  }
  return undefined;
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
