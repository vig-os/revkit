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
//
// An import into a store that ALREADY holds a log is refused outright
// (#73): an archive that continues the head, or that starts above it,
// cannot be shown to be a continuation of THIS log, and accepting one
// silently gave `since(after)` — the daemon's SSE catch-up — foreign
// events under this log's seqs. Only an empty store accepts an archive,
// which is the one shape any producer emits (see `prepareImport`).

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
   * the store's current head (a fresh store's head is 0), and the store
   * must be EMPTY: a store that already holds a log refuses every
   * archive, because nothing in the archive can be shown to continue
   * that log (#73). Same `validateNext` rules as `append` — an archive
   * that violates them is refused as a whole (nothing is left
   * half-imported).
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

// Keep the import label in a template literal so the bundle's quoted-module
// specifier gate cannot mistake operation data for a module import.
export const STORE_OPERATION_LABELS = { append: "append", import: `import`, open: "open" } as const;

/** Location of a refusal, shared by schema and transition diagnostics. */
interface RejectionLocation {
  readonly path?: readonly PropertyKey[];
  readonly index?: number;
  readonly seq?: number;
}

/** Bound each quoted fragment to 120 escaped code units, preserving complete
 * JSON escapes and an explicit omitted-character count. JSON handles C0 and
 * lone surrogates; also escape C1 and Unicode line separators. Errors and
 * accepted-replay warnings share this primitive. */
export function quoteStoreDiagnostic(value: string): string {
  let escaped = "";
  let consumed = 0;
  for (const char of value) {
    const fragment = JSON.stringify(char).slice(1, -1).replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    if (escaped.length + fragment.length > 120) break;
    escaped += fragment;
    consumed += char.length;
  }
  return `"${escaped}"` + (value.length > consumed ? `…(+${value.length - consumed} chars)` : "");
}

// Exhaustive by type: adding a validator kind requires an explicit field here.
const rejectionFields: Record<AppendRejection["kind"], readonly string[]> = {
  "invalid-shape": ["event"],
  "duplicate-thread": ["threadId"],
  "unknown-thread": ["threadId"],
  "unknown-parent": ["parentId"],
  "duplicate-comment-id": ["commentId"],
  "not-open": ["threadId"],
  "not-resolved": ["threadId"],
  "unknown-comment": ["commentId"],
  "invalid-actor": ["actor"],
  "duplicate-ask": ["askId"],
  "unknown-ask": ["askId"],
  "duplicate-answer": ["askId"],
  "ask-not-pending": ["askId"],
  "answer-kind-mismatch": ["answer", "kind"],
  "answer-shape-mismatch": ["answer"],
  "duplicate-link": ["external"],
  "duplicate-external-id": ["external"],
  "already-orphaned": ["threadId"],
  "not-an-agent-draft": ["threadId"],
  "cross-file-reanchor": ["anchor", "path"],
  "duplicate-review": ["reviewNodeId"],
  "review-not-pending": ["reviewNodeId"],
  "promotion-review-not-pending": ["reviewNodeId"],
};

function rejectionPath(rejection: { readonly kind: ImportRejection["kind"] }): readonly PropertyKey[] {
  if (rejection.kind === "answer-shape-mismatch" && "field" in rejection) return ["answer", String(rejection.field)];
  if (rejection.kind === "not-an-agent-draft" && "commentId" in rejection && rejection.commentId !== undefined) return ["commentId"];
  return rejectionFields[rejection.kind as AppendRejection["kind"]] ?? ["seq"];
}

/** Build the human half of the store error contract. Diagnostics and paths
 * may contain caller-controlled values, including Zod's interpolated text.
 * Quote the entire fragment, and escape C1 controls and Unicode line separators
 * too (JSON already escapes C0 controls), so it stays one physical log line. */
export function storeRejectionMessage(
  operation: "append" | "import" | "open",
  rejection: AppendRejection | { readonly kind: ImportRejection["kind"]; readonly message: string },
  location: RejectionLocation = {},
): string {
  const subject = operation === STORE_OPERATION_LABELS.import ? "archive" : operation === "open" ? "existing log" : "event";
  const event = location.index !== undefined
    ? ` at event ${location.index}${location.seq === undefined ? "" : ` (seq ${location.seq})`}`
    : location.seq === undefined ? "" : ` at persisted event (seq ${location.seq})`;
  const path = location.path?.length ? location.path : rejectionPath(rejection);
  const field = `${event === "" ? " at" : ""} field ${quoteStoreDiagnostic(path.map(String).join("."))}`;
  return `${operation}: ${subject} refused${event}${field}: ${rejection.kind} — ${quoteStoreDiagnostic(rejection.message)}`;
}

/** The portion of a Zod issue needed to describe a shape refusal. */
interface StoreIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Thrown by any `ThreadStore.append` when the input is refused. Exposes
 * a machine-readable `rejection` so callers can branch without parsing
 * `.message`. */
export class ThreadStoreAppendError extends Error {
  readonly rejection: AppendRejection;
  constructor(rejection: AppendRejection, location: RejectionLocation = {}, options: ErrorOptions = {}) {
    super(storeRejectionMessage("append", rejection, location), options);
    this.name = "ThreadStoreAppendError";
    this.rejection = rejection;
  }

  /** Shape failures use the first offending field, never a raw issues dump. */
  static fromIssues(issues: readonly StoreIssue[]): ThreadStoreAppendError {
    const first = issues[0];
    return new ThreadStoreAppendError(
      { kind: "invalid-shape", message: first?.message ?? "event failed schema validation" },
      { path: first?.path },
    );
  }
}

/** A persisted log failed replay. Distinct from refusing a new append or an
 * archive: callers must repair or restore the existing store before opening it.
 * JSON and schema failures are invalid-shape; transition failures retain their
 * invariant kind. Infrastructure errors keep their original taxonomy. */
export class ThreadStoreOpenError extends Error {
  readonly rejection: AppendRejection;

  constructor(rejection: AppendRejection, displayName: string, options: {
    readonly location?: RejectionLocation;
    readonly cause?: unknown;
  } = {}) {
    super(
      storeRejectionMessage("open", rejection, options.location) +
        ` Archive ${quoteStoreDiagnostic(displayName)} and start clean, or restore from backup.`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ThreadStoreOpenError";
    this.rejection = rejection;
  }
}

/** What an `import` refusal carries for a caller that has to branch on
 * it. `kind` reuses the `validateNext` vocabulary, so a caller that
 * already branches on `ThreadStoreAppendError.rejection.kind` branches
 * the same way here. `head-not-monotone`, `seq-gap` and
 * `divergent-archive` are import-only: store-local preconditions about
 * the archive's relation to the head, which `append` cannot express
 * (it assigns the seq).
 *
 * `"invalid-shape"` means the archive's bytes are wrong — a field the
 * schema refuses, a duplicate `seq`, an out-of-order `seq`. An archive
 * that is SHAPE-VALID but semantically broken (the issue #72 repro: a
 * `comment.replied` naming a thread the archive itself never opened)
 * reports the real invariant kind, e.g. `"unknown-thread"` — the same
 * kind the store's own dry run reports for the same invariant, because
 * the archive's `superRefine` play-through carries it out structurally
 * (see `export.ts`).
 *
 * `"seq-gap"` and `"divergent-archive"` are the two halves of the #73
 * guard, told apart because a caller can act on them differently: a gap
 * means "events this store never had are missing below your first seq"
 * (fetch them), and a divergence means "your log and this archive
 * disagree about what comes next" (reconcile them). Both are refusals
 * a store that already holds a log hands back for an archive it cannot
 * prove is its continuation. */
export type ImportRejection = {
  /** Which invariant failed. Stable across implementations. */
  readonly kind: AppendRejection["kind"] | "head-not-monotone" | "seq-gap" | "divergent-archive";
  /** The `seq` of the offending archive event, when the failure named
   * one. `undefined` when the failure names no event OF THE ARCHIVE: a bad
   * `schemaVersion`, an `events` that is not an array, a `null` archive, or
   * a refusal about a foreign writer's event a backing could not replay
   * into its state (that event belongs to the store's log, not to the
   * archive, so it has no index here). A head-precondition refusal DOES
   * name an event — `events[0]`, whose seq is the one that failed the
   * check. */
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
 * fails the schema, one that starts at or below the store's head, one
 * this store's dry run refuses, and one that cannot be shown to
 * continue a log the store already holds (#73). A caller can therefore
 * branch on this one class at the store boundary; nothing about an
 * import escapes as a raw `ZodError`, and nothing escapes as the
 * `ThreadStoreAppendError` that the per-event check would have raised
 * on its own.
 *
 * `rejection` carries the machine-readable reason (the offending event's
 * `seq`/`index` plus the invariant's `kind`) so a caller never has to
 * parse `.message`. `cause` carries archive schema failures or persisted-row
 * JSON/schema failures — a `ZodError` or `SyntaxError`, so
 * `cause instanceof Error` holds for these parsing refusals. On the transition path
 * the reason is the structured `rejection.transition` instead, which is
 * why no `cause` is set there: an `AppendRejection` is not an `Error`,
 * and a `cause` that is sometimes an `Error` and sometimes a plain
 * object is a trap for the caller that reaches for it. */
export class ThreadStoreImportError extends Error {
  readonly rejection: ImportRejection | undefined;

  constructor(message: string, options: {
    readonly rejection?: ImportRejection;
    readonly cause?: unknown;
    readonly location?: RejectionLocation;
  } = {}) {
    super(
      storeRejectionMessage(STORE_OPERATION_LABELS.import, {
        ...options.rejection?.transition,
        kind: options.rejection?.kind ?? "invalid-shape",
        message,
      }, options.location),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ThreadStoreImportError";
    this.rejection = options.rejection;
  }
}

/** Columns needed to identify a malformed row even when its payload has no seq. */
export interface PersistedEventRow {
  readonly seq: number;
  readonly payload: string;
}

/** One constructor for persisted-log failures in every backing. Catch-up
 * refuses new input as invalid-shape; open retains a transition's real kind.
 * An import's machine seq/index still name only archive events, so the foreign
 * row's seq belongs in the human location, not in ImportRejection.seq. */
export function persistedLogError(
  operation: "append" | "import" | "open",
  seq: number,
  rejection: AppendRejection,
  options: { readonly path?: readonly PropertyKey[]; readonly cause?: unknown; readonly displayName?: string } = {},
): ThreadStoreAppendError | ThreadStoreImportError | ThreadStoreOpenError {
  const location = { seq, path: options.path ?? rejectionPath(rejection) };
  if (operation === "open") {
    return new ThreadStoreOpenError(rejection, options.displayName ?? "existing store", { location, cause: options.cause });
  }
  const message = rejection.kind === "invalid-shape"
    ? rejection.message : `persisted event violates ${rejection.kind}: ${rejection.message}`;
  if (operation === "append") {
    return new ThreadStoreAppendError({ kind: "invalid-shape", message }, location, { cause: options.cause });
  }
  return new ThreadStoreImportError(message, {
    rejection: { kind: "invalid-shape", seq: undefined, index: undefined, transition: undefined },
    location,
    cause: options.cause,
  });
}

/** Parse a stored payload in the caller's operation taxonomy. Query/read
 * methods keep their own behavior; replay on open and catch-up use this gate. */
export function parsePersistedEvent(
  row: PersistedEventRow,
  operation: "append" | "import" | "open",
  displayName?: string,
): ReviewEvent {
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch (cause) {
    throw persistedLogError(operation, row.seq, { kind: "invalid-shape", message: "persisted payload must be valid JSON" }, {
      path: ["payload"], cause, displayName,
    });
  }
  const parsed = reviewEventSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw persistedLogError(operation, row.seq, {
      kind: "invalid-shape", message: first?.message ?? "persisted event failed schema validation",
    }, { path: first?.path.length ? first.path : ["payload"], cause: parsed.error, displayName });
  }
  return parsed.data;
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
    return new ThreadStoreImportError("it is not a valid revkit thread archive.", { cause });
  }
  const [root, maybeIndex] = first.path;
  const index = root === "events" && typeof maybeIndex === "number" ? maybeIndex : undefined;
  const seq = index === undefined ? undefined : seqAt(raw, index);
  const path = index === undefined ? first.path : first.path.slice(2);
  // The archive failed its OWN `validateNext` play-through, so the
  // invariant's real kind is available and is what the store's dry run
  // would have reported for the same archive. Only a genuine shape
  // failure (a refused field, a duplicate or out-of-order `seq`) is
  // `invalid-shape` (#72: the two must not be indistinguishable).
  const transition = first.transition;
  return new ThreadStoreImportError(
    first.message,
    {
      rejection: {
        kind: transition?.kind ?? "invalid-shape",
        seq,
        index,
        transition,
      },
      cause,
      location: { path, index, seq },
    },
  );
}

/** Every check a `ThreadStore.import` performs before it is allowed to
 * write anything, in one place: `parseArchive` (the Zod shape and a
 * `validateNext` play-through from empty), the head-monotonicity
 * precondition, a dry run of the whole sequence against a DEEP COPY
 * of the caller's state, and the divergence guard. Returns the
 * archive's events on success, in `seq` order; throws
 * `ThreadStoreImportError` — and only that class — on any refusal.
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
  // without re-checking each one — except the two store-local rules, the
  // head precondition and the divergence guard below.
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
      `archive's first seq ${firstSeq} is not strictly greater than the store's head ${head}.`,
      {
        rejection: { kind: "head-not-monotone", seq: firstSeq, index: 0, transition: undefined },
        location: { path: ["seq"], index: 0, seq: firstSeq },
      },
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
        result.rejection.message,
        {
          rejection: { kind: result.rejection.kind, seq: event.seq, index, transition: result.rejection },
          location: { index, seq: event.seq },
        },
      );
    }
  }
  // ── The divergence guard (#73) ─────────────────────────────────────────
  // Deliberately LAST, so every refusal this function already made keeps
  // the kind a caller has seen since #72: the new checks only ever
  // refuse archives that would otherwise have been committed.
  //
  // What is left at this point is narrower than it looks. `parseArchive`
  // plays the archive through `validateNext` from an EMPTY state, so an
  // archive that survived the byte boundary only ever references ids it
  // created itself — an archive that named this store's threads,
  // comments, asks or reviews could not have got here (`unknown-thread`
  // and friends). And an archive whose ids COLLIDE with this store's
  // was just refused by the dry run above, as `duplicate-thread` /
  // `duplicate-comment-id` / `duplicate-external-id`. So an archive
  // reaching this line shares nothing with a store that holds a log, and
  // there is nothing left to compare: whether it is the same log's next
  // events or another repo's history wearing this log's seqs can only be
  // settled by deep-comparing the overlap, which is the parked #35
  // bridge's design to make.
  //
  // **Every clause of that paragraph is conditional on the caller having
  // passed the log the STORE holds.** A backing that hands us a
  // per-instance watermark instead — `D1ThreadStore` did exactly that,
  // with `#head === 0` and an empty `#logState` on every fresh instance,
  // and `src/index.ts` builds one per request — gets an EMPTY comparison
  // here and neither the dry run nor this guard can see anything
  // (#107/#108). `state` and `head` are the store's, not this object's.
  //
  // Until then the conservative reading holds: a store that already has
  // a log accepts no archive, and an EMPTY store accepts any (which is
  // the one shape every producer emits — `exportArchive` is the only
  // producer in `packages/*/src`, it emits the FULL log via
  // `since(0)`, and nothing in `packages/*/src` calls `import` at all,
  // so the only import that ships is a full log into a fresh store).
  // An archive with no events at all returns above, before any of this:
  // there is nothing to diverge when nothing is claimed.
  if (head > 0) {
    throw notAContinuation(firstSeq, head);
  }
  return validated.events;
}

/** The refusal a store that ALREADY holds a log hands back for an
 * archive above the head (#73). One kind per shape, so a caller can tell
 * a hole it could fill from a disagreement it has to reconcile, and one
 * line each naming the offending seq and the head it is measured
 * against. No `transition`: no `validateNext` rule broke — the gap
 * between two logs is a store-local fact, the same class of refusal as
 * `head-not-monotone`, so `cause` stays unset too. */
function notAContinuation(firstSeq: number, head: number): ThreadStoreImportError {
  const gap = firstSeq > head + 1;
  return new ThreadStoreImportError(
    gap
      ? `its first seq ${firstSeq} sits above the store's head ${head} + 1, so seqs ${head + 1}..${firstSeq - 1} would stay empty forever.`
      : `its first seq ${firstSeq} would continue the store's head ${head}, but this store already holds a log and nothing shows the archive is its continuation.`,
    {
      rejection: {
        kind: gap ? "seq-gap" : "divergent-archive",
        seq: firstSeq,
        index: 0,
        transition: undefined,
      },
      location: { path: ["seq"], index: 0, seq: firstSeq },
    },
  );
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
      throw ThreadStoreAppendError.fromIssues(parsed.error.issues);
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
