// Reduce the event log (source of truth, ADR-0006) into the derived Thread
// view. Pure: same input, same output; the store may cache the map but
// never mutates from the outside — `since(seq)` plus `reduce` regenerates
// the same shape a store built up incrementally.
//
// Order rules:
//   1. Events are applied in ascending `seq`. The caller passes any slice
//      of the log; `reduce` re-sorts to make it idempotent regardless of
//      how the caller stored them.
//   2. `comment.replied`, `thread.resolved`, `thread.reopened`,
//      `comment.linked` and `handover` for a subject that has not been
//      created yet in the slice are skipped so the reducer stays total
//      on any slice `since(seq)` might return. The store's `validateNext`
//      refuses such an event on the append side, so a correctly-produced
//      log never carries one — the skip is a safety net for a partial
//      slice, not a silent cover-up.
//   3. `handover`, `presence`, `ask.created` and `ask.answered` do not
//      touch thread state; they are surfaced through the event stream
//      elsewhere (delivery modes, ask routes). `reduce` leaves them out
//      of the Thread view rather than shoehorning them into a comment.

import type { ReviewEvent } from "./events.ts";
import type { Comment, Thread } from "./thread.ts";

/** Reduce an event slice into a threads map keyed by `threadId`. Threads
 * are ordered on the returned map by insertion (i.e. `comment.created`
 * seq); consumers that want a different order sort on `Thread.createdSeq`
 * (deterministic; ISO strings tie-break poorly at sub-second
 * resolution). */
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
      if (threads.has(event.threadId)) return;
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
        createdSeq: event.seq,
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
    case "comment.linked": {
      // Find the thread the comment lives in and merge the external ref
      // onto that comment. Backends are merged (a later `comment.linked`
      // adding `github` does not clobber an earlier one adding a
      // hypothetical second backend); the validator refuses a second
      // `comment.linked` for the SAME backend on the same comment.
      for (const [threadId, thread] of threads) {
        const index = thread.comments.findIndex((c) => c.id === event.commentId);
        if (index === -1) continue;
        const existing = thread.comments[index];
        if (existing === undefined) return;
        const merged: Comment = {
          ...existing,
          external: { ...(existing.external ?? {}), ...event.external },
        };
        const nextComments = thread.comments.slice();
        nextComments[index] = merged;
        threads.set(threadId, { ...thread, updatedAt: event.ts, comments: nextComments });
        return;
      }
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
