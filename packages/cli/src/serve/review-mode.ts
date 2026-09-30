// Review-mode integration for the daemon (M3 part 2b, ADR-0025).
//
// When `startDaemon` is invoked with a `reviewMode` option, the daemon
// carries a live GitHub adapter, a PR ref and the reviewer's `gh`
// token (in memory only, ADR-0013). Every human-authored comment
// posted to `/api/threads` (POST) is mapped onto a `(path, line/
// start_line, side)` — or a file-level position when the block sits
// outside the PR's diff hunks — and added to the reviewer's PENDING
// GitHub review via `GitHubAdapter.addPendingReviewThread`.
//
// Pending-review LIFECYCLE is derived from the log (`reduceReviewState`),
// not held in memory. The daemon writes:
//
//   1. `review.opened(reviewNodeId, headSha)`  — the first time we
//      touch GitHub in this daemon lifetime; carries the pending
//      review's GraphQL id and the head SHA the review is pinned to.
//   2. `comment.linked` events with `external.github.pending: true`
//      and `reviewNodeId` for every pending comment we post.
//   3. `review.submitted(reviewNodeId, event, body?)`  — on submit.
//   4. `review.abandoned(reviewNodeId, reason)`  — on head-move
//      before re-opening a fresh review at the new head.
//
// The event kinds are enforced by the validator (`duplicate-review`,
// `review-not-pending`), so a restart's boot-time hydration derives
// the same pending set the daemon had before shutdown.
//
// Security (ADR-0009, ADR-0013):
//
//   - Every write to GitHub goes through the adapter, and the
//     adapter is called ONLY from human-authenticated request paths
//     (session cookie). The daemon refuses `POST /api/review/submit`
//     and `POST /api/review/refresh` when the caller presents the
//     agent bearer token — an agent MUST NOT be able to submit or
//     approve a review on the human's behalf.
//   - Idempotency: mutations are never auto-retried (adapter policy).
//     Every `addPendingReviewThread` result is captured on
//     `comment.linked`, so a retry after a network flake WOULD show
//     up as `duplicate-external-id` on the second attempt.
//   - Tokens never touch the browser or the log. The adapter holds
//     the reviewer's `gh` token in memory; the daemon reads it via
//     the injected `TokenSource`.

import {
  type Anchor,
  type AnyAnchor,
  type Author,
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
  type DerivedPendingReviewComment,
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

/** Options the daemon accepts in review-mode. Provided by
 * `packages/cli/src/review/cli.ts` after the safe PR-head build
 * finishes. Every write on this shape carries the reviewer's
 * IDENTITY (their `gh` token), so nothing on this shape crosses
 * the wire to the browser or to the agent. */
export interface ReviewModeOptions {
  /** GitHub adapter, ready-to-call. Constructed by the CLI with the
   * reviewer's TokenSource (`createGhTokenSource(gh)`). */
  readonly adapter: GitHubAdapter;
  /** PR coordinate the daemon reviews. */
  readonly pr: PrRef;
  /** Cached PR summary from the last `getPullRequest` call. The
   * head-move refresh routine mutates this in-place after a
   * re-fetch. */
  summary: PullRequestSummary;
  /** The reviewer's GitHub login — used by `findOrCreatePendingReview`
   * to look up an existing pending review by author, and by the rail
   * / channel to attribute the pending draft. */
  readonly viewerLogin: string;
  /** PR file list — anchor-map input. Refreshed on head move. */
  files: readonly PrFile[];
  /** Whether the reviewer passed `--trust <sha>` (unlocks fork PRs
   * or PRs whose tooling files differ from base). Recorded for
   * refresh; the head-move flow refuses a re-fetch that doesn't
   * still match the trust. */
  readonly trustSha?: string;
}

/** Public handle a caller uses to interact with review-mode state.
 * `pendingCommentsFromLog` re-reads the log every call (cheap) so
 * the derived state cannot drift; the memory-only fields are the
 * adapter and the (mutable) PR summary. */
export interface ReviewModeHandle {
  readonly options: ReviewModeOptions;
  /** True when the caller-provided actor kind must not perform
   * review writes (submit / approve / request-changes / any
   * mutation on the pending review). The agent bearer is refused;
   * a session-cookie caller is allowed. */
  refuseAgent(actor: Author): boolean;
  /** Read the current pending-review state from the log. */
  readState(store: ThreadStore): Promise<ReviewState>;
  /** Return the current PR head SHA (from the cached summary). */
  currentHeadSha(): string;
  /** Update the cached summary / files (used by the head-move
   * refresh path). */
  refreshSummary(summary: PullRequestSummary, files: readonly PrFile[]): void;
}

/** Build a `ReviewModeHandle` from options. Pure — the handle
 * closes over the mutable `options` slot. */
export function makeReviewModeHandle(options: ReviewModeOptions): ReviewModeHandle {
  let files = options.files;
  let summary = options.summary;
  return {
    options,
    refuseAgent(actor: Author): boolean {
      return actor.kind === "agent";
    },
    async readState(store: ThreadStore): Promise<ReviewState> {
      const events = await store.since(0);
      return reduceReviewState(events);
    },
    currentHeadSha(): string {
      return summary.headSha;
    },
    refreshSummary(next: PullRequestSummary, nextFiles: readonly PrFile[]): void {
      summary = next;
      files = nextFiles;
      // Mutate the options record too so any handler reading
      // options.summary sees the update.
      (options as { summary: PullRequestSummary }).summary = next;
      (options as { files: readonly PrFile[] }).files = nextFiles;
    },
  };
}

/** Result of `linkCommentAsPendingReviewComment`. */
export type LinkPendingOutcome =
  | { readonly kind: "linked"; readonly reviewNodeId: string; readonly pendingComment: AdapterPendingReviewComment; readonly reason?: "file-fallback" }
  | { readonly kind: "orphaned"; readonly reason: string }
  | { readonly kind: "stale"; readonly reviewNodeId: string; readonly expectedHeadSha: string; readonly actualHeadSha: string | null };

/**
 * Post a local `comment.created` event as a pending-review comment.
 *
 * Steps:
 *   1. Ensure a pending review exists at the CURRENT headSha. If a
 *      previous `review.opened` in the log names a different headSha,
 *      short-circuit `{ kind: "stale" }` so the caller can prompt the
 *      reviewer through the re-anchor / abandon flow.
 *   2. Map the anchor to a GitHub position (line / file-level).
 *   3. Call `adapter.addPendingReviewThread` (never auto-retries;
 *      idempotent-in-shape: a duplicate call would fail on the second
 *      `comment.linked` at `duplicate-external-id`).
 *   4. Append the `review.opened` event (once) and the
 *      `comment.linked` event.
 *
 * All GitHub writes are gated by the caller (`daemon.ts` only invokes
 * this on a cookie-authenticated `POST /api/threads`).
 */
export async function linkCommentAsPendingReviewComment(input: {
  readonly review: ReviewModeHandle;
  readonly store: ThreadStore;
  readonly localCommentId: string;
  readonly anchor: Anchor;
  readonly body: string;
  readonly actor: Author;
  /** Callback the daemon provides so the returned append events get
   * fanned out on `/events` and folded into the delivery cache. The
   * daemon uses its own append path to keep audiences consistent;
   * this module never talks to the bus directly. */
  readonly appendAndPublish: (input: ReviewEventInput) => Promise<ReviewEvent | undefined>;
}): Promise<LinkPendingOutcome> {
  const { review, store, actor, body, anchor, localCommentId, appendAndPublish } = input;

  const state = await review.readState(store);
  const headSha = review.currentHeadSha();

  // Head-move guard: if we already have a pending review open on a
  // different headSha, that review is stale; the daemon must run
  // the re-anchor flow before accepting more drafts. Refuse with a
  // typed result so the caller can plumb the banner (never guess).
  if (state.openPending !== null && isPendingReviewStale(state.openPending, headSha)) {
    return {
      kind: "stale",
      reviewNodeId: state.openPending.reviewNodeId,
      expectedHeadSha: headSha,
      actualHeadSha: state.openPending.headSha,
    };
  }

  // Find or create the pending review, pinned to the current head.
  let reviewNodeId: string;
  if (state.openPending !== null) {
    reviewNodeId = state.openPending.reviewNodeId;
  } else {
    const found = await review.options.adapter.findOrCreatePendingReview({
      pullRequestNodeId: review.options.summary.nodeId,
      commitOid: headSha,
      viewerLogin: review.options.viewerLogin,
    });
    if (found.kind === "stale") {
      // A pending review already exists on a foreign head — that is,
      // the reviewer had a draft open in the GitHub UI at an older
      // commit. Do not touch it silently; refuse and let the
      // reviewer decide (abandon → re-open, or open the GitHub UI).
      return {
        kind: "stale",
        reviewNodeId: found.review.id,
        expectedHeadSha: headSha,
        actualHeadSha: found.actualCommitOid,
      };
    }
    reviewNodeId = found.review.id;
    // First touch — record the open so the log carries it before
    // any comment.linked lands.
    await appendAndPublish({
      kind: "review.opened",
      actor,
      reviewNodeId,
      headSha,
    });
  }

  // Map the anchor to a PR position. The anchor-map file-level
  // fallback (ADR-0025 §5.6) fires when the block is outside every
  // hunk / lives on a renamed file / etc.
  const mapResult = anchorToPrComment(anchor, review.options.files);
  if (mapResult.kind === "reject") {
    return { kind: "orphaned", reason: `anchor rejected: ${mapResult.reason}` };
  }

  let submittedBody = body;
  let subject: "LINE" | "FILE" = "LINE";
  let line: number | undefined;
  let startLine: number | undefined;
  let side: "RIGHT" | "LEFT" = "RIGHT";
  if (mapResult.kind === "line") {
    line = mapResult.target.line;
    if (mapResult.target.startLine !== undefined && mapResult.target.startLine !== mapResult.target.line) {
      startLine = mapResult.target.startLine;
    }
    side = mapResult.target.side;
  } else {
    // File-level fallback. Prepend a machine-readable preamble so a
    // human reader on GitHub sees where the anchor was pointing.
    subject = "FILE";
    submittedBody = fileFallbackPreamble(anchor, mapResult.reason) + submittedBody;
  }

  const posted = await review.options.adapter.addPendingReviewThread({
    reviewId: reviewNodeId,
    path: mapResult.target.path,
    body: submittedBody,
    subjectType: subject,
    ...(line !== undefined ? { line } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    side,
  });

  // Emit comment.linked. If the append fails with a duplicate
  // (retry after a network flake, another window submitted the
  // same comment), swallow — the log already has the mapping.
  try {
    await appendAndPublish({
      kind: "comment.linked",
      actor,
      commentId: localCommentId,
      external: {
        github: {
          commentId: posted.databaseId,
          ...(posted.nodeId !== undefined ? { nodeId: posted.nodeId } : {}),
          pending: true,
          reviewNodeId,
        },
      },
    });
  } catch (err) {
    if (
      err instanceof ThreadStoreAppendError &&
      (err.rejection.kind === "duplicate-link" ||
        err.rejection.kind === "duplicate-external-id")
    ) {
      // Idempotent path — the daemon retried a POST after the mutation
      // already landed; the log holds the mapping.
    } else {
      throw err;
    }
  }

  return {
    kind: "linked",
    reviewNodeId,
    pendingComment: posted,
    ...(mapResult.kind === "file" ? { reason: "file-fallback" as const } : {}),
  };
}

/** True when the anchor's `path` still exists in the current file
 * list (used by the head-move re-anchor). */
export function anchorPathInFiles(anchor: AnyAnchor, files: readonly PrFile[]): boolean {
  for (const file of files) {
    if (file.filename === anchor.path) return true;
    if (file.previousFilename === anchor.path) return true;
  }
  return false;
}

/** Read the ordered list of pending comments the log carries for
 * the current open pending review, if any. Returns an empty list
 * when there's no open pending review. */
export function pendingComments(state: ReviewState): readonly DerivedPendingReviewComment[] {
  return state.openPending?.comments ?? [];
}

/** Compose the top-level body for a submit event when the caller
 * left `body` undefined. GitHub allows an empty body on
 * `submitPullRequestReview`, but we always send a small trailer so
 * a viewer on GitHub sees WHERE the review was authored — same
 * spirit as ADR-0025's file-level preamble. `viewerLogin` is
 * spliced in only if provided; missing = the fallback body without
 * an author reference. */
export function defaultSubmitBody(event: ReviewSubmitEvent, headSha: string): string {
  const label =
    event === "COMMENT" ? "Comment" : event === "APPROVE" ? "Approval" : "Requested changes";
  return `${label} submitted from revkit local review at ${headSha.slice(0, 12)}.`;
}

/** M3 part 2b head-move re-anchoring. Callable by the daemon's
 * `/api/review/reanchor` handler, and only after the daemon has
 * confirmed via `/api/review/refresh` that the head moved. The
 * daemon (not this helper) is the one that owns the human-only
 * auth gate; here we trust the caller and run the pipeline.
 *
 * Flow, in order:
 *   1. Read every pending comment from the log (via the store).
 *   2. For each: read the local thread → its LINE anchor. Read
 *      the OLD source from the snapshot table (indexed by the
 *      anchor's revision). Fetch the NEW source for that path
 *      from the adapter at the new headSha (`fetchBlobText`).
 *      Run the ADR-0006 re-anchor pipeline against the pair.
 *      A `moved`/`fuzzy` result gives a NEW anchor; an
 *      `orphaned` result means the block is gone — the caller
 *      keeps the local thread orphaned.
 *   3. Delete the OLD pending review on GitHub (`deletePendingReview`).
 *   4. Emit `review.abandoned` for the old reviewNodeId.
 *   5. Open a NEW pending review on the new headSha. Emit
 *      `review.opened`.
 *   6. For each non-orphaned pending comment: `addPendingReviewThread`
 *      at the NEW anchor's mapped position (line, or file-level
 *      when the new position falls outside a hunk). Emit
 *      `comment.linked` for the new pending comment. Also emit
 *      `thread.reanchored` so the local rail shows the new
 *      position.
 *   7. For each orphaned pending comment: emit `thread.orphaned`
 *      (unless the thread was already orphaned; the
 *      `already-orphaned` rejection is swallowed).
 *
 * The caller (daemon) is responsible for: (a) refreshing the PR
 * summary + files list before this call; (b) supplying the
 * `appendAndPublish` seam so events fan out uniformly. On any
 * error other than an idempotent duplicate, this function throws
 * — the caller returns 5xx to the reviewer, who then reads
 * `/api/review/state` again.
 */
export interface HeadMoveReanchorResult {
  readonly abandonedReviewNodeId: string;
  readonly openedReviewNodeId: string;
  readonly reanchored: number;
  readonly orphaned: number;
  readonly repositions: ReadonlyArray<{
    readonly localCommentId: string;
    readonly path: string;
    readonly outcome: "moved" | "fuzzy" | "file-fallback" | "orphaned";
    readonly score?: number;
    readonly reason?: string;
  }>;
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
  // Fetch new-source PER-PATH once — the pipeline is per-file.
  const newSourceByPath = new Map<string, string | undefined>();
  const perComment: Array<{
    localCommentId: string;
    threadId: string;
    path: string;
    // Set on non-orphan outcomes.
    newAnchor?: Anchor;
    outcome: "moved" | "fuzzy" | "orphaned" | "file-fallback";
    score?: number;
    reason?: string;
  }> = [];

  for (const c of state.openPending.comments) {
    const thread = await store.thread(c.threadId);
    if (thread === undefined || !isLineAnchor(thread.anchor)) {
      // Non-line-anchored threads (unanchored imports) are already
      // orphan-on-birth. Skip. This shouldn't happen for a
      // locally-authored pending draft.
      perComment.push({
        localCommentId: c.commentId,
        threadId: c.threadId,
        path: c.path,
        outcome: "orphaned",
        reason: "unanchored-source-thread",
      });
      continue;
    }
    const oldAnchor = thread.anchor;
    const oldSource = store.getSnapshot(oldAnchor.revision);
    if (oldSource === undefined) {
      perComment.push({
        localCommentId: c.commentId,
        threadId: c.threadId,
        path: c.path,
        outcome: "orphaned",
        reason: "missing-old-snapshot",
      });
      continue;
    }
    // Fetch the new-side file content once per path.
    let newSource = newSourceByPath.get(c.path);
    if (newSource === undefined && !newSourceByPath.has(c.path)) {
      try {
        const result = await review.options.adapter.fetchBlobText({
          owner: review.options.pr.owner,
          repo: review.options.pr.repo,
          expression: `${newHeadSha}:${c.path}`,
        });
        newSource = result.kind === "text" ? result.text : undefined;
      } catch {
        newSource = undefined;
      }
      newSourceByPath.set(c.path, newSource);
    }
    if (newSource === undefined) {
      perComment.push({
        localCommentId: c.commentId,
        threadId: c.threadId,
        path: c.path,
        outcome: "orphaned",
        reason: "new-source-unavailable",
      });
      continue;
    }
    const result = await reanchor(oldAnchor, oldSource, newSource);
    if (result.kind === "anchored" || result.kind === "moved" || result.kind === "fuzzy") {
      // Preserve the new source under the anchor's new revision
      // so a subsequent local rebuild can re-anchor from it.
      if (result.kind !== "anchored") {
        store.putSnapshot(result.anchor.revision, newSource);
      }
      // For `anchored` (identity — unchanged file), reuse oldAnchor
      // but with the new head commit stamp. Not strictly needed on
      // an identity re-anchor, so we skip re-emitting an event and
      // just keep the anchor.
      const newAnchor: Anchor = result.kind === "anchored" ? oldAnchor : result.anchor;
      perComment.push({
        localCommentId: c.commentId,
        threadId: c.threadId,
        path: c.path,
        newAnchor,
        outcome: result.kind === "anchored" ? "moved" : result.kind,
        ...(result.kind === "fuzzy" ? { score: result.score } : {}),
      });
    } else {
      perComment.push({
        localCommentId: c.commentId,
        threadId: c.threadId,
        path: c.path,
        outcome: "orphaned",
        reason: result.reason,
      });
    }
  }

  // Delete the old pending review on GitHub. All its drafts go
  // with it — that's the semantics of `deletePendingReview`.
  try {
    await review.options.adapter.deletePendingReview({ reviewId: oldReviewNodeId });
  } catch (err) {
    // If GitHub says the review is already gone (submitted /
    // deleted from another window), fall through — the abandon
    // event still records our local decision.
    void err;
  }
  await appendAndPublish({
    kind: "review.abandoned",
    actor,
    reviewNodeId: oldReviewNodeId,
    reason: "head-moved",
  });

  // Open a fresh pending review at the new head.
  const opened = await review.options.adapter.findOrCreatePendingReview({
    pullRequestNodeId: review.options.summary.nodeId,
    commitOid: newHeadSha,
    viewerLogin: review.options.viewerLogin,
  });
  if (opened.kind === "stale") {
    // Race — another window already opened a pending review at a
    // DIFFERENT head. Refuse loudly.
    throw new Error(
      `reanchorPendingReviewAtNewHead: findOrCreatePendingReview returned stale (expected ${newHeadSha}, got ${opened.actualCommitOid ?? "null"})`,
    );
  }
  const newReviewNodeId = opened.review.id;
  await appendAndPublish({
    kind: "review.opened",
    actor,
    reviewNodeId: newReviewNodeId,
    headSha: newHeadSha,
  });

  let reanchored = 0;
  let orphaned = 0;
  const repositions: Array<{
    localCommentId: string;
    path: string;
    outcome: "moved" | "fuzzy" | "file-fallback" | "orphaned";
    score?: number;
    reason?: string;
  }> = [];

  for (const p of perComment) {
    if (p.newAnchor === undefined) {
      orphaned++;
      // Emit thread.orphaned (best-effort — validator refuses on
      // `already-orphaned` which we swallow). The revision is the
      // hash of the new source we tried, or an "unavailable" hash
      // when the fetch failed. `revisionOf` is deterministic; the
      // sentinel string is HONEST — it names why we couldn't reach
      // the file.
      try {
        const newSrc = newSourceByPath.get(p.path);
        const rev = await revisionOf(
          newSrc !== undefined ? newSrc : `head-move-unavailable:${newHeadSha}:${p.path}\n`,
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
      repositions.push({
        localCommentId: p.localCommentId,
        path: p.path,
        outcome: "orphaned",
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      });
      continue;
    }
    // Emit a reanchor event so the rail moves the thread's marker
    // to the new position on the current head. A fuzzy match
    // carries a score field; a moved (quote-exact) result omits it.
    try {
      const method: "quote-exact" | "fuzzy" = p.outcome === "fuzzy" ? "fuzzy" : "quote-exact";
      await appendAndPublish({
        kind: "thread.reanchored",
        actor,
        threadId: p.threadId,
        anchor: p.newAnchor,
        method,
        ...(method === "fuzzy" && p.score !== undefined ? { score: p.score } : {}),
      });
    } catch {
      /* fine — the anchor is still recoverable */
    }
    // Map the NEW anchor onto the refreshed PR files list. If the
    // block is outside every hunk on the new PR, fall back to a
    // file-level comment.
    const mapResult = anchorToPrComment(p.newAnchor, review.options.files);
    if (mapResult.kind === "reject") {
      orphaned++;
      repositions.push({
        localCommentId: p.localCommentId,
        path: p.path,
        outcome: "orphaned",
        reason: `anchor rejected: ${mapResult.reason}`,
      });
      continue;
    }
    // Load the original comment body from the store (opening
    // comment of the thread).
    const thread = await store.thread(p.threadId);
    if (thread === undefined) continue;
    const body = thread.comments[0]?.body ?? "";
    let submittedBody = body;
    let subject: "LINE" | "FILE" = "LINE";
    let line: number | undefined;
    let startLine: number | undefined;
    let side: "RIGHT" | "LEFT" = "RIGHT";
    let outcomeTag: "moved" | "fuzzy" | "file-fallback" = p.outcome === "fuzzy" ? "fuzzy" : "moved";
    if (mapResult.kind === "line") {
      line = mapResult.target.line;
      if (mapResult.target.startLine !== undefined && mapResult.target.startLine !== mapResult.target.line) {
        startLine = mapResult.target.startLine;
      }
      side = mapResult.target.side;
    } else {
      subject = "FILE";
      submittedBody = fileFallbackPreamble(p.newAnchor, mapResult.reason) + submittedBody;
      outcomeTag = "file-fallback";
    }
    try {
      const posted = await review.options.adapter.addPendingReviewThread({
        reviewId: newReviewNodeId,
        path: mapResult.target.path,
        body: submittedBody,
        subjectType: subject,
        ...(line !== undefined ? { line } : {}),
        ...(startLine !== undefined ? { startLine } : {}),
        side,
      });
      await appendAndPublish({
        kind: "comment.linked",
        actor,
        commentId: p.localCommentId,
        external: {
          github: {
            commentId: posted.databaseId,
            ...(posted.nodeId !== undefined ? { nodeId: posted.nodeId } : {}),
            pending: true,
            reviewNodeId: newReviewNodeId,
          },
        },
      });
      reanchored++;
      repositions.push({
        localCommentId: p.localCommentId,
        path: p.path,
        outcome: outcomeTag,
        ...(p.score !== undefined ? { score: p.score } : {}),
      });
    } catch (err) {
      if (
        err instanceof ThreadStoreAppendError &&
        (err.rejection.kind === "duplicate-link" || err.rejection.kind === "duplicate-external-id")
      ) {
        // Already re-linked — treat as success (idempotent
        // retry).
        reanchored++;
        repositions.push({
          localCommentId: p.localCommentId,
          path: p.path,
          outcome: outcomeTag,
        });
      } else {
        throw err;
      }
    }
  }

  return {
    abandonedReviewNodeId: oldReviewNodeId,
    openedReviewNodeId: newReviewNodeId,
    reanchored,
    orphaned,
    repositions,
  };
}
