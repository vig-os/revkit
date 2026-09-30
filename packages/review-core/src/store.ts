// ThreadStore — the append-only event log plus the derived Thread view
// (ADR-0006). The log is the source of truth; a store may cache the
// reduction. Kept an interface so M2 item 2 plugs in `bun:sqlite` on the
// daemon, M4 plugs in D1 on the Worker, and both surfaces flow the same
// events through the same core (ADR-0025). All methods are async so a
// remote / disk-backed implementation can honour them without a shape
// change.
//
// `append` assigns two fields:
//   - `seq` — strictly monotonically increasing, starting at 1
//   - `ts`  — ISO-8601 with offset, from the clock injected at construction
//             (defaults to the process wall clock, swappable so tests can
//             replay a canned timeline)
// It also refuses events that would produce an inconsistent log
// (`comment.created` for a thread id that already exists, `comment.replied`
// / `thread.resolved` / `thread.reopened` for a thread id that does not),
// so a well-formed log stays well-formed under any append order and the
// reducer's byzantine-slice skips (see `reducer.ts`) are a genuine safety
// net rather than a silent cover-up.

import { reviewEventSchema, type ReviewEvent, type ReviewEventInput } from "./events.ts";
import { reduce } from "./reducer.ts";
import type { Thread, ThreadFilter, ThreadStatus } from "./thread.ts";

/** A monotonic clock, injected so tests can control `ts`. Defaults to the
 * process wall clock (`new Date().toISOString()`). */
export type Clock = () => string;

const wallClock: Clock = () => new Date().toISOString();

export interface ThreadStore {
  /**
   * Append an event. Assigns `seq` and `ts`, validates the resulting
   * event against `reviewEventSchema`, refuses events that violate the
   * log's shape rules (see file header), and returns the assigned
   * `seq`.
   */
  append(input: ReviewEventInput): Promise<number>;

  /** All events with `seq` strictly greater than `after`. Ordered by
   * `seq` ascending. Used for cheap replay after a reconnect. */
  since(after: number): Promise<ReviewEvent[]>;

  /** All threads that pass the filter, in `createdAt` order. */
  threads(filter?: ThreadFilter): Promise<Thread[]>;

  /** One thread by id, or undefined. */
  thread(id: string): Promise<Thread | undefined>;
}

/** Reasons `append` may reject an input. The reason id (`kind`) is stable
 * across implementations; the message names the specifics. */
export type AppendRejection =
  | { kind: "invalid-shape"; message: string }
  | { kind: "duplicate-thread"; threadId: string; message: string }
  | { kind: "unknown-thread"; threadId: string; message: string };

/** Thrown by any `ThreadStore.append` when the input is refused. Exposes
 * a machine-readable `rejection` so callers can branch without parsing
 * `.message`. */
export class ThreadStoreAppendError extends Error {
  readonly rejection: AppendRejection;
  constructor(rejection: AppendRejection) {
    super(rejection.message);
    this.name = "ThreadStoreAppendError";
    this.rejection = rejection;
  }
}

/** In-memory reference implementation. The M2 daemon swaps this for a
 * `bun:sqlite` backing (M2 item 2); the Worker swaps it for D1 (M4). Kept
 * simple: an in-order events array, a cached threads map, and a next-seq
 * counter. */
export class InMemoryThreadStore implements ThreadStore {
  readonly #events: ReviewEvent[] = [];
  readonly #threadIds = new Set<string>();
  readonly #clock: Clock;
  #nextSeq = 1;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? wallClock;
  }

  async append(input: ReviewEventInput): Promise<number> {
    const seq = this.#nextSeq;
    const ts = this.#clock();
    const candidate = { ...input, seq, ts } as ReviewEvent;
    const parsed = reviewEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ThreadStoreAppendError({
        kind: "invalid-shape",
        message: `append: event failed validation: ${JSON.stringify(parsed.error.issues)}`,
      });
    }
    const event = parsed.data;
    this.#assertConsistency(event);
    this.#events.push(event);
    if (event.kind === "comment.created") {
      this.#threadIds.add(event.threadId);
    }
    this.#nextSeq = seq + 1;
    return seq;
  }

  async since(after: number): Promise<ReviewEvent[]> {
    return this.#events.filter((event) => event.seq > after).slice();
  }

  async threads(filter?: ThreadFilter): Promise<Thread[]> {
    const derived = reduce(this.#events);
    const list = [...derived.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return list.filter((thread) => matches(thread, filter));
  }

  async thread(id: string): Promise<Thread | undefined> {
    const derived = reduce(this.#events);
    return derived.get(id);
  }

  #assertConsistency(event: ReviewEvent): void {
    switch (event.kind) {
      case "comment.created":
        if (this.#threadIds.has(event.threadId)) {
          throw new ThreadStoreAppendError({
            kind: "duplicate-thread",
            threadId: event.threadId,
            message: `append: thread '${event.threadId}' already exists — thread creation is implicit and one-shot (see reducer.ts).`,
          });
        }
        return;
      case "comment.replied":
      case "thread.resolved":
      case "thread.reopened":
        if (!this.#threadIds.has(event.threadId)) {
          throw new ThreadStoreAppendError({
            kind: "unknown-thread",
            threadId: event.threadId,
            message: `append: thread '${event.threadId}' does not exist — a '${event.kind}' event needs a prior 'comment.created'.`,
          });
        }
        return;
      case "handover":
      case "presence":
      case "ask.created":
      case "ask.answered":
        return;
    }
  }
}

function matches(thread: Thread, filter: ThreadFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.path !== undefined && thread.anchor.path !== filter.path) return false;
  if (filter.status !== undefined) {
    const allowed: readonly ThreadStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!allowed.includes(thread.status)) return false;
  }
  return true;
}
