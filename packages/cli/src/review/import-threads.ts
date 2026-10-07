// Bridge from `GitHubAdapter.importThreads` to a `ThreadStore`. The
// adapter produces `ReviewEventInput[]` (plus a re-anchor snapshot
// map); the daemon stores them by calling `store.append`.
//
// This runs BEFORE the daemon accepts any HTTP request — we open the
// store, drain the imports, then hand the store to `startDaemon` (or
// let `startDaemon` re-open the same file). No daemon endpoint
// accepts a "please write on behalf of this GitHub user" call,
// which keeps the identity-check boundary crisp: the daemon only
// authors comments as the local user or the agent; imported comments
// carry `author.kind: "gh-user"` and are only inserted through this
// pre-populate path.
//
// Deterministic thread / comment IDs are computed from the PR
// coordinate plus the GitHub node id. That means a second run of
// `revkit review <same-pr>` sees the same events as already-imported
// and skips them (the store's `validateNext` refuses a duplicate
// commentId, and we catch that as "already imported").

import { createHash } from "node:crypto";
import {
  GitHubAdapter,
  type ExternalRef,
  type GhReviewThread,
  type PrRef,
  type ReviewEventInput,
  type ThreadStore,
  ThreadStoreAppendError,
} from "@revkit/review-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { revisionOf } from "@revkit/review-core";

/** Result of `populateStoreFromPr`. */
export interface PopulateOutcome {
  /** Number of events actually appended to the store. */
  readonly appended: number;
  /** Number of events skipped as already-present. */
  readonly skipped: number;
  /** Number of events refused as invalid or conflicting rather than
   * already-present — a non-zero value fails the review command. */
  readonly refused: number;
  /** Distinct thread ids that were touched (appended or already
   * present). */
  readonly threadIds: readonly string[];
  /** Round-2 BLOCK-fix 3: per-thread update summary from the
   * refresh diff — new remote replies, resolve/unresolve
   * transitions, remote edits. Zero when the store is being
   * populated for the first time (no updates against an empty
   * log). */
  readonly updates?: {
    readonly newReplies: number;
    readonly resolved: number;
    readonly reopened: number;
    readonly edited: number;
  };
}

/** Options for `populateStoreFromPr`. */
export interface PopulateOptions {
  /** The PR whose review threads are being imported. */
  readonly pr: PrRef;
  /** The GitHub review threads (from `adapter.listReviewThreads`). */
  readonly threads: readonly GhReviewThread[];
  /** The head SHA the PR was resolved against. */
  readonly headSha: string;
  /** The base ref name (branch name or SHA) — passed to
   * `adapter.importThreads` for LEFT-side merge-base lookup. */
  readonly baseRef: string;
  /** Adapter for blob fetches + merge-base lookups. */
  readonly adapter: GitHubAdapter;
  /** Absolute path to the materialized PR-head worktree. Used to
   * read `headSourceOf` for live RIGHT threads. */
  readonly materializedRoot: string;
  /** Store to append events to. */
  readonly store: ThreadStore;
  /** Optional map of PR file oldPath → newPath (from
   * `listPullRequestFiles`). Used by `importThreads` for LEFT-side
   * renamed files. */
  readonly oldPathOf?: (currentPath: string) => string | undefined;
  /** Report unexpected refusals to the consumer's diagnostic logs. */
  readonly onRefused?: (event: ReviewEventInput, error: ThreadStoreAppendError) => void;
}

/**
 * Deterministic thread id: `gh-<owner>-<repo>-<pr>-<hash>` where
 * `hash` is the first 12 hex of sha-256 over the GitHub thread node
 * id. Consistent across runs of `revkit review` on the same PR, and
 * cheap to compute without touching a live store.
 */
export function threadIdOf(pr: PrRef, thread: GhReviewThread): string {
  const h = createHash("sha256").update(thread.id).digest("hex").slice(0, 12);
  return `gh-${pr.owner}-${pr.repo}-${pr.pullNumber}-${h}`;
}

/**
 * Deterministic comment id — same pattern, over the comment's node id.
 * Falls back to `<threadId>-<index>` when a comment has no nodeId
 * (which should not happen through the GraphQL adapter but keeps the
 * function total).
 */
export function commentIdOfFactory(pr: PrRef): (thread: GhReviewThread, comment: { readonly nodeId?: string | null }) => string {
  return (thread, comment) => {
    if (comment.nodeId !== null && comment.nodeId !== undefined && comment.nodeId.length > 0) {
      const h = createHash("sha256").update(comment.nodeId).digest("hex").slice(0, 12);
      return `gh-${pr.owner}-${pr.repo}-${pr.pullNumber}-c-${h}`;
    }
    // Deterministic fallback: hash of thread node id + index within
    // its comments array; caller passes the right thread.
    const idx = thread.comments.indexOf(comment as never);
    const h = createHash("sha256").update(`${thread.id}#${idx}`).digest("hex").slice(0, 12);
    return `gh-${pr.owner}-${pr.repo}-${pr.pullNumber}-c-${h}`;
  };
}

/**
 * Read the head-side content of a materialized path, or `undefined`
 * if the file is not present (deleted in the PR, or path resolution
 * refused it). Used by `importThreads` for live RIGHT-side thread
 * quote cutting.
 */
function makeHeadSourceOf(materializedRoot: string): (path: string) => string | undefined {
  return (path) => {
    // Path validation is a cheap safety net — the materializer has
    // already refused anything unsafe. A path with `..` or an
    // absolute component would already have been rejected upstream.
    if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return undefined;
    if (path.split("/").some((s) => s === "..")) return undefined;
    try {
      return readFileSync(join(materializedRoot, path), "utf8");
    } catch {
      return undefined;
    }
  };
}

/**
 * Compute a head-side revision (SHA-256 of file contents) for a path
 * in the materialized worktree. Async because `revisionOf` is
 * `async`. Cached per-call to avoid re-hashing when the adapter asks
 * for the same path twice.
 */
async function makeHeadRevisionMap(
  materializedRoot: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const distinct = new Set(paths);
  for (const path of distinct) {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\")) continue;
    if (path.split("/").some((s) => s === "..")) continue;
    let content: string;
    try {
      content = readFileSync(join(materializedRoot, path), "utf8");
    } catch {
      continue;
    }
    const rev = await revisionOf(content);
    map.set(path, rev);
  }
  return map;
}

/**
 * Populate `store` with events derived from a PR's review threads.
 * See file-level doc for the identity/dedup story.
 */
export async function populateStoreFromPr(options: PopulateOptions): Promise<PopulateOutcome> {
  const commentIdOfBase = commentIdOfFactory(options.pr);
  const paths = options.threads.map((t) => t.path);
  const headSourceOf = makeHeadSourceOf(options.materializedRoot);
  const headRevMap = await makeHeadRevisionMap(options.materializedRoot, paths);

  // Round-3 BLOCK-fix 2: dedupe re-imports on the GitHub node id
  // already linked to a LOCAL comment. Before round-3 the daemon's
  // own reply would re-import as a duplicate: the mirror path
  // linked the local commentId (a uuid) to a GitHub nodeId, but
  // `commentIdOfFactory` derived a DIFFERENT deterministic id
  // from the same nodeId, so the second-pass import created a
  // fresh comment.replied with the derived id, producing
  // ["my reply", "my reply"] on the local log.
  //
  // Walk the log for every `comment.linked` and build a map from
  // the GitHub nodeId back to the local commentId. The
  // `commentIdOf` factory used below returns the LOCAL id when
  // a nodeId is already linked, so importThreads' events line up
  // with the store's existing rows and the duplicate hits
  // `duplicate-comment-id`. Its identical `comment.linked` is also
  // skipped, but a conflicting external id must remain refused.
  const nodeIdToLocalCommentId = new Map<string, string>();
  const githubLinks = new Map<string, NonNullable<ExternalRef["github"]>>();
  {
    const existingEvents = await options.store.since(0);
    for (const evt of existingEvents) {
      if (evt.kind !== "comment.linked") continue;
      const gh = evt.external.github;
      if (gh === undefined) continue;
      // Keep the latest link: a terminal pending review may have
      // been re-anchored to a different external comment id.
      githubLinks.set(evt.commentId, gh);
      const nid = gh.nodeId;
      if (nid === undefined) continue;
      // Prefer the FIRST link (locally-authored comment). A later
      // re-link with the same nodeId would trip the validator, so
      // this map is 1:1 by construction.
      if (!nodeIdToLocalCommentId.has(nid)) {
        nodeIdToLocalCommentId.set(nid, evt.commentId);
      }
    }
  }
  const commentIdOf: typeof commentIdOfBase = (thread, comment) => {
    const nid = comment.nodeId;
    if (nid !== undefined && nid !== null) {
      const existing = nodeIdToLocalCommentId.get(nid);
      if (existing !== undefined) return existing;
    }
    return commentIdOfBase(thread, comment);
  };

  const importResult = await options.adapter.importThreads({
    pr: options.pr,
    threads: options.threads,
    threadIdOf: (thread) => threadIdOf(options.pr, thread),
    commentIdOf,
    headRevisionOf: (path) => headRevMap.get(path),
    headSourceOf,
    headCommitOid: options.headSha,
    pullRequestBaseRef: options.baseRef,
    ...(options.oldPathOf !== undefined ? { oldPathOf: options.oldPathOf } : {}),
  });

  let appended = 0;
  let skipped = 0;
  let refused = 0;
  const touched = new Set<string>();

  for (const event of importResult.events) {
    // Track thread ids from the event input if present. Every input
    // shape has a `threadId`.
    const threadId = (event as ReviewEventInput & { threadId?: string }).threadId;
    if (threadId !== undefined) touched.add(threadId);
    try {
      await options.store.append(event);
      appended++;
      if (event.kind === "comment.linked" && event.external.github !== undefined) {
        githubLinks.set(event.commentId, event.external.github);
      }
    } catch (err) {
      if (err instanceof ThreadStoreAppendError) {
        // Duplicate deterministic ids are already imported. A
        // duplicate-link only names the comment and backend, so
        // also check the external id before treating it as skipped.
        const msg = err.rejection.kind;
        const gh = event.kind === "comment.linked" ? event.external.github : undefined;
        const existing = event.kind === "comment.linked" ? githubLinks.get(event.commentId) : undefined;
        const sameLink = msg === "duplicate-link" && err.rejection.backend === "github" &&
          gh !== undefined && existing !== undefined && gh.commentId === existing.commentId &&
          (gh.nodeId === undefined || existing.nodeId === undefined || gh.nodeId === existing.nodeId);
        if (msg === "duplicate-comment-id" || msg === "duplicate-thread" || sameLink) {
          skipped++;
          continue;
        }
        refused++;
        options.onRefused?.(event, err);
        continue;
      }
      throw err;
    }
  }

  // Round-2 BLOCK-fix 3 (B4 pull update): diff each remote
  // thread against its local counterpart and emit typed events
  // for what changed since the last refresh. The initial pass
  // above appended new threads / new comments the reducer had
  // never seen (idempotent by deterministic id). This second
  // pass covers three cases: a new remote reply on an already-
  // imported thread, the remote thread's isResolved flipping
  // either way (resolve or unresolve, mirrored as thread.resolved
  // or thread.reopened under a gh-user actor), and a remote body
  // that changed (comment.edited).
  // Every emit is idempotent: an event that would repeat what
  // the reducer already saw is refused with a duplicate kind and
  // silently absorbed.
  const updates = { newReplies: 0, resolved: 0, reopened: 0, edited: 0 };
  for (const remoteThread of options.threads) {
    const localTid = threadIdOf(options.pr, remoteThread);
    const localThread = await options.store.thread(localTid);
    if (localThread === undefined) continue; // just imported; nothing to update.

    // ── Resolve state diff ──
    const remoteResolved = remoteThread.isResolved;
    const localResolved = localThread.status === "resolved";
    const lastObservedRemote = localThread.external?.resolved ?? localResolved;
    if (remoteResolved !== lastObservedRemote && remoteResolved && !localResolved) {
      // orphaned → resolved is allowed (ADR-0025 amendment). The
      // reducer projects `resumeStatus` so a later reopen restores
      // orphaned rather than open.
      const actor = remoteThread.resolvedByLogin !== null
        ? { kind: "gh-user" as const, id: remoteThread.resolvedByLogin, displayName: remoteThread.resolvedByLogin }
        : { kind: "gh-user" as const, id: "github", displayName: "GitHub" };
      try {
        await options.store.append({
          kind: "thread.resolved",
          actor,
          threadId: localTid,
          resolution: "resolved on GitHub",
        });
        updates.resolved++;
        await options.store.append({
          kind: "thread.external_synced",
          actor,
          threadId: localTid,
          resolved: true,
          ...(remoteThread.resolvedByLogin !== null ? { resolvedByLogin: remoteThread.resolvedByLogin } : {}),
        });
      } catch (err) {
        if (!(err instanceof ThreadStoreAppendError)) throw err;
        // Already resolved / refused — fine.
      }
    } else if (remoteResolved !== lastObservedRemote && !remoteResolved && localResolved) {
      // Round-2 BLOCK-fix 3 (probe R6): the remote UN-resolved a
      // thread. Mirror as `thread.reopened` under a gh-user actor.
      const actor = { kind: "gh-user" as const, id: "github", displayName: "GitHub" };
      try {
        await options.store.append({
          kind: "thread.reopened",
          actor,
          threadId: localTid,
          reason: "reopened on GitHub",
        });
        updates.reopened++;
        await options.store.append({
          kind: "thread.external_synced",
          actor,
          threadId: localTid,
          resolved: false,
        });
      } catch (err) {
        if (!(err instanceof ThreadStoreAppendError)) throw err;
      }
    } else if (remoteResolved !== lastObservedRemote && remoteResolved === localResolved) {
      const actor = remoteThread.resolvedByLogin !== null
        ? { kind: "gh-user" as const, id: remoteThread.resolvedByLogin, displayName: remoteThread.resolvedByLogin }
        : { kind: "gh-user" as const, id: "github", displayName: "GitHub" };
      try {
        await options.store.append({
          kind: "thread.external_synced",
          actor,
          threadId: localTid,
          resolved: remoteResolved,
          ...(remoteThread.resolvedByLogin !== null ? { resolvedByLogin: remoteThread.resolvedByLogin } : {}),
        });
      } catch (err) {
        if (!(err instanceof ThreadStoreAppendError)) throw err;
      }
    }

    // ── Comment-level diff (new replies + body edits) ──
    // Build a map from local comment.body by commentId so we can
    // detect edits + missing replies.
    const localById = new Map(localThread.comments.map((c) => [c.id, c]));
    for (let i = 0; i < remoteThread.comments.length; i++) {
      const remoteComment = remoteThread.comments[i];
      if (remoteComment === undefined) continue;
      const localCid = commentIdOf(remoteThread, remoteComment);
      const local = localById.get(localCid);
      if (local === undefined) {
        // A new remote reply we hadn't seen. The first comment
        // (i === 0) is always the opener — already appended by the
        // first-pass import when it was new. Every subsequent
        // comment is a reply.
        if (i === 0) continue;
        const prevRemote = remoteThread.comments[i - 1];
        if (prevRemote === undefined) continue;
        const parentId = commentIdOf(remoteThread, prevRemote);
        const author = remoteComment.authorLogin !== null
          ? { kind: "gh-user" as const, id: remoteComment.authorLogin, displayName: remoteComment.authorLogin }
          : { kind: "gh-user" as const, id: "github", displayName: "GitHub" };
        try {
          await options.store.append({
            kind: "comment.replied",
            actor: author,
            threadId: localTid,
            commentId: localCid,
            parentId,
            body: remoteComment.body,
          });
          updates.newReplies++;
        } catch (err) {
          if (!(err instanceof ThreadStoreAppendError)) throw err;
        }
        continue;
      }
      // Existing local — emit a body edit when the remote's
      // body no longer matches the local one. The event is
      // idempotent at the emitter side (remote-updated-at
      // marker); here we compare bodies as strings.
      if (local.body !== remoteComment.body) {
        const author = remoteComment.authorLogin !== null
          ? { kind: "gh-user" as const, id: remoteComment.authorLogin, displayName: remoteComment.authorLogin }
          : { kind: "gh-user" as const, id: "github", displayName: "GitHub" };
        try {
          await options.store.append({
            kind: "comment.edited",
            actor: author,
            commentId: localCid,
            body: remoteComment.body,
          });
          updates.edited++;
        } catch (err) {
          if (!(err instanceof ThreadStoreAppendError)) throw err;
        }
      }
    }
  }

  return {
    appended,
    skipped,
    refused,
    threadIds: [...touched],
    updates,
  };
}
