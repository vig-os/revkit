// The transition validator — one place that owns the rules a well-formed
// event log obeys. Called by `InMemoryThreadStore.append` (assigning a
// fresh `seq`/`ts`) and by `InMemoryThreadStore.import` (replaying an
// archive's own seq/ts) and by `parseArchive` (refusing a corrupt
// archive at the byte boundary). One rule set, three call sites,
// zero drift.
//
// Rules (each with its own AppendRejection kind so a caller can branch
// on `rejection.kind` without parsing the message):
//   comment.created  — new threadId (no `duplicate-thread`); the
//                      commentId must be globally unique across the
//                      log (no `duplicate-comment-id`).
//   comment.replied  — the threadId must exist (`unknown-thread`), the
//                      parentId must be a commentId in the same thread
//                      (`unknown-parent`), and the commentId globally
//                      unique.
//   thread.resolved  — the threadId must exist and its status must be
//                      `open` (a second resolve or a resolve on an
//                      orphan-only thread is rejected: `not-open`).
//   thread.reopened  — the threadId must exist and its status must be
//                      `resolved` (`not-resolved`).
//   handover         — every commentId in `commentIds` must exist in
//                      the log (`unknown-comment`).
//   presence         — no thread state; always accepted.
//   ask.created      — the askId must be new (`duplicate-ask`).
//   ask.answered     — the askId must be a prior `ask.created` and not
//                      already answered (`unknown-ask`,
//                      `duplicate-answer`).
//   comment.linked   — the commentId must exist; a commentId may be
//                      linked once (a second link is `duplicate-link`).
//
// State (`LogState`) is mutated on success — cheap and equivalent to a
// functional model for the small maps we keep. Store implementations
// hold one long-lived `LogState`; `parseArchive` builds a fresh one and
// throws it away.

import type { ReviewEvent } from "./events.ts";
import type { ThreadStatus } from "./thread.ts";

/** The bookkeeping the validator needs — everything an event might
 * reference at the wire boundary. Kept minimal so the store can hold one
 * without carrying a full Thread map. */
export interface LogState {
  /** Per-thread status. Presence in the map means the thread exists. */
  readonly threads: Map<string, { status: ThreadStatus; readonly commentIds: Set<string> }>;
  /** commentId → threadId. Global (across threads) so a duplicate
   * commentId in any thread is a rejection. */
  readonly commentIndex: Map<string, string>;
  /** askId → answered? — created and answered tracked together. */
  readonly asks: Map<string, { answered: boolean }>;
  /** commentId → set of already-linked backends, so a second link to the
   * same backend can be rejected without silently overwriting the first. */
  readonly commentLinks: Map<string, Set<string>>;
}

export function emptyLogState(): LogState {
  return {
    threads: new Map(),
    commentIndex: new Map(),
    asks: new Map(),
    commentLinks: new Map(),
  };
}

/** Every reason `validateNext` may reject an event. `kind` is stable
 * across implementations; the message names the specifics. */
export type AppendRejection =
  | { kind: "invalid-shape"; message: string }
  | { kind: "duplicate-thread"; threadId: string; message: string }
  | { kind: "unknown-thread"; threadId: string; message: string }
  | { kind: "unknown-parent"; threadId: string; parentId: string; message: string }
  | { kind: "duplicate-comment-id"; commentId: string; message: string }
  | { kind: "not-open"; threadId: string; message: string }
  | { kind: "not-resolved"; threadId: string; message: string }
  | { kind: "unknown-comment"; commentId: string; message: string }
  | { kind: "duplicate-ask"; askId: string; message: string }
  | { kind: "unknown-ask"; askId: string; message: string }
  | { kind: "duplicate-answer"; askId: string; message: string }
  | { kind: "duplicate-link"; commentId: string; backend: string; message: string };

export type ValidationResult = { ok: true } | { ok: false; rejection: AppendRejection };

/** Validate `event` against `state`. On success, mutates `state` to
 * include the event's effect and returns `{ ok: true }`. On failure,
 * leaves `state` untouched and returns the rejection.
 *
 * Callers guarantee `event` has already passed `reviewEventSchema` — this
 * function checks only the transition rules the Zod schema cannot see
 * (cross-event / cross-thread invariants).
 */
export function validateNext(state: LogState, event: ReviewEvent): ValidationResult {
  switch (event.kind) {
    case "comment.created": {
      if (state.threads.has(event.threadId)) {
        return {
          ok: false,
          rejection: {
            kind: "duplicate-thread",
            threadId: event.threadId,
            message: `thread '${event.threadId}' already exists — thread creation is implicit and one-shot.`,
          },
        };
      }
      if (state.commentIndex.has(event.commentId)) {
        return duplicateComment(event.commentId);
      }
      state.threads.set(event.threadId, {
        status: "open",
        commentIds: new Set([event.commentId]),
      });
      state.commentIndex.set(event.commentId, event.threadId);
      return { ok: true };
    }
    case "comment.replied": {
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      if (!thread.commentIds.has(event.parentId)) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-parent",
            threadId: event.threadId,
            parentId: event.parentId,
            message: `comment.replied: parent '${event.parentId}' is not a comment in thread '${event.threadId}'.`,
          },
        };
      }
      if (state.commentIndex.has(event.commentId)) {
        return duplicateComment(event.commentId);
      }
      thread.commentIds.add(event.commentId);
      state.commentIndex.set(event.commentId, event.threadId);
      return { ok: true };
    }
    case "thread.resolved": {
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      if (thread.status !== "open") {
        return {
          ok: false,
          rejection: {
            kind: "not-open",
            threadId: event.threadId,
            message: `thread.resolved: thread '${event.threadId}' is not open (current status: ${thread.status}).`,
          },
        };
      }
      thread.status = "resolved";
      return { ok: true };
    }
    case "thread.reopened": {
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      if (thread.status !== "resolved") {
        return {
          ok: false,
          rejection: {
            kind: "not-resolved",
            threadId: event.threadId,
            message: `thread.reopened: thread '${event.threadId}' is not resolved (current status: ${thread.status}).`,
          },
        };
      }
      thread.status = "open";
      return { ok: true };
    }
    case "handover": {
      for (const commentId of event.commentIds) {
        if (!state.commentIndex.has(commentId)) {
          return {
            ok: false,
            rejection: {
              kind: "unknown-comment",
              commentId,
              message: `handover: comment '${commentId}' is not in the log.`,
            },
          };
        }
      }
      return { ok: true };
    }
    case "presence":
      return { ok: true };
    case "ask.created": {
      if (state.asks.has(event.askId)) {
        return {
          ok: false,
          rejection: {
            kind: "duplicate-ask",
            askId: event.askId,
            message: `ask.created: ask '${event.askId}' already exists.`,
          },
        };
      }
      state.asks.set(event.askId, { answered: false });
      return { ok: true };
    }
    case "ask.answered": {
      const ask = state.asks.get(event.askId);
      if (ask === undefined) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-ask",
            askId: event.askId,
            message: `ask.answered: ask '${event.askId}' does not exist (no prior ask.created).`,
          },
        };
      }
      if (ask.answered) {
        return {
          ok: false,
          rejection: {
            kind: "duplicate-answer",
            askId: event.askId,
            message: `ask.answered: ask '${event.askId}' already has an answer.`,
          },
        };
      }
      ask.answered = true;
      return { ok: true };
    }
    case "comment.linked": {
      if (!state.commentIndex.has(event.commentId)) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-comment",
            commentId: event.commentId,
            message: `comment.linked: comment '${event.commentId}' is not in the log.`,
          },
        };
      }
      const linked = state.commentLinks.get(event.commentId) ?? new Set<string>();
      for (const backend of Object.keys(event.external)) {
        if (event.external[backend as keyof typeof event.external] === undefined) continue;
        if (linked.has(backend)) {
          return {
            ok: false,
            rejection: {
              kind: "duplicate-link",
              commentId: event.commentId,
              backend,
              message: `comment.linked: comment '${event.commentId}' is already linked to backend '${backend}'.`,
            },
          };
        }
        linked.add(backend);
      }
      state.commentLinks.set(event.commentId, linked);
      return { ok: true };
    }
  }
}

function unknownThread(threadId: string, eventKind: string): ValidationResult {
  return {
    ok: false,
    rejection: {
      kind: "unknown-thread",
      threadId,
      message: `${eventKind}: thread '${threadId}' does not exist — a '${eventKind}' event needs a prior 'comment.created'.`,
    },
  };
}

function duplicateComment(commentId: string): ValidationResult {
  return {
    ok: false,
    rejection: {
      kind: "duplicate-comment-id",
      commentId,
      message: `commentId '${commentId}' already exists in the log (commentIds are globally unique).`,
    },
  };
}
