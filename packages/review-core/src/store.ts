// ThreadStore — the append-only event log plus the derived Thread view
// (ADR-0006). The log is the source of truth; a store may cache the
// reduction. Kept an interface so M2 item 2 plugs in `bun:sqlite` on the
// daemon, M4 plugs in D1 on the Worker, and both surfaces flow the same
// events through the same core (ADR-0025). All methods are async so a
// remote / disk-backed implementation can honour them without a shape
// change.
//
// `append` assigns two fields:
//   - `seq` — STRICTLY INCREASING, starting at 1. This in-memory
//             implementation uses lastSeq + 1 (no gaps); a D1-backed
//             implementation may hand out gaps (dropped writes, resumed
//             counters) and that is fine — consumers use
//             `since(lastSeen)` and never assume `seq` is contiguous.
//   - `ts`  — ISO-8601 with offset, from the clock injected at
//             construction (defaults to the process wall clock,
//             swappable so tests can replay a canned timeline)
//
// `import` replays a `ThreadArchive` (see `export.ts`) into the store
// PRESERVING each event's original `seq`/`ts`. The archive's seqs must
// all be strictly greater than the store's current head, and the same
// `validateNext` runs across the sequence, so the import path holds the
// same log-shape guarantees the append path does — one source of truth
// for the rules.

import { parseArchive, type ThreadArchive } from "./export.ts";
import { reviewEventSchema, type ReviewEvent, type ReviewEventInput } from "./events.ts";
import { reduce } from "./reducer.ts";
import type { Thread, ThreadFilter, ThreadStatus } from "./thread.ts";
import { cloneLogState, emptyLogState, validateNext, type AppendRejection, type LogState } from "./validator.ts";

/** A monotonic clock, injected so tests can control `ts`. Defaults to the
 * process wall clock (`new Date().toISOString()`). */
export type Clock = () => string;

const wallClock: Clock = () => new Date().toISOString();

export interface ThreadStore {
  /**
   * Append an event. Assigns `seq` and `ts`, validates the resulting
   * event against `reviewEventSchema` AND against the shared
   * `validateNext` transition rules, and returns the assigned `seq`.
   */
  append(input: ReviewEventInput): Promise<number>;

  /**
   * Replay an archive into this store, preserving each event's original
   * `seq`/`ts`. The archive's first seq must be strictly greater than
   * the store's current head (a fresh store's head is 0). Same
   * `validateNext` rules as `append` — an archive that violates them is
   * refused as a whole (nothing is left half-imported).
   */
  import(archive: ThreadArchive): Promise<void>;

  /** All events with `seq` strictly greater than `after`. Ordered by
   * `seq` ascending. Used for cheap replay after a reconnect. */
  since(after: number): Promise<ReviewEvent[]>;

  /** All threads that pass the filter, ordered by `Thread.createdSeq`
   * ascending (deterministic; not ISO-string clock-sensitive). */
  threads(filter?: ThreadFilter): Promise<Thread[]>;

  /** One thread by id, or undefined. */
  thread(id: string): Promise<Thread | undefined>;
}

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

/** Thrown by `ThreadStore.import` when the archive would break the log's
 * append-only, monotone-seq invariants (independent of the per-event
 * `validateNext` check, which raises `ThreadStoreAppendError`). */
export class ThreadStoreImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadStoreImportError";
  }
}

export { type AppendRejection };

/** In-memory reference implementation. The M2 daemon swaps this for a
 * `bun:sqlite` backing (M2 item 2); the Worker swaps it for D1 (M4).
 * Kept simple: an in-order events array, a validator state carried
 * alongside, and a `head` counter. */
export class InMemoryThreadStore implements ThreadStore {
  readonly #events: ReviewEvent[] = [];
  readonly #logState: LogState = emptyLogState();
  readonly #clock: Clock;
  #head = 0;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? wallClock;
  }

  async append(input: ReviewEventInput): Promise<number> {
    const seq = this.#head + 1;
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
    const result = validateNext(this.#logState, event);
    if (!result.ok) throw new ThreadStoreAppendError(result.rejection);
    this.#events.push(event);
    this.#head = seq;
    return seq;
  }

  async import(archive: ThreadArchive): Promise<void> {
    // `parseArchive` already ran once at the byte boundary and enforced
    // both the Zod shape and `validateNext` starting from an empty state.
    // Re-parse here so a caller that hands us an in-memory object (never
    // JSON) still hits the same shape check, and so this store can trust
    // the events without re-checking each one — except the head-monotone
    // rule, which is store-local.
    const validated = parseArchive(archive);
    if (validated.events.length === 0) return;
    const firstSeq = validated.events[0]?.seq ?? 0;
    if (firstSeq <= this.#head) {
      throw new ThreadStoreImportError(
        `import: archive's first seq ${firstSeq} is not strictly greater than the store's head ${this.#head}.`,
      );
    }
    // Atomic commit — the documented behaviour. Dry-run the whole
    // sequence against a DEEP COPY of the store's state; if any event
    // is refused, throw before touching the real state so a retry with
    // a corrected archive still sees the same starting point. A
    // one-by-one commit would half-import the archive up to the
    // rejected event, and a bun:sqlite / D1 backing that copied that
    // shape would inherit the bug.
    const shadow = cloneLogState(this.#logState);
    for (const event of validated.events) {
      const result = validateNext(shadow, event);
      if (!result.ok) throw new ThreadStoreAppendError(result.rejection);
    }
    // Every event passed on the shadow — the real state is structurally
    // identical to the shadow's starting point, so replaying the same
    // events on it is guaranteed to succeed. Commit as one step.
    for (const event of validated.events) {
      validateNext(this.#logState, event);
      this.#events.push(event);
      this.#head = event.seq;
    }
  }

  async since(after: number): Promise<ReviewEvent[]> {
    return this.#events.filter((event) => event.seq > after).slice();
  }

  async threads(filter?: ThreadFilter): Promise<Thread[]> {
    const derived = reduce(this.#events);
    const list = [...derived.values()].sort((a, b) => a.createdSeq - b.createdSeq);
    return list.filter((thread) => matches(thread, filter));
  }

  async thread(id: string): Promise<Thread | undefined> {
    const derived = reduce(this.#events);
    return derived.get(id);
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
