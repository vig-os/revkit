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
  url: z.string().min(1).optional(),
} as const;

const askAnsweredPayload = {
  kind: z.literal("ask.answered"),
  askId: idSchema,
  answer: askAnswerSchema,
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

/** All event variants — one per `kind`. Each carries the envelope plus
 * its own payload; `.strict()` refuses stray fields so a wire message that
 * looks close but adds an unknown property fails at the boundary. */
const eventVariants = [
  z.object({ ...envelope, ...commentCreatedPayload }).strict(),
  z.object({ ...envelope, ...commentRepliedPayload }).strict(),
  z.object({ ...envelope, ...threadResolvedPayload }).strict(),
  z.object({ ...envelope, ...threadReopenedPayload }).strict(),
  z.object({ ...envelope, ...handoverPayload }).strict(),
  z.object({ ...envelope, ...deliveryModeChangedPayload }).strict(),
  z.object({ ...envelope, ...askCreatedPayload }).strict(),
  z.object({ ...envelope, ...askAnsweredPayload }).strict(),
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
  "delivery.mode_changed",
  "ask.created",
  "ask.answered",
  "comment.linked",
  "thread.reanchored",
  "thread.orphaned",
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
