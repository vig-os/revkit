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
  /** Number of events refused with an unexpected error kind — a
   * non-zero value fails the review command. */
  readonly refused: number;
  /** Distinct thread ids that were touched (appended or already
   * present). */
  readonly threadIds: readonly string[];
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
  const commentIdOf = commentIdOfFactory(options.pr);
  const paths = options.threads.map((t) => t.path);
  const headSourceOf = makeHeadSourceOf(options.materializedRoot);
  const headRevMap = await makeHeadRevisionMap(options.materializedRoot, paths);

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
    } catch (err) {
      if (err instanceof ThreadStoreAppendError) {
        // A duplicate commentId means we've already imported this
        // event on a previous run (deterministic ids). That's the
        // idempotent-import case and NOT a refusal.
        const msg = err.rejection.kind;
        if (msg === "duplicate-comment-id" || msg === "duplicate-thread") {
          skipped++;
          continue;
        }
        refused++;
        continue;
      }
      throw err;
    }
  }

  return {
    appended,
    skipped,
    refused,
    threadIds: [...touched],
  };
}
