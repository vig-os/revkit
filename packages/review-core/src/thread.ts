// Thread and comment shapes — derived state, reduced from the event log
// (ADR-0006). The log is the source of truth; a Thread is what
// `reduce(events)` (see `reducer.ts`) produces from the events that touch
// it. Storing the shape here rather than only inside the reducer lets the
// export/import format and the store interface reference a single Zod
// schema for cross-boundary validation (ADR-0025).
import { z } from "zod";
import { anyAnchorSchema } from "./anchor.ts";
import { authorSchema } from "./author.ts";
import { isoTimestamp } from "./timestamp.ts";

/** Lifecycle state of a thread. `orphaned` is set by the re-anchoring
 * pipeline (ADR-0006, M2 item 5 — not populated by v0 events, kept here
 * so the shape is stable when the pipeline lands). The thread is kept,
 * still answerable, never dropped. */
export const threadStatuses = ["open", "resolved", "orphaned"] as const;
export type ThreadStatus = (typeof threadStatuses)[number];
export const threadStatusSchema = z.enum(threadStatuses);

/** An external comment mapping. Populated by `comment.linked` when the
 * comment is mirrored somewhere off-log — today that means a GitHub PR
 * review comment (M3, ADR-0025). Structured so a second backend (a
 * hosted `@revkit` reference, GitLab down the line) slots in without
 * a `schemaVersion` bump.
 *
 * M3 part 2b: the `github` block gains `pending` and `reviewNodeId`.
 * `pending: true` means the comment lives in an unsubmitted PENDING
 * review; `reviewNodeId` is the GraphQL id of that pending review
 * so the derived "pending set" (see `review-state.ts::reduceReviewState`)
 * can link each comment to the review it belongs to. Both fields are
 * OPTIONAL so a `comment.linked` event for a SUBMITTED comment (older
 * log, import path) still parses. `pending: false` is representable
 * for callers who want to be explicit, but derivation treats
 * `undefined` and `false` alike. */
export const externalRefSchema = z
  .object({
    github: z
      .object({
        // GitHub's REST comment id (integer). The GraphQL id is opaque
        // and lives in `nodeId`; both are useful — pick the one the
        // consumer's API needs.
        commentId: z.number().int().positive(),
        reviewId: z.number().int().positive().optional(),
        nodeId: z.string().min(1).optional(),
        /** True when this link was created for a PENDING (unsubmitted)
         * review draft. Falsy / absent for a published review comment.
         * The daemon writes true on `addPendingReviewThread`, and the
         * derived review-state view flips comments to submitted /
         * abandoned via `review.submitted` / `review.abandoned` events
         * on the containing review (not by mutating the link event —
         * the log is append-only). M3 part 2b. */
        pending: z.boolean().optional(),
        /** GraphQL node id of the pending review this comment belongs
         * to. Set alongside `pending: true` so submit / abandon can
         * find every draft that must go along with the review's own
         * terminal transition. Node ids are opaque strings; only the
         * min-1 constraint is enforced. M3 part 2b. */
        reviewNodeId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ExternalRef = z.infer<typeof externalRefSchema>;

/** A single comment in a thread. `parentId` is set for a reply and points
 * at another comment in the same thread; the first comment (created by
 * `comment.created`) has no parent. `external` is set by
 * `comment.linked` when the comment is mirrored to a backend such as a
 * GitHub PR review. */
export const commentSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    parentId: z.string().min(1).optional(),
    author: authorSchema,
    body: z.string().min(1),
    createdAt: isoTimestamp,
    external: externalRefSchema.optional(),
    /** M2 item 6 round 2: typed mentions parsed on the daemon at
     * append time (see `commentMentionSchema` in `./events.ts`).
     * Optional so pre-round-2 comments still parse. */
    mentions: z
      .array(
        z
          .object({
            kind: z.enum(["agent", "agent-now", "gh-user", "team", "role"]),
            id: z.string(),
            label: z.string().min(1),
            name: z.string().min(1).optional(),
            range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type Comment = z.infer<typeof commentSchema>;

/** A thread — anchor, lifecycle state, ordered comment list, and the
 * bookkeeping needed to render a list without walking events on every
 * request. `comments` is ordered by `seq` of the events that produced
 * them, so the order matches the event log. `createdSeq` is the seq of
 * the `comment.created` event that opened the thread — the deterministic
 * key the store orders threads on (an ISO string tie-breaks poorly at
 * sub-second resolution and drifts if the clock skews). */
export const threadSchema = z
  .object({
    id: z.string().min(1),
    anchor: anyAnchorSchema,
    status: threadStatusSchema,
    createdSeq: z.number().int().positive(),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    comments: z.array(commentSchema),
    /** The reason string from the most recent `thread.orphaned`
     * event on this thread, or the reason recorded on
     * `comment.created` for a thread born unanchored. Present
     * when the thread was ever orphaned and the pipeline supplied
     * a reason — including on a `resolved` thread that was
     * orphaned BEFORE the resolve, so a subsequent
     * `thread.reopened` restores the reason alongside the
     * `orphaned` state (issue #46 item 4). Cleared by
     * `thread.reanchored` (the block came back). Read by the
     * rail's orphan panel so the human sees WHY the anchor was
     * lost — the pipeline's own account rather than a synthesised
     * sentence. Field name matches PR #45 for merge compatibility
     * (issue #46). */
    orphanReason: z.string().min(1).optional(),
    /** Structured origin metadata for a thread imported from an
     * external provider (currently GitHub). Projected from
     * `comment.created.external` by the reducer so B4 two-way
     * sync (ADR-0025 amendment) can reconcile local orphan state
     * with the remote's `resolved` bit without regex-parsing prose.
     * (Issue #46 item 3.) */
    external: z
      .object({
        provider: z.literal("github"),
        threadId: z.string().min(1),
        resolved: z.boolean(),
        resolvedByLogin: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** The status this thread was in BEFORE the most recent
     * `thread.resolved` event, so `thread.reopened` restores the
     * correct pre-resolve state (open or orphaned). Set on
     * resolve, read on reopen. (Issue #46 item 4.) */
    resumeStatus: z.enum(["open", "orphaned"]).optional(),
    /** The typed actor who authored the most recent
     * `thread.resolved` event, projected here so the rail can
     * render "resolved by …" on a collapsed resolved thread
     * without walking the raw event log (issue #60). Set on
     * resolve, dropped on reopen. */
    resolvedBy: authorSchema.optional(),
    /** The `ts` of the most recent `thread.resolved` event.
     * Same projection intent as `resolvedBy` — the rail shows
     * "resolved <relative>". Set on resolve, dropped on
     * reopen. (Issue #60.) */
    resolvedAt: isoTimestamp.optional(),
  })
  .strict();

export type Thread = z.infer<typeof threadSchema>;

/** Optional filter for `ThreadStore.threads()`. `status` narrows the
 * lifecycle set; `path` narrows to threads anchored under one source file.
 * A caller that wants both applies both. */
export const threadFilterSchema = z
  .object({
    status: z.union([threadStatusSchema, z.array(threadStatusSchema).min(1)]).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

export type ThreadFilter = z.infer<typeof threadFilterSchema>;
