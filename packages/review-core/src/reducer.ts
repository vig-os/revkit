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
//      `thread.reanchored`, `thread.orphaned`, `comment.linked` and
//      `handover` for a subject that has not been created yet in the
//      slice are skipped so the reducer stays total on any slice
//      `since(seq)` might return. The store's `validateNext` refuses
//      such an event on the append side, so a correctly-produced log
//      never carries one — the skip is a safety net for a partial
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
      // An unanchored anchor represents "imported without a
      // trustworthy anchor" — the thread starts orphaned so the
      // reanchor engine / rail skip it (no snapshot to load, no
      // quote to render). PR-43 round-5.
      const isUnanchored = "kind" in event.anchor && event.anchor.kind === "unanchored";
      const initialStatus = isUnanchored ? "orphaned" : "open";
      threads.set(event.threadId, {
        id: event.threadId,
        anchor: event.anchor,
        status: initialStatus,
        createdSeq: event.seq,
        createdAt: event.ts,
        updatedAt: event.ts,
        comments: [firstComment],
        // Issue #46 item 3: project structured metadata and the
        // unavailable reason onto the derived Thread view. The
        // reason is only meaningful when the thread starts
        // orphaned (unanchored path); dropping it on line-anchor
        // threads keeps the field's meaning honest (only present
        // when `status === "orphaned"`).
        ...(event.external !== undefined ? { external: event.external } : {}),
        ...(isUnanchored && event.orphanReason !== undefined ? { orphanReason: event.orphanReason } : {}),
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
      // Issue #46 item 4: allow orphaned → resolved (a human
      // marks an orphaned thread as no-longer-relevant). Record
      // the previous status in `resumeStatus` so a subsequent
      // `thread.reopened` restores it (open → open, orphaned →
      // orphaned) rather than always flipping to open.
      if (thread.status !== "open" && thread.status !== "orphaned") return;
      threads.set(event.threadId, {
        ...thread,
        status: "resolved",
        resumeStatus: thread.status,
        updatedAt: event.ts,
      });
      return;
    }
    case "thread.reopened": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      if (thread.status !== "resolved") return;
      // Restore the pre-resolve status. Fall back to `open` when
      // `resumeStatus` is absent (backfilled from an older log).
      const nextStatus: "open" | "orphaned" = thread.resumeStatus ?? "open";
      // Drop `resumeStatus` so a subsequent resolve/reopen cycle
      // starts fresh.
      const { resumeStatus: _prev, ...rest } = thread;
      void _prev;
      threads.set(event.threadId, {
        ...rest,
        status: nextStatus,
        updatedAt: event.ts,
      });
      return;
    }
    case "thread.reanchored": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      // The pipeline (ADR-0006 Acceptance) may have re-anchored a
      // thread that was orphaned on a previous rebuild — the block came
      // back on this revision. Move it back to `open` so the rail no
      // longer marks it stray; if it was resolved, respect that
      // (resolution is a human/agent decision the re-anchor does not
      // overrule). `open` is the only status the un-orphaning transition
      // targets.
      const nextStatus = thread.status === "orphaned" ? "open" : thread.status;
      // When un-orphaning, drop the stale `orphanReason` — the block
      // came back and the rail must stop displaying the old reason.
      // Field name matches PR #45.
      const { orphanReason: _prevReason, ...rest } = thread;
      void _prevReason;
      threads.set(event.threadId, {
        ...rest,
        anchor: event.anchor,
        status: nextStatus,
        updatedAt: event.ts,
      });
      return;
    }
    case "thread.orphaned": {
      const thread = threads.get(event.threadId);
      if (thread === undefined) return;
      // Only `open` threads are tracked by the pipeline; `validateNext`
      // refuses a `thread.orphaned` on a `resolved` or already-
      // `orphaned` thread on the append side. In a partial slice the
      // reducer still guards defensively — leave a non-open status
      // untouched rather than fabricate a transition the log never
      // authorised.
      if (thread.status !== "open") return;
      threads.set(event.threadId, {
        ...thread,
        status: "orphaned",
        // Carry the pipeline's own reason string onto the derived
        // Thread view so the rail's orphan panel renders exactly
        // what the diff engine said, not a synthesised sentence.
        // Field name matches PR #45.
        ...(event.reason !== undefined ? { orphanReason: event.reason } : {}),
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
