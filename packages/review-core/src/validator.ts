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
//   thread.reanchored — the threadId must exist AND the event's
//                       `anchor.path` must equal the thread's original
//                       path (`cross-file-reanchor` otherwise: moving
//                       a comment across files is not re-anchoring).
//                       Accepted on any status; the reducer un-orphans
//                       a re-anchored thread and leaves resolved/open
//                       otherwise.
//   thread.orphaned  — the threadId must exist and its status must be
//                      `open`: a `resolved` thread is not tracked by
//                      the pipeline (the human/agent's final word),
//                      and an already-`orphaned` thread would be a
//                      redundant repeat (`already-orphaned`). Both
//                      cases carry their own rejection kind so a
//                      caller can branch without parsing messages.
//
// State (`LogState`) is mutated on success — cheap and equivalent to a
// functional model for the small maps we keep. Store implementations
// hold one long-lived `LogState`; `parseArchive` builds a fresh one and
// throws it away.

import type { AskKind } from "./asks.ts";
import type { ReviewEvent } from "./events.ts";
import type { ThreadStatus } from "./thread.ts";

/** The bookkeeping the validator needs — everything an event might
 * reference at the wire boundary. Kept minimal so the store can hold one
 * without carrying a full Thread map. All fields are mutable maps of
 * plain values; `cloneLogState` deep-copies them so an atomic-commit
 * pass (see `InMemoryThreadStore.import`) can dry-run against a shadow
 * and either commit the whole sequence or leave the real state
 * untouched. */
export interface LogState {
  /** Per-thread status and anchor path. Presence in the map means
   * the thread exists. `path` is captured on `comment.created` from
   * the anchor and never changes — the validator refuses a
   * `thread.reanchored` whose anchor points at a different file. */
  readonly threads: Map<
    string,
    {
      status: ThreadStatus;
      /** Set by `thread.resolved` to the status the thread had
       * before the resolve (open or orphaned); read by
       * `thread.reopened` so reopen restores it. Issue #46
       * item 4. */
      resumeStatus?: "open" | "orphaned";
      readonly path: string;
      readonly commentIds: Set<string>;
    }
  >;
  /** commentId → threadId. Global (across threads) so a duplicate
   * commentId in any thread is a rejection. */
  readonly commentIndex: Map<string, string>;
  /** askId → { kind, answered? }. `kind` is stored so `ask.answered`
   * can be refused when the answer's discriminant does not match the
   * ask's kind (a `scale` answer on a `text` ask, and so on). */
  readonly asks: Map<string, { kind: AskKind; answered: boolean }>;
  /** commentId → set of already-linked backends, so a second link to
   * the same backend on the same comment can be rejected without
   * silently overwriting the first. */
  readonly commentLinks: Map<string, Set<string>>;
  /** External id → local commentId. Key is `<backend>:<id>` (today
   * `github:<commentId>`). Guards against two different local
   * comments claiming the same external id. */
  readonly externalIndex: Map<string, string>;
}

export function emptyLogState(): LogState {
  return {
    threads: new Map(),
    commentIndex: new Map(),
    asks: new Map(),
    commentLinks: new Map(),
    externalIndex: new Map(),
  };
}

/** Deep-copy a `LogState`. The maps' values are plain records or Sets,
 * so a top-level clone of each entry is enough — nothing in this shape
 * holds a reference to a caller's mutable object. Used by
 * `InMemoryThreadStore.import` to dry-run an archive without mutating
 * the real state (the atomic-commit contract). */
export function cloneLogState(state: LogState): LogState {
  const threads = new Map<
    string,
    {
      status: ThreadStatus;
      resumeStatus?: "open" | "orphaned";
      path: string;
      commentIds: Set<string>;
    }
  >();
  for (const [id, entry] of state.threads) {
    threads.set(id, {
      status: entry.status,
      ...(entry.resumeStatus !== undefined ? { resumeStatus: entry.resumeStatus } : {}),
      path: entry.path,
      commentIds: new Set(entry.commentIds),
    });
  }
  const asks = new Map<string, { kind: AskKind; answered: boolean }>();
  for (const [id, entry] of state.asks) {
    asks.set(id, { kind: entry.kind, answered: entry.answered });
  }
  const commentLinks = new Map<string, Set<string>>();
  for (const [id, backends] of state.commentLinks) {
    commentLinks.set(id, new Set(backends));
  }
  return {
    threads,
    commentIndex: new Map(state.commentIndex),
    asks,
    commentLinks,
    externalIndex: new Map(state.externalIndex),
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
  | { kind: "answer-kind-mismatch"; askId: string; askKind: AskKind; answerKind: AskKind; message: string }
  | { kind: "duplicate-link"; commentId: string; backend: string; message: string }
  | { kind: "duplicate-external-id"; commentId: string; backend: string; externalId: string; existingCommentId: string; message: string }
  | { kind: "already-orphaned"; threadId: string; message: string }
  | { kind: "cross-file-reanchor"; threadId: string; fromPath: string; toPath: string; message: string };

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
      // PR-43 round-5: an unanchored anchor puts the thread in
      // `orphaned` from birth. The reducer mirrors this so the two
      // stay in lock-step.
      const initialStatus =
        "kind" in event.anchor && event.anchor.kind === "unanchored" ? "orphaned" : "open";
      state.threads.set(event.threadId, {
        status: initialStatus,
        path: event.anchor.path,
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
      // Issue #46 item 4: allow `orphaned → resolved`. A human
      // reviewer marks an orphaned thread as no-longer-relevant
      // (or B4 two-way sync mirrors GitHub's resolved bit onto a
      // local orphaned thread). Record the pre-resolve status
      // so a subsequent `thread.reopened` restores it.
      if (thread.status !== "open" && thread.status !== "orphaned") {
        return {
          ok: false,
          rejection: {
            kind: "not-open",
            threadId: event.threadId,
            message: `thread.resolved: thread '${event.threadId}' cannot be resolved from status '${thread.status}' (allowed: open, orphaned).`,
          },
        };
      }
      thread.resumeStatus = thread.status;
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
      // Restore the pre-resolve status when known (issue #46 item 4).
      // Falls back to `open` for logs from before this field existed.
      thread.status = thread.resumeStatus ?? "open";
      thread.resumeStatus = undefined;
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
      state.asks.set(event.askId, { kind: event.spec.kind, answered: false });
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
      if (event.answer.kind !== ask.kind) {
        return {
          ok: false,
          rejection: {
            kind: "answer-kind-mismatch",
            askId: event.askId,
            askKind: ask.kind,
            answerKind: event.answer.kind,
            message: `ask.answered: ask '${event.askId}' is a '${ask.kind}' question, so the answer.kind must be '${ask.kind}' — got '${event.answer.kind}'.`,
          },
        };
      }
      ask.answered = true;
      return { ok: true };
    }
    case "thread.reanchored": {
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      // Refuse a cross-file reanchor: moving a comment onto a
      // different file is not "re-anchoring the same block", and
      // silently accepting it would erase the audit trail of where
      // the comment was originally made. The daemon (item 5b) reads
      // the source file whose path the anchor names — the re-anchor
      // pipeline reads and writes the SAME file.
      if (event.anchor.path !== thread.path) {
        return {
          ok: false,
          rejection: {
            kind: "cross-file-reanchor",
            threadId: event.threadId,
            fromPath: thread.path,
            toPath: event.anchor.path,
            message: `thread.reanchored: thread '${event.threadId}' is anchored on '${thread.path}'; refusing a reanchor onto a different file '${event.anchor.path}'.`,
          },
        };
      }
      // A re-anchor un-orphans a previously-orphaned thread — the
      // reducer records the anchor change and moves the status back
      // to open. The validator only needs to track status here (the
      // anchor lives outside `LogState`).
      //
      // PR #47 round-1 nit: if the thread is currently `resolved` and
      // was orphaned BEFORE the resolve (`resumeStatus === "orphaned"`),
      // the reanchor also flips `resumeStatus` to `open` — the block
      // has come back, so a subsequent reopen must land on `open`,
      // not on the stale pre-reanchor `orphaned` state.
      if (thread.status === "orphaned") thread.status = "open";
      if (thread.status === "resolved" && thread.resumeStatus === "orphaned") {
        thread.resumeStatus = "open";
      }
      return { ok: true };
    }
    case "thread.orphaned": {
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      if (thread.status === "orphaned") {
        return {
          ok: false,
          rejection: {
            kind: "already-orphaned",
            threadId: event.threadId,
            message: `thread.orphaned: thread '${event.threadId}' is already orphaned — the pipeline is idempotent, so a redundant orphan is refused.`,
          },
        };
      }
      if (thread.status !== "open") {
        return {
          ok: false,
          rejection: {
            kind: "not-open",
            threadId: event.threadId,
            message: `thread.orphaned: thread '${event.threadId}' is not open (current status: ${thread.status}) — the pipeline only tracks open threads.`,
          },
        };
      }
      thread.status = "orphaned";
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
      // Build the (backend, externalId) list first — no state mutation
      // until every backend on the event passes both the same-comment
      // duplicate check and the cross-comment external-id uniqueness
      // check, so a rejection leaves state untouched.
      const github = event.external.github;
      const pairs: Array<{ backend: string; externalId: string }> = [];
      if (github !== undefined) pairs.push({ backend: "github", externalId: String(github.commentId) });
      for (const { backend, externalId } of pairs) {
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
        const externalKey = `${backend}:${externalId}`;
        const existingCommentId = state.externalIndex.get(externalKey);
        if (existingCommentId !== undefined && existingCommentId !== event.commentId) {
          return {
            ok: false,
            rejection: {
              kind: "duplicate-external-id",
              commentId: event.commentId,
              backend,
              externalId,
              existingCommentId,
              message: `comment.linked: external ${backend} id '${externalId}' is already linked to comment '${existingCommentId}' — external ids are unique across local comments.`,
            },
          };
        }
      }
      for (const { backend, externalId } of pairs) {
        linked.add(backend);
        state.externalIndex.set(`${backend}:${externalId}`, event.commentId);
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
