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
 * pipeline (ADR-0006) when the quote can no longer be found — the thread
 * is kept, still answerable, never dropped. */
export const threadStatuses = ["open", "resolved", "orphaned"] as const;
export type ThreadStatus = (typeof threadStatuses)[number];
export const threadStatusSchema = z.enum(threadStatuses);

/** A single comment in a thread. `parentId` is set for a reply and points
 * at another comment in the same thread; the first comment (created by
 * `comment.created`) has no parent. */
export const commentSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    parentId: z.string().min(1).optional(),
    author: authorSchema,
    body: z.string().min(1),
    createdAt: isoTimestamp,
  })
  .strict();

export type Comment = z.infer<typeof commentSchema>;

/** A thread — anchor, lifecycle state, ordered comment list, and the
 * bookkeeping needed to render a list without walking events on every
 * request. `comments` is ordered by `seq` of the events that produced
 * them, so the order matches the event log. */
export const threadSchema = z
  .object({
    id: z.string().min(1),
    anchor: anchorSchema,
    status: threadStatusSchema,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    comments: z.array(commentSchema),
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
