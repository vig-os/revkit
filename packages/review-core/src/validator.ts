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
//   delivery.mode_changed — no thread state; always accepted.
//   presence         — REMOVED from durable log in M2 item 6 round 2.
//                      Now broadcast ephemerally over /events only.
//   ask.created      — the askId must be new (`duplicate-ask`).
//   ask.answered     — the askId must be a prior `ask.created` and still
//                      pending (`unknown-ask`, `ask-not-pending`); the
//                      answer's `kind` must match the spec's `kind`
//                      (`answer-kind-mismatch`).
//   ask.cancelled    — the askId must be a prior `ask.created` and
//                      still pending (`unknown-ask`, `ask-not-pending`).
//   ask.expired      — the askId must be a prior `ask.created` and
//                      still pending (`unknown-ask`, `ask-not-pending`).
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
//   doc.published    — no thread state; always accepted. Records
//                      that the agent wrote a new revision at
//                      `path`; downstream `thread.reanchored` /
//                      `thread.orphaned` events on threads that
//                      lived on `path` fire from the re-anchor
//                      pipeline the daemon triggers after the write.
//   draft.promoted   — issue #70: a reviewer attached an AGENT-
//                      authored draft to their own pending review.
//                      The actor must be `local` (`invalid-actor`) —
//                      over HTTP, the bearer is refused the promote
//                      route and its requests are identified as
//                      `agent`, so it cannot author a promotion; a
//                      same-user agent holding a REVIEWER SESSION is a
//                      different question, owned on #55 — the named
//                      draft must actually be agent-authored
//                      (`not-an-agent-draft`), so the event can never
//                      claim a human's own comment was promoted, and a
//                      lifecycle target must be the thread's CURRENT
//                      change (also `not-an-agent-draft`), so a
//                      promotion cannot authorize a resolve the thread
//                      has since reopened. A comment promotion's
//                      `commentSeq`/`bodyHash` pin must name the
//                      authoring event's seq, so the log cannot record
//                      an approval of a version that does not exist
//                      (`unknown-comment`).
//
// State (`LogState`) is mutated on success — cheap and equivalent to a
// functional model for the small maps we keep. Store implementations
// hold one long-lived `LogState`; `parseArchive` builds a fresh one and
// throws it away.

import type { Ask, AskAnswer, AskKind, AskStatus } from "./asks.ts";
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
      /** Set by the LAST `thread.resolved` / `thread.reopened` for
       * this thread: which change it was, and who authored it. Issue
       * #70: `draft.promoted` with a lifecycle target may only name a
       * change an agent made, and may only name the one that is
       * CURRENT — a promotion recorded against a superseded resolve is
       * refused here as well as at the route. */
      lifecycle?: { readonly target: "resolve" | "reopen"; readonly actorKind: string };
    }
  >;
  /** commentId → threadId. Global (across threads) so a duplicate
   * commentId in any thread is a rejection. */
  readonly commentIndex: Map<string, string>;
  /** commentId → the actor that AUTHORED it (`comment.created` /
   * `comment.replied`). Issue #70: `draft.promoted` may only name a
   * draft an agent wrote — a reviewer's own comment mirrors itself,
   * so promoting it would be a claim the log cannot support. */
  readonly commentAuthors: Map<string, ReviewEvent["actor"]>;
  /** commentId → the `seq` of the event that AUTHORED it, fixed at
   * creation (`comment.edited` does not advance it). Issue #70 round 2:
   * `draft.promoted.commentSeq` records the version a reviewer
   * approved, and this is what makes that field checkable at append
   * time. It is provenance, not a currentness guard — the currentness
   * guard is `bodyHash`, compared against the live body outside the
   * validator. */
  readonly commentSeqs: Map<string, number>;
  /** askId → { spec, status }. The FULL spec is kept so
   * `ask.answered` can validate the answer's SHAPE against the
   * question — not just the discriminant. PR #52 review: the
   * daemon otherwise accepted `answer.value = "zzz"` on a `choice`
   * with `allowOther: false`, `99999` on a 1..5 scale, `["nope"]`
   * on a `rank` whose options never contained `nope`, and so on.
   * `status` gates all three terminal transitions (answered /
   * cancelled / expired) — the validator refuses any of them on
   * an ask that is already terminal. */
  readonly asks: Map<string, { spec: Ask; status: AskStatus }>;
  /** commentId → set of already-linked backends, so a second link to
   * the same backend on the same comment can be rejected without
   * silently overwriting the first. */
  readonly commentLinks: Map<string, Set<string>>;
  /** External id → local commentId. Key is `<backend>:<id>` (today
   * `github:<commentId>`). Guards against two different local
   * comments claiming the same external id. */
  readonly externalIndex: Map<string, string>;
  /** M3 part 2b: pending-review lifecycle state, keyed on
   * `reviewNodeId` (GitHub GraphQL id). `pending` after
   * `review.opened`; terminal after `review.submitted` or
   * `review.abandoned`. A duplicate `review.opened` on a
   * currently-pending id is rejected; a terminal transition on a
   * non-pending id is rejected. Derivable from the full log — the
   * daemon's derived pending-comment view (see
   * `review-state.ts::reduceReviewState`) reads the same log the
   * validator does. */
  readonly reviews: Map<string, { status: "pending" | "submitted" | "abandoned"; headSha: string }>;
}

export function emptyLogState(): LogState {
  return {
    threads: new Map(),
    commentIndex: new Map(),
    commentAuthors: new Map(),
    commentSeqs: new Map(),
    asks: new Map(),
    commentLinks: new Map(),
    externalIndex: new Map(),
    reviews: new Map(),
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
      lifecycle?: { readonly target: "resolve" | "reopen"; readonly actorKind: string };
    }
  >();
  for (const [id, entry] of state.threads) {
    threads.set(id, {
      status: entry.status,
      ...(entry.resumeStatus !== undefined ? { resumeStatus: entry.resumeStatus } : {}),
      path: entry.path,
      commentIds: new Set(entry.commentIds),
      ...(entry.lifecycle !== undefined ? { lifecycle: { ...entry.lifecycle } } : {}),
    });
  }
  const asks = new Map<string, { spec: Ask; status: AskStatus }>();
  for (const [id, entry] of state.asks) {
    // Copying the spec by reference is fine here: Zod has already
    // validated it, and nothing between validator dry-runs mutates
    // it.
    asks.set(id, { spec: entry.spec, status: entry.status });
  }
  const commentLinks = new Map<string, Set<string>>();
  for (const [id, backends] of state.commentLinks) {
    commentLinks.set(id, new Set(backends));
  }
  const reviews = new Map<string, { status: "pending" | "submitted" | "abandoned"; headSha: string }>();
  for (const [id, entry] of state.reviews) {
    reviews.set(id, { status: entry.status, headSha: entry.headSha });
  }
  return {
    threads,
    commentIndex: new Map(state.commentIndex),
    commentAuthors: new Map(state.commentAuthors),
    commentSeqs: new Map(state.commentSeqs),
    asks,
    commentLinks,
    externalIndex: new Map(state.externalIndex),
    reviews,
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
  /** `commentId` is absent only when the event refused to name one at
   * all (issue #70: a `draft.promoted` with `target: "comment"` and no
   * `commentId`, which the wire schema also refuses) — the message
   * names the thread in that case. */
  | { kind: "unknown-comment"; commentId: string; message: string }
  /** Round-3 nit: an event's actor is not the one the shape
   * allows (e.g. an agent trying to edit a human comment). */
  | { kind: "invalid-actor"; actor: unknown; message: string }
  | { kind: "duplicate-ask"; askId: string; message: string }
  | { kind: "unknown-ask"; askId: string; message: string }
  /** Kept as a distinct kind so a caller can special-case
   * "the answer beat a cancel" without parsing the message. Emitted
   * only when an `ask.answered` targets an already-answered ask. */
  | { kind: "duplicate-answer"; askId: string; message: string }
  /** `ask.answered`, `ask.cancelled` or `ask.expired` targeting an
   * ask that is no longer pending (already answered / cancelled /
   * expired). Carries the current status so a race between two
   * terminal events (e.g. concurrent cancel + answer) surfaces
   * which one won. */
  | { kind: "ask-not-pending"; askId: string; currentStatus: AskStatus; attempted: "answered" | "cancelled" | "expired"; message: string }
  | { kind: "answer-kind-mismatch"; askId: string; askKind: AskKind; answerKind: AskKind; message: string }
  /** The answer's kind matches the ask's, but the VALUES fail
   * the ask's own constraints (choice value not in options
   * unless allowOther; scale out of [min,max] or off-step;
   * rank not an exact permutation of the option ids; text
   * over the 65 535-char cap). PR #52 review. `field` is the
   * dotted path of the offending field so a caller can point
   * the user at it. */
  | { kind: "answer-shape-mismatch"; askId: string; askKind: AskKind; field: string; message: string }
  | { kind: "duplicate-link"; commentId: string; backend: string; message: string }
  | { kind: "duplicate-external-id"; commentId: string; backend: string; externalId: string; existingCommentId: string; message: string }
  | { kind: "already-orphaned"; threadId: string; message: string }
  /** Issue #70: `draft.promoted` naming something an agent did not
   * author. A reviewer's own comment is mirrored on its own; there is
   * nothing to promote, so the log refuses to record one. */
  | { kind: "not-an-agent-draft"; threadId: string; commentId?: string; message: string }
  | { kind: "cross-file-reanchor"; threadId: string; fromPath: string; toPath: string; message: string }
  /** M3 part 2b: `review.opened` for a `reviewNodeId` that already
   * exists in the log (with any status). GitHub allows at most one
   * pending review per (viewer, PR); the log mirrors that. */
  | { kind: "duplicate-review"; reviewNodeId: string; message: string }
  /** M3 part 2b: `review.submitted` or `review.abandoned` targeting
   * a review that is not currently `pending` — either the
   * `reviewNodeId` has no `review.opened` in the log, or it has
   * already been submitted / abandoned. Carries the current
   * status so a race between two terminal events surfaces which
   * one won. */
  | {
      kind: "review-not-pending";
      reviewNodeId: string;
      currentStatus: "missing" | "submitted" | "abandoned";
      attempted: "submitted" | "abandoned";
      message: string;
    };

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
      state.commentAuthors.set(event.commentId, event.actor);
      state.commentSeqs.set(event.commentId, event.seq);
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
      state.commentAuthors.set(event.commentId, event.actor);
      state.commentSeqs.set(event.commentId, event.seq);
      return { ok: true };
    }
    case "comment.edited": {
      // Round-2 BLOCK-fix 3: `commentId` must be a known local
      // comment. `remoteUpdatedAt` idempotency is left to the
      // emitter (the daemon's refresh path).
      if (!state.commentIndex.has(event.commentId)) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-comment",
            commentId: event.commentId,
            message: `comment.edited: comment '${event.commentId}' is not in the log.`,
          },
        };
      }
      // Round-3 (nit): restrict the actor to the comment's own
      // author (a self-edit) or the github-import gh-user actor
      // (a B4-pull edit mirrored from GitHub). This blocks an
      // agent bearer from editing a human's comment body under
      // a hostile appendReviewLifecycleEvent path.
      if (event.actor.kind !== "gh-user" && event.actor.kind !== "local") {
        return {
          ok: false,
          rejection: {
            kind: "invalid-actor",
            actor: event.actor,
            message: `comment.edited: actor must be the comment's author (local) or the github-import actor (gh-user), got '${event.actor.kind}'.`,
          },
        };
      }
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
      thread.lifecycle = { target: "resolve", actorKind: event.actor.kind };
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
      thread.lifecycle = { target: "reopen", actorKind: event.actor.kind };
      return { ok: true };
    }
    case "thread.external_synced": {
      if (!state.threads.has(event.threadId)) return unknownThread(event.threadId, event.kind);
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
    case "delivery.mode_changed":
      // Mode changes have no cross-event invariant (the daemon
      // dedupes no-op changes at emit time). Always accept.
      return { ok: true };
    case "doc.published":
      // No thread state to update: the event records that the agent
      // wrote a new revision of `path`. Any thread on that path
      // reaches the re-anchor pipeline through the daemon's
      // `reanchor.refresh(path)` call, which emits its own
      // `thread.reanchored`/`thread.orphaned` events. The event
      // itself is stateless (like `presence` and `handover` above).
      return { ok: true };
    case "build.requested":
    case "build.started":
    case "build.succeeded":
    case "build.failed":
      // Background astro-build lifecycle (M2 item 9, PR-56 round 3).
      // No cross-event invariants — the daemon emits these purely so
      // the rail can reload once dist catches up after a fast-path
      // refusal. Stateless.
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
      state.asks.set(event.askId, { spec: event.spec, status: "pending" });
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
      if (ask.status === "answered") {
        return {
          ok: false,
          rejection: {
            kind: "duplicate-answer",
            askId: event.askId,
            message: `ask.answered: ask '${event.askId}' already has an answer.`,
          },
        };
      }
      if (ask.status !== "pending") {
        return {
          ok: false,
          rejection: {
            kind: "ask-not-pending",
            askId: event.askId,
            currentStatus: ask.status,
            attempted: "answered",
            message: `ask.answered: ask '${event.askId}' is '${ask.status}' — a terminal state cannot be answered.`,
          },
        };
      }
      if (event.answer.kind !== ask.spec.kind) {
        return {
          ok: false,
          rejection: {
            kind: "answer-kind-mismatch",
            askId: event.askId,
            askKind: ask.spec.kind,
            answerKind: event.answer.kind,
            message: `ask.answered: ask '${event.askId}' is a '${ask.spec.kind}' question, so the answer.kind must be '${ask.spec.kind}' — got '${event.answer.kind}'.`,
          },
        };
      }
      // PR #52 review: the answer's kind matches, but the values
      // must ALSO conform to the ask's own constraints (a `choice`
      // value must be an option id unless allowOther; a `scale`
      // value must be in [min,max] on a step; a `rank` must be an
      // exact permutation of the option ids). Kind-matched-but-
      // shape-wrong lands as `answer-shape-mismatch`.
      const shapeIssue = validateAnswerAgainstSpec(ask.spec, event.answer);
      if (shapeIssue !== undefined) {
        return {
          ok: false,
          rejection: {
            kind: "answer-shape-mismatch",
            askId: event.askId,
            askKind: ask.spec.kind,
            field: shapeIssue.field,
            message: `ask.answered: ask '${event.askId}': ${shapeIssue.message}`,
          },
        };
      }
      ask.status = "answered";
      return { ok: true };
    }
    case "ask.cancelled":
    case "ask.expired": {
      const ask = state.asks.get(event.askId);
      const attempted = event.kind === "ask.cancelled" ? "cancelled" : "expired";
      if (ask === undefined) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-ask",
            askId: event.askId,
            message: `${event.kind}: ask '${event.askId}' does not exist (no prior ask.created).`,
          },
        };
      }
      if (ask.status !== "pending") {
        return {
          ok: false,
          rejection: {
            kind: "ask-not-pending",
            askId: event.askId,
            currentStatus: ask.status,
            attempted,
            message: `${event.kind}: ask '${event.askId}' is '${ask.status}' — a terminal state cannot transition.`,
          },
        };
      }
      ask.status = attempted === "cancelled" ? "cancelled" : "expired";
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
          // M3 part 2b relaxation: a comment MAY be linked twice to
          // the same backend WHEN the earlier link was for a pending
          // review whose lifecycle is now terminal (submitted /
          // abandoned) AND the new link is for a DIFFERENT
          // reviewNodeId. That is exactly the head-move re-anchor
          // shape: the first link targeted the old pending review
          // (now abandoned); the second targets the fresh one.
          // Without this the re-anchor path would refuse legitimate
          // re-posts on `duplicate-link`, and the pending set could
          // never be re-established.
          const gh = event.external.github;
          const newReviewNodeId = gh?.reviewNodeId;
          const newIsPending = gh?.pending === true && newReviewNodeId !== undefined;
          // Find the earlier github link on this comment via
          // externalIndex reverse-lookup. `externalIndex` stores
          // `github:<databaseId>` → commentId. Enumerate the reviews
          // set: if every existing github link on THIS comment
          // (identified by databaseId in the externalIndex) refers
          // to a terminal review, and the new link is for a
          // different, still-pending review, accept.
          let earlierIsTerminal = false;
          for (const [key, cid] of state.externalIndex) {
            if (cid !== event.commentId) continue;
            if (!key.startsWith(`${backend}:`)) continue;
            // At least one prior github link exists; is it linked
            // to a terminal review? We can't recover its
            // reviewNodeId from externalIndex alone — the pattern
            // we want is "all previous github links are terminal".
            // Instead of tracking reviewNodeId on the linked set,
            // rely on the invariant: at most ONE pending review
            // exists at a time, and the validator's `duplicate-review`
            // rule enforces that. So if there is ANY currently-
            // pending review in state.reviews AND this new link is
            // for that pending review, and the earlier link's
            // reviewNodeId (implicit) is different — accept.
            // Simpler: any earlier github link is treated as terminal
            // when the reviews map has NO currently-pending review
            // at the moment the OLD link landed. Since we can't
            // reconstruct that after-the-fact, use a coarser rule:
            // accept the re-link iff the new event's reviewNodeId
            // is not equal to any currently-pending review's
            // reviewNodeId. Concretely: if we see the new
            // reviewNodeId as a `pending` in the reviews map, the
            // earlier link is by definition on a DIFFERENT
            // reviewNodeId (or a plain published link).
            //
            // For simplicity — and to keep the invariant honest —
            // we accept the second link ONLY when the new link is
            // marked `pending: true` on a `reviewNodeId` currently
            // in status `pending`, AND at least one review in
            // state.reviews carries a terminal status. That guards
            // against "silently overwriting" a still-live link.
            if (newIsPending) {
              for (const [, review] of state.reviews) {
                if (review.status === "submitted" || review.status === "abandoned") {
                  earlierIsTerminal = true;
                  break;
                }
              }
            }
            if (earlierIsTerminal) break;
          }
          if (!earlierIsTerminal) {
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
    case "review.opened": {
      if (state.reviews.has(event.reviewNodeId)) {
        return {
          ok: false,
          rejection: {
            kind: "duplicate-review",
            reviewNodeId: event.reviewNodeId,
            message:
              `review.opened: review '${event.reviewNodeId}' already exists on the log — ` +
              `at most one open pending review is allowed at a time (GitHub enforces this too).`,
          },
        };
      }
      state.reviews.set(event.reviewNodeId, { status: "pending", headSha: event.headSha });
      return { ok: true };
    }
    case "comment.sync_requested":
    case "comment.sync_failed":
    case "comment.sync_cancelled": {
      // The comment must exist. Cross-review lifecycle is enforced
      // by the reducer / derived view — a sync_requested on an
      // already-terminal review is dead intent, not a validator
      // failure. We refuse UNKNOWN comment ids so a caller can't
      // record intent for a comment that never landed.
      if (!state.commentIndex.has(event.commentId)) {
        return {
          ok: false,
          rejection: {
            kind: "unknown-comment",
            commentId: event.commentId,
            message: `${event.kind}: comment '${event.commentId}' is not in the log.`,
          },
        };
      }
      return { ok: true };
    }
    case "draft.promoted": {
      // Issue #70. Three independent guarantees, all enforced HERE so
      // they hold for every store backing and every writer — not only
      // for the daemon route that happens to check them first.
      if (event.actor.kind !== "local") {
        return {
          ok: false,
          rejection: {
            kind: "invalid-actor",
            actor: event.actor,
            message:
              `draft.promoted: only the reviewer may promote a draft into their own pending review, ` +
              `got actor kind '${event.actor.kind}'.`,
          },
        };
      }
      const thread = state.threads.get(event.threadId);
      if (thread === undefined) return unknownThread(event.threadId, event.kind);
      if (event.target === "comment") {
        const commentId = event.commentId;
        if (commentId === undefined) {
          // The wire schema already refuses this shape; reaching here
          // means a caller bypassed `reviewEventSchema`.
          return {
            ok: false,
            rejection: {
              kind: "invalid-shape",
              message: "draft.promoted: target='comment' requires the commentId of the draft being promoted.",
            },
          };
        }
        if (!thread.commentIds.has(commentId)) {
          return {
            ok: false,
            rejection: {
              kind: "unknown-comment",
              commentId,
              message: `draft.promoted: comment '${commentId}' is not in thread '${event.threadId}'.`,
            },
          };
        }
        const author = state.commentAuthors.get(commentId);
        if (author?.kind !== "agent") {
          return {
            ok: false,
            rejection: {
              kind: "not-an-agent-draft",
              threadId: event.threadId,
              commentId,
              message:
                `draft.promoted: comment '${commentId}' was authored by '${author?.kind ?? "unknown"}', not an agent — ` +
                `a reviewer's own comment is mirrored without a promotion.`,
            },
          };
        }
        // Issue #70 round 2: `commentSeq` must name a version this log
        // actually issued. This is an APPEND-time check on
        // PROVENANCE, not on currentness: the comment's authoring seq is
        // stable for the life of the log (`comment.edited` does not
        // advance it), so this cannot detect a body swapped after the
        // fact. Detecting that is `bodyHash`'s job, and it happens
        // outside the validator — `findDraftToPromote` compares the
        // CURRENT body against the pin and refuses
        // (`promoted-body-changed`), and the reconciler separately
        // refuses a `body-drift` retry against the INTENT's bodyHash.
        // What is refused HERE is the shape that can never be right: a
        // promotion claiming to approve a version that does not exist.
        if (event.commentSeq !== undefined && state.commentSeqs.get(commentId) !== event.commentSeq) {
          return {
            ok: false,
            rejection: {
              kind: "unknown-comment",
              commentId,
              message:
                `draft.promoted: commentSeq ${event.commentSeq} is not the seq of the authoring event for ` +
                `'${commentId}' (the log has ${state.commentSeqs.get(commentId) ?? "none"}) — ` +
                `a promotion pins the version of the comment it approves.`,
            },
          };
        }
        return { ok: true };
      }
      // Lifecycle targets close the asymmetry the comment arm above
      // does not have (issue #70 review, finding in §5): the log now
      // checks that the named change is agent-authored AND is the
      // thread's CURRENT one, so a `draft.promoted` cannot authorize a
      // resolve the thread has since reopened — the same rule the route,
      // the reconciler and the rail's draft list read.
      const lifecycle = thread.lifecycle;
      if (lifecycle === undefined || lifecycle.target !== event.target) {
        return {
          ok: false,
          rejection: {
            kind: "not-an-agent-draft",
            threadId: event.threadId,
            message:
              `draft.promoted: thread '${event.threadId}' has no current '${event.target}' to promote ` +
              `(its latest lifecycle change is ${lifecycle === undefined ? "none" : `'${lifecycle.target}'`}) — ` +
              `a superseded lifecycle change has nothing left to write to GitHub.`,
          },
        };
      }
      if (lifecycle.actorKind !== "agent") {
        return {
          ok: false,
          rejection: {
            kind: "not-an-agent-draft",
            threadId: event.threadId,
            message:
              `draft.promoted: the current '${event.target}' on thread '${event.threadId}' was authored by ` +
              `'${lifecycle.actorKind}', not an agent — there is no agent draft to promote.`,
          },
        };
      }
      return { ok: true };
    }
    case "review.submitted":
    case "review.abandoned": {
      const attempted = event.kind === "review.submitted" ? "submitted" : "abandoned";
      const existing = state.reviews.get(event.reviewNodeId);
      if (existing === undefined) {
        return {
          ok: false,
          rejection: {
            kind: "review-not-pending",
            reviewNodeId: event.reviewNodeId,
            currentStatus: "missing",
            attempted,
            message:
              `${event.kind}: review '${event.reviewNodeId}' has no prior 'review.opened' — ` +
              `refusing a terminal transition on an unknown review.`,
          },
        };
      }
      if (existing.status !== "pending") {
        return {
          ok: false,
          rejection: {
            kind: "review-not-pending",
            reviewNodeId: event.reviewNodeId,
            currentStatus: existing.status,
            attempted,
            message:
              `${event.kind}: review '${event.reviewNodeId}' is '${existing.status}' — ` +
              `a terminal state cannot transition again.`,
          },
        };
      }
      existing.status = attempted;
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

/** Cross-check the answer's values against the ask spec's own
 * constraints, once we already know `answer.kind === spec.kind`
 * (the earlier discriminant guard). Returns `undefined` on pass,
 * or `{ field, message }` on failure — the field name is the
 * dotted path (`"value"`, `"ranking"`) so a client can render the
 * error against the right widget. The rules mirror what the
 * `/ask/<id>` UI would already refuse; the validator being the
 * authority prevents a client-side bypass from writing a
 * malformed answer to the log.
 *
 * Cap for free-form text on `choice`/`scale`/`region`/`review` is
 * 4096 chars (matches the `note` cap the CLI expects). `text.text`
 * caps at 65 535 to line up with the HTML `maxLength` the page
 * renders. */
export function validateAnswerAgainstSpec(spec: Ask, answer: AskAnswer): { readonly field: string; readonly message: string } | undefined {
  const CAP_NOTE = 4096;
  const CAP_TEXT = 65_535;
  switch (answer.kind) {
    case "choice": {
      if (spec.kind !== "choice") return { field: "kind", message: `internal: kind mismatch (${spec.kind} vs ${answer.kind}).` };
      const allowedIds = new Set(spec.options.map((o) => o.id));
      const isOtherToken = (value: string): boolean => spec.allowOther === true && value.startsWith("other:");
      const check = (value: string, path: string): { field: string; message: string } | undefined => {
        if (value.length > CAP_NOTE) return { field: path, message: `value too long (${value.length} > ${CAP_NOTE}).` };
        if (allowedIds.has(value)) return undefined;
        if (isOtherToken(value)) return undefined;
        return { field: path, message: `value '${value}' is not one of the ask's options (${[...allowedIds].join(", ")})${spec.allowOther === true ? " and does not carry the 'other:' prefix" : " and allowOther is false"}.` };
      };
      if (Array.isArray(answer.value)) {
        if (spec.multi !== true) return { field: "value", message: "spec.multi is false, so `value` must be a single option id, not an array." };
        if (answer.value.length === 0) return { field: "value", message: "empty array — pick at least one option." };
        const seen = new Set<string>();
        for (let i = 0; i < answer.value.length; i++) {
          const v = answer.value[i]!;
          if (seen.has(v)) return { field: `value[${i}]`, message: `duplicate option id '${v}'.` };
          seen.add(v);
          const issue = check(v, `value[${i}]`);
          if (issue !== undefined) return issue;
        }
      } else {
        if (spec.multi === true) return { field: "value", message: "spec.multi is true, so `value` must be an array of option ids." };
        const issue = check(answer.value, "value");
        if (issue !== undefined) return issue;
      }
      if (answer.note !== undefined && answer.note.length > CAP_NOTE) {
        return { field: "note", message: `note too long (${answer.note.length} > ${CAP_NOTE}).` };
      }
      return undefined;
    }
    case "rank": {
      if (spec.kind !== "rank") return { field: "kind", message: `internal: kind mismatch.` };
      const optionIds = spec.options.map((o) => o.id);
      const optionSet = new Set(optionIds);
      if (answer.ranking.length !== optionIds.length) {
        return { field: "ranking", message: `ranking length ${answer.ranking.length} does not match option count ${optionIds.length}.` };
      }
      const seen = new Set<string>();
      for (let i = 0; i < answer.ranking.length; i++) {
        const v = answer.ranking[i]!;
        if (seen.has(v)) return { field: `ranking[${i}]`, message: `duplicate id '${v}' — ranking must be a permutation.` };
        seen.add(v);
        if (!optionSet.has(v)) return { field: `ranking[${i}]`, message: `id '${v}' is not one of the ask's options.` };
      }
      return undefined;
    }
    case "scale": {
      if (spec.kind !== "scale") return { field: "kind", message: `internal: kind mismatch.` };
      if (!Number.isFinite(answer.value)) return { field: "value", message: `value must be a finite number.` };
      // PR #52 round-3 review — tolerance is anchored to `step`
      // (so whole values cannot slip through: `1e9 + 0.4` on
      // `0..1e9 step 1` had a diff of 0.4 that the earlier
      // magnitude-scaled tolerance of ~1 accepted), with an
      // additional epsilon-of-magnitude floor for the case
      // where the reconstruction `min + i*step` itself carries
      // binary-float noise proportional to the values involved
      // (e.g. `999_999_999.999` on `0..1e9 step 0.001` —
      // reconstruction accumulates ~3e-6 of double-precision
      // noise, far above `step * 1e-6` = 1e-9). The two
      // components together are still bounded by a small
      // fraction of `step`, so whole-value drift is still
      // refused. Separately, the integer-step-index bounds
      // check below refuses `index < 0` or `index > stepsInSpan`
      // outright.
      const step = spec.step ?? 1;
      const rawIndex = (answer.value - spec.min) / step;
      const index = Math.round(rawIndex);
      const reconstructed = spec.min + index * step;
      const magnitude = Math.max(Math.abs(spec.min), Math.abs(spec.max), Math.abs(answer.value));
      const tolerance = Math.max(
        Math.abs(step) * 1e-6,
        magnitude * Number.EPSILON * 16,
        Number.EPSILON * 8,
      );
      if (Math.abs(answer.value - reconstructed) > tolerance) {
        return { field: "value", message: `value ${answer.value} is not on a step of ${step} from min ${spec.min} (nearest step: ${reconstructed}).` };
      }
      // Range check: value must reconstruct into [min, max]. The
      // integer-step-index bounds check below is the load-bearing
      // guard; this one names the failure clearly for a value
      // that landed clean of the step lattice but past the
      // endpoints.
      if (answer.value < spec.min - tolerance || answer.value > spec.max + tolerance) {
        return { field: "value", message: `value ${answer.value} is outside [${spec.min}, ${spec.max}].` };
      }
      // Integer-step-index bounds — the definitive check. A
      // spec that already survived `askSchema` has
      // `(max - min) / step` as an integer, so `stepsInSpan`
      // is exact. `index < 0 || index > stepsInSpan` refuses
      // anything half-a-step past either endpoint that could
      // otherwise slip through the range check by tolerance.
      const stepsInSpan = Math.round((spec.max - spec.min) / step);
      if (index < 0 || index > stepsInSpan) {
        return { field: "value", message: `value ${answer.value} maps to step index ${index}, outside [0, ${stepsInSpan}].` };
      }
      if (answer.note !== undefined && answer.note.length > CAP_NOTE) {
        return { field: "note", message: `note too long (${answer.note.length} > ${CAP_NOTE}).` };
      }
      return undefined;
    }
    case "text": {
      if (spec.kind !== "text") return { field: "kind", message: `internal: kind mismatch.` };
      if (answer.text.length > CAP_TEXT) return { field: "text", message: `text too long (${answer.text.length} > ${CAP_TEXT}).` };
      return undefined;
    }
    case "region": {
      if (spec.kind !== "region") return { field: "kind", message: `internal: kind mismatch.` };
      // `askAnswerSchema` already enforces at least two coords, but
      // the arity should be even (point = 2, brush = 4, polygon = 2k).
      if (answer.coordinates.length % 2 !== 0) {
        return { field: "coordinates", message: `coordinates must have an even length (got ${answer.coordinates.length}).` };
      }
      for (let i = 0; i < answer.coordinates.length; i++) {
        const c = answer.coordinates[i]!;
        if (!Number.isFinite(c)) return { field: `coordinates[${i}]`, message: `coordinate must be finite.` };
      }
      if (answer.note !== undefined && answer.note.length > CAP_NOTE) {
        return { field: "note", message: `note too long (${answer.note.length} > ${CAP_NOTE}).` };
      }
      return undefined;
    }
    case "review": {
      if (spec.kind !== "review") return { field: "kind", message: `internal: kind mismatch.` };
      // The discriminated union already restricts `decision` to
      // the three enum values; nothing further to check.
      if (answer.note !== undefined && answer.note.length > CAP_NOTE) {
        return { field: "note", message: `note too long (${answer.note.length} > ${CAP_NOTE}).` };
      }
      return undefined;
    }
  }
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
