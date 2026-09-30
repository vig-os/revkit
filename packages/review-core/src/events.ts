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

const handoverPayload = {
  kind: z.literal("handover"),
  commentIds: z.array(idSchema).min(1),
  revision: z
    .string()
    .regex(SHA256_HEX_REGEX, "handover.revision must be a lowercase 64-char SHA-256 hex string (see revisionOf)."),
  note: z.string().min(1).optional(),
} as const;

const presenceStates = ["editing", "idle"] as const;
export const presenceStateSchema = z.enum(presenceStates);
export type PresenceState = (typeof presenceStates)[number];

const presencePayload = {
  kind: z.literal("presence"),
  state: presenceStateSchema,
  path: z.string().min(1).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
} as const;

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
 * without listing the plot document as the primary path. */
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
} as const;

/** All event variants — one per `kind`. Each carries the envelope plus
 * its own payload; `.strict()` refuses stray fields so a wire message that
 * looks close but adds an unknown property fails at the boundary. */
const eventVariants = [
  z.object({ ...envelope, ...commentCreatedPayload }).strict(),
  z.object({ ...envelope, ...commentRepliedPayload }).strict(),
  z.object({ ...envelope, ...threadResolvedPayload }).strict(),
  z.object({ ...envelope, ...threadReopenedPayload }).strict(),
  z.object({ ...envelope, ...handoverPayload }).strict(),
  z
    .object({ ...envelope, ...presencePayload })
    .strict()
    .superRefine((event, ctx) => {
      // Line range is optional on presence, but if either bound is set the
      // other must be too and end >= start. Prevents a half-specified
      // "editing L10" event that a consumer can't render.
      const startSet = event.startLine !== undefined;
      const endSet = event.endLine !== undefined;
      if (startSet !== endSet) {
        ctx.addIssue({
          code: "custom",
          path: [startSet ? "endLine" : "startLine"],
          message: "presence: startLine and endLine must be set together.",
        });
        return;
      }
      if (startSet && endSet && (event.endLine ?? 0) < (event.startLine ?? 0)) {
        ctx.addIssue({
          code: "custom",
          path: ["endLine"],
          message: "presence: endLine must be >= startLine.",
        });
      }
    }),
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
  "thread.resolved",
  "thread.reopened",
  "handover",
  "presence",
  "ask.created",
  "ask.answered",
  "ask.cancelled",
  "ask.expired",
  "comment.linked",
  "thread.reanchored",
  "thread.orphaned",
  "doc.published",
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
