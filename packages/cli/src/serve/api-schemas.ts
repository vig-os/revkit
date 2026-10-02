// Zod schemas for the JSON API request bodies.
//
// Every schema wraps review-core's shapes so the validator that runs
// on `store.append` (`reviewEventSchema` + `validateNext`) is the
// last word, not the first — nothing here can accept an event
// review-core rejects. The wrappers exist because a POST body is
// smaller than a full `ReviewEvent`. The shapes.
// `POST /api/threads` takes `{anchor, threadId?, commentId?, body}`
// (the daemon fills `actor` from the session or the bearer token,
// generates ids when omitted, and dispatches `comment.created`).
// `POST /api/threads/:id/replies` takes `{parentId, body, commentId?}`.
// `POST /api/threads/:id/resolve` takes `{resolution?}`.
// `POST /api/threads/:id/reopen` takes `{reason?}`.
//
// Ids are optional so the browser can post without minting them; the
// daemon uses `randomUUID()` when the client omits them. A client that
// wants a specific id (test harness, replay) passes one in.

import { z } from "zod";
import { anchorSchema, askAnswerSchema, askSchema, idSchema, reviewSubmitEventSchema } from "@revkit/review-core";
import { PUBLISH_ARRAY_SHAPE_MAX } from "./publish.ts";

/** POST /api/threads. Creates a thread and its first comment in one
 * event (`comment.created`). */
export const createThreadRequestSchema = z
  .object({
    threadId: idSchema.optional(),
    commentId: idSchema.optional(),
    anchor: anchorSchema,
    body: z.string().min(1),
  })
  .strict();

export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

/** POST /api/threads/:id/replies. Adds a reply to an existing thread. */
export const replyRequestSchema = z
  .object({
    commentId: idSchema.optional(),
    parentId: idSchema,
    body: z.string().min(1),
  })
  .strict();

export type ReplyRequest = z.infer<typeof replyRequestSchema>;

/** POST /api/threads/:id/resolve. Marks a thread resolved. */
export const resolveRequestSchema = z
  .object({
    resolution: z.string().min(1).optional(),
  })
  .strict();

export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

/** POST /api/threads/:id/reopen. Reopens a resolved thread. */
export const reopenRequestSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

export type ReopenRequest = z.infer<typeof reopenRequestSchema>;

// ── Asks (M2 item 7, story A1 — ADR-0007, DESIGN-0001 §5.1) ─────────

/** POST /api/asks. Creates a new ask; agent-bearer only. The `id`
 * is optional so the caller may pin one (test harness, replay), but
 * the daemon always assigns a fresh `randomUUID()` when it is
 * omitted — the id ends up as the filename under `.revkit/asks/`.
 * `ttlMs` caps how long the daemon waits before emitting
 * `ask.expired`; a client passing 0 or omitting the field means
 * "no deadline". */
export const MAX_ASK_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a review runs way faster than that
export const createAskRequestSchema = z
  .object({
    id: idSchema.optional(),
    spec: askSchema,
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(
        MAX_ASK_TTL_MS,
        `ttlMs must be <= ${MAX_ASK_TTL_MS} (24h) — asks are for one review session, not a long-lived queue.`,
      )
      .optional(),
  })
  .strict();
export type CreateAskRequest = z.infer<typeof createAskRequestSchema>;

/** POST /api/asks/:id/answer. Cookie-authenticated (the human).
 * Body is an `AskAnswer`; the daemon cross-checks its `kind` against
 * the stored spec's kind before appending `ask.answered`. */
export const answerAskRequestSchema = z
  .object({
    answer: askAnswerSchema,
  })
  .strict();
export type AnswerAskRequest = z.infer<typeof answerAskRequestSchema>;

/** POST /api/asks/:id/cancel. Agent-bearer only. */
export const cancelAskRequestSchema = z
  .object({
    reason: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type CancelAskRequest = z.infer<typeof cancelAskRequestSchema>;

// ── Publish (M2 item 9, story A4 — ADR-0001 amendment) ─────────────

/** One file in a publish batch. `path` is repo-relative POSIX; the
 * daemon-side confinement (`resolvePublishTarget`) enforces the
 * allowlist. `content` is the LF-normalised source (the orchestrator
 * normalises again as a defence in depth). The daemon caps sizes
 * outside this schema (`PUBLISH_FILE_MAX_BYTES`, `PUBLISH_REQUEST_MAX_BYTES`)
 * because the byte total spans MULTIPLE fields, which zod does not
 * express cleanly. */
const publishFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    content: z.string(),
  })
  .strict();

/** POST /api/publish. Agent-bearer only. Batch shape:
 *
 *   { docs: [ { path, content }, … ], data?: [ { path, content }, … ] }
 *
 * `docs` carries the primary source files (the .md documents the
 * daemon renders through the fast path). `data` carries side files
 * (plot data, `vocab/terms.yaml`) which do not produce their own
 * override HTML but still trigger `revkit check` + re-anchoring +
 * a `doc.published` event.
 *
 * Both arrays are optional-at-schema (the daemon refuses empty
 * batches with a runtime error so the schema-level `min(1)` isn't
 * needed) so a batch that carries only data doesn't need an empty
 * `docs: []` on the wire.
 */
export const publishRequestSchema = z
  .object({
    docs: z.array(publishFileSchema).max(PUBLISH_ARRAY_SHAPE_MAX).optional(),
    data: z.array(publishFileSchema).max(PUBLISH_ARRAY_SHAPE_MAX).optional(),
  })
  .strict();
export type PublishRequest = z.infer<typeof publishRequestSchema>;

// ── Review-mode (M3 part 2b, ADR-0025) ────────────────────────────

/** POST /api/review/submit. Cookie-authenticated only (the agent
 * bearer is refused with 403 at the route). `event` matches
 * `GitHubAdapter.ReviewSubmissionEvent`; `body` is the top-level
 * review message (optional — the daemon composes a default). */
export const submitReviewRequestSchema = z
  .object({
    event: reviewSubmitEventSchema,
    body: z.string().max(65_536).optional(),
  })
  .strict();
export type SubmitReviewRequest = z.infer<typeof submitReviewRequestSchema>;

/** POST /api/review/discard. Cookie-authenticated only. Deletes
 * the pending review on GitHub and records the abandon. Body is
 * optional — an omitted body defaults to `reason: "user-discarded"`
 * at the daemon. */
export const discardReviewRequestSchema = z
  .object({
    reason: z.string().min(1).max(256).optional(),
  })
  .strict();
export type DiscardReviewRequest = z.infer<typeof discardReviewRequestSchema>;
