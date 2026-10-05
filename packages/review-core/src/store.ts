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
import { reduceAsks, selectAsks } from "./asks-view.ts";
import type { AskFilter, AskRecord } from "./asks.ts";
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

  /** All asks that pass the filter, ordered by `AskRecord.createdSeq`
   * ascending (deterministic — same discipline as threads). */
  asks(filter?: AskFilter): Promise<AskRecord[]>;

  /** One ask by id, or undefined. */
  ask(id: string): Promise<AskRecord | undefined>;
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

/** What an `import` refusal carries for a caller that has to branch on
 * it. `kind` reuses the `validateNext` vocabulary, so a caller that
 * already branches on `ThreadStoreAppendError.rejection.kind` branches
 * the same way here. `head-not-monotone` is import-only: the store-local
 * precondition that an archive starts strictly above the head, which
 * `append` cannot express (it assigns the seq).
 *
 * `"invalid-shape"` means the archive's bytes are wrong — a field the
 * schema refuses, a duplicate `seq`, an out-of-order `seq`. An archive
 * that is SHAPE-VALID but semantically broken (the issue #72 repro: a
 * `comment.replied` naming a thread the archive itself never opened)
 * reports the real invariant kind, e.g. `"unknown-thread"` — the same
 * kind the store's own dry run reports for the same invariant, because
 * the archive's `superRefine` play-through carries it out structurally
 * (see `export.ts`). */
export type ImportRejection = {
  /** Which invariant failed. Stable across implementations. */
  readonly kind: AppendRejection["kind"] | "head-not-monotone";
  /** The `seq` of the offending archive event, when the failure named
   * one. `undefined` only for a failure that names no event at all: a bad
   * `schemaVersion`, an `events` that is not an array, a `null` archive.
   * A head-precondition refusal DOES name an event — `events[0]`, whose
   * seq is the one that failed the check. */
  readonly seq: number | undefined;
  /** Index into `archive.events`, when the failure named one event. */
  readonly index: number | undefined;
  /** The `validateNext` rejection verbatim, when the refusal came from a
   * transition rule — the archive's own play-through at the byte boundary
   * or this store's dry run. `undefined` when the archive's SHAPE is what
   * failed, where the Zod issues are on `cause` instead. Named
   * `transition` rather than `rejection` so it does not read as
   * `err.rejection.rejection`; `cause` is the same value on the
   * transition path, and stays an `Error` on the shape path. */
  readonly transition: AppendRejection | undefined;
};

/** Thrown by `ThreadStore.import` for EVERY refusal — an archive that
 * fails the schema, one that starts at or below the store's head, and
 * one whose events break a `validateNext` transition against this
 * store's state. A caller can therefore branch on this one class at the
 * store boundary; nothing about an import escapes as a raw `ZodError`,
 * and nothing escapes as the `ThreadStoreAppendError` that the
 * per-event check would have raised on its own.
 *
 * `rejection` carries the machine-readable reason (the offending event's
 * `seq`/`index` plus the invariant's `kind`) so a caller never has to
 * parse `.message`. `cause` is set only on the shape path, where it is
 * the `ZodError` from `parseArchive` — so `cause instanceof Error`
 * always holds when `cause` is present at all. On the transition path
 * the reason is the structured `rejection.transition` instead, which is
 * why no `cause` is set there: an `AppendRejection` is not an `Error`,
 * and a `cause` that is sometimes an `Error` and sometimes a plain
 * object is a trap for the caller that reaches for it. */
export class ThreadStoreImportError extends Error {
  readonly rejection: ImportRejection | undefined;

  constructor(message: string, options: { readonly rejection?: ImportRejection; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ThreadStoreImportError";
    this.rejection = options.rejection;
  }
}

/** The `seq` of the event at `index` in a raw (not yet validated)
 * archive, or `undefined` when the archive is not shaped well enough to
 * carry one. Used only to name the offending event in a refusal
 * message. */
function seqAt(raw: ThreadArchive, index: number): number | undefined {
  const events = (raw as { readonly events?: unknown }).events;
  if (!Array.isArray(events)) return undefined;
  const seq = (events[index] as { readonly seq?: unknown } | undefined)?.seq;
  return typeof seq === "number" ? seq : undefined;
}

/** A `threadArchiveSchema` issue, as far as `importSchemaError` reads
 * it. `transition` is present only on an issue the archive's own
 * `validateNext` play-through added (`export.ts`), and it carries the
 * `AppendRejection` STRUCTURALLY — the kind is read from here, never
 * parsed back out of `message`. */
interface ArchiveIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly transition?: AppendRejection;
}

/** Turn a `parseArchive` failure into a `ThreadStoreImportError` whose
 * message names the offending event and the invariant it broke, in one
 * line — the raw Zod message for a shape failure is a path/multi-line
 * blob, and a caller's log gets one unhandled `ZodError` today. */
function importSchemaError(raw: ThreadArchive, cause: unknown): ThreadStoreImportError {
  // Read the issues structurally rather than with `instanceof`: the
  // ZodError that escaped came from whichever copy of zod `parseArchive`
  // bound, and a caller must not be told "schema failure" just because
  // two bundles hold two zods.
  const issues = (cause as { readonly issues?: readonly ArchiveIssue[] }).issues;
  const first = Array.isArray(issues) ? issues[0] : undefined;
  if (first === undefined) {
    return new ThreadStoreImportError("import: archive refused — it is not a valid revkit thread archive.", { cause });
  }
  const [root, maybeIndex] = first.path;
  const index = root === "events" && typeof maybeIndex === "number" ? maybeIndex : undefined;
  const seq = index === undefined ? undefined : seqAt(raw, index);
  // A `superRefine` issue already names the invariant in its message
  // ("log invariant: unknown-thread — …"); a plain Zod issue names a
  // field, so print the path under the event to say which one.
  const field = index === undefined ? first.path.join(".") : first.path.slice(2).join(".");
  const where =
    index === undefined
      ? first.path.length === 0
        ? "the archive itself"
        : `archive field '${field}'`
      : `event ${index}${seq === undefined ? "" : ` (seq ${seq})`}${field === "" ? "" : ` field '${field}'`}`;
  // The archive failed its OWN `validateNext` play-through, so the
  // invariant's real kind is available and is what the store's dry run
  // would have reported for the same archive. Only a genuine shape
  // failure (a refused field, a duplicate or out-of-order `seq`) is
  // `invalid-shape` (#72: the two must not be indistinguishable).
  const transition = first.transition;
  return new ThreadStoreImportError(
    `import: archive refused at ${where}: ${first.message}`,
    {
      rejection: {
        kind: transition?.kind ?? "invalid-shape",
        seq,
        index,
        transition,
      },
      cause,
    },
  );
}

/** Every check a `ThreadStore.import` performs before it is allowed to
 * write anything, in one place: `parseArchive` (the Zod shape and a
 * `validateNext` play-through from empty), the head-monotonicity
 * precondition, and a dry run of the whole sequence against a DEEP COPY
 * of the caller's state. Returns the archive's events on success, in
 * `seq` order; throws `ThreadStoreImportError` — and only that class —
 * on any refusal.
 *
 * All three backings call this, so the taxonomy is one contract rather
 * than three (near-identical) copies: `InMemoryThreadStore`,
 * `SqliteThreadStore` and `D1ThreadStore` differ in how they COMMIT the
 * events, not in what they accept or how they say no. The dry run is why
 * a refusal leaves nothing half-imported — the caller only starts writing
 * once this has returned.
 */
export function prepareImport(archive: ThreadArchive, state: LogState, head: number): readonly ReviewEvent[] {
  // `parseArchive` already ran once at the byte boundary. Re-parse here
  // so a caller that hands us an in-memory object (never JSON) still
  // hits the same shape check, and so this store can trust the events
  // without re-checking each one — except the head-monotone rule, which
  // is store-local.
  let validated: ThreadArchive;
  try {
    validated = parseArchive(archive);
  } catch (error) {
    throw importSchemaError(archive, error);
  }
  if (validated.events.length === 0) return [];
  const firstSeq = validated.events[0]?.seq ?? 0;
  if (firstSeq <= head) {
    throw new ThreadStoreImportError(
      `import: archive's first seq ${firstSeq} is not strictly greater than the store's head ${head}.`,
      { rejection: { kind: "head-not-monotone", seq: firstSeq, index: 0, transition: undefined } },
    );
  }
  // Atomic commit — the documented behaviour. Dry-run the whole sequence
  // against a DEEP COPY of the store's state; if any event is refused,
  // throw before the caller touches the real state so a retry with a
  // corrected archive still sees the same starting point. A one-by-one
  // commit would half-import the archive up to the rejected event, and a
  // bun:sqlite / D1 backing that copied that shape would inherit the bug.
  const shadow = cloneLogState(state);
  for (const [index, event] of validated.events.entries()) {
    const result = validateNext(shadow, event);
    if (!result.ok) {
      throw new ThreadStoreImportError(
        `import: archive refused at event ${index} (seq ${event.seq}): ${result.rejection.kind} — ${result.rejection.message}`,
        { rejection: { kind: result.rejection.kind, seq: event.seq, index, transition: result.rejection } },
      );
    }
  }
  return validated.events;
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
    // `prepareImport` owns every check and every message — see its doc
    // for why all three backings share it. Here we only COMMIT what it
    // already proved, which cannot fail: the same sequence was accepted
    // against a deep copy of the state we are about to mutate, so the
    // real state ends up structurally identical to that copy.
    const events = prepareImport(archive, this.#logState, this.#head);
    for (const event of events) {
      validateNext(this.#logState, event);
      this.#events.push(event);
      this.#head = event.seq;
    }
  }

  async since(after: number): Promise<ReviewEvent[]> {
    return this.#events.filter((event) => event.seq > after).slice();
  }

  async threads(filter?: ThreadFilter): Promise<Thread[]> {
    return selectThreads(this.#events, filter);
  }

  async thread(id: string): Promise<Thread | undefined> {
    const derived = reduce(this.#events);
    return derived.get(id);
  }

  async asks(filter?: AskFilter): Promise<AskRecord[]> {
    return selectAsks(this.#events, filter);
  }

  async ask(id: string): Promise<AskRecord | undefined> {
    const derived = reduceAsks(this.#events);
    return derived.get(id);
  }
}

/** Reduce `events` and return the resulting threads, ordered by
 * `createdSeq` ascending and filtered by `filter`. One implementation
 * owns the reduce → sort → filter sequence; both `InMemoryThreadStore`
 * and the daemon's `SqliteThreadStore` call it, so a filter rule added
 * here (an author kind, a mention target, a `since` filter later)
 * shows up on both stores without a copy-paste.
 *
 * The ordering (`createdSeq` ascending) matches the `Thread.createdSeq`
 * doc line in `thread.ts`: deterministic, and stable across replays,
 * because seq is the wire-level monotone the store assigns, not a
 * clock-sensitive ISO string. */
export function selectThreads(
  events: readonly ReviewEvent[],
  filter?: ThreadFilter,
): Thread[] {
  const derived = reduce(events);
  const list = [...derived.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  return list.filter((thread) => matchesFilter(thread, filter));
}

/** Predicate for `ThreadFilter`. Exported so a caller with its own
 * pre-reduced thread set (a UI cache, an export tool) can apply the
 * same rules the store applies. */
export function matchesFilter(thread: Thread, filter: ThreadFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.path !== undefined && thread.anchor.path !== filter.path) return false;
  if (filter.status !== undefined) {
    const allowed: readonly ThreadStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!allowed.includes(thread.status)) return false;
  }
  return true;
}
