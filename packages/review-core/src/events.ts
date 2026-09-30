// Review event log — the append-only, server-ordered wire (ADR-0006,
// ADR-0007). Every event that crosses a process boundary flows through
// this file: appended by the daemon, fanned out over `/events` (channel /
// WebSocket / SSE / hook), replayed on reconnect via `since(seq)`, and
// reduced into the derived `Thread` view (see `reducer.ts`).
//
// Envelope shape (§5.3):
//   `seq`   — server-assigned, strictly monotonically increasing, starting
//             at 1. Consumers use `since(seq)` for cheap replay after a
//             reconnect.
//   `ts`    — ISO-8601 datetime with offset, assigned by the store on
//             append.
//   `actor` — the typed author of the event (ADR-0011).
//   `kind`  — discriminant. Payload fields live alongside on the same
//             object so a wire message is one flat record, not a nested
//             envelope + payload.
//
// The kinds match §5.3 / ADR-0007:
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
import { z } from "zod";
import { anchorSchema } from "./anchor.ts";
import { askAnswerSchema, askSchema } from "./asks.ts";
import { authorSchema } from "./author.ts";
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
  threadId: z.string().min(1),
  commentId: z.string().min(1),
  anchor: anchorSchema,
  body: z.string().min(1),
} as const;

const commentRepliedPayload = {
  kind: z.literal("comment.replied"),
  threadId: z.string().min(1),
  commentId: z.string().min(1),
  parentId: z.string().min(1),
  body: z.string().min(1),
} as const;

const threadResolvedPayload = {
  kind: z.literal("thread.resolved"),
  threadId: z.string().min(1),
  resolution: z.string().min(1).optional(),
} as const;

const threadReopenedPayload = {
  kind: z.literal("thread.reopened"),
  threadId: z.string().min(1),
  reason: z.string().min(1).optional(),
} as const;

const handoverPayload = {
  kind: z.literal("handover"),
  commentIds: z.array(z.string().min(1)).min(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
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
  askId: z.string().min(1),
  spec: askSchema,
  url: z.string().min(1).optional(),
} as const;

const askAnsweredPayload = {
  kind: z.literal("ask.answered"),
  askId: z.string().min(1),
  answer: askAnswerSchema,
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
] as const;

/** The wire-shape event, discriminated on `kind`. Consumers narrow on
 * `event.kind` and TypeScript gives them the right payload fields with no
 * casts. */
export const reviewEventSchema = z.discriminatedUnion("kind", eventVariants);

export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewEventKind = ReviewEvent["kind"];

/** Convenience: the set of kinds, iterable for exhaustiveness checks and
 * for tests that want to enumerate them. Kept as a manual const tuple —
 * `.superRefine()` (used by the `presence` variant) wraps the object so
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
