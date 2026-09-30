// Reduce the event log (source of truth, ADR-0006) into the derived Thread
// view. Pure: same input, same output; the store may cache the map but
// never mutates from the outside — `since(seq)` plus `reduce` regenerates
// the same shape a store built up incrementally.
//
// Order rules:
//   1. Events are applied in ascending `seq`. The caller passes any slice
//      of the log; `reduce` re-sorts to make it idempotent regardless of
//      how the caller stored them.
//   2. A `comment.replied`, `thread.resolved` or `thread.reopened` for a
//      thread that has not been created yet is ignored. The append path
//      (see `store.ts`) refuses such an event at the boundary, so a
//      correctly-produced log never carries one; ignoring on the read
//      side keeps `reduce` a total function on any event slice (a partial
//      slice via `since(seq)` may legitimately reference an older,
//      still-in-scope thread).
//   3. `handover`, `presence`, `ask.created` and `ask.answered` do not
//      touch thread state; they are surfaced through the event stream and
//      elsewhere (delivery modes, ask routes). `reduce` leaves them out
//      of the Thread view rather than shoehorning them into a comment.

import type { ReviewEvent } from "./events.ts";
import type { Comment, Thread } from "./thread.ts";

/** Reduce an event slice into a threads map keyed by `threadId`. Threads
 * are ordered on the returned map by insertion (i.e. `comment.created`
 * seq); consumers that want a different order should sort on
 * `Thread.updatedAt` or `Thread.createdAt`. */
export function reduce(events: readonly ReviewEvent[]): Map<string, Thread> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const threads = new Map<string, Thread>();
  for (const event of ordered) {
    applyEvent(threads, event);
  }
  return threads;
}

function applyEvent(threads: Map<string, Thread>, event: ReviewEvent): void {
  switch (event.kind) {
    case "comment.created": {
      if (threads.has(event.threadId)) {
        // A second `comment.created` for the same thread id is a producer
        // bug (thread creation is implicit and one-shot). Skip so the
        // reducer stays total on a byzantine slice; the append path
        // rejects it at the boundary.
        return;
      }
      const firstComment: Comment = {
        id: event.commentId,
        threadId: event.threadId,
        author: event.actor,
        body: event.body,
        createdAt: event.ts,
      };
      threads.set(event.threadId, {
        id: event.threadId,
        anchor: event.anchor,
        status: "open",
        createdAt: event.ts,
        updatedAt: event.ts,
        comments: [firstComment],
      });
      return;
    }
    case "comment.replied": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      const reply: Comment = {
        id: event.commentId,
        threadId: event.threadId,
        parentId: event.parentId,
        author: event.actor,
        body: event.body,
        createdAt: event.ts,
      };
      threads.set(event.threadId, {
        ...thread,
        updatedAt: event.ts,
        comments: [...thread.comments, reply],
      });
      return;
    }
    case "thread.resolved": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      threads.set(event.threadId, {
        ...thread,
        status: "resolved",
        updatedAt: event.ts,
      });
      return;
    }
    case "thread.reopened": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      threads.set(event.threadId, {
        ...thread,
        status: "open",
        updatedAt: event.ts,
      });
      return;
    }
    case "handover":
    case "presence":
    case "ask.created":
    case "ask.answered":
      // Handled outside the Thread view — see the file header.
      return;
  }
}
