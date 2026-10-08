// Review-mode integration for the daemon (M3 part 2b, ADR-0025).
//
// Round-2 (BLOCK-fix): the mirror-to-GitHub path is an INTENT LOG
// plus a RECONCILER. The request handler NEVER makes fire-and-forget
// mutations. It appends `comment.sync_requested` (intent), then
// invokes `reconcile()`, which:
//
//   1. READS the truth: viewer's pending review + its comments, and
//      the full `listReviewThreads` set for B4 sync.
//   2. Compares against the log's intents.
//   3. Adds only what is missing, matching by GraphQL node id when
//      known, else by a body-hash + position fingerprint recorded on
//      the `comment.sync_requested` event.
//   4. Emits `comment.linked` on success, `comment.sync_failed` on
//      GitHub error. NEVER auto-retries a mutation — retries happen
//      by re-invoking `reconcile`, which always re-reads first.
//
// Runs after every human-driven write, on `/api/review/refresh`, and
// at daemon startup — so a crash between "GitHub accepted the write"
// and "the log recorded it" heals on the next tick. The log stays
// the source of truth; GitHub becomes idempotently consistent.
//
// Security (ADR-0009, ADR-0013): every adapter call is invoked from
// a human-authenticated path (session cookie). The agent bearer is
// refused with 403 at the daemon's route layer for every review
// write. Tokens never touch the browser or the log.

import {
  type Anchor,
  type Author,
  type CommentSyncState,
  type GitHubAdapter,
  type GhReviewThread,
  type PendingReviewComment as AdapterPendingReviewComment,
  type PrRef,
  type PrFile,
  type PullRequestSummary,
  type ReviewEvent,
  type ReviewEventInput,
  type ReviewState,
  type ReviewSubmitEvent,
  type SyncFingerprint,
  type Thread,
  type ThreadStore,
  type ViewerReviewSummary,
  ThreadStoreAppendError,
  anchorToPrComment,
  fileFallbackPreamble,
  isLineAnchor,
  isPendingReviewStale,
  reanchor,
  reduceReviewState,
  reduceThreadLifecycleStates,
  revisionOf,
} from "@revkit/review-core";
import { guardPromotionDestination } from "./promotion-review-guard.ts";
import { promotedCommentIntents } from "./promotion-provenance.ts";
import { isUnchangedSyncFailure } from "./sync-failure.ts";

/** Options the daemon accepts in review-mode. */
export interface ReviewModeOptions {
  readonly adapter: GitHubAdapter;
  readonly pr: PrRef;
  summary: PullRequestSummary;
  readonly viewerLogin: string;
  files: readonly PrFile[];
  readonly trustSha?: string;
}

/** Handle the daemon uses to interact with review-mode state. */
export interface ReviewModeHandle {
  readonly options: ReviewModeOptions;
  /** Read the current review state from the log. */
  readState(store: ThreadStore): Promise<ReviewState>;
  /** Current PR head SHA (from the cached summary). */
  currentHeadSha(): string;
  /** Update the cached summary / files (after a refresh call). */
  refreshSummary(summary: PullRequestSummary, files: readonly PrFile[]): void;
}

/** Build a `ReviewModeHandle` from options. */
export function makeReviewModeHandle(options: ReviewModeOptions): ReviewModeHandle {
  return {
    options,
    async readState(store: ThreadStore): Promise<ReviewState> {
      const events = await store.since(0);
      return reduceReviewState(events);
    },
    currentHeadSha(): string {
      return options.summary.headSha;
    },
    refreshSummary(next: PullRequestSummary, nextFiles: readonly PrFile[]): void {
      (options as { summary: PullRequestSummary }).summary = next;
      (options as { files: readonly PrFile[] }).files = nextFiles;
    },
  };
}

/** Result of mapping a local anchor onto a pending-review coordinate.
 * `orphan` means the anchor cannot be represented as a pending draft
 * on GitHub (deleted path, etc.); the caller decides what to do. */
export type PendingMap =
  | {
      readonly kind: "line";
      readonly path: string;
      readonly line: number;
      readonly startLine?: number;
      readonly side: "RIGHT" | "LEFT";
      readonly submittedBody: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly submittedBody: string;
    }
  | { readonly kind: "orphan"; readonly reason: string };

/** Map an anchor onto a pending-review request. Same anchor-map used
 * by both the request handler AND the reanchor pipeline. Returns
 * `orphan` when the block cannot be posted (deleted file, patch
 * unavailable). Callable pure — no I/O. */
export function mapAnchorForPending(
  anchor: Anchor,
  files: readonly PrFile[],
  body: string,
): PendingMap {
  const mapResult = anchorToPrComment(anchor, files);
  if (mapResult.kind === "reject") {
    return { kind: "orphan", reason: `anchor rejected: ${mapResult.reason}` };
  }
  if (mapResult.kind === "file") {
    return {
      kind: "file",
      path: mapResult.target.path,
      submittedBody: fileFallbackPreamble(anchor, mapResult.reason) + body,
    };
  }
  const line = mapResult.target.line;
  const startLine =
    mapResult.target.startLine !== undefined && mapResult.target.startLine !== mapResult.target.line
      ? mapResult.target.startLine
      : undefined;
  return {
    kind: "line",
    path: mapResult.target.path,
    line,
    side: mapResult.target.side,
    submittedBody: body,
    ...(startLine !== undefined ? { startLine } : {}),
  };
}

/** Compose the `comment.sync_requested` event input for a mapped
 * pending draft. Pure — the caller appends it. */
export async function buildSyncRequest(input: {
  readonly actor: Author;
  readonly commentId: string;
  readonly mapping: PendingMap;
}): Promise<ReviewEventInput> {
  if (input.mapping.kind === "orphan") {
    throw new Error("buildSyncRequest: cannot build for an orphan mapping — the caller must handle orphans separately.");
  }
  const bodyHash = await revisionOf(input.mapping.submittedBody);
  if (input.mapping.kind === "line") {
    return {
      kind: "comment.sync_requested",
      actor: input.actor,
      commentId: input.commentId,
      path: input.mapping.path,
      subjectType: "LINE",
      side: input.mapping.side,
      line: input.mapping.line,
      ...(input.mapping.startLine !== undefined ? { startLine: input.mapping.startLine } : {}),
      bodyHash,
    };
  }
  return {
    kind: "comment.sync_requested",
    actor: input.actor,
    commentId: input.commentId,
    path: input.mapping.path,
    subjectType: "FILE",
    bodyHash,
  };
}

/** Compose the top-level body for a submit event when the caller
 * left `body` undefined. */
export function defaultSubmitBody(event: ReviewSubmitEvent, headSha: string): string {
  const label =
    event === "COMMENT" ? "Comment" : event === "APPROVE" ? "Approval" : "Requested changes";
  return `${label} submitted from revkit local review at ${headSha.slice(0, 12)}.`;
}

/** Map GitHub's review state enum onto our `review.submitted.event`
 * type. Terminal-but-non-COMMENT states (APPROVED / CHANGES_REQUESTED)
 * carry the event through; DISMISSED is treated as a COMMENT
 * (dismissed reviews are also terminal). */
function ghStateToReviewEvent(state: ViewerReviewSummary["state"]): ReviewSubmitEvent {
  switch (state) {
    case "APPROVED":
      return "APPROVE";
    case "CHANGES_REQUESTED":
      return "REQUEST_CHANGES";
    case "COMMENTED":
    case "DISMISSED":
    case "PENDING":
    default:
      return "COMMENT";
  }
}

/** Full reconciler outcome. */
export interface ReconcileOutcome {
  /** Local commentIds we just marked synced. */
  readonly newlySynced: readonly string[];
  /** Local commentIds we just marked failed. */
  readonly newlyFailed: ReadonlyArray<{ readonly commentId: string; readonly reason: string }>;
  /** The pending review's node id after reconcile (null when none
   * exists on either side). */
  readonly reviewNodeId: string | null;
  /** True when reconcile discovered a submitted review on GitHub
   * that the log had not yet recorded. */
  readonly healedSubmit: boolean;
  /** True when reconcile discovered the review had been deleted
   * from under us (abandon). */
  readonly healedAbandon: boolean;
  /** Round-2 BLOCK-fix 1: true when reconcile discovered the
   * log's pending review was deleted from GitHub — the reconciler
   * appends `review.abandoned` with reason `deleted-on-github`
   * and DOES NOT auto-create a replacement. The rail surfaces
   * this and asks the human to confirm before re-posting. */
  readonly deletedRemotely?: boolean;
}

/** Reconciler input. `store` needs the snapshot API for the
 * head-move reanchor path but the reconciler itself only reads
 * events. `appendAndPublish` fans through the daemon's audit
 * path. */
export interface ReconcileInput {
  readonly review: ReviewModeHandle;
  readonly store: ThreadStore;
  readonly actor: Author;
  readonly appendAndPublish: (input: ReviewEventInput) => Promise<ReviewEvent | undefined>;
  /** False during daemon boot: read GitHub and heal local completion
   * events, but never create reviews or issue mutations without a
   * current cookie-authenticated human action. */
  readonly allowMutations: boolean;
}

/** Compare two `SyncFingerprint`s. `nodeId` matching is the primary
 * key on `comment.linked` events, but at re-hydration time we may
 * see a GitHub draft we posted BEFORE a crash and never linked; then
 * the fingerprint is what tells us it's ours. Fingerprint match is
 * strict on path + subjectType + side + line + startLine + bodyHash. */
export async function fingerprintMatches(
  fingerprint: SyncFingerprint,
  draft: AdapterPendingReviewComment,
): Promise<boolean> {
  if (draft.path !== fingerprint.path) return false;
  if ((draft.subjectType ?? "LINE") !== fingerprint.subjectType) return false;
  if (fingerprint.subjectType === "LINE") {
    if (draft.line !== fingerprint.line) return false;
    if ((draft.startLine ?? undefined) !== (fingerprint.startLine ?? undefined)) return false;
    // The pending-comment shape from GraphQL doesn't expose `side`,
    // only the parent thread does; we trust the (path,line) pair.
  }
  const draftHash = await revisionOf(draft.body);
  return draftHash === fingerprint.bodyHash;
}

/** Reconcile the log against GitHub's actual state. See file header
 * for the invariants. Never throws for a per-comment failure — it
 * emits `comment.sync_failed` and continues. Throws only for a
 * fatal read-side error (network to `viewer` or the pending-review
 * query). */
export async function reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
  const { review, store, actor, appendAndPublish, allowMutations } = input;

  let state = await review.readState(store);
  const currentHeadSha = review.currentHeadSha();
  const promotions = promotedCommentIntents(await store.since(0));

  async function recordSyncFailure(commentId: string, reason: string): Promise<void> {
    const previous = state.commentSync.get(commentId);
    const intentSeq = previous !== undefined && "requestedAtSeq" in previous ? previous.requestedAtSeq : 0;
    if (isUnchangedSyncFailure(previous?.kind === "failed"
      ? { intentSeq: previous.requestedAtSeq, reason: previous.reason } : undefined, intentSeq, reason)) return;
    await appendAndPublish({ kind: "comment.sync_failed", actor, commentId, reason });
  }

  async function promotionRefusal(commentId: string): Promise<string | undefined> {
    if (!promotions.has(commentId)) return undefined;
    const guard = guardPromotionDestination(
      reviewNodeId,
      promotions.get(commentId),
      new Set(state.terminal.map((entry) => entry.reviewNodeId)),
    );
    if (guard.ok) return undefined;
    await recordSyncFailure(commentId, guard.error);
    return guard.error;
  }

  // 1. Read the truth: is there a pending review on GitHub?
  //    `findOrCreatePendingReview` returns reused|created|stale. We
  //    NEVER auto-create here — the reconciler only opens a review
  //    when there's at least one intent to sync. That keeps GitHub
  //    from carrying an empty pending review after a discard.
  const hasIntent =
    state.unsyncedCommentIds.length > 0 ||
    (state.openPending !== null && state.openPending.comments.length > 0);

  let reviewNodeId: string | null = state.openPending?.reviewNodeId ?? null;
  let healedSubmit = false;
  let healedAbandon = false;
  let deletedRemotely = false;

  // Round-2 BLOCK-fix 1: if the log records an open pending
  // review, DO NOT ask findOrCreatePendingReview (which would
  // CREATE a new one and lose the fact that GitHub already
  // accepted our submit). Instead read the viewer's reviews on
  // this PR across ALL states. Compare the log's recorded
  // reviewNodeId against GitHub:
  //   - MATCHES a PENDING review → good, still open.
  //   - MATCHES a SUBMITTED review (state != PENDING with a
  //     submittedAt) → GitHub accepted the submit and the log
  //     lost the terminal event; append `review.submitted`
  //     with the actual event/commit, then stop. NEVER auto-
  //     create a replacement.
  //   - NOT PRESENT (deleted on GitHub, likely by another
  //     viewer client) → append `review.abandoned` with
  //     `deleted-on-github` and STOP. The daemon will surface
  //     "your pending review was deleted on GitHub — re-post N
  //     drafts?" and the human confirms before a new one opens.
  if (state.openPending !== null) {
    // Round-3 BLOCK-fix 3: look up the RECORDED review directly by
    // its node id. The old `listViewerReviewsOnPr(first: 50)`
    // window would drop a legitimately-SUBMITTED review out of the
    // page for any reviewer with 50+ reviews on the PR, tripping a
    // false `deleted-on-github`.
    let recorded: ViewerReviewSummary | null;
    try {
      recorded = await review.options.adapter.getReviewById(
        state.openPending.reviewNodeId,
      );
    } catch (err) {
      throw err;
    }
    if (recorded === null) {
      // Deleted on GitHub — mark it terminal locally, refuse to
      // create anything without a human's confirmation.
      try {
        await appendAndPublish({
          kind: "review.abandoned",
          actor,
          reviewNodeId: state.openPending.reviewNodeId,
          reason: "deleted-on-github",
        });
      } catch (err) {
        void err; // already terminal — fine.
      }
      deletedRemotely = true;
      reviewNodeId = null;
      state = await review.readState(store);
    } else if (recorded.state === "PENDING") {
      reviewNodeId = recorded.id;
    } else {
      // Submitted-on-github. Heal by appending review.submitted
      // with the ACTUAL event GitHub recorded. NEVER open a new
      // pending review in the same reconcile — a retried submit
      // must be refused, not double-fired.
      const ghEvent = ghStateToReviewEvent(recorded.state);
      try {
        await appendAndPublish({
          kind: "review.submitted",
          actor,
          reviewNodeId: recorded.id,
          event: ghEvent,
        });
        healedSubmit = true;
      } catch (err) {
        void err; // already terminal — fine.
      }
      reviewNodeId = null;
      state = await review.readState(store);
    }
  }

  // Round-2 BLOCK-fix 1 + 2: after a submit-heal or a delete-
  // remotely heal, refuse to auto-recreate a pending review
  // inside this reconcile. The rail surfaces the situation and
  // the human confirms via a new intent. The bearer path also
  // refuses to open a fresh pending review — only replay of
  // existing intents is allowed.
  if (!hasIntent || deletedRemotely || healedSubmit) {
    const newlyFailed: Array<{ commentId: string; reason: string }> = [];
    for (const commentId of state.unsyncedCommentIds) {
      const reason = await promotionRefusal(commentId);
      if (reason !== undefined) newlyFailed.push({ commentId, reason });
    }
    return { newlySynced: [], newlyFailed, reviewNodeId, healedSubmit, healedAbandon, deletedRemotely };
  }

  // 2. If we still don't have a reviewNodeId (no local open pending)
  //    and we DO have intents, open a pending review on GitHub and
  //    record `review.opened`.
  //
  // Round-2 BLOCK-fix 2: opening a pending review is itself a
  // HUMAN intent. An agent-bearer reconcile MUST NOT create one —
  // reconcile from the agent bearer is a STRICT REPLAY of already-
  // recorded intents. When there's no pending review, the bearer
  // reconciler returns the failed-count and lets the human retry.
  if (reviewNodeId === null) {
    if (actor.kind !== "local" || !allowMutations) {
      // Agent bearer without an existing pending review: refuse
      // to open one. Every unsynced intent stays unsynced, and
      // the rail's retry surface handles the recovery under the
      // human's identity.
      const newlyFailed: Array<{ commentId: string; reason: string }> = [];
      for (const commentId of state.unsyncedCommentIds) {
        const st = state.commentSync.get(commentId);
        if (st === undefined) continue;
        newlyFailed.push({ commentId, reason: "bearer-refused-to-open-review" });
      }
      return {
        newlySynced: [],
        newlyFailed,
        reviewNodeId: null,
        healedSubmit,
        healedAbandon,
        deletedRemotely,
      };
    }
    let live;
    try {
      live = await review.options.adapter.findOrCreatePendingReview({
        pullRequestNodeId: review.options.summary.nodeId,
        commitOid: currentHeadSha,
        viewerLogin: review.options.viewerLogin,
      });
    } catch (err) {
      throw err;
    }
    if (live.kind === "stale") {
      // A pending review exists but at a different commit — the
      // caller must resolve via the reanchor flow. Do not touch.
      return {
        newlySynced: [],
        newlyFailed: [],
        reviewNodeId: live.review.id,
        healedSubmit,
        healedAbandon,
      };
    }
    reviewNodeId = live.review.id;
    await appendAndPublish({
      kind: "review.opened",
      actor,
      reviewNodeId,
      headSha: live.review.commitSha ?? currentHeadSha,
    });
    state = await review.readState(store);
  }

  // 3. Read the pending review's actual drafts on GitHub.
  let liveDrafts: AdapterPendingReviewComment[] = [];
  try {
    liveDrafts = await review.options.adapter.listPendingReviewComments(reviewNodeId);
  } catch (err) {
    // If listing failed, mark every un-synced intent as failed
    // (with a machine-readable reason) so the rail can show retry.
    const newlyFailed: Array<{ commentId: string; reason: string }> = [];
    for (const commentId of state.unsyncedCommentIds) {
      const st = state.commentSync.get(commentId);
      if (st === undefined) continue;
      newlyFailed.push({ commentId, reason: `list-drafts-failed:${(err as Error).name}` });
      await recordSyncFailure(commentId, `list-drafts-failed:${(err as Error).name}`);
    }
    return { newlySynced: [], newlyFailed, reviewNodeId, healedSubmit, healedAbandon };
  }

  // 4. For each unsynced intent, look for a matching draft already
  //    on GitHub (fingerprint). If present → emit comment.linked.
  //    Otherwise → post via addPendingReviewThread → on success
  //    emit comment.linked; on failure emit comment.sync_failed.
  const newlySynced: string[] = [];
  const newlyFailed: Array<{ commentId: string; reason: string }> = [];
  const usedDraftIds = new Set<string>();
  let liveThreads: readonly GhReviewThread[] | undefined;
  for (const commentId of state.unsyncedCommentIds) {
    const syncState = state.commentSync.get(commentId);
    if (syncState === undefined) continue;
    // syncState is pending-sync or failed; both carry a
    // fingerprint from the LATEST sync_requested via
    // reduceReviewState. A failed state may hold an older
    // fingerprint; scan for the latest one.
    const fingerprint = syncStateFingerprint(syncState);
    if (fingerprint === undefined) continue;
    // Check the actual destination BEFORE either mutation or fingerprint
    // healing. The destination node id stays fixed throughout the loop.
    // GitHub refuses writes if that review closes during a later read.
    // The intent cannot be redirected to another review.
    const refusal = await promotionRefusal(commentId);
    if (refusal !== undefined) {
      newlyFailed.push({ commentId, reason: refusal });
      continue;
    }

    // Replies use a different GitHub mutation and cannot be matched
    // against the pending review's top-level draft coordinates. Read
    // the target thread and look for a new viewer-authored comment
    // with the intended body. This heals an accepted mutation whose
    // response (and therefore comment.linked append) was lost.
    if (fingerprint.replyThreadNodeId !== undefined) {
      if (liveThreads === undefined) {
        liveThreads = await review.options.adapter.listReviewThreads(review.options.pr);
      }
      const remoteThread = liveThreads.find((thread) => thread.id === fingerprint.replyThreadNodeId);
      const known = new Set(fingerprint.knownCommentNodeIds ?? []);
      let matchedReply: { readonly nodeId: string; readonly databaseId: number } | undefined;
      if (remoteThread !== undefined) {
        for (const comment of remoteThread.comments) {
          if (known.has(comment.nodeId) || comment.authorLogin !== review.options.viewerLogin) continue;
          if (await revisionOf(comment.body) !== fingerprint.bodyHash) continue;
          matchedReply = { nodeId: comment.nodeId, databaseId: comment.databaseId };
          break;
        }
      }

      let postedReply = matchedReply;
      if (postedReply === undefined && allowMutations) {
        const threadId = await threadIdOfComment(store, commentId);
        const thread = threadId === undefined ? undefined : await store.thread(threadId);
        const body = thread?.comments.find((comment) => comment.id === commentId)?.body;
        if (body === undefined || await revisionOf(body) !== fingerprint.bodyHash) {
          const reason = body === undefined ? "body-not-in-log" : "body-drift";
          newlyFailed.push({ commentId, reason });
          await recordSyncFailure(commentId, reason);
          continue;
        }
        try {
          const posted = await review.options.adapter.addReviewThreadReply({
            threadNodeId: fingerprint.replyThreadNodeId,
            body,
            pendingReviewId: reviewNodeId,
          });
          postedReply = { nodeId: posted.nodeId, databaseId: posted.databaseId };
        } catch (err) {
          const reason = `adapter:${(err as Error).name}`;
          newlyFailed.push({ commentId, reason });
          await recordSyncFailure(commentId, reason);
          continue;
        }
      }
      if (postedReply !== undefined) {
        await appendAndPublish({
          kind: "comment.linked",
          actor,
          commentId,
          external: {
            github: {
              commentId: postedReply.databaseId,
              nodeId: postedReply.nodeId,
              pending: true,
              reviewNodeId,
            },
          },
        });
        newlySynced.push(commentId);
      }
      continue;
    }
    let matched: AdapterPendingReviewComment | undefined;
    for (const draft of liveDrafts) {
      if (usedDraftIds.has(draft.nodeId)) continue;
      if (await fingerprintMatches(fingerprint, draft)) {
        matched = draft;
        break;
      }
    }
    if (matched !== undefined) {
      usedDraftIds.add(matched.nodeId);
      try {
        await appendAndPublish({
          kind: "comment.linked",
          actor,
          commentId,
          external: {
            github: {
              commentId: matched.databaseId,
              nodeId: matched.nodeId,
              pending: true,
              reviewNodeId,
            },
          },
        });
        newlySynced.push(commentId);
      } catch (err) {
        if (
          err instanceof ThreadStoreAppendError &&
          (err.rejection.kind === "duplicate-link" || err.rejection.kind === "duplicate-external-id")
        ) {
          newlySynced.push(commentId);
        } else {
          throw err;
        }
      }
      continue;
    }
    // Not on GitHub — post it. Rebuild the request from the
    // fingerprint (path, line, side, subjectType, bodyHash) plus
    // the ORIGINAL body which we fetch back from the local thread.
    let submittedBody: string | undefined;
    const thread = await store.thread((await threadIdOfComment(store, commentId)) ?? "");
    if (thread !== undefined) {
      const c = thread.comments.find((x) => x.id === commentId);
      submittedBody = c?.body;
    }
    if (submittedBody === undefined) {
      newlyFailed.push({ commentId, reason: "body-not-in-log" });
      await recordSyncFailure(commentId, "body-not-in-log");
      continue;
    }
    // Round-2 BLOCK-fix 2 (body drift): compare the CURRENT
    // thread body's hash against the fingerprint's bodyHash. If
    // they don't match, an editor changed the body after the
    // intent was recorded. Refuse the retry — the human must
    // re-request the intent (via a new POST) so a fresh
    // sync_requested carries the current body's hash. The old
    // reconciler would have posted the CURRENT body under the
    // OLD intent, letting an edit ship without a fresh trip
    // through the log.
    const currentBodyHash = await revisionOf(submittedBody);
    if (fingerprint.bodyHash !== currentBodyHash) {
      newlyFailed.push({ commentId, reason: "body-drift" });
      await recordSyncFailure(commentId, "body-drift");
      continue;
    }
    // Recompute the outgoing body: if the fingerprint said FILE and
    // the local thread carries a plain body without the preamble
    // (rare — only when the anchor mapping fell back), we may need
    // to prepend it here. Simpler and correct: recompute from
    // anchor + files. If mapping now says orphan, mark failed.
    if (thread === undefined || !isLineAnchor(thread.anchor)) {
      // An unanchored thread should never reach this path — its
      // anchor is `unanchored` and we never queued a sync request
      // for it. Defensive fail.
      newlyFailed.push({ commentId, reason: "unanchored-thread" });
      await recordSyncFailure(commentId, "unanchored-thread");
      continue;
    }
    const mapping = mapAnchorForPending(thread.anchor, review.options.files, submittedBody);
    if (mapping.kind === "orphan") {
      newlyFailed.push({ commentId, reason: mapping.reason });
      await recordSyncFailure(commentId, mapping.reason);
      continue;
    }
    if (!allowMutations) continue;
    try {
      const posted = await review.options.adapter.addPendingReviewThread({
        reviewId: reviewNodeId,
        path: mapping.path,
        body: mapping.submittedBody,
        subjectType: mapping.kind === "file" ? "FILE" : "LINE",
        ...(mapping.kind === "line" ? { line: mapping.line, side: mapping.side } : {}),
        ...(mapping.kind === "line" && mapping.startLine !== undefined ? { startLine: mapping.startLine } : {}),
      });
      await appendAndPublish({
        kind: "comment.linked",
        actor,
        commentId,
        external: {
          github: {
            commentId: posted.databaseId,
            nodeId: posted.nodeId,
            pending: true,
            reviewNodeId,
          },
        },
      });
      newlySynced.push(commentId);
    } catch (err) {
      if (
        err instanceof ThreadStoreAppendError &&
        (err.rejection.kind === "duplicate-link" || err.rejection.kind === "duplicate-external-id")
      ) {
        newlySynced.push(commentId);
      } else {
        const reason = `adapter:${(err as Error).name}`;
        newlyFailed.push({ commentId, reason });
        await recordSyncFailure(commentId, reason);
      }
    }
  }

  return { newlySynced, newlyFailed, reviewNodeId, healedSubmit, healedAbandon };
}

/** Extract the fingerprint from a sync state entry. Returns
 * undefined when the state is `synced` or `not-attempted` (no
 * intent still-pending). For `failed`, the previous
 * `sync_requested`'s fingerprint is the one to retry against — but
 * we cannot recover it from the CommentSyncState alone (it's only
 * kept for `pending-sync`). The daemon rebuilds a fresh
 * `sync_requested` before invoking reconcile on retry, so
 * `failed`'s fingerprint isn't needed here. */
function syncStateFingerprint(state: CommentSyncState): SyncFingerprint | undefined {
  if (state.kind === "pending-sync") return state.fingerprint;
  if (state.kind === "failed") return state.fingerprint;
  return undefined;
}

/** Look up the local threadId for a comment via the store. Reads
 * the log's `comment.created` and `comment.replied` events; slow
 * but only used on the reconciler's rare fallback path. */
async function threadIdOfComment(store: ThreadStore, commentId: string): Promise<string | undefined> {
  const events = await store.since(0);
  for (const evt of events) {
    if ((evt.kind === "comment.created" || evt.kind === "comment.replied") && evt.commentId === commentId) {
      return evt.threadId;
    }
  }
  return undefined;
}

/** Head-move re-anchor + repost. Correct ordering (BLOCK-fix):
 *
 *   (a) Compute ALL mappings first. Append `thread.orphaned` for
 *       unmappable comments so orphans are never silently dropped.
 *   (b) Delete the OLD pending review on GitHub. On adapter failure,
 *       STOP — do NOT append `review.abandoned`, so a retry can
 *       resume. (Old failure path swallowed the error.)
 *   (c) Append `review.abandoned`.
 *   (d) Append fresh `comment.sync_requested` events for the
 *       carried-forward comments; run `reconcile()` to let the
 *       normal reconciler post them. Per-item failures land as
 *       `comment.sync_failed` and stay retryable. */
export interface HeadMoveReanchorResult {
  readonly abandonedReviewNodeId: string;
  readonly newIntents: number;
  readonly orphaned: number;
  readonly repositions: ReadonlyArray<{
    readonly localCommentId: string;
    readonly path: string;
    readonly outcome: "moved" | "fuzzy" | "file-fallback" | "orphaned";
    readonly reason?: string;
  }>;
  /** The reconcile pass that ran after re-anchoring, so callers
   * can surface newly-synced vs newly-failed counts. */
  readonly reconcile: ReconcileOutcome;
}

export async function reanchorPendingReviewAtNewHead(input: {
  readonly review: ReviewModeHandle;
  readonly store: ThreadStore & { getSnapshot(revision: string): string | undefined; putSnapshot(revision: string, source: string): boolean };
  readonly actor: Author;
  readonly appendAndPublish: (input: ReviewEventInput) => Promise<ReviewEvent | undefined>;
}): Promise<HeadMoveReanchorResult> {
  const { review, store, actor, appendAndPublish } = input;
  const state = await review.readState(store);
  if (state.openPending === null) {
    throw new Error("reanchorPendingReviewAtNewHead: no open pending review");
  }
  const oldReviewNodeId = state.openPending.reviewNodeId;
  const oldHeadSha = state.openPending.headSha;
  const newHeadSha = review.currentHeadSha();
  if (oldHeadSha.toLowerCase() === newHeadSha.toLowerCase()) {
    throw new Error("reanchorPendingReviewAtNewHead: head has not moved");
  }

  // (a) Compute all mappings first.
  interface Reposition {
    readonly commentId: string;
    readonly threadId: string;
    readonly path: string;
    readonly newAnchor?: Anchor;
    readonly outcome: "moved" | "fuzzy" | "orphaned";
    readonly score?: number;
    readonly reason?: string;
  }
  const perComment: Reposition[] = [];
  const newSourceByPath = new Map<string, string | undefined>();

  // Enumerate LOCAL comments whose sync intent points at the OLD
  // pending review. The openPending comments field holds the
  // SYNCED set; for unsynced intents that never reached
  // comment.linked, we also walk the commentSync map.
  const commentIds = new Set<string>();
  for (const c of state.openPending.comments) commentIds.add(c.commentId);
  for (const [cid, st] of state.commentSync) {
    if (st.kind === "pending-sync" || st.kind === "failed") commentIds.add(cid);
  }

  for (const commentId of commentIds) {
    const threadId = await threadIdOfComment(store, commentId);
    if (threadId === undefined) continue;
    const thread = await store.thread(threadId);
    if (thread === undefined) continue;
    if (!isLineAnchor(thread.anchor)) {
      perComment.push({
        commentId,
        threadId,
        path: thread.anchor.path,
        outcome: "orphaned",
        reason: "unanchored-source-thread",
      });
      continue;
    }
    const oldAnchor = thread.anchor;
    const oldSource = store.getSnapshot(oldAnchor.revision);
    if (oldSource === undefined) {
      perComment.push({
        commentId,
        threadId,
        path: oldAnchor.path,
        outcome: "orphaned",
        reason: "missing-old-snapshot",
      });
      continue;
    }
    let newSource = newSourceByPath.get(oldAnchor.path);
    if (newSource === undefined && !newSourceByPath.has(oldAnchor.path)) {
      try {
        const result = await review.options.adapter.fetchBlobText({
          owner: review.options.pr.owner,
          repo: review.options.pr.repo,
          expression: `${newHeadSha}:${oldAnchor.path}`,
        });
        newSource = result.kind === "text" ? result.text : undefined;
      } catch {
        newSource = undefined;
      }
      newSourceByPath.set(oldAnchor.path, newSource);
    }
    if (newSource === undefined) {
      perComment.push({
        commentId,
        threadId,
        path: oldAnchor.path,
        outcome: "orphaned",
        reason: "new-source-unavailable",
      });
      continue;
    }
    const result = await reanchor(oldAnchor, oldSource, newSource);
    if (result.kind === "anchored" || result.kind === "moved" || result.kind === "fuzzy") {
      const newAnchor: Anchor = result.kind === "anchored" ? oldAnchor : result.anchor;
      if (result.kind !== "anchored") {
        store.putSnapshot(newAnchor.revision, newSource);
      }
      perComment.push({
        commentId,
        threadId,
        path: oldAnchor.path,
        newAnchor,
        outcome: result.kind === "fuzzy" ? "fuzzy" : "moved",
        ...(result.kind === "fuzzy" ? { score: result.score } : {}),
      });
    } else {
      perComment.push({
        commentId,
        threadId,
        path: oldAnchor.path,
        outcome: "orphaned",
        reason: result.reason,
      });
    }
  }

  // Emit `thread.orphaned` for unmappable comments FIRST — orphans
  // must be visible before the abandon lands. Refused
  // `already-orphaned` is fine.
  for (const p of perComment) {
    if (p.outcome !== "orphaned") continue;
    try {
      const rev = await revisionOf(
        newSourceByPath.get(p.path) ?? `head-move-unavailable:${newHeadSha}:${p.path}\n`,
      );
      await appendAndPublish({
        kind: "thread.orphaned",
        actor,
        threadId: p.threadId,
        revision: rev,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      });
    } catch {
      /* already-orphaned — fine */
    }
  }

  // (b) Delete the old pending review on GitHub. On failure STOP —
  // do not append review.abandoned; the reviewer can retry.
  await review.options.adapter.deletePendingReview({ reviewId: oldReviewNodeId });

  // (c) Append review.abandoned.
  try {
    await appendAndPublish({
      kind: "review.abandoned",
      actor,
      reviewNodeId: oldReviewNodeId,
      reason: "head-moved",
    });
  } catch (err) {
    if (
      err instanceof ThreadStoreAppendError &&
      err.rejection.kind === "review-not-pending"
    ) {
      /* already terminal — fine */
    } else {
      throw err;
    }
  }

  // (d) Emit fresh sync_requested for each carried-forward
  // comment. The reconciler then opens a new pending review and
  // posts them.
  let newIntents = 0;
  let orphaned = 0;
  const repositions: Array<{
    localCommentId: string;
    path: string;
    outcome: "moved" | "fuzzy" | "file-fallback" | "orphaned";
    reason?: string;
  }> = [];
  const reanchoredThreadIds = new Set<string>();
  for (const p of perComment) {
    if (p.outcome === "orphaned") {
      orphaned++;
      repositions.push({
        localCommentId: p.commentId,
        path: p.path,
        outcome: "orphaned",
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      });
      continue;
    }
    if (p.newAnchor === undefined) continue;
    // One thread can contain several pending replies. Move its local
    // anchor once; each comment below keeps its own body/operation.
    if (!reanchoredThreadIds.has(p.threadId)) {
      if (p.outcome === "fuzzy") {
        if (p.score === undefined) throw new Error("fuzzy re-anchor result is missing its score");
        await appendAndPublish({
          kind: "thread.reanchored",
          actor,
          threadId: p.threadId,
          anchor: p.newAnchor,
          method: "fuzzy",
          score: p.score,
        });
      } else {
        await appendAndPublish({
          kind: "thread.reanchored",
          actor,
          threadId: p.threadId,
          anchor: p.newAnchor,
          method: "quote-exact",
        });
      }
      reanchoredThreadIds.add(p.threadId);
    }
    const thread = await store.thread(p.threadId);
    if (thread === undefined) continue;
    const body = thread.comments.find((comment) => comment.id === p.commentId)?.body;
    if (body === undefined) continue;
    const previousSync = state.commentSync.get(p.commentId);
    const previousFingerprint = previousSync !== undefined && "fingerprint" in previousSync
      ? previousSync.fingerprint
      : undefined;
    if (previousFingerprint?.replyThreadNodeId !== undefined) {
      await appendAndPublish({
        kind: "comment.sync_requested",
        actor,
        commentId: p.commentId,
        path: p.newAnchor.path,
        subjectType: "FILE",
        bodyHash: await revisionOf(body),
        replyThreadNodeId: previousFingerprint.replyThreadNodeId,
        ...(previousFingerprint.knownCommentNodeIds !== undefined
          ? { knownCommentNodeIds: [...previousFingerprint.knownCommentNodeIds] }
          : {}),
      });
      newIntents++;
      repositions.push({
        localCommentId: p.commentId,
        path: p.path,
        outcome: p.outcome === "fuzzy" ? "fuzzy" : "moved",
      });
      continue;
    }
    const mapping = mapAnchorForPending(p.newAnchor, review.options.files, body);
    if (mapping.kind === "orphan") {
      // Round-2 nit: an orphan mapping AFTER a reanchor must
      // emit `thread.orphaned` so the rail's orphan panel picks
      // it up. Previously we only counted it — no event landed
      // on the log.
      try {
        await appendAndPublish({
          kind: "thread.orphaned",
          actor,
          threadId: p.threadId,
          revision: p.newAnchor.revision,
          reason: `reanchor-mapping-orphan:${mapping.reason}`,
        });
      } catch {
        /* already orphaned — fine */
      }
      orphaned++;
      repositions.push({
        localCommentId: p.commentId,
        path: p.path,
        outcome: "orphaned",
        reason: mapping.reason,
      });
      continue;
    }
    const req = await buildSyncRequest({ actor, commentId: p.commentId, mapping });
    await appendAndPublish(req);
    newIntents++;
    repositions.push({
      localCommentId: p.commentId,
      path: p.path,
      outcome: mapping.kind === "file" ? "file-fallback" : p.outcome === "fuzzy" ? "fuzzy" : "moved",
    });
  }

  // Run the reconciler now to actually post the new intents. The
  // reconciler opens a fresh pending review on GitHub as needed.
  const reconcileOutcome = await reconcile({ review, store, actor, appendAndPublish, allowMutations: true });

  return {
    abandonedReviewNodeId: oldReviewNodeId,
    newIntents,
    orphaned,
    repositions,
    reconcile: reconcileOutcome,
  };
}

/** Compute how many local comments still owe a GitHub write. Used by
 * the submit gate: submit is only allowed when this is zero AND the
 * pending review is not stale. */
export function unsyncedCount(state: ReviewState): number {
  return state.unsyncedCommentIds.length;
}

/** What `findDraftToPromote` resolved a promotion request to. */
export type DraftToPromote =
  | {
      /** An agent-authored COMMENT (top-level or reply) to promote. */
      readonly kind: "comment";
      readonly thread: Thread;
      readonly comment: Thread["comments"][number];
      /** True when the draft is a REPLY — the reconciler posts it
       * through `addReviewThreadThreadReply` against
       * `thread.external.threadId` rather than opening a new draft.
       * Narrowing this flag also narrows `replyThreadNodeId`, so the
       * caller never has to re-narrow or cast `thread.external`. */
      readonly reply: boolean;
      /** The GitHub thread node a reply posts into. Present iff
       * `reply` — `findDraftToPromote` refuses a reply on a thread with
       * no GitHub origin before getting here. */
      readonly replyThreadNodeId?: string;
      /** The seq of the `draft.promoted` already in the log for this
       * exact draft, or `undefined` when the reviewer has not promoted
       * it yet. Two halves of crash recovery read this: the caller skips
       * a second promotion when it is set, and still appends the
       * missing intent when `intentRecorded` is false. */
      readonly promotedAtSeq: number | undefined;
      /** True when the machine intent (`comment.sync_requested`) follows
       * this draft's latest promotion in the log. A promotion whose intent append was lost is
       * `promotedAtSeq` set + this false, and the caller repairs it. */
      readonly intentRecorded: boolean;
      /** The content pin the reviewer's promotion recorded: the `seq` of
       * the authoring event and `revisionOf(body)` of the text they
       * approved. `findDraftToPromote` has already refused a body that
       * no longer matches, so these are what a NEW promotion must
       * record. */
      readonly commentSeq: number;
      /** The pin already on the log, when one is. */
      readonly promotedPin?: { readonly commentSeq: number; readonly bodyHash: string };
    }
  | {
      /** An agent-authored resolve/reopen to promote. */
      readonly kind: "lifecycle";
      readonly thread: Thread;
      readonly desiredResolved: boolean;
      readonly promotedAtSeq: number | undefined;
    };

/** Resolve a `POST /api/review/promote` body to the draft it names
 * (issue #70), or say precisely why there is nothing to promote.
 *
 * The rules, each with its own refusal reason so the route answers
 * with a machine-readable `error`:
 *   - `unknown-thread` / `unknown-comment` — the named ids are not in
 *     the log.
 *   - `not-an-agent-draft` — the comment or the lifecycle change was
 *     the REVIEWER's own act. A reviewer's own comment mirrors itself
 *     (or has already mirrored); promoting it would be a no-op at best
 *     and a misattribution at worst.
 *   - `no-github-thread` — a reply draft has no remote thread to
 *     reply to, so there is nothing to promote it into.
 *   - `stale-lifecycle-draft` — the thread's current state no longer
 *     matches the named target (e.g. promoting `resolve` on a thread
 *     that is open), so the promotion would not describe what it
 *     promotes.
 *
 * `target` on the request is what makes the last check meaningful: a
 * `resolve` promotion names a RESOLVED thread and a `reopen`
 * promotion an OPEN one. */
export async function findDraftToPromote(input: {
  readonly store: ThreadStore;
  readonly threadId: string;
  readonly target: "comment" | "resolve" | "reopen";
  readonly commentId?: string;
}): Promise<{ readonly ok: true; readonly draft: DraftToPromote } | { readonly ok: false; readonly error: string; readonly detail: string }> {
  const events = await input.store.since(0);
  const thread = await input.store.thread(input.threadId);
  if (thread === undefined) {
    return { ok: false, error: "unknown-thread", detail: `thread '${input.threadId}' is not in the log.` };
  }
  if (input.target === "comment") {
    const commentId = input.commentId ?? "";
    const comment = thread.comments.find((entry) => entry.id === commentId);
    if (comment === undefined) {
      return { ok: false, error: "unknown-comment", detail: `comment '${commentId}' is not in thread '${thread.id}'.` };
    }
    const authoredBy = commentAuthorKind(events, commentId);
    if (authoredBy !== "agent") {
      return {
        ok: false,
        error: "not-an-agent-draft",
        detail: `comment '${commentId}' was authored by '${authoredBy ?? "unknown"}' — only an agent's draft can be promoted.`,
      };
    }
    // Issue #70 round 2: refuse a draft whose body has moved since the
    // reviewer last approved it. There is no edit route today, so this
    // cannot fire yet — which is exactly why it is pinned here rather
    // than left to the day an edit route lands. The check is on the
    // CURRENT body against the pin the last promotion recorded; a
    // promotion that pinned nothing (a log written before the pin
    // existed) cannot be compared and is reported so the caller can
    // refuse it rather than promote unknown text.
    const promotedAtSeq = promotionSeqFor(events, { threadId: thread.id, target: "comment", commentId });
    const pinned = promotionPinFor(events, commentId);
    if (pinned !== undefined) {
      const currentHash = await revisionOf(comment.body);
      if (currentHash !== pinned.bodyHash) {
        return {
          ok: false,
          error: "promoted-body-changed",
          detail:
            `comment '${commentId}' has changed since it was promoted (the approved text hashes to ` +
            `${pinned.bodyHash.slice(0, 12)}…, the current text to ${currentHash.slice(0, 12)}…) — ` +
            `review the current text and promote it again.`,
        };
      }
    } else if (promotedAtSeq !== undefined) {
      return {
        ok: false,
        error: "promoted-body-changed",
        detail: `comment '${commentId}' was promoted without a content pin, so its current text cannot be shown to be the approved text.`,
      };
    }
    const reply = !events.some((event) => event.kind === "comment.created" && event.commentId === commentId);
    // Narrowing here is what lets the caller build a reply intent
    // without re-narrowing (or casting) `thread.external`.
    const githubThreadId = thread.external?.provider === "github" ? thread.external.threadId : undefined;
    if (reply && githubThreadId === undefined) {
      return {
        ok: false,
        error: "no-github-thread",
        detail: `comment '${commentId}' is a reply on a thread with no GitHub origin — there is no remote thread to reply to.`,
      };
    }
    return {
      ok: true,
      draft: {
        kind: "comment",
        thread,
        comment,
        reply,
        ...(githubThreadId !== undefined ? { replyThreadNodeId: githubThreadId } : {}),
        promotedAtSeq,
        intentRecorded: intentRecordedFor(events, commentId, promotedAtSeq),
        commentSeq: authoringSeqOf(events, commentId) ?? 0,
        ...(pinned !== undefined ? { promotedPin: pinned } : {}),
      },
    };
  }
  // The lifecycle arm reads the SAME shared derivation the rail's draft
  // list and `reconcileThreadStateIntents` read, so "which change is
  // this thread's current one, and has it been promoted" has exactly
  // one implementation (issue #70 review, finding 2).
  const lifecycle = reduceThreadLifecycleStates(events).get(input.threadId);
  if (lifecycle === undefined) {
    return {
      ok: false,
      error: "stale-lifecycle-draft",
      detail: `thread '${thread.id}' has no lifecycle change on the log to promote.`,
    };
  }
  if (lifecycle.target !== input.target) {
    return {
      ok: false,
      error: "stale-lifecycle-draft",
      detail: `thread '${thread.id}' currently carries a '${lifecycle.target}'${lifecycle.actorKind === "local" ? " of the reviewer's own" : ""}, not a '${input.target}' — there is no '${input.target}' to promote.`,
    };
  }
  if (lifecycle.actorKind !== "agent") {
    return {
      ok: false,
      error: "not-an-agent-draft",
      detail: `the current '${input.target}' on thread '${thread.id}' was the reviewer's own act — there is no agent draft to promote.`,
    };
  }
  if (thread.external?.provider !== "github") {
    return {
      ok: false,
      error: "no-github-thread",
      detail: `thread '${thread.id}' has no GitHub origin — there is no remote thread to resolve.`,
    };
  }
  return {
    ok: true,
    draft: {
      kind: "lifecycle",
      thread,
      desiredResolved: lifecycle.desiredResolved,
      promotedAtSeq: lifecycle.promotedAtSeq,
    },
  };
}

/** The seq of the `draft.promoted` that names this exact draft, or
 * `undefined`. Matches on the draft's own identity — and, for a
 * lifecycle target, only when the shared derivation still considers
 * that change current, so a promotion the log has but that a later
 * opposite lifecycle change superseded does NOT count as promoted
 * (the reviewer may promote the replacement instead). */
function promotionSeqFor(
  events: readonly ReviewEvent[],
  draft: { readonly threadId: string; readonly target: "comment" | "resolve" | "reopen"; readonly commentId?: string },
): number | undefined {
  if (draft.target !== "comment") {
    return reduceThreadLifecycleStates(events).get(draft.threadId)?.promotedAtSeq;
  }
  const commentId = draft.commentId ?? "";
  let promoted: number | undefined;
  for (const event of events) {
    if (event.kind !== "draft.promoted" || event.target !== "comment") continue;
    if ((event.commentId ?? "") !== commentId) continue;
    if (promoted === undefined || event.seq > promoted) promoted = event.seq;
  }
  return promoted;
}

/** The content pin on the most recent promotion of this comment, or
 * `undefined` when no promotion carries one. */
function promotionPinFor(
  events: readonly ReviewEvent[],
  commentId: string,
): { readonly commentSeq: number; readonly bodyHash: string } | undefined {
  let pin: { readonly commentSeq: number; readonly bodyHash: string } | undefined;
  for (const event of events) {
    if (event.kind !== "draft.promoted" || event.target !== "comment") continue;
    if ((event.commentId ?? "") !== commentId) continue;
    if (event.commentSeq === undefined || event.bodyHash === undefined) continue;
    pin = { commentSeq: event.commentSeq, bodyHash: event.bodyHash };
  }
  return pin;
}

/** The `seq` of the event that authored this comment — what a NEW
 * promotion pins. */
function authoringSeqOf(events: readonly ReviewEvent[], commentId: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if ((event.kind === "comment.created" || event.kind === "comment.replied") && event.commentId === commentId) {
      return event.seq;
    }
  }
  return undefined;
}

/** True when an intent or completion follows this comment's latest
 * promotion. An earlier review's intent cannot satisfy a fresh promotion.
 * A promotion that landed without its intent is
 * `promotedAtSeq` set and this false — the state a retry repairs.
 *
 * INVARIANT this rests on: a `comment.linked` for an agent-authored
 * comment is only ever appended BY the reconciler, inside its loop over
 * `comment.sync_requested` intents (plus the adapter's import path,
 * which mints `gh-…` ids or reuses an already-linked id). So for an
 * agent draft, `comment.linked` here implies an intent was recorded —
 * and treating it as "the intent is present" is therefore safe. If a
 * future writer ever links a comment with NO intent, this predicate
 * would report `intentRecorded: true`, the route would skip the intent
 * append, and the promotion would sit in the log authorizing nothing —
 * the shape round 1 called unreachable. The test "a linked agent
 * comment always has an intent behind it" in
 * `packages/cli/test/serve/review-mode-promote.test.ts` pins it, so the
 * day it breaks, the test breaks with it. */
function intentRecordedFor(events: readonly ReviewEvent[], commentId: string, promotionSeq: number | undefined): boolean {
  return events.some(
    (event) =>
      (event.kind === "comment.sync_requested" || event.kind === "comment.linked") && event.commentId === commentId &&
      (promotionSeq === undefined || event.seq > promotionSeq),
  );
}

/** The actor kind that authored a comment (`comment.created` /
 * `comment.replied`), or undefined when the comment is not in the log. */
function commentAuthorKind(
  events: readonly ReviewEvent[],
  commentId: string,
): ReviewEvent["actor"]["kind"] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if ((event.kind === "comment.created" || event.kind === "comment.replied") && event.commentId === commentId) {
      return event.actor.kind;
    }
  }
  return undefined;
}
