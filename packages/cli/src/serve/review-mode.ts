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
  type PendingReviewComment as AdapterPendingReviewComment,
  type PrRef,
  type PrFile,
  type PullRequestSummary,
  type ReviewEvent,
  type ReviewEventInput,
  type ReviewState,
  type ReviewSubmitEvent,
  type SyncFingerprint,
  type ThreadStore,
  ThreadStoreAppendError,
  anchorToPrComment,
  fileFallbackPreamble,
  isLineAnchor,
  isPendingReviewStale,
  reanchor,
  reduceReviewState,
  revisionOf,
} from "@revkit/review-core";

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
  const { review, store, actor, appendAndPublish } = input;

  let state = await review.readState(store);
  const currentHeadSha = review.currentHeadSha();

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

  // If the log records an open pending review, check it exists on
  // GitHub. If not, it was submitted or deleted elsewhere — heal.
  if (state.openPending !== null) {
    // A single GraphQL query returns the viewer's current pending
    // review + commit oid. Compare with what the log has.
    let live;
    try {
      live = await review.options.adapter.findOrCreatePendingReview({
        pullRequestNodeId: review.options.summary.nodeId,
        commitOid: state.openPending.headSha,
        viewerLogin: review.options.viewerLogin,
      });
    } catch (err) {
      // Network hiccup — bail; the caller will retry.
      throw err;
    }
    if (live.kind === "reused") {
      // Good — the log's open pending review still exists.
      reviewNodeId = live.review.id;
    } else if (live.kind === "created") {
      // The log thought a pending review existed but GitHub had
      // none — mark the old one abandoned locally and adopt the
      // new one. Then walk the intents (which point at the OLD
      // reviewNodeId) — they still need to sync on the NEW review.
      if (state.openPending.reviewNodeId !== live.review.id) {
        try {
          await appendAndPublish({
            kind: "review.abandoned",
            actor,
            reviewNodeId: state.openPending.reviewNodeId,
            reason: "reconciler-healed-missing",
          });
          healedAbandon = true;
        } catch (err) {
          // Already terminal / racing — fine.
          void err;
        }
        await appendAndPublish({
          kind: "review.opened",
          actor,
          reviewNodeId: live.review.id,
          headSha: state.openPending.headSha,
        });
        reviewNodeId = live.review.id;
        state = await review.readState(store);
      }
    } else {
      // stale: the pending review is pinned to a different commit
      // than we asked for. That means the head moved and we asked
      // via `state.openPending.headSha`. Not our reconciler's job
      // to fix — the reanchor flow does that. Return the stale
      // shape via state.stale flag.
      reviewNodeId = live.review.id;
    }
  }

  if (!hasIntent) {
    return { newlySynced: [], newlyFailed: [], reviewNodeId, healedSubmit, healedAbandon };
  }

  // 2. If we still don't have a reviewNodeId (no local open pending)
  //    and we DO have intents, open a pending review on GitHub and
  //    record `review.opened`. Idempotent by construction —
  //    findOrCreatePendingReview reuses an existing viewer pending
  //    review if one already exists.
  if (reviewNodeId === null) {
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
      await appendAndPublish({
        kind: "comment.sync_failed",
        actor,
        commentId,
        reason: `list-drafts-failed:${(err as Error).name}`,
      });
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
  for (const commentId of state.unsyncedCommentIds) {
    const syncState = state.commentSync.get(commentId);
    if (syncState === undefined) continue;
    // syncState is pending-sync or failed; both carry a
    // fingerprint from the LATEST sync_requested via
    // reduceReviewState. A failed state may hold an older
    // fingerprint; scan for the latest one.
    const fingerprint = syncStateFingerprint(syncState);
    if (fingerprint === undefined) continue;
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
      await appendAndPublish({
        kind: "comment.sync_failed",
        actor,
        commentId,
        reason: "body-not-in-log",
      });
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
      await appendAndPublish({
        kind: "comment.sync_failed",
        actor,
        commentId,
        reason: "unanchored-thread",
      });
      continue;
    }
    const mapping = mapAnchorForPending(thread.anchor, review.options.files, submittedBody);
    if (mapping.kind === "orphan") {
      newlyFailed.push({ commentId, reason: mapping.reason });
      await appendAndPublish({
        kind: "comment.sync_failed",
        actor,
        commentId,
        reason: mapping.reason,
      });
      continue;
    }
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
        await appendAndPublish({
          kind: "comment.sync_failed",
          actor,
          commentId,
          reason,
        });
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
    // Emit thread.reanchored so the rail moves the marker.
    try {
      const method: "quote-exact" | "fuzzy" = p.outcome === "fuzzy" ? "fuzzy" : "quote-exact";
      await appendAndPublish({
        kind: "thread.reanchored",
        actor,
        threadId: p.threadId,
        anchor: p.newAnchor,
        method,
        // Fuzzy score isn't threaded through the reanchor result
        // — omit and the wire schema's `superRefine` accepts.
      } as ReviewEventInput);
    } catch {
      /* fine */
    }
    const thread = await store.thread(p.threadId);
    if (thread === undefined) continue;
    const body = thread.comments[0]?.body ?? "";
    const mapping = mapAnchorForPending(p.newAnchor, review.options.files, body);
    if (mapping.kind === "orphan") {
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
  const reconcileOutcome = await reconcile({ review, store, actor, appendAndPublish });

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
