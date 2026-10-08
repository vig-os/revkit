// The comment rail island (DESIGN-0001 §5.2, ADR-0002).
//
// A minimal Solid island: it discovers every `data-src`-stamped block
// on the page, lets the reviewer create, view and reply to threads
// anchored to those blocks, and re-renders when the daemon fans a
// new event over `/events`. Auth is the session cookie the
// launch-code flow set — the rail never sees the agent bearer token.
//
// The rail runs from a bundle built by the daemon at first serve
// (`packages/cli/src/rail/bundle.ts`), served at `/-/rail.js` and
// `/-/rail.css`. It expects the page to have a `<main>` or `<body>`
// element to anchor its floating panel to; a page with no rendered
// content still gets an inert rail (announcing zero threads) so the
// injection is idempotent and does not break plain HTML.
//
// Authored as `.tsx` and compiled at build time by
// `babel-preset-solid` (via a Bun.build plugin — see
// `packages/cli/src/rail/bundle.ts`). Solid's JSX transform emits
// plain DOM code with no `eval` / `new Function`, so the daemon's
// CSP does NOT need `'unsafe-eval'` (ADR-0013 amendment 2026-09-30).
// The previous version used `solid-js/html`'s tagged-template
// runtime, which JIT-compiled templates via `new Function()` — that
// widening is gone.

import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { parseDataSrc } from "../data-src-format.ts";
import { PROVENANCE_VERSION, type SourceSelection } from "../provenance-format.ts";
import { containingBlock, rangeBlock, rangeSelection, type CommentTarget } from "./selection-provenance.ts";
import type { ReviewRefreshResponse } from "../review/api-types.ts";
import {
  createSeqGate,
  readPageRenderHead,
  readResumeSeq,
  sinceForSubscribe,
  writeResumeSeq,
  type ResumeStorage,
} from "./resume-point.ts";
import {
  readDraft,
  removeDraft,
  saveDraft,
  sweepExpiredDrafts,
  type DraftStorage,
} from "./drafts.ts";
import {
  excerptOf,
  formatRelativeTime,
  isThreadUnread,
  latestAgentActivityOf,
  migrateSeenStorage,
  pruneSeenMap,
  readSeenMap as readSeenMapImpl,
  seenStorageKeyFor,
  writeSeenMap as writeSeenMapImpl,
  type SeenMap,
} from "./unread.ts";
// Round-2 refactor: the rail no longer parses mention structure
// itself. The daemon parses every comment body at append time with
// the real Markdown AST and writes the typed mention list onto the
// event; the rail reads `comment.mentions` and renders chips from
// that data. This removes the parser from the browser bundle
// entirely.
//
// We keep a Mention type here as a browser-side duck-type only.
interface Mention {
  readonly kind: "agent" | "agent-now" | "gh-user" | "team" | "role";
  readonly id: string;
  readonly label: string;
  readonly name?: string;
  readonly range: readonly [number, number];
}

/** The wire shape the daemon returns from `GET /api/threads` — kept as
 * a minimal duck type here so the rail bundle does not pull the whole
 * `@revkit/review-core` package into the browser payload. */
interface RailAuthor {
  readonly kind: string;
  readonly id: string;
  readonly displayName?: string;
}
/** A line anchor — the shape existing threads carry. `kind` is
 * absent on the wire for backward compat. */
interface RailLineAnchor {
  readonly kind?: "line";
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly revision: string;
}
/** An unanchored anchor — issue #46 item 5. Imported threads
 * whose source content couldn't be fetched carry this shape.
 * The rail renders these under the file with a file-level
 * label; no `L<n>-L<m>` (which would print `Lundefined`). */
interface RailUnanchoredAnchor {
  readonly kind: "unanchored";
  readonly path: string;
  readonly originalStartLine?: number;
  readonly originalEndLine?: number;
}
type RailAnchor = RailLineAnchor | RailUnanchoredAnchor;
/** True when `anchor` carries `startLine`/`endLine`/`quote` — i.e.
 * a line-anchored thread. `kind === "unanchored"` (or the
 * absence of `startLine`) puts a thread in the file-level path,
 * where none of `L<n>-L<m>`, `focusAnchor`, or the quote are
 * used. */
function isRailLineAnchor(anchor: RailAnchor): anchor is RailLineAnchor {
  return anchor.kind !== "unanchored" && typeof (anchor as RailLineAnchor).startLine === "number";
}
interface RailComment {
  readonly id: string;
  readonly parentId?: string;
  readonly author: RailAuthor;
  readonly body: string;
  readonly mentions?: readonly Mention[];
  readonly createdAt: string;
}
export interface RailThread {
  readonly id: string;
  /** `orphaned` (M2 item 5b + issue #46): the re-anchoring pipeline
   * could not find the thread on a later revision (ADR-0006), OR
   * the thread was imported from GitHub without an anchor (PR #43,
   * `anchor.kind === "unanchored"`). The thread is kept, still
   * repliable / resolvable, and surfaced in the orphan panel with
   * a "was at L…" note (line-anchored) or a file-level line
   * (unanchored). A subsequent `thread.reanchored` unorphans it
   * back to `open`. */
  readonly status: "open" | "resolved" | "orphaned";
  readonly anchor: RailAnchor;
  readonly comments: readonly RailComment[];
  readonly updatedAt: string;
  /** Reason string projected from the pipeline's
   * `thread.orphaned.reason` or, for a thread born unanchored,
   * `comment.created.orphanReason`. Read by the orphan panel so
   * the human sees WHY the anchor was lost — the pipeline's own
   * account rather than a synthesised sentence. Absent when no
   * reason was supplied. (PR #45 round-2 + issue #46 item 3.) */
  readonly orphanReason?: string;
  /** The typed actor who resolved this thread, projected onto the
   * derived thread by the reducer on `thread.resolved`. Absent
   * for open/orphaned threads. Read by the rail's collapsed
   * resolved row so the reviewer sees WHO closed the thread
   * without opening the raw event log. Issue #60. */
  readonly resolvedBy?: RailAuthor;
  /** The `ts` of the `thread.resolved` event. Same projection
   * intent as `resolvedBy`; the rail renders the relative time.
   * Issue #60. */
  readonly resolvedAt?: string;
}
interface RailListResponse {
  readonly threads: readonly RailThread[];
  readonly head: number;
}
interface RailReviewEvent {
  readonly seq: number;
  readonly kind: string;
  readonly threadId?: string;
  readonly route?: string;
  readonly path?: string;
}

/** Delivery mode wire shape from `GET /api/delivery-mode` (M2 item 6).
 * Kept a minimal duck-type here so the rail bundle does not pull the
 * whole `@revkit/review-core` type surface into the browser payload. */
type DeliveryMode = "handover" | "live" | "quiet";
interface DeliveryStatus {
  readonly mode: DeliveryMode;
  readonly batched: number;
  readonly lastEventMsAgo: number | null;
  readonly updatedAt: string;
  readonly idleFlushMs: number;
}

/** Presence beacon projected onto rail state — the latest per agent id. */
interface PresenceBadge {
  readonly agentId: string;
  readonly agentDisplayName?: string;
  readonly state: "editing" | "idle";
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly ts: string;
}

/** Fetch the current delivery mode. */
async function fetchDeliveryMode(): Promise<DeliveryStatus> {
  const response = await fetch("/api/delivery-mode", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GET /api/delivery-mode failed: ${response.status}`);
  return (await response.json()) as DeliveryStatus;
}

/** Change the delivery mode. */
async function setDeliveryMode(mode: DeliveryMode): Promise<DeliveryStatus> {
  const response = await fetch("/api/delivery-mode", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`POST /api/delivery-mode failed: ${response.status}`);
  return (await response.json()) as DeliveryStatus;
}

/** Flush the handover batch. */
async function handOverNow(): Promise<void> {
  const response = await fetch("/api/handover", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`POST /api/handover failed: ${response.status}`);
}

// ── Review-mode wire shapes (M3 part 2b) ─────────────────────────

/** Minimal wire type for `GET /api/review/state`. Kept a duck-type
 * so the browser bundle doesn't pull in review-core. `null` in
 * `state.openPending` = no open pending review; `stale: true` when
 * the head moved after opening. `err` in the fetch layer surfaces
 * a non-review daemon (404 on the route) as a null result — the
 * rail then hides the review panel entirely. */
interface RailReviewState {
  readonly pr: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly headSha: string;
    readonly headRef: string;
    readonly baseSha: string;
    readonly baseRef: string;
    readonly url: string;
    readonly state: "open" | "closed";
  };
  readonly viewerLogin: string;
  readonly state: {
    readonly openPending:
      | {
          readonly reviewNodeId: string;
          readonly headSha: string;
          readonly comments: ReadonlyArray<{
            readonly commentId: string;
            readonly threadId: string;
            readonly path: string;
            readonly pendingCommentDatabaseId: number;
            readonly pendingCommentNodeId?: string;
          }>;
        }
      | null;
    readonly terminal: ReadonlyArray<{
      readonly reviewNodeId: string;
      readonly outcome: {
        readonly kind: "submitted" | "abandoned";
        readonly reason?: string;
        readonly event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      };
      readonly at?: string;
    }>;
    readonly unsyncedCommentIds?: readonly string[];
    readonly commentSync?: ReadonlyArray<{
      readonly commentId: string;
      readonly state: {
        readonly kind: "not-attempted" | "pending-sync" | "synced" | "failed" | "cancelled";
        readonly reason?: string;
      };
    }>;
    /** Issue #70: agent-authored drafts awaiting the reviewer's
     * explicit promotion. Absent on a daemon that predates the
     * promotion route. */
    readonly agentDrafts?: ReadonlyArray<{
      readonly threadId: string;
      readonly target: "comment" | "resolve" | "reopen";
      readonly commentId?: string;
      readonly path: string;
    }>;
    /** Current promoted lifecycle intents refused by their review binding. */
    readonly lifecycleFailures?: ReadonlyArray<{
      readonly threadId: string;
      readonly target: "resolve" | "reopen";
      readonly path: string;
      readonly intentSeq: number;
      readonly reason: string;
    }>;
    /** Issue #70 round 3: the reviewer's OWN resolve/reopen that a
     * later lifecycle change superseded, so it never reached GitHub. */
    readonly droppedReviewerIntents?: ReadonlyArray<{
      readonly threadId: string;
      readonly target: "resolve" | "reopen";
      readonly path: string;
    }>;
  };
  readonly stale: boolean;
}

/** One agent-authored draft awaiting the reviewer's promotion
 * (issue #70). Same shape the daemon's `/api/review/state` reports. */
type RailAgentDraft = NonNullable<RailReviewState["state"]["agentDrafts"]>[number];

/** One of the reviewer's own resolve/reopen that a later lifecycle
 * change superseded, so it never reached GitHub (issue #70 round 3). */
type RailDroppedIntent = NonNullable<RailReviewState["state"]["droppedReviewerIntents"]>[number];

/** Fetch review-mode state. Returns null when the daemon is not in
 * review mode (`/api/review/state` returns 404). Any other error
 * surfaces on the rail's error line. */
async function fetchReviewState(): Promise<RailReviewState | null> {
  const response = await fetch("/api/review/state", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /api/review/state failed: ${response.status}`);
  return (await response.json()) as RailReviewState;
}

async function submitReview(event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<void> {
  const response = await fetch("/api/review/submit", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body.length > 0 ? { event, body } : { event }),
  });
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error("This pending review is stale (head moved). Click 'Re-anchor to new head'.");
    }
    let msg = `submit failed: ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (typeof parsed.error === "string") msg = `submit refused: ${parsed.error}`;
    } catch {
      /* fine */
    }
    throw new Error(msg);
  }
}

async function discardPendingReview(reason?: string): Promise<void> {
  const response = await fetch("/api/review/discard", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(reason !== undefined ? { reason } : {}),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`discard failed: ${response.status}`);
  }
}

async function reanchorPendingReview(): Promise<{
  reanchored: number;
  orphaned: number;
  openedReviewNodeId: string;
}> {
  const response = await fetch("/api/review/reanchor", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`reanchor failed: ${response.status}`);
  return (await response.json()) as {
    reanchored: number;
    orphaned: number;
    openedReviewNodeId: string;
  };
}

async function refreshReviewPr(): Promise<ReviewRefreshResponse> {
  const response = await fetch("/api/review/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`refresh failed: ${response.status}`);
  return (await response.json()) as ReviewRefreshResponse;
}

/** Issue #70: the reviewer's promotion of an agent-authored draft
 * into their own pending review. Cookie-authenticated like every other
 * review mutation (the agent bearer is refused by the route), so this
 * is the rail's half of a human act — nothing about it is available to
 * the agent. A refusal carries the daemon's machine-readable error so
 * the rail can say which one. */
async function promoteAgentDraft(input: {
  threadId: string;
  target: "comment" | "resolve" | "reopen";
  commentId?: string;
  reviewNodeId?: string;
}): Promise<{ ok: boolean; promoted: boolean; reason?: string; error?: string }> {
  const response = await fetch("/api/review/promote", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      threadId: input.threadId,
      target: input.target,
      ...(input.commentId !== undefined ? { commentId: input.commentId } : {}),
      ...(input.reviewNodeId !== undefined ? { reviewNodeId: input.reviewNodeId } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    promoted?: boolean;
    error?: string;
    reason?: string;
  };
  if (!response.ok) {
    // Every refusal the route can return gets a sentence a reviewer can
    // act on, not a code — including `promote-mapping-orphan`, which is a
    // permanent outcome for a comment anchored outside the PR's diff
    // (issue #70 review, §5).
    throw new Error(promoteRefusalMessage(body.error, response.status));
  }
  return { ok: body.ok === true, promoted: body.promoted === true, ...(body.reason !== undefined ? { reason: body.reason } : {}) };
}

/** The reviewer's sentence for a refused promotion. An unrecognised
 * code falls back to the code itself rather than inventing an
 * explanation for a refusal we do not have wording for. */
function promoteRefusalMessage(error: string | undefined, status: number): string {
  switch (error) {
    case "no-open-pending-review":
      return "Cannot promote: your pending review was submitted or discarded. Comment on the PR to open a new one.";
    case "promote-mapping-orphan":
      return "Cannot promote: this comment is anchored outside the PR's diff, so it has no GitHub line to become a review comment on.";
    case "no-github-thread":
      return "Cannot promote: this thread has no GitHub origin, so there is nothing on the PR to attach to.";
    case "not-an-agent-draft":
      return "Cannot promote: that was your own comment or resolve, not the agent's draft.";
    case "stale-lifecycle-draft":
      return "Cannot promote: the agent has since changed this thread's resolve state, so that draft is no longer current.";
    case "promoted-body-changed":
      return "Cannot promote: this comment's text changed since you promoted it, so promoting now would publish text you have not read. Read the current text and promote it again.";
    case "unknown-thread":
    case "unknown-comment":
      return "Cannot promote: that draft is no longer on this page.";
    default:
      return `promote refused: ${error ?? status}`;
  }
}

function needsFreshPromotion(reason: string | undefined): boolean {
  return reason === "promotion-review-mismatch" || reason === "promotion-review-not-pending" || reason === "promotion-review-unbound";
}

function syncFailureMessage(reason: string): string {
  return needsFreshPromotion(reason)
    ? "This agent draft needs a fresh promotion into your current review."
    : reason;
}

/** Fetch review threads for the source paths visible on THIS page.
 * The rail walks every `[data-src]` on load, collects the distinct
 * `path` values, and asks the daemon for each — a large repo with
 * many threads across many files must not stream them all into
 * every page's rail. If the page has no stamped blocks, we fall
 * back to a single unfiltered request so a page carrying nothing
 * more than a `<main>` still surfaces any thread the reviewer has
 * open elsewhere. */
async function fetchThreads(): Promise<RailListResponse> {
  const paths = collectPagePaths();
  // Ask for open, orphaned AND resolved threads on THIS page. Issue
  // #60: a reply-then-resolve race used to blink the reply out of
  // sight because the resolved thread was filtered here and the
  // reviewer never saw the ack. The rail now surfaces resolved
  // threads collapsed inline (like GitHub does), so a reviewer never
  // misses the agent's answer. Anchored resolved threads render
  // next to their block; a resolved thread whose anchor is not
  // rendered on this page falls into the orphaned/resolved panel.
  const statusFilter = "open,orphaned,resolved";
  if (paths.length === 0) {
    const response = await fetch(
      "/api/threads?status=" + encodeURIComponent(statusFilter),
      {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error(`GET /api/threads failed: ${response.status}`);
    return (await response.json()) as RailListResponse;
  }
  const responses = await Promise.all(
    paths.map((path) =>
      fetch(
        "/api/threads?path=" +
          encodeURIComponent(path) +
          "&status=" +
          encodeURIComponent(statusFilter),
        {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        },
      ).then(async (r) => {
        if (!r.ok) throw new Error(`GET /api/threads?path=${path} failed: ${r.status}`);
        return (await r.json()) as RailListResponse;
      }),
    ),
  );
  const merged: RailThread[] = [];
  let head = 0;
  const seen = new Set<string>();
  for (const one of responses) {
    if (one.head > head) head = one.head;
    for (const t of one.threads) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      }
    }
  }
  return { threads: merged, head };
}

/** Walk `[data-src]` blocks and collect the unique repo-relative
 * paths they anchor to. `parseDataSrc` validates the format (path
 * shape + line range); invalid values are dropped silently. */
function collectPagePaths(): string[] {
  const stamped = document.querySelectorAll<HTMLElement>("[data-src]");
  const seen = new Set<string>();
  for (const el of Array.from(stamped)) {
    const raw = el.getAttribute("data-src");
    if (raw === null) continue;
    const parsed = parseDataSrc(raw);
    if (parsed === undefined) continue;
    seen.add(parsed.path);
  }
  return [...seen];
}

/** Body a `POST /api/threads` accepts. Kept in step with the daemon's
 * `createThreadRequestSchema` (packages/cli/src/serve/api-schemas.ts). */
interface CreateThreadBody {
  readonly anchor: CommentTarget;
  readonly selection: SourceSelection;
  readonly body: string;
}
async function createThread(body: CreateThreadBody): Promise<void> {
  const response = await fetch("/api/threads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("The selection could not be mapped to the current source. Reload the page and try again; your draft is still here.");
}

async function replyToThread(threadId: string, parentId: string, body: string): Promise<void> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/replies`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId, body }),
    },
  );
  if (!response.ok) throw new Error(`POST /api/threads/:id/replies failed: ${response.status}`);
}

async function resolveThread(threadId: string): Promise<void> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/resolve`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error(`POST /api/threads/:id/resolve failed: ${response.status}`);
}

async function reopenThread(threadId: string): Promise<void> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/reopen`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error(`POST /api/threads/:id/reopen failed: ${response.status}`);
}

// Local wrappers around the pure helpers in `./unread.ts`. The
// browser-side seen map is keyed by the daemon's persistent
// `repoId`, fetched once on mount via `GET /-/health`. The
// wrappers fall back to the unversioned key when we haven't
// received the id yet; `migrateSeenStorage` folds anything
// written under the bare key into the resolved bucket the
// moment `repoId` arrives, so a "click before /-/health returned"
// mark cannot be lost (issue #60 PR #62 round-3 review).
let currentSeenKey: string | undefined;
function readSeenMap(): SeenMap {
  return readSeenMapImpl(undefined, currentSeenKey);
}
function writeSeenMap(next: SeenMap): void {
  writeSeenMapImpl(next, undefined, currentSeenKey);
}
/** Fetch the daemon's `/-/health` payload and adopt its
 * `repoId` as the storage key. Called once on mount; a
 * failure (rare — daemon is loopback) leaves the unversioned key,
 * so the reviewer's local session still works. */
async function fetchRepoId(): Promise<string | undefined> {
  try {
    const response = await fetch("/-/health", { credentials: "same-origin" });
    if (!response.ok) return undefined;
    const parsed = (await response.json()) as { repoId?: string };
    return typeof parsed.repoId === "string" ? parsed.repoId : undefined;
  } catch {
    return undefined;
  }
}
/** Fetch the FULL, unscoped list of thread ids so the prune
 * pass keeps marks for threads on OTHER pages. Issue #60
 * PR #62 round-3 review: pruning against the page-scoped
 * `threads()` wiped seen marks for every other page.
 *
 * `fields=id` asks the daemon for the id list alone, and that
 * projection GATES the lazy re-anchor trigger (issue #67): the
 * daemon re-anchors before serving a read that can return an
 * anchor, and this one cannot. An unprojected fetch here — the
 * shape this had on `dev` — fired a full `refreshAll()` on every
 * rail mount, ~94% of the mount's daemon cost at 40 threaded
 * paths, for anchors this pass discards. */
async function fetchAllThreadIds(): Promise<readonly string[] | undefined> {
  try {
    const response = await fetch(
      "/api/threads?fields=id&status=" + encodeURIComponent("open,resolved,orphaned"),
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    const parsed = (await response.json()) as { threads?: ReadonlyArray<{ id?: string }> };
    if (!Array.isArray(parsed.threads)) return undefined;
    return parsed.threads.map((t) => t.id).filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}
/** How many unread threads render EXPANDED before the rest fall
 * back to collapsed-with-pill. Tuned so a colleague opening a
 * page with a long agent backlog can still scan the list. */
const UNREAD_EXPANDED_LIMIT = 5;

function normaliseCurrentRoute(pathname: string): string {
  let path = pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  if (!path.startsWith("/")) path = "/" + path;
  if (!path.endsWith("/")) path += "/";
  return path.replace(/\/+/g, "/");
}

/** Where to open `/events` from.
 *
 * Primary source: the log head the daemon stamped into THIS page when
 * it rendered it (`<meta name="revkit-log-head">`). That value is
 * guaranteed to predate the window between this page's HTML GET and
 * the stream attaching, so subscribing from it REPLAYS any update
 * that landed in that window — an update a page which had subscribed
 * unconditionally would have received. The per-seq gate drops the
 * frames the page already handled, so replaying costs nothing.
 *
 * This matters because a working resume point TRADES unconditional
 * replay for conditional updates: before one existed the rail replayed
 * the whole log on every load, so it was never blind — and re-fired
 * its reload triggers forever. With a resume point the trade is only
 * sound if the blind window is closed BY CONSTRUCTION, which is what
 * the server-side stamp does. Probing the head from the page cannot
 * do it, because the probe itself runs inside the window it would
 * need to cover.
 *
 * Fallbacks, in order: this tab's persisted resume point (a WARM
 * reload), then a live read of `/api/events-head`.
 *
 * A total failure degrades to `since=0` (full replay) — safe, not
 * merely degraded: the per-seq gate drops anything already handled, so
 * the worst case is ONE extra reload followed by quiescence. The
 * resume point is the optimisation; the gate is the safety net. */
async function resolveInitialSince(storage: ResumeStorage | undefined): Promise<number> {
  const stored = readResumeSeq(storage);
  // The stamp is in the HTML the browser already has — no request, so
  // no window between reading it and using it.
  const pageHead = readPageRenderHead(document);
  if (pageHead > 0) return sinceForSubscribe(stored, 0, pageHead);
  if (stored > 0) return sinceForSubscribe(stored, 0, 0);
  try {
    const response = await fetch("/api/events-head", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { head?: unknown };
    return sinceForSubscribe(stored, typeof body.head === "number" ? body.head : 0, 0);
  } catch {
    return 0;
  }
}

/** SSE subscriber that re-fetches threads whenever the daemon reports
 * a comment / thread event. Reconnects on close with an exponential
 * backoff up to 30 s — a paused laptop can wake into a stale stream
 * and this brings it back quickly without hammering the daemon.
 *
 * **Two independent guards against acting twice on one event** (M2
 * item 9, PR-56 blocker):
 *
 * 1. A resume point, so the daemon does not replay what this tab has
 *    already seen (see `resolveInitialSince`).
 * 2. A monotonic per-seq gate inside `onmessage`, so ANY
 *    duplicate — a replay that raced the resume point, a reconnect
 *    that re-delivered a frame, a second tab's worth of history — is
 *    dropped before it can bump state or navigate. This is what makes
 *    "reload on `build.succeeded`" safe: the reload is a reaction to a
 *    NEW event, never to the replay of the one that caused it.
 *
 * The resume point is persisted BEFORE any action, so the reload the
 * action triggers starts the next page load already past it. */
function subscribeEvents(
  onBump: (event: RailReviewEvent) => void,
  onModeBump: () => void = () => {},
  onPresence: (event: {
    readonly ts: string;
    readonly state?: string;
    readonly path?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly actor?: { readonly id?: string; readonly displayName?: string };
  }) => void = () => {},
  onDeliveryEvent: (event: {
    readonly kind: string;
    readonly ts: string;
    readonly trigger?: string;
    readonly commentIds?: readonly string[];
    readonly from?: string | null;
    readonly to?: string;
    readonly actor?: { readonly kind?: string; readonly id?: string; readonly displayName?: string };
  }) => void = () => {},
  onAttached: () => void = () => {},
): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let retryDelayMs = 500;
  /** Monotonic per-seq gate: a replay is dropped before it can bump
   * state or navigate. Seeded with the persisted resume point so the
   * gate holds on its own even if `?since=` does not — see
   * `rail/resume-point.ts`. */
  const gate = createSeqGate(readResumeSeq(sessionStorageOrUndefined()));
  /** Resolved once, on first subscribe; reused across reconnects so a
   * reconnect does not re-probe and does not drift to a newer head,
   * which would skip events the browser missed while disconnected. */
  let initialSince: Promise<number> | undefined;
  const kick = (): void => {
    if (closed) return;
    initialSince ??= resolveInitialSince(sessionStorageOrUndefined());
    void initialSince.then((since) => {
      if (closed) return;
      // `EventSource` sends the session cookie automatically because
      // we opened the page under the daemon's own origin.
      source = new EventSource(
        since > 0 ? `/events?since=${encodeURIComponent(String(since))}` : "/events?since=0",
      );
      attach();
    });
  };
  const attach = (): void => {
    if (closed || source === undefined) return;
    // ONE authoritative thread-list refetch once the stream is open.
    //
    // What this does: re-reads `GET /api/threads`, so the rail's
    // thread list reflects anything that landed while it was wiring
    // itself up.
    //
    // What this does NOT do, and used to be claimed to do: re-read
    // THIS ROUTE's HTML. It cannot — the route's page HTML is not
    // reachable from a thread-list fetch. The lost-update window
    // between this page's HTML GET and the stream attaching is closed
    // instead by resuming from the head stamped into this page at
    // RENDER time (`resolveInitialSince`), which REPLAYS that window
    // rather than papering over it.
    onAttached();
    source.onmessage = (message: MessageEvent<string>): void => {
      try {
        const event = JSON.parse(message.data) as RailReviewEvent;
        // Idempotence gate. A durable event carries a positive seq; a
        // replay of one this tab already handled is dropped HERE,
        // before any bump or navigation. Ephemeral frames (presence)
        // carry no seq and are always processed — they are not on the
        // log and cannot be replayed.
        if (typeof event.seq === "number" && !gate.accept(event.seq)) return;
        // Persist BEFORE acting: a reload triggered below must start
        // the next page load past this seq.
        writeResumeSeq(sessionStorageOrUndefined(), event.seq);
        // Any comment/thread transition is a reason to re-fetch. We
        // do not merge into local state — the daemon is authoritative
        // and a re-fetch is one round-trip we can afford.
        if (
          event.kind === "comment.created" ||
          event.kind === "comment.replied" ||
          event.kind === "thread.resolved" ||
          event.kind === "thread.reopened" ||
          // M2 item 5b: re-anchor + orphan events move a thread to a
          // new block (or to the orphan panel) without a page reload.
          // Same refetch strategy — cheap, keeps the rail's model of
          // the world identical to the daemon's authoritative state.
          event.kind === "thread.reanchored" ||
          event.kind === "thread.orphaned" ||
          // M3 part 2b: review-lifecycle + comment-link events
          // change the pending set. The rail's review panel reads
          // that via `refetchReview`; the outer bump also refetches
          // threads (a review.opened / review.submitted doesn't
          // move threads, but comment.linked can update a
          // thread's `external.github` field).
          event.kind === "comment.linked" ||
          event.kind === "comment.sync_requested" ||
          event.kind === "comment.sync_failed" ||
          event.kind === "thread.sync_failed" ||
          event.kind === "thread.external_synced" ||
          event.kind === "draft.promoted" ||
          event.kind === "review.opened" ||
          event.kind === "review.submitted" ||
          event.kind === "review.abandoned"
        ) {
          onBump(event);
        }
        if (event.kind === "doc.published" && typeof event.route === "string") {
          if (normaliseCurrentRoute(window.location.pathname) === normaliseCurrentRoute(event.route)) {
            saveReplyDraftsToSessionStorage();
            window.location.reload();
          }
        }
        // M2 item 9, story A4: a scheduled full build finished —
        // either way. On `build.succeeded` the daemon has fresh dist
        // HTML for every route, so a page that was showing the
        // "rendering..." banner reloads and swaps it out. On
        // `build.failed` the page must ALSO reload, because the
        // banner's content changes from "a build is running" to the
        // build's error tail. Reloading only on success left the
        // reviewer staring at a spinner for a build that had already
        // died — the one state the banner could not self-correct.
        // Reload unconditionally: the server-side derive-from-files
        // logic serves dist untouched when source and dist agree,
        // so an up-to-date page pays a no-op reload at worst.
        if (event.kind === "build.succeeded" || event.kind === "build.failed") {
          saveReplyDraftsToSessionStorage();
          window.location.reload();
        }
        // M2 item 6: any event that could change the batch count
        // re-fetches the mode. A `comment.created` / `comment.replied`
        // adds to the pending set under `handover`; a `handover`
        // event drains it. Both need the badge to reflect the new
        // count without a page reload. `presence` events don't
        // affect the badge.
        if (
          event.kind === "handover" ||
          event.kind === "comment.created" ||
          event.kind === "comment.replied"
        ) {
          onModeBump();
        }
        // Round-3: expose handover + mode-change events to the rail
        // so the human sees a "flushed by …" indicator when the
        // agent (or another local caller) triggers a flush or
        // mode change. Delivery-timing is not confidentiality —
        // the human needs to SEE this happen.
        if (event.kind === "handover" || event.kind === "delivery.mode_changed") {
          onDeliveryEvent(event as unknown as {
            readonly kind: string;
            readonly ts: string;
            readonly trigger?: string;
            readonly commentIds?: readonly string[];
            readonly from?: string | null;
            readonly to?: string;
            readonly actor?: { readonly kind?: string; readonly id?: string; readonly displayName?: string };
          });
        }
        if (event.kind === "presence") {
          onPresence(event as unknown as {
            readonly ts: string;
            readonly state?: string;
            readonly path?: string;
            readonly startLine?: number;
            readonly endLine?: number;
            readonly actor?: { readonly id?: string; readonly displayName?: string };
          });
        }
      } catch {
        // A non-JSON frame is the SSE keepalive comment or a corrupt
        // frame — either way, ignore and wait for the next.
      }
      retryDelayMs = 500;
    };
    source.onerror = (): void => {
      source?.close();
      if (closed) return;
      const delay = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      setTimeout(kick, delay);
    };
  };
  kick();
  return () => {
    closed = true;
    source?.close();
  };
}

function sessionStorageOrUndefined(): (Storage & DraftStorage) | undefined {
  // `sessionStorage` is a getter on `window` and throws in some
  // sandboxed / privacy contexts; a bare read would take the whole rail
  // down, so probe once per call and let the helpers degrade.
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function saveReplyDraftsToSessionStorage(): void {
  const storage = sessionStorageOrUndefined();
  if (storage === undefined) return;
  // Sweep first, so an abandoned tab's drafts do not accumulate
  // indefinitely even while the reviewer is actively using the rail.
  sweepExpiredDrafts(storage, Date.now());
  const forms = document.querySelectorAll<HTMLFormElement>(
    "form.revkit-rail__reply-form[data-thread-id]",
  );
  for (const form of Array.from(forms)) {
    const threadId = form.getAttribute("data-thread-id");
    const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
    if (threadId === null || textarea === null) continue;
    saveDraft(storage, threadId, textarea.value, Date.now());
  }
}

function restoreReplyDraftFromSessionStorage(threadId: string, textarea: HTMLTextAreaElement): boolean {
  const draft = readDraft(sessionStorageOrUndefined(), threadId, Date.now());
  if (draft !== undefined && draft.text.length > 0) {
    textarea.value = draft.text;
    return true;
  }
  return false;
}

function clearReplyDraftFor(threadId: string): void {
  removeDraft(sessionStorageOrUndefined(), threadId);
}

/** Try to find the block on the page whose `data-src` matches
 * `anchor.path:start-end`. Used to scroll a thread's anchor into view
 * when the reviewer opens it in the rail. */
function findBlockForAnchor(anchor: RailAnchor): HTMLElement | undefined {
  // Issue #46 item 5: an unanchored anchor has no line range —
  // nothing on the page to scroll to. Skip the DOM lookup rather
  // than emit `docs/x.mdx:undefined-undefined`.
  if (!isRailLineAnchor(anchor)) return undefined;
  return containingBlock(anchor);
}

/** The floating rail root — one panel pinned to the right edge of the
 * viewport at desktop width; a full-width sheet at phone width. Uses
 * ARIA landmarks / dialogs so a screen reader treats it as a
 * complementary region (ADR-0017). */
function Rail(): JSX.Element {
  const [threads, { refetch }] = createResource(fetchThreads);
  const [mode, { refetch: refetchMode }] = createResource(fetchDeliveryMode);
  // Review-mode state (M3 part 2b). `null` means the daemon is not
  // in review mode; the rail hides the panel entirely.
  const [reviewState, { refetch: refetchReview }] = createResource<RailReviewState | null>(fetchReviewState);
  // Issue #70: the comment ids of agent-authored drafts that no
  // reviewer has promoted yet. The badge on a comment reads this, so
  // the badge disappears the moment the draft is promoted — the same
  // derived state the daemon's promotion route acts on, never a second
  // source of truth in the browser.
  const unpromotedDraftCommentIds = createMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const draft of reviewState()?.state.agentDrafts ?? []) {
      if (draft.target === "comment" && draft.commentId !== undefined) ids.add(draft.commentId);
    }
    return ids;
  });
  const [submitEvent, setSubmitEvent] = createSignal<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [submitBody, setSubmitBody] = createSignal<string>("");
  const [reviewBusy, setReviewBusy] = createSignal<boolean>(false);
  // Two-step discard (nit): first click arms, second click fires,
  // and a 5s idle window disarms — you cannot lose N drafts with
  // a single stray click.
  const [discardArmed, setDiscardArmed] = createSignal<boolean>(false);
  let discardArmTimer: ReturnType<typeof setTimeout> | undefined;
  // Presence — latest beacon per agent id. Cleared on `idle`.
  const [presence, setPresence] = createSignal<readonly PresenceBadge[]>([]);
  // Round-3: "flushed by …" indicator. Every handover or mode
  // change carries the actor who triggered it. The rail shows a
  // short line (auto-clearing after 10 s) so the human sees when
  // the agent-side has taken an action on the delivery pipeline.
  const [deliveryNote, setDeliveryNote] = createSignal<{
    readonly text: string;
    readonly kind: "handover" | "mode-change";
  } | undefined>(undefined);
  let deliveryNoteTimer: ReturnType<typeof setTimeout> | undefined;
  const applyDeliveryEvent = (event: {
    readonly kind: string;
    readonly trigger?: string;
    readonly commentIds?: readonly string[];
    readonly from?: string | null;
    readonly to?: string;
    readonly actor?: { readonly kind?: string; readonly id?: string; readonly displayName?: string };
  }): void => {
    const actor = event.actor;
    const who = actor?.displayName ?? actor?.id ?? actor?.kind ?? "someone";
    if (event.kind === "handover") {
      const count = event.commentIds?.length ?? 0;
      const trigger = event.trigger ?? "handover";
      // Skip bookkeeping frames — a live-trigger handover is not a
      // "flush", it's just the log record for a live push.
      if (trigger === "live") return;
      const label = trigger === "agent-now" ? "@agent now" : trigger === "mode-change-flush" ? "mode change" : "hand-over";
      setDeliveryNote({
        text: `${who} flushed ${count} comment${count === 1 ? "" : "s"} (${label}).`,
        kind: "handover",
      });
    } else if (event.kind === "delivery.mode_changed") {
      setDeliveryNote({
        text: `${who} changed mode: ${event.from ?? "(none)"} → ${event.to ?? "?"}.`,
        kind: "mode-change",
      });
    }
    if (deliveryNoteTimer !== undefined) clearTimeout(deliveryNoteTimer);
    deliveryNoteTimer = setTimeout(() => setDeliveryNote(undefined), 10_000);
  };
  const applyPresenceEvent = (event: {
    readonly ts: string;
    readonly state?: string;
    readonly path?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly actor?: { readonly id?: string; readonly displayName?: string };
  }): void => {
    const agentId = event.actor?.id;
    if (typeof agentId !== "string" || agentId.length === 0) return;
    const state = event.state === "editing" ? "editing" : event.state === "idle" ? "idle" : undefined;
    if (state === undefined) return;
    const next = presence().filter((p) => p.agentId !== agentId);
    if (state === "editing") {
      next.push({
        agentId,
        ...(event.actor?.displayName !== undefined ? { agentDisplayName: event.actor.displayName } : {}),
        state,
        ...(event.path !== undefined ? { path: event.path } : {}),
        ...(event.startLine !== undefined ? { startLine: event.startLine } : {}),
        ...(event.endLine !== undefined ? { endLine: event.endLine } : {}),
        ts: event.ts,
      });
    }
    setPresence(next);
  };
  // The composer builds a fresh line anchor from the reviewer's
  // selection; nothing in this path is ever unanchored. Type as
  // `CommentTarget` so `.startLine` / `.endLine` type-check
  // without narrowing.
  const [composerAnchor, setComposerAnchor] = createSignal<{
    readonly element: HTMLElement;
    readonly anchor: CommentTarget;
    readonly sourceSelection: SourceSelection;
    readonly quote: string;
  } | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  // `replyDraftFor` holds the id of the thread whose reply form is
  // open. Declared here so keyboard handlers set up below can read
  // it in Escape's dispatch table.
  const [replyDraftFor, setReplyDraftFor] = createSignal<string | undefined>(undefined);

  function restoreReplyDraftForThread(threadId: string, textarea: HTMLTextAreaElement): void {
    if (restoreReplyDraftFromSessionStorage(threadId, textarea)) setReplyDraftFor(threadId);
  }
  // Per-viewer "seen" marks for the unread pill (issue #60). Kept
  // in localStorage; wrapped in try/catch, keyed by the daemon's
  // `instanceId` (fetched below) so a rebuild starts fresh. The
  // stored value for each thread is the `latestAgentActivityOf`
  // timestamp the reviewer acknowledged — NOT `updatedAt`, which
  // advances on every event including the reviewer's own resolve /
  // reopen and the re-anchor pipeline (PR #62 review, the L855
  // pre-reopen mark was masking this).
  const [seenMap, setSeenMap] = createSignal<SeenMap>(readSeenMap());
  // On mount:
  //   1. Fetch `repoId` from `/-/health`. `repoId` is stable across
  //      daemon restarts on the same repo (issue #60 PR #62
  //      round-3 review: `instanceId` was per-start so every
  //      restart wiped the reviewer's ack state and left an
  //      orphaned key in localStorage).
  //   2. Migrate: fold any marks under the bare key (from a click
  //      that landed before `/-/health` responded) into the
  //      resolved-key bucket, prefer the newer per-thread
  //      timestamp, touch this repo's bucket in a bounded LRU
  //      index, and reclaim only the seen keys that index does not
  //      list. Another repo's bucket is KEPT (issue #63) — a second
  //      repo served on the same fixed `--port` shares this
  //      origin's localStorage, and deleting its bucket re-fired
  //      every ack the reviewer had already made there.
  //   3. Prune once against the UNSCOPED thread-id list — using
  //      the page-scoped `threads()` here would wipe marks for
  //      threads on every OTHER page (the round-3 blocker).
  //   A `/-/health` failure leaves the bare key in place; the
  //   session still works, just without the per-repo bucket
  //   separation.
  void (async (): Promise<void> => {
    const id = await fetchRepoId();
    if (id !== undefined) {
      const targetKey = seenStorageKeyFor(id);
      // Migrate uses the underlying storage so it can iterate.
      try {
        if (typeof globalThis !== "undefined") {
          const w = globalThis as unknown as { localStorage?: Storage };
          if (w.localStorage !== undefined) migrateSeenStorage(w.localStorage, targetKey);
        }
      } catch {
        // Storage inaccessible — skip; the pill will re-fire once
        // if the click's mark was under the bare key.
      }
      currentSeenKey = targetKey;
      setSeenMap(readSeenMap());
    }
    // Prune against the unscoped id list, once. Fresh mounts on
    // subsequent pages call this again and keep their own marks.
    const allIds = await fetchAllThreadIds();
    if (allIds === undefined) return;
    const current = seenMap();
    const pruned = pruneSeenMap(current, allIds);
    if (pruned === current) return;
    setSeenMap(pruned);
    writeSeenMap(pruned);
  })();
  const markThreadSeen = (thread: RailThread): void => {
    const current = seenMap();
    const latest = latestAgentActivityOf(thread);
    if (latest === undefined) return; // Nothing agent-authored to acknowledge.
    if (current[thread.id] === latest) return;
    const next: SeenMap = { ...current, [thread.id]: latest };
    setSeenMap(next);
    writeSeenMap(next);
  };
  /** Mark every currently-unread thread seen at its latest agent
   * activity — the header "Mark all seen" bulk action. */
  const markAllSeen = (): void => {
    const response = threads();
    if (response === undefined) return;
    const current = seenMap();
    let changed = false;
    const next: Record<string, string> = { ...current };
    for (const thread of response.threads) {
      const latest = latestAgentActivityOf(thread);
      if (latest === undefined) continue;
      if (current[thread.id] === latest) continue;
      next[thread.id] = latest;
      changed = true;
    }
    if (!changed) return;
    setSeenMap(next);
    writeSeenMap(next);
  };
  // Note: the old per-refetch `createEffect` prune (against
  // `threads()`, page-scoped) was removed here — the round-3
  // review caught it wiping every OTHER page's marks. The mount
  // block above prunes once against the UNSCOPED id list.
  // The set of unread thread ids that are ALLOWED to auto-expand.
  // Cap at UNREAD_EXPANDED_LIMIT so a browser opening on a page
  // with 150 unread agent replies does not render 150 expanded
  // threads at once. The remaining unread threads still carry the
  // pill (so the reviewer can navigate to them) but stay collapsed.
  // Ordering: latest agent activity first — the freshest N.
  const autoExpandedUnread = createMemo<ReadonlySet<string>>(() => {
    const response = threads();
    if (response === undefined) return new Set();
    const current = seenMap();
    const withActivity: Array<{ id: string; ts: string }> = [];
    for (const thread of response.threads) {
      if (!isThreadUnread(thread, current)) continue;
      const ts = latestAgentActivityOf(thread) ?? thread.updatedAt;
      withActivity.push({ id: thread.id, ts });
    }
    withActivity.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return new Set(withActivity.slice(0, UNREAD_EXPANDED_LIMIT).map((entry) => entry.id));
  });
  /** Count of unread agent replies — read by the single polite
   * live-region below so screen readers announce a summary once,
   * instead of per-thread `role="status"` pills that would
   * announce 150 times in a row. */
  const unreadCount = createMemo<number>(() => {
    const response = threads();
    if (response === undefined) return 0;
    const current = seenMap();
    let n = 0;
    for (const thread of response.threads) {
      if (isThreadUnread(thread, current)) n += 1;
    }
    return n;
  });
  /** Resolved-thread count for the "Resolved (N)" pill in the
   * rail header. Memoized so a re-render doesn't repeat the O(N)
   * filter for the aria-label, header string and empty-state
   * check — issue #60 exercised these together, so with 150
   * threads the linear scan was running three times per render.
   */
  const resolvedCount = createMemo<number>(() => {
    const response = threads();
    if (response === undefined) return 0;
    let n = 0;
    for (const thread of response.threads) if (thread.status === "resolved") n += 1;
    return n;
  });
  /** True when the whole thread list is empty — open, resolved,
   * orphaned, everything. Drives the "No open threads yet."
   * placeholder. */
  const isThreadListEmpty = createMemo<boolean>(() => {
    const response = threads();
    return response === undefined || response.threads.length === 0;
  });
  /** Memoised main-list / sideline partition (PR #62 review nit).
   * `mainListThreadsFor` and `sidelinedThreadsFor` each call
   * `hasAnchorOnPage` per resolved thread, which walks the DOM
   * with `document.querySelector('[data-src=...]')`. On a page
   * with 150 resolved threads, running the partition twice per
   * render (once for the main list, once for the sideline) was
   * doing 300 DOM queries per state change. Compute both together,
   * one DOM walk per resolved thread. */
  const partition = createMemo<{ readonly main: readonly RailThread[]; readonly sidelined: readonly RailThread[] }>(
    () => {
      const response = threads();
      if (response === undefined) return { main: [], sidelined: [] };
      const main: RailThread[] = [];
      const sidelined: RailThread[] = [];
      for (const thread of response.threads) {
        if (thread.status === "open") main.push(thread);
        else if (thread.status === "resolved") {
          if (hasAnchorOnPage(thread.anchor)) main.push(thread);
          else sidelined.push(thread);
        } else sidelined.push(thread);
      }
      return { main, sidelined };
    },
  );
  const mainList = (): readonly RailThread[] => partition().main;
  const sidelinedList = (): readonly RailThread[] => partition().sidelined;
  // Which resolved threads the reviewer has manually toggled on the
  // disclosure button — separate from the unread-driven auto
  // expansion. Per-session, not persisted. Two sets so a click on
  // an unread-expanded thread can move it into `collapsed` (marking
  // it seen at the same time), which is the intent when the caret
  // is pointing down and the reviewer clicks it. Without this, the
  // toggle on an unread thread would flip `expanded` on and leave
  // the visible state unchanged (already expanded), then need a
  // second click to collapse.
  const [expandedResolved, setExpandedResolved] = createSignal<ReadonlySet<string>>(new Set());
  const [collapsedResolved, setCollapsedResolved] = createSignal<ReadonlySet<string>>(new Set());
  const isResolvedExpanded = (thread: RailThread): boolean => {
    // A manual collapse wins over any default. Then a manual expand
    // wins over the seen-default. Otherwise unread → expanded (issue
    // #60 point 3), but only for threads inside
    // `autoExpandedUnread` — the N most-recent unread threads
    // (PR #62 review: a fresh browser with 150 unread agent-resolved
    // threads must not render 150 expanded rows).
    if (collapsedResolved().has(thread.id)) return false;
    if (expandedResolved().has(thread.id)) return true;
    return autoExpandedUnread().has(thread.id);
  };
  const toggleResolvedExpansion = (thread: RailThread): void => {
    const wasExpanded = isResolvedExpanded(thread);
    if (wasExpanded) {
      // Collapse: drop any manual-expand and record a manual
      // collapse. If the thread is unread, `markThreadSeen` (called
      // by the button) also clears the unread-driven default, but
      // we still keep the manual-collapse mark so a future re-fetch
      // that ticks `updatedAt` (without new agent activity) does not
      // spring the thread open again on the same viewer.
      const nextExpanded = new Set(expandedResolved());
      nextExpanded.delete(thread.id);
      setExpandedResolved(nextExpanded);
      const nextCollapsed = new Set(collapsedResolved());
      nextCollapsed.add(thread.id);
      setCollapsedResolved(nextCollapsed);
    } else {
      const nextCollapsed = new Set(collapsedResolved());
      nextCollapsed.delete(thread.id);
      setCollapsedResolved(nextCollapsed);
      const nextExpanded = new Set(expandedResolved());
      nextExpanded.add(thread.id);
      setExpandedResolved(nextExpanded);
    }
  };

  // Wire the SSE stream on mount, tear it down on unmount. The three
  // subscribers are separated so a `presence` event does not force a
  // thread refetch, and a comment event does not force a mode refetch.
  const unsubscribe = subscribeEvents(
    (event) => {
      void refetch();
      // Any comment.linked / review.* event affects the derived
      // review state — kick a refetch so the pending count and
      // stale banner stay in sync with the log.
      if (
        event.kind === "comment.linked" ||
        event.kind === "comment.sync_requested" ||
        event.kind === "comment.sync_failed" ||
        event.kind === "thread.sync_failed" ||
        event.kind === "thread.external_synced" ||
        event.kind === "draft.promoted" ||
        event.kind === "review.opened" ||
        event.kind === "review.submitted" ||
        event.kind === "review.abandoned" ||
        event.kind === "thread.reanchored" ||
        event.kind === "thread.orphaned" ||
        event.kind === "thread.resolved" ||
        event.kind === "thread.reopened"
      ) {
        void refetchReview();
      }
    },
    () => {
      void refetchMode();
    },
    (event) => applyPresenceEvent(event),
    (event) => applyDeliveryEvent(event),
    // One authoritative refetch once the SSE stream is open, so an
    // event appended between the head probe and the connection is not
    // missed. See `subscribeEvents`.
    () => {
      void refetch();
    },
  );
  onCleanup(unsubscribe);

  // Selection listener: on `mouseup` (or a keyboard-driven
  // `selectionchange` when a screen reader / keyboard user extends
  // a selection with shift+arrow), if the user has selected
  // non-empty text inside a stamped block, we surface two entry
  // points to the composer. First, a floating "Comment" button
  // pinned to the selection's bounding box, so the click
  // affordance is where the eye is. Second, the `c` keyboard
  // shortcut and the "comment on selection" button inside the rail
  // panel (both wired up further down).
  // Selection always builds a fresh LINE anchor from the reviewer's
  // range in the DOM — nothing on this path is ever unanchored.
  const [selection, setSelection] = createSignal<{
    readonly block: HTMLElement;
    readonly anchor: CommentTarget;
    readonly sourceSelection: SourceSelection;
    readonly quote: string;
    readonly rect: { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
  } | undefined>(undefined);
  const readSelection = (): void => {
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(undefined);
      return;
    }
    const text = sel.toString().trim();
    if (text.length === 0) {
      setSelection(undefined);
      return;
    }
    const range = sel.getRangeAt(0);
    const block = rangeBlock(range);
    if (block === undefined) {
      setSelection(undefined);
      return;
    }
    // Ignore selections that live INSIDE the rail itself — e.g. a
    // user selecting an old comment's text should not offer to
    // start a NEW thread from that text.
    if (block.closest("[data-testid=\"revkit-rail\"]") !== null) {
      setSelection(undefined);
      return;
    }
    const raw = block.getAttribute("data-src");
    if (raw === null) {
      setSelection(undefined);
      return;
    }
    const parsed = parseDataSrc(raw);
    if (parsed === undefined) {
      setSelection(undefined);
      return;
    }
    const revision = document.querySelector("[data-revkit-revision]")?.getAttribute("data-revkit-revision");
    if (revision === undefined || revision === null) { setSelection(undefined); return; }
    const sourceSelection = rangeSelection(range, block, revision) ?? { kind: "block" as const, version: PROVENANCE_VERSION, revision };
    const box = range.getBoundingClientRect();
    setSelection({
      block,
      anchor: { ...parsed, revision },
      sourceSelection,
      quote: text,
      rect: { top: box.top, left: box.left, width: box.width, height: box.height },
    });
  };
  document.addEventListener("mouseup", readSelection);
  // `selectionchange` catches keyboard-driven selections (shift+arrow,
  // shift+home/end) so the floating button appears without the mouse.
  document.addEventListener("selectionchange", readSelection);
  onCleanup(() => {
    document.removeEventListener("mouseup", readSelection);
    document.removeEventListener("selectionchange", readSelection);
  });

  const openComposer = async (candidate: NonNullable<ReturnType<typeof selection>>): Promise<void> => {
    setComposerAnchor({
      element: candidate.block,
      anchor: candidate.anchor,
      sourceSelection: candidate.sourceSelection,
      quote: candidate.sourceSelection.kind === "block" ? candidate.block.textContent ?? "" : candidate.quote,
    });
    setSelection(undefined);
  };

  // Keyboard shortcut: `c` when a selection exists opens the
  // composer. Ignored when the user is typing in a form field (a
  // shortcut that steals `c` in a textarea would be worse than not
  // having one). ADR-0017: keyboard-accessible parity with the
  // "comment on selection" button.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
    const pending = selection();
    if (pending === undefined) return;
    event.preventDefault();
    void openComposer(pending);
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  // Escape closes the composer / reply form / dismisses the
  // selection prompt — the browser's own dismiss gesture.
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (composerAnchor() !== undefined) {
      setComposerAnchor(undefined);
      return;
    }
    if (replyDraftFor() !== undefined) {
      setReplyDraftFor(undefined);
      return;
    }
    if (selection() !== undefined) {
      setSelection(undefined);
    }
  };
  document.addEventListener("keydown", onEscape);
  onCleanup(() => document.removeEventListener("keydown", onEscape));

  const submitNewThread = async (bodyText: string): Promise<void> => {
    const composed = composerAnchor();
    if (composed === undefined) return;
    setError(undefined);
    try {
      await createThread({ anchor: composed.anchor, selection: composed.sourceSelection, body: bodyText });
      setComposerAnchor(undefined);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const submitReply = async (thread: RailThread, bodyText: string): Promise<void> => {
    setError(undefined);
    const last = thread.comments[thread.comments.length - 1];
    if (last === undefined) return;
    try {
      await replyToThread(thread.id, last.id, bodyText);
      setReplyDraftFor(undefined);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const doResolve = async (thread: RailThread): Promise<void> => {
    setError(undefined);
    try {
      await resolveThread(thread.id);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const doReopen = async (thread: RailThread): Promise<void> => {
    setError(undefined);
    try {
      // The reviewer's own reopen is not agent activity, so
      // `latestAgentActivityOf(thread)` — which is what
      // `markThreadSeen` records now (PR #62 review) — is
      // unchanged by the reopen. The old "mark seen at
      // pre-reopen `updatedAt`" ceremony is gone; the pill was
      // never going to fire from this action anyway.
      await reopenThread(thread.id);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  // Scroll the anchor block into view when the reviewer clicks on a
  // thread in the list.
  const focusAnchor = (anchor: RailAnchor): void => {
    const block = findBlockForAnchor(anchor);
    if (block !== undefined) {
      block.scrollIntoView({ behavior: "smooth", block: "center" });
      block.setAttribute("data-rail-focus", "true");
      setTimeout(() => block.removeAttribute("data-rail-focus"), 1200);
    }
  };

  // The DOM below is JSX; `babel-preset-solid` compiles it into
  // plain DOM code at bundle time (no `eval` / `new Function`).
  // `Show`, `For`, and event handlers work the same way as under
  // the tagged-template runtime; the migration is textual.
  return (
    <aside
      class="revkit-rail"
      role="complementary"
      aria-label="review comments"
      data-testid="revkit-rail"
    >
      <Show when={selection() !== undefined && composerAnchor() === undefined}>
        {(() => {
          // Floating "Comment" button pinned to the selection's
          // top-right corner. Uses viewport coordinates from
          // `getBoundingClientRect()` (position: fixed). Clicking
          // opens the composer; the `c` keyboard shortcut is the
          // keyboard-only equivalent.
          const sel = selection()!;
          const style =
            `top: ${Math.max(8, sel.rect.top - 36)}px; ` +
            `left: ${Math.min(window.innerWidth - 120, sel.rect.left + sel.rect.width - 8)}px;`;
          return (
            <button
              type="button"
              class="revkit-rail__floating"
              data-testid="revkit-rail-floating"
              style={style}
              onMouseDown={(event: MouseEvent): void => {
                // `mousedown` fires before the click clears the
                // selection — otherwise `openComposer(selection())`
                // sees `undefined` because the click collapsed the
                // range.
                event.preventDefault();
                void openComposer(sel);
              }}
              aria-label={sel.sourceSelection.kind === "block" ? "Comment on whole block — shortcut: c" : `Comment on "${sel.quote.slice(0, 40)}" — shortcut: c`}
            >{sel.sourceSelection.kind === "block" ? "Comment on whole block" : "Comment"}</button>
          );
        })()}
      </Show>
      <header class="revkit-rail__header">
        <h2 class="revkit-rail__title">Comments</h2>
        <Show when={resolvedCount() > 0}>
          <span
            class="revkit-rail__header-resolved-count"
            data-testid="revkit-rail-resolved-count"
            aria-label={`${resolvedCount()} resolved thread${resolvedCount() === 1 ? "" : "s"}`}
          >
            Resolved ({resolvedCount()})
          </span>
        </Show>
        <Show when={unreadCount() > 0}>
          <button
            type="button"
            class="revkit-rail__mark-all-seen"
            data-testid="revkit-rail-mark-all-seen"
            onClick={() => markAllSeen()}
            aria-label={`Mark all ${unreadCount()} unread agent repl${unreadCount() === 1 ? "y" : "ies"} as seen`}
          >Mark all seen</button>
        </Show>
        <button
          type="button"
          class="revkit-rail__refresh"
          onClick={() => void refetch()}
          aria-label="refresh"
        >refresh</button>
      </header>
      {/* Single polite live region for the unread count. PR #62
          review a11y: a screen-reader user should hear one summary
          ("3 unread agent replies") — not a per-thread barrage of
          "agent replied — unread" from every pill's role=status. The
          previous version put role=status on every pill; those pills
          are now presentational and this region carries the announcement. */}
      <div
        class="revkit-rail__unread-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="revkit-rail-unread-live"
      >
        <Show when={unreadCount() > 0}>
          {unreadCount()} unread agent repl{unreadCount() === 1 ? "y" : "ies"}
        </Show>
      </div>
      <section
        class="revkit-rail__mode"
        aria-label="delivery mode"
        data-testid="revkit-rail-mode"
      >
        <fieldset class="revkit-rail__mode-fieldset">
          <legend class="revkit-rail__mode-legend">Delivery</legend>
          <For each={["handover", "live", "quiet"] as const}>
            {(m: DeliveryMode) => (
              <label
                class={`revkit-rail__mode-option revkit-rail__mode-option--${m}`}
                data-testid={`revkit-rail-mode-${m}`}
                data-selected={mode()?.mode === m ? "true" : "false"}
              >
                <input
                  type="radio"
                  name="revkit-rail-mode"
                  value={m}
                  checked={mode()?.mode === m}
                  onChange={() => {
                    void (async () => {
                      try {
                        await setDeliveryMode(m);
                        await refetchMode();
                      } catch (cause) {
                        setError((cause as Error).message);
                      }
                    })();
                  }}
                />
                <span class="revkit-rail__mode-label">{m}</span>
              </label>
            )}
          </For>
        </fieldset>
        <Show when={mode()?.mode === "handover" && (mode()?.batched ?? 0) > 0}>
          <div class="revkit-rail__mode-batched" data-testid="revkit-rail-batched">
            <span
              class="revkit-rail__mode-badge"
              aria-label={`${mode()!.batched} draft${mode()!.batched === 1 ? "" : "s"} pending`}
            >
              {mode()!.batched} pending
            </span>
            <button
              type="button"
              class="revkit-rail__mode-handover"
              data-testid="revkit-rail-handover"
              onClick={() => {
                void (async () => {
                  try {
                    await handOverNow();
                    await refetchMode();
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                })();
              }}
            >Hand over</button>
          </div>
        </Show>
      </section>
      <Show when={deliveryNote() !== undefined}>
        <section
          class={`revkit-rail__delivery-note revkit-rail__delivery-note--${deliveryNote()!.kind}`}
          role="status"
          aria-live="polite"
          data-testid="revkit-rail-delivery-note"
        >
          <p class="revkit-rail__delivery-note-text">{deliveryNote()!.text}</p>
        </section>
      </Show>
      <Show when={reviewState() !== null && reviewState() !== undefined}>
        <section
          class="revkit-rail__review"
          data-testid="revkit-rail-review"
          aria-labelledby="revkit-rail-review-heading"
        >
          <h3 id="revkit-rail-review-heading" class="revkit-rail__review-heading">
            Review: #{reviewState()!.pr.number} — {reviewState()!.pr.title}
          </h3>
          <p class="revkit-rail__review-meta">
            <span class="revkit-rail__review-viewer">as {reviewState()!.viewerLogin}</span>
            {" · "}
            <span class="revkit-rail__review-head">
              head <code>{reviewState()!.pr.headSha.slice(0, 12)}</code>
            </span>
          </p>
          <Show when={reviewState()!.stale}>
            <div
              class="revkit-rail__review-stale"
              role="alert"
              data-testid="revkit-rail-review-stale"
            >
              <p class="revkit-rail__review-stale-text">
                The PR head moved after you opened this pending review — your drafts point at an
                older commit and cannot be submitted as-is.
              </p>
              <button
                type="button"
                class="revkit-rail__review-reanchor"
                data-testid="revkit-rail-review-reanchor"
                disabled={reviewBusy()}
                onClick={() => {
                  void (async () => {
                    setReviewBusy(true);
                    setError(undefined);
                    try {
                      const result = await reanchorPendingReview();
                      setError(undefined);
                      await refetchReview();
                      await refetch();
                      // Surface the outcome in the delivery-note
                      // channel — cheap way to show a transient banner.
                      if (result.orphaned > 0) {
                        setError(
                          `Re-anchored ${result.reanchored} comment${result.reanchored === 1 ? "" : "s"}; ${result.orphaned} orphaned — see the orphan panel below.`,
                        );
                      }
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setReviewBusy(false);
                    }
                  })();
                }}
              >Re-anchor to new head</button>
            </div>
          </Show>
          <p class="revkit-rail__review-count" data-testid="revkit-rail-review-count">
            <Show
              when={reviewState()!.state.openPending !== null && reviewState()!.state.openPending!.comments.length > 0}
              fallback={<span>No pending review comments yet.</span>}
            >
              {reviewState()!.state.openPending!.comments.length} pending comment
              {reviewState()!.state.openPending!.comments.length === 1 ? "" : "s"} on {" "}
              <code>{reviewState()!.state.openPending!.headSha.slice(0, 12)}</code>
            </Show>
          </p>
          {/* Round-3 BLOCK-fix 1 (deleted-on-github recovery): when
              the reconciler detected the pending review was
              deleted on GitHub, the reducer reverts every synced
              draft to `pending-sync` and appends a terminal
              `review.abandoned` with reason `deleted-on-github`.
              The rail surfaces a clear banner asking the human to
              re-post — a click hits /api/review/reconcile under
              cookie auth, which now sees openPending=null +
              unsynced intents and opens a fresh pending review. */}
          <Show
            when={
              reviewState()!.state.openPending === null &&
              (reviewState()!.state.commentSync ?? []).some((c) => c.state.kind === "pending-sync") &&
              reviewState()!.state.terminal.some(
                (t) => t.outcome.kind === "abandoned" && t.outcome.reason === "deleted-on-github",
              )
            }
          >
            <div
              class="revkit-rail__review-deleted-remotely"
              data-testid="revkit-rail-review-deleted-remotely"
              role="alert"
            >
              <p class="revkit-rail__review-deleted-remotely-summary">
                Your pending review was deleted on GitHub — {(reviewState()!.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync").length}{" "}
                draft{(reviewState()!.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync").length === 1 ? "" : "s"} not on GitHub.
              </p>
              <div class="revkit-rail__review-deleted-remotely-actions">
                <button
                  type="button"
                  class="revkit-rail__review-deleted-remotely-repost"
                  data-testid="revkit-rail-review-deleted-remotely-repost"
                  disabled={reviewBusy()}
                  onClick={() => {
                    void (async () => {
                      setReviewBusy(true);
                      setError(undefined);
                      try {
                        const url = new URL(location.href);
                        const response = await fetch(new URL("/api/review/reconcile", url.origin), {
                          method: "POST",
                          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
                          credentials: "same-origin",
                          body: "{}",
                        });
                        if (!response.ok) throw new Error(`Re-post failed (${response.status})`);
                        await refetchReview();
                      } catch (cause) {
                        setError((cause as Error).message);
                      } finally {
                        setReviewBusy(false);
                      }
                    })();
                  }}
                >Re-post {(reviewState()!.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync").length} draft{(reviewState()!.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync").length === 1 ? "" : "s"}</button>
                <button
                  type="button"
                  class="revkit-rail__review-deleted-remotely-discard"
                  data-testid="revkit-rail-review-deleted-remotely-discard"
                  disabled={reviewBusy()}
                  onClick={() => {
                    void (async () => {
                      setReviewBusy(true);
                      setError(undefined);
                      try {
                        // POST /api/review/decline-repost durably
                        // cancels every stranded intent. There is no
                        // pending review to delete on GitHub here.
                        const url = new URL(location.href);
                        const response = await fetch(new URL("/api/review/decline-repost", url.origin), {
                          method: "POST",
                          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
                          credentials: "same-origin",
                          body: "{}",
                        });
                        if (!response.ok) throw new Error(`Discard failed (${response.status})`);
                        await refetchReview();
                      } catch (cause) {
                        setError((cause as Error).message);
                      } finally {
                        setReviewBusy(false);
                      }
                    })();
                  }}
                >Discard</button>
              </div>
            </div>
          </Show>
          {/* Round-2 (ADR-0025): per-comment sync state — a local
              comment whose GitHub AddThread failed shows a "not on
              GitHub — retry" line here. Submit is gated on
              everything being SYNCED; retry runs the reconciler,
              which itself reads GitHub first before writing. */}
          <Show when={(reviewState()!.state.unsyncedCommentIds ?? []).length > 0}>
            <div
              class="revkit-rail__review-unsynced"
              data-testid="revkit-rail-review-unsynced"
              role="alert"
            >
              <p class="revkit-rail__review-unsynced-summary">
                {(reviewState()!.state.unsyncedCommentIds ?? []).length} comment
                {(reviewState()!.state.unsyncedCommentIds ?? []).length === 1 ? "" : "s"} not on GitHub yet.
              </p>
              <ul class="revkit-rail__review-unsynced-list">
                <For each={(reviewState()!.state.commentSync ?? []).filter((c) => c.state.kind === "failed" || c.state.kind === "pending-sync" || c.state.kind === "not-attempted")}>
                  {(entry) => (
                    <li
                      class="revkit-rail__review-unsynced-item"
                      data-testid="revkit-rail-review-unsynced-item"
                      data-comment-id={entry.commentId}
                      data-sync-kind={entry.state.kind}
                    >
                      <code>{entry.commentId.slice(0, 12)}</code>{" "}
                      <span class="revkit-rail__review-unsynced-kind">{entry.state.kind}</span>
                      <Show when={entry.state.reason !== undefined}>
                        <span class="revkit-rail__review-unsynced-reason"> — {syncFailureMessage(entry.state.reason!)}</span>
                      </Show>
                      <Show when={needsFreshPromotion(entry.state.reason)}>
                        <button
                          type="button"
                          class="revkit-rail__agent-draft-promote"
                          data-testid="revkit-rail-review-fresh-promote"
                          disabled={reviewBusy() || reviewState()!.state.openPending === null || !threads()?.threads.some((thread) => thread.comments.some((comment) => comment.id === entry.commentId))}
                          onClick={() => {
                            const reviewNodeId = reviewState()?.state.openPending?.reviewNodeId;
                            const thread = threads()?.threads.find((candidate) => candidate.comments.some((comment) => comment.id === entry.commentId));
                            if (reviewNodeId === undefined || thread === undefined) return;
                            void (async () => {
                              setReviewBusy(true);
                              setError(undefined);
                              try {
                                await promoteAgentDraft({ threadId: thread.id, target: "comment", commentId: entry.commentId, reviewNodeId });
                                await refetchReview();
                                await refetch();
                              } catch (cause) {
                                setError((cause as Error).message);
                              } finally {
                                setReviewBusy(false);
                              }
                            })();
                          }}
                        >Promote to this review</button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <button
                type="button"
                class="revkit-rail__review-unsynced-retry"
                data-testid="revkit-rail-review-unsynced-retry"
                disabled={reviewBusy()}
                onClick={() => {
                  void (async () => {
                    setReviewBusy(true);
                    setError(undefined);
                    try {
                      const url = new URL(location.href);
                      await fetch(new URL("/api/review/reconcile", url.origin), {
                        method: "POST",
                        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
                        credentials: "same-origin",
                        body: "{}",
                      });
                      await refetchReview();
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setReviewBusy(false);
                    }
                  })();
                }}
              >Retry sync</button>
            </div>
          </Show>
          {/* Issue #70 round 3: the reviewer resolved or reopened a
              thread, then the agent changed it again. The reconciler
              correctly refuses to fire the superseded change, so this
              says so — otherwise their click looks like it posted. */}
          <Show when={(reviewState()!.state.droppedReviewerIntents ?? []).length > 0}>
            <div
              class="revkit-rail__dropped-intents"
              data-testid="revkit-rail-dropped-intents"
              role="status"
            >
              <p class="revkit-rail__dropped-intents-summary">
                {(reviewState()!.state.droppedReviewerIntents ?? []).length} of your{" "}
                {(reviewState()!.state.droppedReviewerIntents ?? []).length === 1 ? "resolve or reopen was" : "resolves or reopens were"}{" "}
                superseded before reaching GitHub
                {(reviewState()!.state.droppedReviewerIntents ?? []).length === 1 ? "" : "s"} — the agent
                changed {""}
                {(reviewState()!.state.droppedReviewerIntents ?? []).length === 1 ? "that thread" : "those threads"} after you.
                Nothing was sent to GitHub for{" "}
                {(reviewState()!.state.droppedReviewerIntents ?? []).length === 1 ? "it" : "them"}.
              </p>
              <ul class="revkit-rail__dropped-intents-list">
                <For each={reviewState()!.state.droppedReviewerIntents ?? []}>
                  {(dropped: RailDroppedIntent) => (
                    <li
                      class="revkit-rail__dropped-intent"
                      data-testid="revkit-rail-dropped-intent"
                      data-thread-id={dropped.threadId}
                      data-target={dropped.target}
                    >
                      your {dropped.target} on <code>{dropped.path}</code> — not sent to GitHub
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={(reviewState()!.state.lifecycleFailures ?? []).length > 0}>
            <div class="revkit-rail__review-unsynced" data-testid="revkit-rail-lifecycle-failures" role="alert">
              <ul class="revkit-rail__review-unsynced-list">
                <For each={reviewState()!.state.lifecycleFailures ?? []}>
                  {(entry) => (
                    <li class="revkit-rail__review-unsynced-item" data-testid="revkit-rail-lifecycle-failure"
                      data-thread-id={entry.threadId} data-target={entry.target}>
                      <span>{entry.target} on <code>{entry.path}</code> — {syncFailureMessage(entry.reason)}</span>
                      <button type="button" class="revkit-rail__agent-draft-promote"
                        data-testid="revkit-rail-lifecycle-fresh-promote"
                        disabled={reviewBusy() || reviewState()!.state.openPending === null}
                        onClick={() => {
                          const reviewNodeId = reviewState()?.state.openPending?.reviewNodeId;
                          if (reviewNodeId === undefined) return;
                          void (async () => {
                            setReviewBusy(true);
                            setError(undefined);
                            try {
                              await promoteAgentDraft({ threadId: entry.threadId, target: entry.target, reviewNodeId });
                              await refetchReview();
                              await refetch();
                            } catch (cause) {
                              setError((cause as Error).message);
                            } finally {
                              setReviewBusy(false);
                            }
                          })();
                        }}
                      >Promote to this review</button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={(reviewState()!.state.agentDrafts ?? []).length > 0}>
            {/* Issue #70 (B6, option B): the agent's reply / resolve /
                reopen is a LOCAL draft until the reviewer attaches it
                to their own pending review. Nothing here has reached
                GitHub, and the button is the reviewer's explicit act —
                it POSTs the cookie-authenticated promote route. */}
            <div
              class="revkit-rail__agent-drafts"
              data-testid="revkit-rail-agent-drafts"
              role="region"
              aria-label="agent drafts awaiting promotion"
            >
              <p class="revkit-rail__agent-drafts-summary">
                {(reviewState()!.state.agentDrafts ?? []).length} agent draft
                {(reviewState()!.state.agentDrafts ?? []).length === 1 ? "" : "s"} — written locally by the
                agent, not on GitHub. Promote to include {""}
                {(reviewState()!.state.agentDrafts ?? []).length === 1 ? "it" : "them"} in your review.
              </p>
              <ul class="revkit-rail__agent-drafts-list">
                <For each={reviewState()!.state.agentDrafts ?? []}>
                  {(draft: RailAgentDraft) => (
                    <li
                      class="revkit-rail__agent-draft"
                      data-testid="revkit-rail-agent-draft"
                      data-target={draft.target}
                      data-thread-id={draft.threadId}
                      data-comment-id={draft.commentId ?? ""}
                    >
                      <span
                        class="revkit-rail__agent-draft-badge"
                        data-testid="revkit-rail-agent-draft-badge"
                      >agent draft · not on GitHub</span>
                      <span class="revkit-rail__agent-draft-where">
                        {draft.target === "comment" ? "comment" : draft.target} on{" "}
                        <code>{draft.path}</code>
                      </span>
                      <button
                        type="button"
                        class="revkit-rail__agent-draft-promote"
                        data-testid="revkit-rail-agent-draft-promote"
                        disabled={reviewBusy()}
                        onClick={() => {
                          void (async () => {
                            setReviewBusy(true);
                            setError(undefined);
                            try {
                              await promoteAgentDraft({
                                threadId: draft.threadId,
                                target: draft.target,
                                ...(draft.commentId !== undefined ? { commentId: draft.commentId } : {}),
                              });
                              await refetchReview();
                              await refetch();
                            } catch (cause) {
                              setError((cause as Error).message);
                            } finally {
                              setReviewBusy(false);
                            }
                          })();
                        }}
                      >Promote to my review</button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={reviewState()!.state.openPending !== null && !reviewState()!.stale}>
            <form
              class="revkit-rail__review-submit"
              data-testid="revkit-rail-review-submit"
              onSubmit={(evt) => {
                evt.preventDefault();
                void (async () => {
                  setReviewBusy(true);
                  setError(undefined);
                  try {
                    await submitReview(submitEvent(), submitBody());
                    setSubmitBody("");
                    await refetchReview();
                    await refetch();
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setReviewBusy(false);
                  }
                })();
              }}
            >
              <fieldset class="revkit-rail__review-event">
                <legend class="revkit-rail__review-event-legend">Review event</legend>
                <For each={["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const}>
                  {(e) => (
                    <label class="revkit-rail__review-event-option">
                      <input
                        type="radio"
                        name="revkit-review-event"
                        value={e}
                        checked={submitEvent() === e}
                        onChange={() => setSubmitEvent(e)}
                      />
                      <span class="revkit-rail__review-event-label">{e}</span>
                    </label>
                  )}
                </For>
              </fieldset>
              <label class="revkit-rail__review-body-label" for="revkit-rail-review-body">
                Summary (optional)
              </label>
              <textarea
                id="revkit-rail-review-body"
                class="revkit-rail__review-body"
                data-testid="revkit-rail-review-body"
                rows={3}
                value={submitBody()}
                onInput={(evt) => setSubmitBody((evt.currentTarget as HTMLTextAreaElement).value)}
              />
              <div class="revkit-rail__review-actions">
                <button
                  type="submit"
                  class="revkit-rail__review-submit-button"
                  data-testid="revkit-rail-review-submit-button"
                  disabled={reviewBusy() || (reviewState()!.state.unsyncedCommentIds ?? []).length > 0}
                  title={(reviewState()!.state.unsyncedCommentIds ?? []).length > 0 ? "Retry sync before submitting — the review would ship without unsynced comments." : ""}
                >{reviewBusy() ? "Submitting…" : `Submit review (${submitEvent()})`}</button>
                <button
                  type="button"
                  class={discardArmed() ? "revkit-rail__review-discard revkit-rail__review-discard--armed" : "revkit-rail__review-discard"}
                  data-testid="revkit-rail-review-discard"
                  data-discard-armed={discardArmed() ? "true" : "false"}
                  disabled={reviewBusy()}
                  onClick={() => {
                    if (!discardArmed()) {
                      setDiscardArmed(true);
                      if (discardArmTimer !== undefined) clearTimeout(discardArmTimer);
                      discardArmTimer = setTimeout(() => setDiscardArmed(false), 5000);
                      return;
                    }
                    if (discardArmTimer !== undefined) clearTimeout(discardArmTimer);
                    setDiscardArmed(false);
                    void (async () => {
                      setReviewBusy(true);
                      setError(undefined);
                      try {
                        await discardPendingReview("user-discarded");
                        await refetchReview();
                      } catch (cause) {
                        setError((cause as Error).message);
                      } finally {
                        setReviewBusy(false);
                      }
                    })();
                  }}
                >{discardArmed() ? "Click again to discard" : "Discard"}</button>
                <button
                  type="button"
                  class="revkit-rail__review-refresh"
                  data-testid="revkit-rail-review-refresh"
                  disabled={reviewBusy()}
                  onClick={() => {
                    void (async () => {
                      setReviewBusy(true);
                      setError(undefined);
                      try {
                        await refreshReviewPr();
                        await refetchReview();
                      } catch (cause) {
                        setError((cause as Error).message);
                      } finally {
                        setReviewBusy(false);
                      }
                    })();
                  }}
                >Refresh PR</button>
              </div>
            </form>
          </Show>
        </section>
      </Show>
      <Show when={presence().length > 0}>
        <section
          class="revkit-rail__presence"
          aria-live="polite"
          aria-label="agent activity"
          data-testid="revkit-rail-presence"
        >
          <For each={presence()}>
            {(badge: PresenceBadge) => (
              <p class="revkit-rail__presence-line" data-testid="revkit-rail-presence-line">
                <span class="revkit-rail__presence-dot" aria-hidden="true"></span>
                <span class="revkit-rail__presence-who">
                  {badge.agentDisplayName ?? badge.agentId}
                </span>
                <span class="revkit-rail__presence-verb"> is editing </span>
                <span class="revkit-rail__presence-where">
                  {badge.path ?? "the review"}
                  <Show when={badge.startLine !== undefined && badge.endLine !== undefined}>
                    <span class="revkit-rail__presence-lines">
                      {" "}L{badge.startLine}-{badge.endLine}
                    </span>
                  </Show>
                </span>
              </p>
            )}
          </For>
        </section>
      </Show>
      <Show when={error() !== undefined}>
        <p class="revkit-rail__error" role="alert">{error()}</p>
      </Show>
      <Show when={selection() !== undefined}>
        <div class="revkit-rail__selection" role="region" aria-label="selected text">
          <p class="revkit-rail__quote">"{selection()!.quote}"</p>
          <button
            type="button"
            class="revkit-rail__new"
            data-testid="revkit-rail-new"
            onClick={() => void openComposer(selection()!)}
          >{selection()!.sourceSelection.kind === "block" ? "comment on whole block" : "comment on selection"}</button>
        </div>
      </Show>
      <Show when={composerAnchor() !== undefined}>
        {(() => {
          const composed = composerAnchor()!;
          return (
            <form
              class="revkit-rail__composer"
              data-testid="revkit-rail-composer"
              onSubmit={(event: SubmitEvent): void => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                if (textarea === null || textarea.value.trim().length === 0) return;
                void submitNewThread(textarea.value.trim());
              }}
            >
              <p class="revkit-rail__composer-anchor">
                <span class="revkit-rail__composer-path">{composed.anchor.path}</span>
                <span class="revkit-rail__composer-lines">L{composed.anchor.startLine}–{composed.anchor.endLine}</span>
              </p>
              <p class="revkit-rail__quote">"{composed.quote}"</p>
              <label class="revkit-rail__label">
                <span class="revkit-rail__label-text">Comment</span>
                <textarea
                  required
                  rows="3"
                  data-testid="revkit-rail-composer-input"
                  aria-label="comment body"
                  ref={(el: HTMLTextAreaElement): void => {
                    // Focus on mount so a reviewer opening the
                    // composer (via keyboard `c` or the mouse) can
                    // type immediately (WCAG 2.4.3 focus order).
                    queueMicrotask(() => el.focus());
                  }}
                ></textarea>
              </label>
              <div class="revkit-rail__actions">
                <button
                  type="button"
                  class="revkit-rail__cancel"
                  onClick={() => setComposerAnchor(undefined)}
                >cancel</button>
                <button
                  type="submit"
                  class="revkit-rail__submit"
                  data-testid="revkit-rail-submit"
                >post</button>
              </div>
            </form>
          );
        })()}
      </Show>
      <ol class="revkit-rail__threads" aria-live="polite" data-testid="revkit-rail-threads">
        <For each={mainList()}>
          {(thread: RailThread) => {
            // Issue #60: a resolved thread stays visible in place,
            // collapsed under a disclosure button. An "unread"
            // pill anchors on any thread whose latest touch was
            // agent-authored (reply or resolve) since the human
            // last acknowledged it — expanded by default, and
            // clicking anywhere on the thread marks it seen.
            const isResolved = (): boolean => thread.status === "resolved";
            const unread = (): boolean => isThreadUnread(thread, seenMap());
            // For a resolved thread: collapsed unless unread OR the
            // reviewer explicitly toggled it open. For an open
            // thread: always expanded (its comments matter).
            const expanded = (): boolean => !isResolved() || isResolvedExpanded(thread);
            const disclosureId = `revkit-rail-panel-${thread.id}`;
            const lastComment = thread.comments[thread.comments.length - 1];
            const onThreadInteract = (): void => {
              // Any interaction with the thread body clears the
              // unread pill. The mark is per-viewer and stored in
              // localStorage; a colleague on a different browser
              // keeps their own unread state.
              if (unread()) markThreadSeen(thread);
            };
            return (
              <li
                class={`revkit-rail__thread revkit-rail__thread--${thread.status}${unread() ? " revkit-rail__thread--unread" : ""}`}
                data-thread-id={thread.id}
                data-testid="revkit-rail-thread"
                data-unread={unread() ? "true" : "false"}
                data-expanded={expanded() ? "true" : "false"}
                onClick={onThreadInteract}
              >
                <div class="revkit-rail__thread-header">
                  <button
                    type="button"
                    class="revkit-rail__thread-anchor"
                    onClick={() => focusAnchor(thread.anchor)}
                    data-anchor-kind={isRailLineAnchor(thread.anchor) ? "line" : "unanchored"}
                  >
                    <span class="revkit-rail__thread-path">{thread.anchor.path}</span>
                    <Show
                      when={isRailLineAnchor(thread.anchor)}
                      fallback={
                        // Issue #46 item 5: an unanchored thread renders a
                        // file-level label, never `Lundefined`. The
                        // orphan reason (`diffhunk-mismatch`, `binary`, …)
                        // rides beside it when present, so the reviewer
                        // sees WHY the anchor was lost.
                        <span class="revkit-rail__thread-lines revkit-rail__thread-lines--file">
                          (file-level{thread.orphanReason !== undefined ? ` — ${thread.orphanReason}` : ""})
                        </span>
                      }
                    >
                      <span class="revkit-rail__thread-lines">
                        L{(thread.anchor as RailLineAnchor).startLine}–{(thread.anchor as RailLineAnchor).endLine}
                      </span>
                    </Show>
                  </button>
                  <Show when={unread()}>
                    <span
                      class="revkit-rail__pill revkit-rail__pill--unread"
                      data-testid="revkit-rail-unread-pill"
                    >
                      <span class="revkit-rail__pill-icon" aria-hidden="true">*</span>
                      <span class="revkit-rail__pill-text">
                        {isResolved() ? "agent replied · resolved — unread" : "agent replied — unread"}
                      </span>
                    </span>
                  </Show>
                </div>
                <Show when={isResolved()}>
                  {/* Disclosure summary + resolver line. The
                      disclosure button is a real <button
                      aria-expanded> so screen readers announce
                      "collapsed" / "expanded" (ADR-0017). */}
                  <div class="revkit-rail__resolved-summary">
                    <button
                      type="button"
                      class="revkit-rail__resolved-toggle"
                      aria-expanded={expanded() ? "true" : "false"}
                      aria-controls={disclosureId}
                      data-testid="revkit-rail-resolved-toggle"
                      onClick={(event: MouseEvent): void => {
                        event.stopPropagation();
                        toggleResolvedExpansion(thread);
                        if (unread()) markThreadSeen(thread);
                      }}
                    >
                      <span class="revkit-rail__resolved-caret" aria-hidden="true">{expanded() ? "▾" : "▸"}</span>
                      <span class="revkit-rail__resolved-status">Resolved</span>
                      <Show when={thread.resolvedBy !== undefined || thread.resolvedAt !== undefined}>
                        <span class="revkit-rail__resolved-meta" data-testid="revkit-rail-resolved-meta">
                          <Show when={thread.resolvedBy !== undefined}>
                            {" by "}
                            <span class="revkit-rail__resolved-who">
                              {thread.resolvedBy!.displayName ?? thread.resolvedBy!.id}
                            </span>
                          </Show>
                          <Show when={thread.resolvedAt !== undefined}>
                            {" · "}
                            <time
                              class="revkit-rail__resolved-when"
                              datetime={thread.resolvedAt!}
                            >{formatRelativeTime(thread.resolvedAt!)}</time>
                          </Show>
                        </span>
                      </Show>
                    </button>
                    <Show when={!expanded() && lastComment !== undefined}>
                      <p class="revkit-rail__resolved-excerpt" data-testid="revkit-rail-resolved-excerpt">
                        <span class={`revkit-rail__author-kind revkit-rail__author-kind--${lastComment!.author.kind}`}>{lastComment!.author.kind}</span>
                        {" "}
                        {excerptOf(lastComment!.body)}
                      </p>
                    </Show>
                    {/* PR #62 review nit: reopen is one click from
                        the collapsed row, not two (expand → reopen).
                        The button lives inside the summary so a
                        reviewer scanning a long list of resolved
                        threads can reopen without changing the row's
                        rendered height. */}
                    <button
                      type="button"
                      class="revkit-rail__resolved-reopen"
                      data-testid="revkit-rail-collapsed-reopen"
                      onClick={(event: MouseEvent): void => {
                        event.stopPropagation();
                        void doReopen(thread);
                      }}
                      aria-label={`reopen thread on ${thread.anchor.path}`}
                    >reopen</button>
                  </div>
                </Show>
                <div
                  id={disclosureId}
                  class="revkit-rail__thread-body"
                  data-expanded={expanded() ? "true" : "false"}
                  hidden={!expanded()}
                >
                  <ol class="revkit-rail__comments">
                    <For each={thread.comments}>
                      {(comment: RailComment) => (
                        <li class="revkit-rail__comment" data-testid="revkit-rail-comment" data-author-kind={comment.author.kind}>
                          <p class="revkit-rail__author">
                            <span class={`revkit-rail__author-kind revkit-rail__author-kind--${comment.author.kind}`}>{comment.author.kind}</span>
                            <span class="revkit-rail__author-id">{comment.author.displayName ?? comment.author.id}</span>
                            {/* Issue #70: an agent draft says so, right
                                where the reviewer reads it. The badge is
                                driven by the daemon's derived draft list,
                                so it vanishes the moment the draft is
                                promoted. */}
                            <Show when={unpromotedDraftCommentIds().has(comment.id)}>
                              <span
                                class="revkit-rail__agent-draft-badge"
                                data-testid="revkit-rail-comment-agent-draft-badge"
                              >agent draft · not on GitHub</span>
                            </Show>
                          </p>
                          <p class="revkit-rail__body">{renderBodyWithMentions(comment.body, comment.mentions ?? [])}</p>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={thread.status === "open"}>
                    <div class="revkit-rail__thread-actions">
                      <Show
                        when={replyDraftFor() === thread.id}
                        fallback={
                          <>
                            <button
                              type="button"
                              class="revkit-rail__reply"
                              data-testid="revkit-rail-reply"
                              onClick={() => setReplyDraftFor(thread.id)}
                            >reply</button>
                            <button
                              type="button"
                              class="revkit-rail__resolve"
                              data-testid="revkit-rail-resolve"
                              onClick={() => void doResolve(thread)}
                            >resolve</button>
                          </>
                        }
                      >
                        <form
                          class="revkit-rail__reply-form"
                          data-thread-id={thread.id}
                          onSubmit={(event: SubmitEvent): void => {
                            event.preventDefault();
                            const form = event.currentTarget as HTMLFormElement;
                            const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                            if (textarea === null || textarea.value.trim().length === 0) return;
                            void submitReply(thread, textarea.value.trim());
                            clearReplyDraftFor(thread.id);
                          }}
                        >
                          <label class="revkit-rail__label">
                            <span class="revkit-rail__label-text">Reply</span>
                            <textarea
                              required
                              rows="2"
                              data-testid="revkit-rail-reply-input"
                              aria-label="reply body"
                              ref={(element: HTMLTextAreaElement) => restoreReplyDraftForThread(thread.id, element)}
                            ></textarea>
                          </label>
                          <div class="revkit-rail__actions">
                            <button
                              type="button"
                              class="revkit-rail__cancel"
                              onClick={() => setReplyDraftFor(undefined)}
                            >cancel</button>
                            <button
                              type="submit"
                              class="revkit-rail__submit"
                              data-testid="revkit-rail-reply-submit"
                            >post reply</button>
                          </div>
                        </form>
                      </Show>
                    </div>
                  </Show>
                  <Show when={thread.status === "resolved"}>
                    <div class="revkit-rail__thread-actions">
                      <button
                        type="button"
                        class="revkit-rail__reopen"
                        data-testid="revkit-rail-reopen"
                        onClick={(event: MouseEvent): void => {
                          event.stopPropagation();
                          void doReopen(thread);
                        }}
                      >reopen</button>
                      <Show when={unread()}>
                        <button
                          type="button"
                          class="revkit-rail__mark-seen"
                          data-testid="revkit-rail-mark-seen"
                          onClick={(event: MouseEvent): void => {
                            event.stopPropagation();
                            markThreadSeen(thread);
                          }}
                        >mark seen</button>
                      </Show>
                    </div>
                  </Show>
                </div>
              </li>
            );
          }}
        </For>
      </ol>
      <Show when={isThreadListEmpty()}>
        <p class="revkit-rail__empty" data-testid="revkit-rail-empty">No open threads yet.</p>
      </Show>
      <Show when={sidelinedList().length > 0}>
        {/* Sidelined panel (M2 item 5b, story A8 + issue #60).
            Lists threads that can't render inline — either
            orphaned (the re-anchoring pipeline couldn't place
            them on the current revision) or resolved-but-not-on-
            page (issue #60: instead of vanishing, a resolved
            thread on a file this page doesn't render still
            surfaces here). Both kinds stay repliable, resolvable,
            reopenable. axe: labelled landmark region. */}
        <section
          class="revkit-rail__orphans"
          aria-label="orphaned and resolved review threads"
          data-testid="revkit-rail-orphans"
        >
          <h3 class="revkit-rail__orphans-title">
            Orphaned &amp; resolved
            <span class="revkit-rail__orphans-count" aria-label="count">
              {" "}({sidelinedList().length})
            </span>
          </h3>
          <ol class="revkit-rail__orphans-list">
            <For each={sidelinedList()}>
              {(thread: RailThread) => {
                const unread = (): boolean => isThreadUnread(thread, seenMap());
                const onThreadInteract = (): void => {
                  if (unread()) markThreadSeen(thread);
                };
                return (
                  <li
                    class={`revkit-rail__thread revkit-rail__thread--${thread.status}${unread() ? " revkit-rail__thread--unread" : ""}`}
                    data-thread-id={thread.id}
                    data-testid="revkit-rail-orphan"
                    data-unread={unread() ? "true" : "false"}
                    onClick={onThreadInteract}
                  >
                    <p class="revkit-rail__thread-anchor revkit-rail__thread-anchor--orphaned">
                      <span class="revkit-rail__thread-path">{thread.anchor.path}</span>
                      <Show
                        when={isRailLineAnchor(thread.anchor)}
                        fallback={
                          <span
                            class="revkit-rail__thread-lines revkit-rail__thread-lines--file"
                            data-testid="revkit-rail-orphan-file-scope"
                          >
                            (file-level — no source location)
                          </span>
                        }
                      >
                        {(() => {
                          const la = thread.anchor as RailLineAnchor;
                          return (
                            <span class="revkit-rail__thread-lines">
                              was at L{la.startLine}–{la.endLine}
                            </span>
                          );
                        })()}
                      </Show>
                    </p>
                    <Show when={unread()}>
                      <span
                        class="revkit-rail__pill revkit-rail__pill--unread"
                        data-testid="revkit-rail-unread-pill"
                      >
                        <span class="revkit-rail__pill-icon" aria-hidden="true">*</span>
                        <span class="revkit-rail__pill-text">
                          {thread.status === "resolved" ? "agent replied · resolved — unread" : "agent replied — unread"}
                        </span>
                      </span>
                    </Show>
                    <Show when={thread.status === "resolved" && (thread.resolvedBy !== undefined || thread.resolvedAt !== undefined)}>
                      <p class="revkit-rail__resolved-meta" data-testid="revkit-rail-resolved-meta">
                        Resolved
                        <Show when={thread.resolvedBy !== undefined}>
                          {" by "}
                          <span class="revkit-rail__resolved-who">
                            {thread.resolvedBy!.displayName ?? thread.resolvedBy!.id}
                          </span>
                        </Show>
                        <Show when={thread.resolvedAt !== undefined}>
                          {" · "}
                          <time datetime={thread.resolvedAt!}>{formatRelativeTime(thread.resolvedAt!)}</time>
                        </Show>
                      </p>
                    </Show>
                    <Show when={isRailLineAnchor(thread.anchor)}>
                      {(() => {
                        const la = thread.anchor as RailLineAnchor;
                        return (
                          <blockquote class="revkit-rail__orphan-quote" aria-label="original quote">
                            "{la.quote.exact}"
                          </blockquote>
                        );
                      })()}
                    </Show>
                    <Show when={thread.status === "orphaned"}>
                      <p class="revkit-rail__orphan-reason" data-testid="revkit-rail-orphan-reason">
                        {orphanReasonFor(thread)}
                      </p>
                    </Show>
                    <ol class="revkit-rail__comments">
                      <For each={thread.comments}>
                        {(comment: RailComment) => (
                          <li class="revkit-rail__comment" data-testid="revkit-rail-comment" data-author-kind={comment.author.kind}>
                            <p class="revkit-rail__author">
                              <span class={`revkit-rail__author-kind revkit-rail__author-kind--${comment.author.kind}`}>{comment.author.kind}</span>
                              <span class="revkit-rail__author-id">{comment.author.displayName ?? comment.author.id}</span>
                            </p>
                            <p class="revkit-rail__body">{renderBodyWithMentions(comment.body, comment.mentions ?? [])}</p>
                          </li>
                        )}
                      </For>
                    </ol>
                    <div class="revkit-rail__thread-actions">
                      <Show when={thread.status !== "resolved"}>
                        <Show
                          when={replyDraftFor() === thread.id}
                          fallback={
                            <>
                              <button
                                type="button"
                                class="revkit-rail__reply"
                                data-testid="revkit-rail-orphan-reply"
                                onClick={() => setReplyDraftFor(thread.id)}
                              >reply</button>
                              <button
                                type="button"
                                class="revkit-rail__resolve"
                                data-testid="revkit-rail-orphan-resolve"
                                onClick={() => void doResolve(thread)}
                              >resolve</button>
                            </>
                          }
                        >
                          <form
                            class="revkit-rail__reply-form"
                            data-thread-id={thread.id}
                            onSubmit={(event: SubmitEvent): void => {
                              event.preventDefault();
                              const form = event.currentTarget as HTMLFormElement;
                              const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                              if (textarea === null || textarea.value.trim().length === 0) return;
                              void submitReply(thread, textarea.value.trim());
                              clearReplyDraftFor(thread.id);
                            }}
                          >
                            <label class="revkit-rail__label">
                              <span class="revkit-rail__label-text">Reply</span>
                              <textarea
                                required
                                rows="2"
                                data-testid="revkit-rail-orphan-reply-input"
                                aria-label="reply body"
                                ref={(element: HTMLTextAreaElement) => restoreReplyDraftForThread(thread.id, element)}
                              ></textarea>
                            </label>
                            <div class="revkit-rail__actions">
                              <button
                                type="button"
                                class="revkit-rail__cancel"
                                onClick={() => setReplyDraftFor(undefined)}
                              >cancel</button>
                              <button
                                type="submit"
                                class="revkit-rail__submit"
                                data-testid="revkit-rail-orphan-reply-submit"
                              >post reply</button>
                            </div>
                          </form>
                        </Show>
                      </Show>
                      <Show when={thread.status === "resolved"}>
                        <button
                          type="button"
                          class="revkit-rail__reopen"
                          data-testid="revkit-rail-reopen"
                          onClick={(event: MouseEvent): void => {
                            event.stopPropagation();
                            void doReopen(thread);
                          }}
                        >reopen</button>
                        <Show when={unread()}>
                          <button
                            type="button"
                            class="revkit-rail__mark-seen"
                            data-testid="revkit-rail-mark-seen"
                            onClick={(event: MouseEvent): void => {
                              event.stopPropagation();
                              markThreadSeen(thread);
                            }}
                          >mark seen</button>
                        </Show>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ol>
        </section>
      </Show>
    </aside>
  );
}

/** True when this line-anchored thread's block IS on the page.
 * A resolved thread whose anchor is on-page renders inline
 * collapsed next to its block; one whose anchor is missing
 * (source rebuilt, path deleted, unanchored) is moved into the
 * sidelined panel instead of vanishing. Issue #60. Used by the
 * memoized `partition` inside the Rail component, not called from
 * unit tests — those cover the pure derivations in `unread.ts`. */
function hasAnchorOnPage(anchor: RailAnchor): boolean {
  if (!isRailLineAnchor(anchor)) return false;
  return findBlockForAnchor(anchor) !== undefined;
}


/** Render the orphan panel's reason line. Priority order:
 *
 *   1. The pipeline's own reason from the reducer (Thread.
 *      orphanReason, plumbed through from thread.orphaned's payload
 *      — PR #45 round-2 fix). This is the diff engine's account of
 *      WHY the anchor was lost ("block deleted; no move detected."
 *      or "modified: quote similarity 0.32 < gate 0.4."), which is
 *      what the human actually needs.
 *   2. A generic fallback for backwards-compat: an orphan event
 *      without a reason (from an older daemon) still gets a
 *      readable line. */
function orphanReasonFor(thread: RailThread): string {
  if (thread.orphanReason !== undefined && thread.orphanReason.length > 0) {
    return thread.orphanReason;
  }
  if (!isRailLineAnchor(thread.anchor)) {
    // Unanchored thread with no supplied reason — the pipeline
    // couldn't map it to a source range at all.
    return (
      `This thread has no source location under ${thread.anchor.path}. ` +
      `The thread is kept — reply or resolve it here.`
    );
  }
  return (
    `The quoted text no longer appears at ${thread.anchor.path}:` +
    `L${thread.anchor.startLine}–${thread.anchor.endLine}. ` +
    `The thread is kept — reply or resolve it here.`
  );
}

/** Render a comment body with `@mention` chips inline (M2 item 6
 * round 2, ADR-0011). Round-2: the rail no longer parses mention
 * structure. The daemon parsed the body with the real Markdown AST
 * at append time and stored typed mentions on the event; here we
 * consume them.
 *
 * The rail refuses to render mention text as HTML — every chip
 * goes through the JSX text path so a body like
 * `<script>@agent</script>` never lands in the DOM as script. */
function renderBodyWithMentions(body: string, mentions: readonly Mention[]): JSX.Element {
  if (mentions.length === 0) return body;
  const nodes: JSX.Element[] = [];
  let cursor = 0;
  // Deduplicate ranges: an `@agent now` produces two entries whose
  // ranges overlap (the bare agent mention + the marker). Prefer the
  // WIDER range for chip rendering so `@agent now` appears as one
  // chip, not two overlapping ones.
  const sorted = [...mentions].sort((a, b) => a.range[0] - b.range[0] || (b.range[1] - b.range[0]) - (a.range[1] - a.range[0]));
  const chosen: Mention[] = [];
  let lastEnd = -1;
  for (const mention of sorted) {
    if (mention.range[0] >= lastEnd) {
      chosen.push(mention);
      lastEnd = mention.range[1];
    } else if (mention.range[1] > lastEnd) {
      // The next mention extends the previous — pick the wider by
      // replacing the last chosen when this one is strictly wider.
      const previous = chosen[chosen.length - 1];
      if (previous !== undefined && mention.range[1] - mention.range[0] > previous.range[1] - previous.range[0]) {
        chosen[chosen.length - 1] = mention;
        lastEnd = mention.range[1];
      }
    }
  }
  for (const mention of chosen) {
    const [start, end] = mention.range;
    if (cursor < start) nodes.push(body.slice(cursor, start));
    const label = body.slice(start, end);
    nodes.push(
      <span
        class={`revkit-rail__mention revkit-rail__mention--${mention.kind}`}
        data-testid="revkit-rail-mention"
        data-mention-kind={mention.kind}
        data-mention-id={mention.id}
        title={mention.kind === "agent-now" ? "flushes handover immediately" : mention.label}
      >
        {label}
      </span>,
    );
    cursor = end;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes as unknown as JSX.Element;
}

/** Mount the rail into a fresh `<div>` appended to `<body>`. Idempotent
 * — a second call replaces the previous mount. The bundle's entry
 * point is the single side-effect below, so `import "…/rail.js"` runs
 * `mount()` at load. */
export function mount(): void {
  const previous = document.querySelector<HTMLElement>("[data-revkit-rail-mount]");
  if (previous !== null) previous.remove();
  const root = document.createElement("div");
  root.setAttribute("data-revkit-rail-mount", "true");
  document.body.appendChild(root);
  // `Rail()` returns a Solid JSX element; `render()` accepts any
  // JSX-element factory.
  render(() => Rail(), root);
}

// The bundle's module side-effect: as soon as the browser evaluates
// `/-/rail.js`, the rail mounts itself. The daemon injects the
// `<script type="module" src="/-/rail.js"></script>` tag; no other
// glue is needed on the page.
mount();

// Named export so tests can call `mount()` after tearing the DOM down.
export default mount;
