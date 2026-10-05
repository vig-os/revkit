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

/** One thread's lifecycle-draft state — the SINGLE derivation of
 * "which resolve/reopen is this thread's current one, who authored it,
 * and has a reviewer promoted it".
 *
 * It exists because three consumers must agree (issue #70 review,
 * finding 2): the `agentDrafts` list below, the daemon's
 * `findDraftToPromote` (which refuses a stale target), and
 * `reconcileThreadStateIntents` (which is the one that WRITES). A
 * second implementation in any of them is a divergence waiting to
 * happen, so there is one and all three read it.
 *
 * The rule, in full:
 *   - the thread's CURRENT lifecycle change is its LAST
 *     `thread.resolved` / `thread.reopened`, whoever authored it;
 *   - a later lifecycle change SUPERSEDES the earlier one, promotion
 *     or not — an agent resolve the reviewer promoted, that the agent
 *     then reopens, has nothing left to resolve on GitHub;
 *   - it counts as PROMOTED only when a `draft.promoted` naming the
 *     same target has a seq LATER than it, so a promotion recorded
 *     before the change it claims authorizes nothing. */
export interface ThreadLifecycleState {
  readonly threadId: string;
  /** Which change the thread's current state came from. */
  readonly target: "resolve" | "reopen";
  /** The remote state that change asks for. */
  readonly desiredResolved: boolean;
  /** The seq of the `thread.resolved` / `thread.reopened` that set it. */
  readonly atSeq: number;
  /** Who authored that change — `agent` for an unpromoted draft. */
  readonly actorKind: ReviewEvent["actor"]["kind"];
  /** The seq of a `draft.promoted` authorizing it, or `undefined`. */
  readonly promotedAtSeq: number | undefined;
}

/** Derive every thread's `ThreadLifecycleState` from the log. Exported
 * so the daemon's reconciler and promote route read the same rule the
 * rail's draft list is built from. */
export function reduceThreadLifecycleStates(
  events: readonly ReviewEvent[],
): ReadonlyMap<string, ThreadLifecycleState> {
  const states = new Map<string, ThreadLifecycleState>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "thread.resolved" || event.kind === "thread.reopened") {
      const target = event.kind === "thread.resolved" ? "resolve" : "reopen";
      // A later lifecycle change REPLACES the state outright, dropping
      // any promotion the earlier one carried — the supersession rule.
      states.set(event.threadId, {
        threadId: event.threadId,
        target,
        desiredResolved: target === "resolve",
        atSeq: event.seq,
        actorKind: event.actor.kind,
        promotedAtSeq: undefined,
      });
      continue;
    }
    if (event.kind !== "draft.promoted" || event.target === "comment") continue;
    const state = states.get(event.threadId);
    if (state === undefined || state.target !== event.target) continue;
    if (event.seq <= state.atSeq) continue;
    states.set(event.threadId, { ...state, promotedAtSeq: event.seq });
  }
  return states;
}

/** An agent-authored reply / resolve / reopen that no reviewer has
 * promoted into the pending GitHub review yet (issue #70, option B).
 *
 * These are the drafts the rail badges as "agent draft — not on
 * GitHub" and offers to promote. Derived from the log like everything
 * else in this view: an agent-authored comment, or an agent-authored
 * lifecycle change (see `reduceThreadLifecycleStates`) that no later
 * `draft.promoted` authorizes. Ordered by the seq of the event that
 * authored the draft. */
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
  // Issue #70: the agent-draft ledger for COMMENTS, keyed by the
  // draft's own identity and carrying the seq that authored it. A
  // comment draft is REGISTERED when an agent authors it and RETIRED
  // when a later `draft.promoted` names it; promoting one comment of a
  // thread never retires the thread's other drafts. LIFECYCLE drafts
  // come from `reduceThreadLifecycleStates` after the walk — the SAME
  // derivation the daemon's reconciler and promote route read, so one
  // rule has one implementation.
  const commentDrafts = new Map<string, { readonly atSeq: number; readonly draft: AgentDraft }>();
  // threadId → the path its opening comment anchored on. A reply and a
  // resolve/reopen all belong to that thread, so all three inherit it.
  const threadPath = new Map<string, string>();

  for (const event of ordered) {
    switch (event.kind) {
      case "comment.created": {
        commentPath.set(event.commentId, event.anchor.path);
        commentThread.set(event.commentId, event.threadId);
        threadPath.set(event.threadId, event.anchor.path);
        registerAgentDraft(commentDrafts, event, event.anchor.path);
        break;
      }
      case "comment.replied": {
        commentThread.set(event.commentId, event.threadId);
        registerAgentDraft(commentDrafts, event, threadPath.get(event.threadId) ?? "");
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
      case "draft.promoted": {
        // Only a COMMENT promotion retires anything here: the
        // lifecycle half is derived once after the walk, from the
        // shared rule, so there is one implementation of "which
        // lifecycle change is current, and has it been promoted".
        if (event.target !== "comment") break;
        const key = `comment ${event.commentId ?? ""}`;
        const registered = commentDrafts.get(key);
        // Retire the draft this promotion names — and only if the
        // promotion is LATER than the draft. A promotion recorded
        // before the draft it claims (only reachable through a
        // hand-built log) leaves the draft unpromoted.
        if (registered !== undefined && event.seq > registered.atSeq) {
          commentDrafts.delete(key);
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

  // Issue #70: lifecycle drafts come from the SHARED derivation, so a
  // superseded resolve is gone here for the same reason the daemon's
  // reconciler will not fire it (issue #70 review, finding 2).
  const lifecycleDrafts: Array<{ readonly atSeq: number; readonly draft: AgentDraft }> = [];
  for (const state of reduceThreadLifecycleStates(ordered).values()) {
    // An AGENT's lifecycle change is a draft until a reviewer promotes
    // it; a reviewer's own change is not a draft at all (the existing
    // mirror path already authorizes it).
    if (state.actorKind !== "agent" || state.promotedAtSeq !== undefined) continue;
    lifecycleDrafts.push({
      atSeq: state.atSeq,
      draft: {
        threadId: state.threadId,
        target: state.target,
        path: threadPath.get(state.threadId) ?? "",
      },
    });
  }

  // Ordering is by the seq that AUTHORED each draft, so the rail lists
  // them in the sequence the agent wrote them. Comment drafts first at
  // equal seq is impossible (seqs are unique), so the merge is total.
  const allDrafts = [...commentDrafts.values(), ...lifecycleDrafts].sort((a, b) => a.atSeq - b.atSeq);
  return {
    openPending,
    terminal: terminalWithoutSeq,
    commentSync: syncState,
    unsyncedCommentIds,
    agentDrafts: allDrafts.map((entry) => entry.draft),
  };
}

/** Register an agent-authored comment as an unpromoted draft
 * (issue #70). Keyed by the comment's own id, so promoting one
 * comment of a thread never disturbs the thread's other drafts, and a
 * second agent reply after a promotion is a fresh entry. */
function registerAgentDraft(
  drafts: Map<string, { readonly atSeq: number; readonly draft: AgentDraft }>,
  event: Extract<ReviewEvent, { kind: "comment.created" | "comment.replied" }>,
  path: string,
): void {
  if (event.actor.kind !== "agent") return;
  drafts.set(`comment ${event.commentId}`, {
    atSeq: event.seq,
    draft: {
      threadId: event.threadId,
      target: "comment",
      commentId: event.commentId,
      path,
    },
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
