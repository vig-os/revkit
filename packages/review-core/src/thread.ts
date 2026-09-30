// Thread and comment shapes — derived state, reduced from the event log
// (ADR-0006). The log is the source of truth; a Thread is what
// `reduce(events)` (see `reducer.ts`) produces from the events that touch
// it. Storing the shape here rather than only inside the reducer lets the
// export/import format and the store interface reference a single Zod
// schema for cross-boundary validation (ADR-0025).
import { z } from "zod";
import { anchorSchema } from "./anchor.ts";
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
 * a `schemaVersion` bump. */
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
    anchor: anchorSchema,
    status: threadStatusSchema,
    createdSeq: z.number().int().positive(),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    comments: z.array(commentSchema),
    /** The reason string from the most recent `thread.orphaned`
     * event on this thread, if any. Present ONLY when
     * `status === "orphaned"` and the pipeline supplied a reason;
     * cleared by a subsequent `thread.reanchored` (which un-orphans
     * the thread). Read by the rail's orphan panel so the human
     * sees WHY the anchor was lost — the diff's own account rather
     * than a synthesised sentence. (PR #45 round-2 nit.) */
    orphanReason: z.string().min(1).optional(),
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
