// `D1ThreadStore` — the hosted Worker's `ThreadStore` (ADR-0006 append-only
// log, ADR-0025 "same core, store = D1").
//
// This is a PORT of the daemon's `SqliteThreadStore` (455 lines,
// `packages/cli/src/serve/sqlite-store.ts`) — of its *shape*, not its code.
// `bun:sqlite` does not exist in workerd, and `SqliteThreadStore`'s
// concurrency discipline is built on `BEGIN IMMEDIATE`, which D1 refuses
// outright. So the rules come from review-core (the same
// `reviewEventSchema` + `validateNext` + `selectThreads` + `reduce` the
// in-memory reference store uses) and the seq allocation is re-derived
// from what D1 actually does.
//
// ── Why the seq allocation looks the way it does ──────────────────────────
//
// `SqliteThreadStore.append` takes the next seq inside a `BEGIN IMMEDIATE`
// transaction: read the head, validate, insert, all under a write lock.
// D1 has no interactive transactions. Measured on miniflare 4.20260518.0
// (D1 emulation, no account):
//
//   - `BEGIN IMMEDIATE` / `COMMIT` -> `D1_EXEC_ERROR: … To execute a
//     transaction, please use the ["batch()"] API`.
//   - six CONCURRENT naive read-then-write appends -> 3 distinct seqs,
//     `UNIQUE constraint failed: events.seq`, 2 rows persisted.
//   - the same six with only the INSERT inside `batch()` and the head
//     read outside it -> all six computed seq 1, and it STILL collided.
//     `batch()` cannot help a read that happened before it.
//   - one `batch()` whose second statement violated the PK ->
//     `committed=false`, nothing written. `batch()` IS atomic.
//
// So the critical section is exactly one `batch()`, and the head read is
// a statement INSIDE it. Each attempt issues three statements:
//
//   1. read MAX(seq)                                    -> `dbHead`
//   2. read every row with seq > our last validated seq -> catch-up
//   3. INSERT … WHERE MAX(seq) = <the head we validated against>
//
// Statement 3 is a compare-and-swap on the head. D1 serialises a batch as
// a unit, so in practice statements 1 and 3 always agree and the insert
// lands. The guard exists for the case the brief flags and cannot be
// proven away locally: miniflare's SQLite may serialise more aggressively
// than production D1. If another writer moved the head, statement 3 writes
// ZERO rows, `meta.changes === 0`, and this store retries having already
// replayed the other writer's rows from statement 2 — so the retry
// validates against the state the other writer actually left behind
// instead of silently overwriting. That is the difference between
// "gaps are legal" (ADR-0006: a D1 store may hand out gaps) and "lost
// writes" (never legal).
//
// `test/d1-store.test.ts` pins the collision directly: 20 concurrent
// appends, 20 distinct seqs, 20 rows.

import {
  cloneLogState,
  emptyLogState,
  parseArchive,
  reduce,
  reduceAsks,
  reviewEventSchema,
  selectAsks,
  selectThreads,
  validateNext,
  ThreadStoreAppendError,
  ThreadStoreImportError,
  type AskFilter,
  type AskRecord,
  type Clock,
  type LogState,
  type ReviewEvent,
  type ReviewEventInput,
  type Thread,
  type ThreadArchive,
  type ThreadFilter,
  type ThreadStore,
} from "@revkit/review-core";

const wallClock: Clock = () => new Date().toISOString();

/**
 * Cap on compare-and-swap retries in `append`.
 *
 * One retry corresponds to exactly one competing commit landing between an
 * attempt's head read and its insert, and the CAS means **one writer wins
 * per round**: N concurrent appends therefore take up to N rounds, so the
 * worst-case retry count for any single append is the number of competing
 * writers. Measured on miniflare 4.20260518.0 with two store instances
 * writing 8 events each concurrently, the last append needed 9 attempts
 * — so an earlier cap of 8 was reachable by a legitimate burst, which is
 * how this number was chosen rather than guessed.
 *
 * 64 is ~4x the largest burst this slice's tests create. It exists so a
 * pathological writer storm fails LOUDLY with a typed error instead of
 * spinning forever; exhausting it means more than 64 commits landed inside
 * one append, which is a signal to look at the writer, not to retry more.
 *
 * **Known characteristic, recorded rather than hidden:** an append costs up
 * to one D1 round trip per competing writer, so throughput under a write
 * burst is O(N) round trips for N writers. The interface explicitly
 * permits gaps, so the fix if that ever matters is a block allocator
 * (claim K seqs atomically, then serve appends from the block) — not a
 * transaction, which D1 refuses.
 */
export const APPEND_CAS_ATTEMPTS = 64;

/** Reads the log's current head. Cheapest statement that proves the
 * batch's other statements are looking at a consistent snapshot. */
const HEAD_SQL = "SELECT COALESCE(MAX(seq), 0) AS head FROM events";

/** Rows another writer appended that this store has not validated yet.
 * Bounded by the gap between our head and theirs; a store that is the
 * only writer reads nothing. */
const CATCH_UP_SQL = "SELECT payload FROM events WHERE seq > ? ORDER BY seq ASC";

/** The append, guarded. `SELECT … WHERE MAX(seq) = ?` is the CAS: the
 * insert happens only if the head is still the one this attempt
 * validated against, and the seq written is the one this attempt's
 * payload already claims. A mismatch writes nothing and returns
 * `changes: 0`. */
const INSERT_SQL =
  "INSERT INTO events (seq, ts, payload) SELECT ?, ?, ? " +
  "WHERE (SELECT COALESCE(MAX(seq), 0) FROM events) = ?";

/** `import`'s insert: the archive's OWN seqs, unguarded. The head-monotone
 * rule is already enforced above against this store's head, and a
 * concurrent writer that claimed one of the archive's seqs must fail the
 * whole batch loudly (batch atomicity) rather than be silently skipped.
 * A guard here would be WRONG rather than merely redundant: an archive
 * may legally carry gaps (ADR-0006 — consumers use `since(lastSeen)` and
 * never assume contiguity, and A14 pins that), and a
 * `MAX(seq) = seq - 1` guard would skip exactly those rows. */
const INSERT_ARCHIVE_SQL = "INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)";

export interface D1ThreadStoreOptions {
  /** The bound D1 database. The schema is NOT created here — D1
   * migrations run out of band, so an absent table is a loud failure
   * rather than a request that quietly creates one. */
  readonly db: D1Database;
  /** Injected so a test can pin `ts`. Defaults to the wall clock. */
  readonly clock?: Clock;
}

/** `D1ThreadStore` — the hosted `ThreadStore`. Construct it once per
 * request scope and reuse it: `#logState` is the validator's state and
 * rebuilding it per call would replay the whole log on every append. */
export class D1ThreadStore implements ThreadStore {
  readonly #db: D1Database;
  readonly #clock: Clock;
  readonly #logState: LogState = emptyLogState();
  /** Highest seq this store has validated. 0 on an empty log. NOT
   * assumed to equal the table's MAX(seq) — the catch-up read in every
   * append reconciles the two. */
  #head = 0;
  /** Tail of the mutation queue. `#head` and `#logState` are per-instance
   * bookkeeping that only makes sense one mutation at a time, and the CAS
   * protects the DATABASE, not this object's fields: two `append()` calls
   * racing on one store would both read `#head === 0`, both validate
   * against the same state, and the loser's catch-up would then re-absorb
   * the winner's own event as `duplicate-thread`.
   *
   * `SqliteThreadStore` gets this for free from `BEGIN IMMEDIATE`, which
   * holds a write lock for the whole read-validate-insert. D1 has no
   * interactive transactions, so the mutual exclusion is explicit here.
   * It is NOT the cross-store lock — that is the CAS. This only orders
   * one instance against itself, which is what a Worker isolate needs
   * (its event loop interleaves two in-flight requests at every `await`). */
  #queue: Promise<unknown> = Promise.resolve();

  /** Run `work` after every previously enqueued mutation on this store. */
  #serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(options: D1ThreadStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? wallClock;
  }

  /** The highest seq this store has validated. A hosted page uses it to
   * stamp a resume point, the same way the daemon's `/events` does. */
  head(): number {
    return this.#head;
  }

  append(input: ReviewEventInput): Promise<number> {
    return this.#serialise(() => this.appendNow(input));
  }

  private async appendNow(input: ReviewEventInput): Promise<number> {
    const ts = this.#clock();
    for (let attempt = 1; attempt <= APPEND_CAS_ATTEMPTS; attempt++) {
      const expected = this.#head;
      const seq = expected + 1;
      const candidate = { ...input, seq, ts } as ReviewEvent;
      const parsed = reviewEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ThreadStoreAppendError({
          kind: "invalid-shape",
          message: `append: event failed validation: ${JSON.stringify(parsed.error.issues)}`,
        });
      }
      const event = parsed.data;
      // Dry-run on a DEEP COPY, never on `#logState`. `validateNext`
      // mutates the state it is given, and this append is not committed
      // yet: the batch below can still refuse the write (that is what the
      // CAS is for), and a state that had already absorbed a refused event
      // would reject it again as `duplicate-thread` on the retry. Same
      // discipline `InMemoryThreadStore.import` uses, for the same reason.
      const shadow = cloneLogState(this.#logState);
      const result = validateNext(shadow, event);
      if (!result.ok) throw new ThreadStoreAppendError(result.rejection);

      const batched = await this.#db.batch<{ payload: string }>([
        this.#db.prepare(HEAD_SQL),
        this.#db.prepare(CATCH_UP_SQL).bind(expected),
        this.#db.prepare(INSERT_SQL).bind(seq, ts, JSON.stringify(event), expected),
      ]);
      const dbHead = readHead(batched[0]);
      // Whatever another writer committed is durable, so it belongs in
      // the real state whether or not our own insert landed — the next
      // attempt must validate against it, not against a stale state.
      absorbCatchUp(this.#logState, readPayloads(batched[1]));
      if (this.#head < dbHead) this.#head = dbHead;
      if ((batched[2]?.meta?.changes ?? 0) > 0) {
        // The CAS held, which means `MAX(seq)` was still `expected`, which
        // means the catch-up read was empty — so `#logState` and the shadow
        // agreed and re-running the transition here is exactly the one the
        // dry run accepted.
        validateNext(this.#logState, event);
        this.#head = seq;
        return seq;
      }
    }
    throw new ThreadStoreAppendError({
      kind: "invalid-shape",
      message: `append: gave up after ${APPEND_CAS_ATTEMPTS} compare-and-swap retries; another writer kept moving the head.`,
    });
  }

  import(archive: ThreadArchive): Promise<void> {
    return this.#serialise(() => this.importNow(archive));
  }

  private async importNow(archive: ThreadArchive): Promise<void> {
    // Same guarantees as `InMemoryThreadStore.import` and
    // `SqliteThreadStore.import`: `parseArchive` ran the Zod shape and
    // `validateNext` from empty at the byte boundary; re-parse so a
    // caller handing us an in-memory object hits the same check; the
    // archive's first seq must be strictly greater than our head; and
    // the whole sequence is dry-run against a DEEP COPY so a refusal
    // leaves nothing half-imported.
    const validated = parseArchive(archive);
    if (validated.events.length === 0) return;
    const firstSeq = validated.events[0]?.seq ?? 0;
    if (firstSeq <= this.#head) {
      throw new ThreadStoreImportError(
        `import: archive's first seq ${firstSeq} is not strictly greater than the store's head ${this.#head}.`,
      );
    }
    const shadow = cloneLogState(this.#logState);
    for (const event of validated.events) {
      const result = validateNext(shadow, event);
      if (!result.ok) throw new ThreadStoreAppendError(result.rejection);
    }
    // Every event passed on the shadow. The rows go in ONE batch, so a
    // PK collision mid-archive writes none of them (measured: D1
    // refuses the whole batch) and the store is left exactly as it was.
    await this.#db.batch(
      validated.events.map((event) =>
        this.#db.prepare(INSERT_ARCHIVE_SQL).bind(event.seq, event.ts, JSON.stringify(event)),
      ),
    );
    for (const event of validated.events) {
      // Cannot fail — the shadow accepted this exact sequence.
      validateNext(this.#logState, event);
      this.#head = event.seq;
    }
  }

  async since(after: number): Promise<ReviewEvent[]> {
    const result = await this.#db
      .prepare("SELECT payload FROM events WHERE seq > ? ORDER BY seq ASC")
      .bind(after)
      .all<{ payload: string }>();
    return (result.results ?? []).map((row) => reviewEventSchema.parse(JSON.parse(row.payload)));
  }

  async threads(filter?: ThreadFilter): Promise<Thread[]> {
    // review-core owns the reduce -> sort -> filter sequence so a filter
    // rule added there lands on every store at once (same reason
    // `SqliteThreadStore.threads` delegates).
    return selectThreads(await this.since(0), filter);
  }

  async thread(id: string): Promise<Thread | undefined> {
    return (await reduce(await this.since(0))).get(id);
  }

  async asks(filter?: AskFilter): Promise<AskRecord[]> {
    return selectAsks(await this.since(0), filter);
  }

  async ask(id: string): Promise<AskRecord | undefined> {
    return (await reduceAsks(await this.since(0))).get(id);
  }
}

function readHead(statement: D1Result<unknown> | undefined): number {
  const row = statement?.results?.[0] as { head?: unknown } | undefined;
  const head = row?.head;
  return typeof head === "number" ? head : 0;
}

function readPayloads(statement: D1Result<{ payload: string }> | undefined): string[] {
  return (statement?.results ?? []).map((row) => row.payload);
}

/** Replay rows another writer committed into this store's validator
 * state. A refusal here means the log is genuinely inconsistent with the
 * shared rules — surface it as the typed append error rather than
 * letting our own event ride on top of a state we could not build. */
function absorbCatchUp(state: LogState, payloads: readonly string[]): void {
  for (const payload of payloads) {
    const foreign = reviewEventSchema.parse(JSON.parse(payload));
    const result = validateNext(state, foreign);
    if (!result.ok) {
      throw new ThreadStoreAppendError({
        kind: "invalid-shape",
        message: `append: another writer's event seq=${foreign.seq} broke the local log state (${result.rejection.kind}: ${result.rejection.message}).`,
      });
    }
  }
}
