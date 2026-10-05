// Review event log — the append-only, server-ordered wire (ADR-0006,
// ADR-0007). Every event that crosses a process boundary flows through
// this file: appended by the daemon, fanned out over `/events` (channel /
// WebSocket / SSE / hook), replayed on reconnect via `since(seq)`, and
// reduced into the derived `Thread` view (see `reducer.ts`).
//
// Envelope shape (§5.3):
//   `seq`   — server-assigned, STRICTLY INCREASING (gaps allowed, D1-
//             friendly), starting at 1 for a fresh log. Consumers use
//             `since(lastSeen)` for cheap replay after a reconnect.
//   `ts`    — ISO-8601 datetime with offset, assigned by the store on
//             append.
//   `actor` — the typed author of the event (ADR-0011).
//   `kind`  — discriminant. Payload fields live alongside on the same
//             object so a wire message is one flat record, not a nested
//             envelope + payload.
//
// The kinds match §5.3 / ADR-0007 plus one M3 hook (`comment.linked`,
// see ADR-0025):
//   comment.created  — the first comment of a new thread, carrying the
//                      dual anchor (ADR-0006). Thread creation is implicit
//                      (threads are derived from events).
//   comment.replied  — a subsequent comment in an existing thread.
//   thread.resolved  — the thread's lifecycle moves to `resolved`.
//   thread.reopened  — a resolved thread reopens for follow-up.
//   handover         — the reviewer's "here's my state, go" batched
//                      hand-off (§5.3 delivery modes); carries the ids of
//                      the comments in the batch and the revision they
//                      were made against so the agent sees a coherent
//                      state.
//   presence         — an agent's edit/idle beacon; the page shows "agent
//                      is editing …" and holds a comment on that region
//                      until the edit lands (§5.3).
//   ask.created      — a new question spec (`Ask`) is available at
//                      /ask/<id> (§5.1, ADR-0007).
//   ask.answered     — the human answered the question; the answer is
//                      routed back to the agent through the channel.
//   ask.cancelled    — the agent (or a supervisor) cancels a pending
//                      ask before the human answers, e.g. because the
//                      question is stale after a rebuild. Terminal.
//   ask.expired      — a pending ask crossed its `expiresAt` deadline
//                      without an answer. The daemon emits this
//                      lazily on the next read, so a caller that
//                      never polls still sees the terminal state on
//                      its first `GET /api/asks/:id`. Terminal.
//   comment.linked   — records an external mapping for a local comment
//                      (M3 GitHub adapter, ADR-0025). Reserved on v0 so
//                      M3 lands without a `schemaVersion` bump; the M2
//                      daemon does not emit it.
//   thread.reanchored — the re-anchoring pipeline (ADR-0006 Acceptance,
//                       M2 item 5a) found the thread on a new revision.
//                       Carries the new anchor (with the new revision),
//                       the method that produced it ('quote-exact' or
//                       'fuzzy'), and — for fuzzy — the score. Emitted
//                       by the daemon on every rebuild for each open
//                       thread whose anchor survived; identity/unchanged
//                       results emit nothing.
//   thread.orphaned  — the pipeline could not find the thread on the
//                      new revision above the fuzzy-score threshold.
//                      The thread's status transitions to `orphaned`
//                      but it is kept, still answerable, never dropped
//                      (ADR-0006). A subsequent `thread.reanchored`
//                      un-orphans the thread when a later rebuild finds
//                      it again.
//   doc.published    — the `revkit publish` MCP tool (M2 item 9, story
//                      A4) accepted a new revision of one source file.
//                      Carries the repo-relative `path`, the new
//                      `revision` and the site route the daemon serves
//                      (`route` — may be undefined for a data side
//                      file the site does not surface as its own
//                      page). The rail listens for this event and
//                      reloads the affected page live. The event
//                      touches no thread state; the follow-up
//                      re-anchor pass emits its own
//                      `thread.reanchored`/`thread.orphaned` events.
import { z } from "zod";
import { anchorSchema, anyAnchorSchema } from "./anchor.ts";
import { askAnswerSchema, askSchema } from "./asks.ts";
import { authorSchema } from "./author.ts";
import { idSchema } from "./id.ts";
import { SHA256_HEX_REGEX } from "./revision.ts";
import { externalRefSchema } from "./thread.ts";
import { isoTimestamp } from "./timestamp.ts";

/** The envelope every event carries. Split into a plain object so each
 * kind's variant can spread it and add its own payload fields with one
 * `.strict()` at the end, without repeating the field list six times. */
const envelope = {
  seq: z.number().int().positive(),
  ts: isoTimestamp,
  actor: authorSchema,
} as const;

/** Anchor plus body — the payload of `comment.created`. Its own name so
 * downstream consumers (the rail, the GitHub adapter) can type against
 * exactly the first-comment payload without picking the whole event
 * apart. */
/** Typed mention (ADR-0011). The daemon parses comment bodies at
 * append time with the real Markdown parser (`micromark`), extracts
 * mentions from prose (code spans / fenced blocks / HTML comments
 * are excluded), and writes the typed list onto the event. The
 * rail renders chips from this field — never re-parses the body.
 * A subsequent `comment.linked` etc. never mutates this. */
const commentMentionSchema = z
  .object({
    kind: z.enum(["agent", "agent-now", "gh-user", "team", "role"]),
    /** `<login>` for gh-user; `<org>/<team>` for team; `agent` /
     * `agent:<name>` / `claude` for agent; `author`/`reviewers`/`owners`
     * for role; empty string for `agent-now` (the marker itself). */
    id: z.string(),
    /** The label rendered inside the chip (`@agent`, `@login`, …). */
    label: z.string().min(1),
    /** For `@agent:<name>` only. */
    name: z.string().min(1).optional(),
    /** [start, end) offset in the original comment body. */
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  })
  .strict();

const commentCreatedPayload = {
  kind: z.literal("comment.created"),
  threadId: idSchema,
  commentId: idSchema,
  /** Line-anchored (`kind` absent) OR unanchored (`kind:
   * "unanchored"`). The reducer treats an unanchored anchor as
   * orphaned-from-birth (PR-43 round-5 nit — proper state, not a
   * sentinel string). */
  anchor: anyAnchorSchema,
  body: z.string().min(1),
  /** Typed mentions parsed from the body at append time (ADR-0011,
   * M2 item 6 review round 2). Written by the daemon; the rail
   * reads it to render chips WITHOUT bundling a parser. */
  mentions: z.array(commentMentionSchema).optional(),
  /** PR-43 round-5 nit: structured origin metadata for a thread
   * imported from an external provider (currently GitHub). Set on
   * the thread's opening `comment.created` so the reducer can
   * project it onto `Thread` state without regex-parsing prose.
   * Same shape as the field on `thread.orphaned`. */
  external: z
    .object({
      provider: z.literal("github"),
      threadId: z.string().min(1),
      resolved: z.boolean(),
      resolvedByLogin: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  /** Issue #46 item 3: for a thread born unanchored (`anchor.kind ===
   * "unanchored"`), the reducer projects this onto
   * `Thread.orphanReason` so the rail's orphan panel shows the
   * unavailable reason (`diffhunk-mismatch`, `binary`, …) rather
   * than nothing. Ignored when the anchor is line-anchored — a
   * line-anchored thread reaches `orphaned` via a `thread.orphaned`
   * event, whose own `reason` field the reducer projects on that
   * transition. */
  orphanReason: z.string().min(1).optional(),
} as const;

const commentRepliedPayload = {
  kind: z.literal("comment.replied"),
  threadId: idSchema,
  commentId: idSchema,
  parentId: idSchema,
  body: z.string().min(1),
  /** Typed mentions — same shape as on `comment.created`. */
  mentions: z.array(commentMentionSchema).optional(),
} as const;

/** Round-2 BLOCK-fix 3 (B4 pull update): a remote comment's body
 * changed. Emitted only on refresh, when the local log's last
 * body for `commentId` differs from the remote's current body.
 * The reducer projects it on `Comment.body` and stamps
 * `Comment.editedAt`; the rail's SSE refetches the thread when
 * this arrives, showing an "edited" marker. */
const commentEditedPayload = {
  kind: z.literal("comment.edited"),
  commentId: idSchema,
  body: z.string().min(1),
  /** ISO-8601 timestamp of the remote edit — the caller's own
   * clock for a local edit. Used as a monotonic idempotency
   * marker on refresh: the reducer skips an edit whose
   * `remoteUpdatedAt` is not newer than the last seen. */
  remoteUpdatedAt: z.string().min(1).optional(),
} as const;

const threadResolvedPayload = {
  kind: z.literal("thread.resolved"),
  threadId: idSchema,
  resolution: z.string().min(1).optional(),
} as const;

const threadReopenedPayload = {
  kind: z.literal("thread.reopened"),
  threadId: idSchema,
  reason: z.string().min(1).optional(),
} as const;

/** Last GitHub resolve state observed after a local resolve/reopen
 * intent. Local thread lifecycle remains the durable intent; this
 * event advances the external baseline only after GitHub confirms
 * that state, including an accepted mutation whose response was
 * lost. */
const threadExternalSyncedPayload = {
  kind: z.literal("thread.external_synced"),
  threadId: idSchema,
  resolved: z.boolean(),
  /** Seq of the local thread.resolved/thread.reopened intent this
   * completion acknowledges. Remote observations have no intentSeq. */
  intentSeq: z.number().int().positive().optional(),
  resolvedByLogin: z.string().min(1).optional(),
} as const;

/** Trigger for a `handover` delivery event (M2 item 6 review round 2).
 * Every delivery to the agent stream is recorded on the log as a
 * `handover` event with one of these triggers, so the "pending" set
 * is a pure function of the log — no in-memory state to drift.
 *
 *   - `live` — the comment arrived under `live` mode and was pushed
 *     immediately. commentIds carries the single id.
 *   - `agent-now` — the comment body carried the `@agent now`
 *     marker; the batch was flushed alongside. commentIds carries
 *     every id delivered in the frame (the marker's own comment
 *     plus any prior batched drafts).
 *   - `handover` — reviewer's explicit hand-over (`POST /api/handover`
 *     or the rail's Hand-over button). commentIds carries the whole
 *     pending batch at the time of the flush.
 *   - `mode-change-flush` — handover→live transition flushed the
 *     pending batch first, so a mid-flight batch does not disappear
 *     when the reviewer flips modes. Handover→quiet does NOT flush
 *     (documented decision, ADR-0007 amendment). */
const handoverTriggers = ["live", "agent-now", "handover", "mode-change-flush"] as const;
export const handoverTriggerSchema = z.enum(handoverTriggers);
export type HandoverTrigger = (typeof handoverTriggers)[number];

const handoverPayload = {
  kind: z.literal("handover"),
  commentIds: z.array(idSchema).min(1),
  revision: z
    .string()
    .regex(SHA256_HEX_REGEX, "handover.revision must be a lowercase 64-char SHA-256 hex string (see revisionOf)."),
  note: z.string().min(1).optional(),
  /** The reason this delivery event fired. Optional on the wire so
   * an older log (pre-round-2) still parses; the daemon writes it
   * on every new delivery. Missing = pre-round-2 handover, treated
   * as `handover` trigger for derivation purposes. */
  trigger: handoverTriggerSchema.optional(),
} as const;

/** M2 item 6 review round 2: mode changes ARE log events, not just
 * a file on disk. This lets rehydration derive the "current mode"
 * (and every comment's arrival mode) from the log alone. */
const deliveryModes = ["handover", "live", "quiet"] as const;
export const deliveryModeSchema = z.enum(deliveryModes);
export type DeliveryMode = (typeof deliveryModes)[number];

const deliveryModeChangedPayload = {
  kind: z.literal("delivery.mode_changed"),
  /** Previous mode. `null` for the very first mode-set on a fresh
   * daemon (there was no prior mode to record). */
  from: deliveryModeSchema.nullable(),
  to: deliveryModeSchema,
} as const;

/** Presence state is EPHEMERAL (M2 item 6 review round 2). It is
 * broadcast over the /events stream but never persisted to the
 * durable log — a presence beacon vanishes on a daemon restart,
 * which matches its meaning ("agent is editing NOW"). Kept here as
 * a shared type + Zod enum so the daemon's broadcast validator +
 * the rail's subscriber use the same shape. */
const presenceStates = ["editing", "idle"] as const;
export const presenceStateSchema = z.enum(presenceStates);
export type PresenceState = (typeof presenceStates)[number];

const askCreatedPayload = {
  kind: z.literal("ask.created"),
  askId: idSchema,
  spec: askSchema,
  /** Same-origin path (e.g. `/ask/<id>`) or absolute URL the human
   * opens to answer. Recorded on the event so a re-derivation of
   * the asks view reproduces exactly what the agent got back from
   * `ask` at creation time — even if the daemon later runs on a
   * different port. Optional so an older log still parses. */
  url: z.string().min(1).max(4096).optional(),
  /** Wall-clock deadline (ms since epoch) after which the daemon
   * lazily emits `ask.expired`. Optional — an ask with no deadline
   * lives until answered or cancelled. */
  expiresAtMs: z.number().int().positive().optional(),
} as const;

const askAnsweredPayload = {
  kind: z.literal("ask.answered"),
  askId: idSchema,
  answer: askAnswerSchema,
} as const;

const askCancelledPayload = {
  kind: z.literal("ask.cancelled"),
  askId: idSchema,
  reason: z.string().min(1).max(4096).optional(),
} as const;

const askExpiredPayload = {
  kind: z.literal("ask.expired"),
  askId: idSchema,
} as const;

const commentLinkedPayload = {
  kind: z.literal("comment.linked"),
  commentId: idSchema,
  external: externalRefSchema,
} as const;

/** Methods `thread.reanchored` may carry. `unchanged` is not on the
 * wire — the pipeline emits no event for an identity re-anchor. The
 * other two match the pipeline stages (ADR-0006 Acceptance). */
const reanchorMethods = ["quote-exact", "fuzzy"] as const;
export const reanchorMethodSchema = z.enum(reanchorMethods);
export type ReanchorEventMethod = (typeof reanchorMethods)[number];

const threadReanchoredPayload = {
  kind: z.literal("thread.reanchored"),
  threadId: z.string().min(1),
  anchor: anchorSchema,
  method: reanchorMethodSchema,
  // Present only when `method === 'fuzzy'`. A `superRefine` on the
  // variant below enforces both directions — fuzzy requires a score,
  // and quote-exact refuses one so no silent extra field lands on the log.
  score: z.number().min(0).max(1).optional(),
} as const;

const threadOrphanedPayload = {
  kind: z.literal("thread.orphaned"),
  threadId: z.string().min(1),
  // The revision the pipeline ran against — the SHA-256 of the new
  // source (LF-normalised). Named so an operator can see "this thread
  // orphaned on THIS content", not just "at this timestamp".
  revision: z
    .string()
    .regex(
      SHA256_HEX_REGEX,
      "thread.orphaned.revision must be a lowercase 64-char SHA-256 hex string (see revisionOf).",
    ),
  reason: z.string().min(1).optional(),
  /** PR-43 round-5 nit: structured origin metadata for a thread
   * that was orphaned during import (e.g. the source blob for its
   * lines couldn't be fetched, but the thread still exists on
   * GitHub). Callers use this to render "originally on GitHub,
   * resolved by …" without regex-parsing the reason string. The
   * B4 two-way sync (see ADR-0025 amendment) reconciles the
   * local orphan with the remote resolved state via this field. */
  external: z
    .object({
      provider: z.literal("github"),
      threadId: z.string().min(1),
      resolved: z.boolean(),
      resolvedByLogin: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
} as const;

/** Payload for `doc.published` (M2 item 9, story A4). The agent's
 * `publish` MCP tool wrote a new revision of `path`; the daemon
 * accepted it, re-anchored comments, and re-rendered the affected
 * page. `revision` is the SHA-256 of the new LF-normalised source
 * (matches `revisionOf(source)` so a re-derivation reproduces
 * exactly the same hash). `route` is the site route the daemon
 * serves for this document, or `undefined` when the path is a data
 * side file (a plot data file, `vocab/terms.yaml`) that participates
 * in a page but does not have a page of its own. `paths` carries
 * every co-published file in the same publish batch so a live-
 * update listener can refresh a page whose plot data changed
 * without listing the plot document as the primary path.
 *
 * `generation` is the BATCH boundary: a SHA-256 over the ordered
 * `(path, revision)` pairs of every file in the publish request that
 * produced this event. Every `doc.published` in one batch carries
 * the SAME generation, so a reader that reconnects mid-batch (or
 * receives frames out of order across an SSE gap) can tell which
 * events belong to one atomic publish and never mix revisions from
 * two batches. Required — an event without it cannot be attributed
 * to a batch. The `build.*` kinds reuse the same field for the same
 * reason: a build is scheduled for ONE generation, and its terminal
 * event names that generation so a newer publish's refusal is not
 * cleared by an older build's success. */
const docPublishedPayload = {
  kind: z.literal("doc.published"),
  path: z.string().min(1).max(4096),
  revision: z
    .string()
    .regex(
      SHA256_HEX_REGEX,
      "doc.published.revision must be a lowercase 64-char SHA-256 hex string (see revisionOf).",
    ),
  route: z.string().min(1).max(4096).optional(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
  generation: z
    .string()
    .regex(
      SHA256_HEX_REGEX,
      "doc.published.generation must be a lowercase 64-char SHA-256 hex string (see generationOf).",
    ),
} as const;

/** Submitted-review event options: COMMENT / APPROVE / REQUEST_CHANGES.
 * Same enum shape as `GitHubAdapter.ReviewSubmissionEvent`; declared
 * here so the wire schema does not import the adapter (review-core
 * runs in Bun AND in a Cloudflare Worker — the adapter imports plain
 * `fetch` only, but importing it into events.ts would still couple
 * layers). M3 part 2b. */
const reviewSubmitEvents = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export const reviewSubmitEventSchema = z.enum(reviewSubmitEvents);
export type ReviewSubmitEvent = (typeof reviewSubmitEvents)[number];

/** M3 part 2b: a pending review was OPENED. The daemon writes this
 * before it writes any `comment.linked` event with
 * `external.github.pending: true`, so a restart can derive the
 * "currently-open pending review" without reading anything but the
 * log. `reviewNodeId` is the GraphQL id GitHub assigned; `headSha`
 * is the commit the review was pinned to (must match the pending
 * comments' anchor commit). */
const reviewOpenedPayload = {
  kind: z.literal("review.opened"),
  reviewNodeId: z.string().min(1),
  headSha: z
    .string()
    // `originalCommitOid` shape — hex, may be short or long. Use the
    // same regex the adapter's `github-adapter.ts` uses for oids to
    // avoid an inconsistent constraint. Deliberately not tightened
    // to 40 hex: GitHub's own diff-hunk fixtures sometimes carry
    // short oids and we accept them at import time.
    .regex(/^[0-9a-fA-F]{7,64}$/, "review.opened.headSha must be a 7..64-char hex string"),
} as const;

/** M3 part 2b: the pending review was SUBMITTED. Terminal for the
 * `reviewNodeId`. `event` is the GitHub review event; `body` the
 * top-level review message. */
const reviewSubmittedPayload = {
  kind: z.literal("review.submitted"),
  reviewNodeId: z.string().min(1),
  event: reviewSubmitEventSchema,
  body: z.string().max(65_536).optional(),
} as const;

/** M3 part 2b: the pending review was ABANDONED (deleted). Used by
 * the head-move re-anchor flow — the old pending review's draft
 * comments no longer point at valid lines on the new head, so we
 * delete it before opening a fresh one. Terminal for the
 * `reviewNodeId`. `reason` is a short machine-parseable tag
 * (`head-moved`, `user-discarded`, …). */
const reviewAbandonedPayload = {
  kind: z.literal("review.abandoned"),
  reviewNodeId: z.string().min(1),
  reason: z.string().min(1).max(256).optional(),
} as const;

/** M3 part 2b round-2 (BLOCK-fix): a local comment's sync to the
 * reviewer's PENDING GitHub review was REQUESTED. This is an
 * intent, not a completion — the reconciler is what turns intent
 * into confirmation (via `comment.linked`) or into a visible
 * failure (`comment.sync_failed`). Emitted:
 *   - by the daemon's POST /api/threads handler right after the
 *     local `comment.created`, BEFORE any GitHub call;
 *   - by the re-anchor pipeline for each carried-forward comment
 *     at the new head.
 * Body / anchor coordinates are stored so the reconciler can
 * fingerprint a candidate draft on GitHub (by nodeId when known,
 * else by path+line+side+body). `bodyHash` is `revisionOf(body)`
 * — reconstructable, so the reconciler never trusts the body
 * bytes themselves. */
const commentSyncRequestedPayload = {
  kind: z.literal("comment.sync_requested"),
  commentId: idSchema,
  /** The path the pending comment was posted against — matches the
   * anchor's path except when the anchor mapped to a file-level
   * fallback (renamed file, etc.). */
  path: z.string().min(1),
  /** `LINE` (line-scoped, has line + side) or `FILE` (file-level,
   * no line). */
  subjectType: z.enum(["LINE", "FILE"]),
  side: z.enum(["RIGHT", "LEFT"]).optional(),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  /** SHA-256 hex of the body the daemon INTENDS to post. The
   * reconciler compares GitHub's draft body hash against this to
   * detect an already-posted match. */
  bodyHash: z
    .string()
    .regex(
      SHA256_HEX_REGEX,
      "comment.sync_requested.bodyHash must be a lowercase 64-char SHA-256 hex string (see revisionOf).",
    ),
  /** Present for a reply intent. The reconciler posts through
   * addPullRequestReviewThreadReply instead of creating a new
   * top-level thread, and reads this thread before retrying. */
  replyThreadNodeId: z.string().min(1).optional(),
  /** Remote comment node ids observed before the reply intent.
   * A matching viewer/body comment outside this set proves an
   * accepted-but-response-lost mutation without duplicating it. */
  knownCommentNodeIds: z.array(z.string().min(1)).optional(),
} as const;

/** M3 part 2b round-2 (BLOCK-fix): the reconciler tried to sync a
 * comment and GitHub refused / the network broke / etc. Carries a
 * short machine-readable `reason` so the rail's "not on GitHub —
 * retry" state can be actioned. A subsequent `comment.sync_requested`
 * or `comment.linked` clears the failed state — the log's LAST
 * event on a comment decides its sync state. */
const commentSyncFailedPayload = {
  kind: z.literal("comment.sync_failed"),
  commentId: idSchema,
  reason: z.string().min(1).max(512),
} as const;

/** The reviewer explicitly declined recovery of one sync intent.
 * Correlation to requestedAtSeq prevents a delayed decline from
 * cancelling a newer explicit sync request for the same comment. */
const commentSyncCancelledPayload = {
  kind: z.literal("comment.sync_cancelled"),
  commentId: idSchema,
  requestedAtSeq: z.number().int().positive(),
} as const;

/** Issue #70 (B6, option B): a reviewer explicitly promoted an
 * AGENT-authored draft into their own pending GitHub review. The
 * draft itself is already in the log (`comment.replied` /
 * `thread.resolved` / `thread.reopened` with an `agent` actor) and
 * stays LOCAL until this event lands; promotion is the human act that
 * authorizes the machine intent the reconciler then replays under the
 * reviewer's identity.
 *
 * `commentId` is required iff `target === "comment"` — a resolve or
 * reopen promotion names the THREAD, not a comment. `actor` is the
 * reviewer; the transition validator refuses any other actor, so the
 * agent bearer can author a draft but can never record that it was
 * promoted (see validator.ts `draft.promoted`). */
const draftPromotedPayload = {
  kind: z.literal("draft.promoted"),
  threadId: idSchema,
  target: z.enum(["comment", "resolve", "reopen"]),
  commentId: idSchema.optional(),
} as const;

/** Shared envelope for the four `build.*` kinds (M2 item 9, story
 * A4). `generation` names the publish generation the build was
 * scheduled FOR, so a terminal `build.succeeded` clears exactly the
 * refusals recorded by that generation and a LATER publish's
 * refusal survives. `routes` lists the site routes the build is
 * expected to refresh (empty for a data-only publish, which has no
 * route of its own but still needs the rebuild for the plots and
 * vocabulary that embed it).
 *
 * These are DURABLE log events, not transient bus frames: the daemon
 * appends them through the store, so each carries a real positive
 * `seq` from the envelope, an SSE client that reconnects with
 * `Last-Event-ID` replays them, and a daemon restart can reconcile a
 * build that was in flight when it died. Never mint a seq-0
 * pseudo-event for these — a seq-0 frame breaks the monotonic resume
 * contract the rail and the agent channel both rely on. */
const buildEnvelope = {
  generation: z
    .string()
    .regex(
      SHA256_HEX_REGEX,
      "build.*.generation must be a lowercase 64-char SHA-256 hex string (see generationOf).",
    ),
  routes: z.array(z.string().min(1).max(4096)).max(64),
} as const;
const buildRequestedPayload = {
  kind: z.literal("build.requested"),
  ...buildEnvelope,
} as const;
const buildStartedPayload = {
  kind: z.literal("build.started"),
  ...buildEnvelope,
} as const;
const buildSucceededPayload = {
  kind: z.literal("build.succeeded"),
  ...buildEnvelope,
} as const;
const buildFailedPayload = {
  kind: z.literal("build.failed"),
  ...buildEnvelope,
  error: z.string().min(1).max(8192),
} as const;

/** All event variants — one per `kind`. Each carries the envelope plus
 * its own payload; `.strict()` refuses stray fields so a wire message that
 * looks close but adds an unknown property fails at the boundary. */
const eventVariants = [
  z.object({ ...envelope, ...commentCreatedPayload }).strict(),
  z.object({ ...envelope, ...commentRepliedPayload }).strict(),
  z.object({ ...envelope, ...commentEditedPayload }).strict(),
  z.object({ ...envelope, ...threadResolvedPayload }).strict(),
  z.object({ ...envelope, ...threadReopenedPayload }).strict(),
  z.object({ ...envelope, ...threadExternalSyncedPayload }).strict(),
  z.object({ ...envelope, ...handoverPayload }).strict(),
  z.object({ ...envelope, ...deliveryModeChangedPayload }).strict(),
  z.object({ ...envelope, ...askCreatedPayload }).strict(),
  z.object({ ...envelope, ...askAnsweredPayload }).strict(),
  z.object({ ...envelope, ...askCancelledPayload }).strict(),
  z.object({ ...envelope, ...askExpiredPayload }).strict(),
  z
    .object({ ...envelope, ...commentLinkedPayload })
    .strict()
    .superRefine((event, ctx) => {
      // At least one backend must be present so the event does something.
      // The v0 shape only defines `github`; more backends slot into
      // `externalRefSchema` without a schemaVersion bump.
      if (event.external.github === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["external"],
          message: "comment.linked.external must carry at least one backend (github).",
        });
      }
    }),
  z
    .object({ ...envelope, ...threadReanchoredPayload })
    .strict()
    .superRefine((event, ctx) => {
      // `score` is meaningful only for a fuzzy re-anchor and required
      // for it. A quote-exact match has no fuzzy score; a fuzzy match
      // without one hides the confidence that gates the orphan
      // decision. Fail either shape at the wire boundary.
      if (event.method === "fuzzy" && event.score === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["score"],
          message: "thread.reanchored: method='fuzzy' requires a numeric `score` (0–1).",
        });
      }
      if (event.method !== "fuzzy" && event.score !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["score"],
          message: `thread.reanchored: method='${event.method}' must not carry a score (score is a fuzzy-only signal).`,
        });
      }
    }),
  z.object({ ...envelope, ...threadOrphanedPayload }).strict(),
  z.object({ ...envelope, ...docPublishedPayload }).strict(),
  z.object({ ...envelope, ...reviewOpenedPayload }).strict(),
  z.object({ ...envelope, ...reviewSubmittedPayload }).strict(),
  z.object({ ...envelope, ...reviewAbandonedPayload }).strict(),
  z.object({ ...envelope, ...commentSyncRequestedPayload }).strict(),
  z.object({ ...envelope, ...commentSyncFailedPayload }).strict(),
  z.object({ ...envelope, ...commentSyncCancelledPayload }).strict(),
  z
    .object({ ...envelope, ...draftPromotedPayload })
    .strict()
    .superRefine((event, ctx) => {
      // `commentId` is the identity of a comment draft and is
      // meaningless on a thread-lifecycle promotion. Requiring it one
      // way and forbidding it the other keeps the promotion
      // unambiguous: there is exactly one way to promote each kind.
      if (event.target === "comment" && event.commentId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["commentId"],
          message: "draft.promoted: target='comment' requires the commentId of the draft being promoted.",
        });
      }
      if (event.target !== "comment" && event.commentId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["commentId"],
          message: `draft.promoted: target='${event.target}' must not carry a commentId (a resolve/reopen promotion names the thread).`,
        });
      }
    }),
  z.object({ ...envelope, ...buildRequestedPayload }).strict(),
  z.object({ ...envelope, ...buildStartedPayload }).strict(),
  z.object({ ...envelope, ...buildSucceededPayload }).strict(),
  z.object({ ...envelope, ...buildFailedPayload }).strict(),
] as const;

/** The wire-shape event, discriminated on `kind`. Consumers narrow on
 * `event.kind` and TypeScript gives them the right payload fields with no
 * casts. */
export const reviewEventSchema = z.discriminatedUnion("kind", eventVariants);

export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewEventKind = ReviewEvent["kind"];

/** Convenience: the set of kinds, iterable for exhaustiveness checks and
 * for tests that want to enumerate them. Kept as a manual const tuple —
 * `.superRefine()` (used by two variants) wraps the object so
 * `variant.shape` is not uniformly available across the array. The
 * `satisfies` clause asserts membership without erasing the tuple
 * literal, so adding a new kind above without listing it here fails the
 * typecheck. */
export const reviewEventKinds = [
  "comment.created",
  "comment.replied",
  "comment.edited",
  "thread.resolved",
  "thread.reopened",
  "thread.external_synced",
  "handover",
  "delivery.mode_changed",
  "ask.created",
  "ask.answered",
  "ask.cancelled",
  "ask.expired",
  "comment.linked",
  "thread.reanchored",
  "thread.orphaned",
  "doc.published",
  "review.opened",
  "review.submitted",
  "review.abandoned",
  "comment.sync_requested",
  "comment.sync_failed",
  "comment.sync_cancelled",
  "draft.promoted",
  "build.requested",
  "build.started",
  "build.succeeded",
  "build.failed",
] as const satisfies readonly ReviewEventKind[];

/**
 * The input shape appended to a store: everything except `seq` and `ts`,
 * which the store assigns. Used by `ThreadStore.append`. Keeping the
 * `Input` type derived from `ReviewEvent` means adding a new kind touches
 * one file, not two.
 */
export type ReviewEventInput = {
  [Kind in ReviewEventKind]: Omit<Extract<ReviewEvent, { kind: Kind }>, "seq" | "ts">;
}[ReviewEventKind];
