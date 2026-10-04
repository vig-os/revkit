// `D1ThreadStore` — the hosted Worker's `ThreadStore` (ADR-0006 append-only
// log, ADR-0025 "same core, store = D1").
//
// **ONE STORE IS ONE REVIEW (slice 5).** `logKey` is required, and every
// statement names it. This is not an interface change and not a `review-core`
// change: `ThreadStore` is still `append`/`since`/`threads`/`thread`, still
// means "this store's log", and both other implementations (the in-memory
// reference and the daemon's `bun:sqlite` store) are untouched. What changed is
// that the HOSTED table holds many logs — ADR-0008 is one Worker, one D1 and one
// deployment per org, and an org has many `(repo, PR)` reviews — so the hosted
// store needed to say WHICH one it is, and `migrations/0003_scoped_logs.sql`
// gave `events` a key to be partitioned by. The shared 19-case conformance
// suite still passes on all three backings, which is the point of it being in
// `review-core`.
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
// (Those four measurements were taken when the log was one per deployment, so
// the constraint they collided on was `events.seq` — a GLOBAL seq. With slice
// 5's `(log_key, seq)` key that particular collision is gone between logs and
// only writers to the SAME review contend, which is what `test/d1-store.test.ts`
// now drives directly.)
//
// So the critical section is exactly one `batch()`, and the head read is
// a statement INSIDE it. Each attempt issues three statements:
//
//   1. read MAX(seq) for this log                         -> `dbHead`
//   2. read this log's rows with seq > our last validated seq -> catch-up
//   3. INSERT … WHERE MAX(seq) for this log = <the head we validated against>
//
// Statement 3 is a compare-and-swap on this log's head. D1 serialises a batch
// as a unit, so in practice statements 1 and 3 always agree and the insert
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
 *
 * **Second known cost, and the one that bites first: the FIRST append on a
 * fresh instance is O(N).** `#logState` starts empty, so a store that has
 * never appended replays the entire log — one unbounded read plus one
 * `validateNext` per event — inside its first `append`, and that append also
 * pays its own batch. Today that is free: nothing appends over HTTP
 * (`POST /api/threads` is a 501), the table is empty, and every Worker
 * request builds its store lazily. From the bridge onward (`revkit threads
 * import`, the GitHub adapter's writes) the same shape is a per-isolate
 * warm-up cost proportional to the log, and the read it does is unbounded —
 * see the "no scale evidence" note in `README.md`.
 *
 * The fix when it matters is NOT to cache `#logState` across isolates,
 * which would mean trusting another isolate's writes; it is to make the
 * catch-up read BOUNDED and paginated, so the replay is chunked, or to give
 * the hosted surface a store instance per scope with a warm-up it controls.
 */
export const APPEND_CAS_ATTEMPTS = 64;

/** Reads the log's current head. Cheapest statement that proves the
 * batch's other statements are looking at a consistent snapshot.
 *
 * `WHERE log_key = ?` on EVERY statement is the whole of slice 5's
 * partition, and it is not decoration: ADR-0008 puts one Worker and one D1 per
 * org, so this table holds one log per `(repo, PR)` in the deployment rather
 * than one log per deployment. A statement that omitted the predicate would read
 * every review in the org — the exact defect `migrations/0003_scoped_logs.sql`
 * exists to remove. */
const HEAD_SQL = "SELECT COALESCE(MAX(seq), 0) AS head FROM review_logs WHERE log_key = ?";

/** Rows another writer appended to THIS LOG that this store has not validated
 * yet. Bounded by the gap between our head and theirs; a store that is the
 * only writer on this key reads nothing.
 *
 * Filtering on `log_key` here is also a CORRECTNESS control, not only a
 * disclosure one: `absorbCatchUp` replays what comes back through
 * `validateNext`, and another review's events are a different log with
 * colliding `threadId`s — feeding them to this store's validator would raise
 * `duplicate-thread` from somebody else's comment. */
const CATCH_UP_SQL = "SELECT payload FROM review_logs WHERE log_key = ? AND seq > ? ORDER BY seq ASC";

/** The append, guarded. `SELECT … WHERE MAX(seq) = ?` is the CAS: the insert
 * happens only if THIS LOG's head is still the one this attempt validated
 * against, and the seq written is the one this attempt's payload already claims.
 * A mismatch writes nothing and returns `changes: 0`.
 *
 * **The CAS is per-log, and that is why concurrent writers on different reviews
 * no longer collide.** With one global `MAX(seq)` and a global `seq` primary key,
 * two reviews appending at the same time had to take the same next `seq` and one
 * of them lost — retried, absorbed the other's events through `validateNext`, and
 * failed. With `(log_key, seq)` both take `seq = 1` of their own log and neither
 * is in the other's way. `test/d1-store.test.ts` drives two logs concurrently. */
const INSERT_SQL =
  "INSERT INTO review_logs (log_key, seq, ts, payload) SELECT ?, ?, ?, ? " +
  "WHERE (SELECT COALESCE(MAX(seq), 0) FROM review_logs WHERE log_key = ?) = ?";

/** `import`'s insert: the archive's OWN seqs, unguarded, but still carrying this
 * store's log key — the archive names seqs, never a log, and a store that
 * imported into "everything" would be a cross-review write. The head-monotone
 * rule is already enforced above against this store's head, and a concurrent
 * writer that claimed one of the archive's seqs must fail the whole batch loudly
 * (batch atomicity) rather than be silently skipped. A guard here would be WRONG
 * rather than merely redundant: an archive may legally carry gaps (ADR-0006 —
 * consumers use `since(lastSeen)` and never assume contiguity, and A14 pins that),
 * and a `MAX(seq) = seq - 1` guard would skip exactly those rows. */
const INSERT_ARCHIVE_SQL = "INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)";

/** Thrown when `append` exhausts its compare-and-swap budget.
 *
 * **Deliberately NOT a `ThreadStoreAppendError`.** That class means "the
 * event you handed me does not belong in this log", and every `kind` in its
 * `AppendRejection` union is a statement about log shape — a caller that
 * branches on the rejection type to answer 400 would turn a TRANSIENT
 * server-side condition into a client error and tell a reviewer their
 * comment is malformed when it is fine. Contention is a different class of
 * event: the event is valid, the log is simply busy.
 *
 * `retryable: true` is the field a future handler branches on to answer
 * **503 with `Retry-After`**, not 400. Nothing maps it in slice 1 because
 * nothing calls `append` over HTTP — `POST /api/threads` is a 501 (see
 * `src/index.ts`) — but the type exists so the first handler that does map
 * it cannot invent a 400 by accident.
 */
export class ThreadStoreContendedError extends Error {
  readonly retryable = true;
  readonly attempts: number;
  constructor(attempts: number, message: string) {
    super(message);
    this.name = "ThreadStoreContendedError";
    this.attempts = attempts;
  }
}

export interface D1ThreadStoreOptions {
  /** The bound D1 database. The schema is NOT created here — D1
   * migrations run out of band, so an absent table is a loud failure
   * rather than a request that quietly creates one. */
  readonly db: D1Database;
  /**
   * Which log this store IS. **Required, with no default** (slice 5).
   *
   * A default — or a `logKey?:` that fell back to "everything" — would put the
   * scope axis back exactly where it was: a store nobody scoped, reading one
   * deployment-wide log, behind a gate whose per-call check selects nothing.
   * Making it required means the type refuses the unscoped store, so the defect
   * is unrepresentable rather than guarded.
   *
   * The value is `previewScopePath(repo, pr)` from `src/router.ts`, carried on
   * `Route.scope.logKey` — i.e. it comes from the AUTHENTICATED PATH. Nothing in
   * this package turns a header, a query parameter or a body field into one.
   */
  readonly logKey: string;
  /** Injected so a test can pin `ts`. Defaults to the wall clock. */
  readonly clock?: Clock;
}

/** `D1ThreadStore` — the hosted `ThreadStore`, ONE PER REVIEW. Construct it
 * once per request scope and reuse it: `#logState` is the validator's state and
 * rebuilding it per call would replay the whole log on every append. */
export class D1ThreadStore implements ThreadStore {
  readonly #db: D1Database;
  readonly #logKey: string;
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
    this.#logKey = options.logKey;
    this.#clock = options.clock ?? wallClock;
  }

  /** This store's log key. The one that names which review this is — exposed so
   * a caller can log or assert it without a second derivation of its own. */
  get logKey(): string {
    return this.#logKey;
  }

  /** This log's current head, READ FROM D1.
   *
   * **Not `#head`.** `#head` is this instance's validated watermark, and
   * `src/index.ts` builds a fresh store per request — so on a log this
   * instance has never appended to, `#head` is 0 while the table holds
   * seq 7, and every resume point the caller computed from it was wrong.
   * That is not hypothetical: it is exactly what the #76 review measured
   * against a log seeded with seqs 1, 2, 3 and 7, and the test that caught
   * it had only ever asserted the EMPTY case.
   *
   * **Per log, since slice 5** — the head of THIS review's log, not of the
   * deployment. A `since=` resume point is only meaningful against the log it
   * came from, so a head that spanned reviews would hand every client a
   * resume point that silently skipped a review's events.
   *
   * `SqliteThreadStore.head()` re-reads `max(seq)` at construction, so the
   * two were already going to disagree about a method with the same name.
   * Reading the table here makes the VALUES agree, and it costs one indexed
   * query that a resume point needs anyway.
   *
   * The SIGNATURES still differ — this one is `async`, the SQLite one
   * returns `number` — and deliberately so: `head()` is not on the
   * `ThreadStore` interface, so nothing breaks, and forcing this store to
   * look synchronous would mean either caching a head that is stale by
   * construction (the bug above) or blocking. A caller holding both types
   * must `await` this one, and that is the honest cost of a remote store.
   *
   * After `append`/`import` on THIS instance the two VALUES agree, because
   * those are the only ways `#head` advances and both leave the table's
   * `MAX(seq)` equal to it. */
  async head(): Promise<number> {
    const row = await this.#db.prepare(HEAD_SQL).bind(this.#logKey).first<{ head?: number }>();
    return typeof row?.head === "number" ? row.head : 0;
  }

  /** This instance's validated watermark, without a query. Diagnostics
   * and the append path's bookkeeping only — a caller that wants the log's
   * head wants `head()`. */
  validatedHead(): number {
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
        this.#db.prepare(HEAD_SQL).bind(this.#logKey),
        this.#db.prepare(CATCH_UP_SQL).bind(this.#logKey, expected),
        this.#db.prepare(INSERT_SQL).bind(this.#logKey, seq, ts, JSON.stringify(event), this.#logKey, expected),
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
    throw new ThreadStoreContendedError(
      APPEND_CAS_ATTEMPTS,
      `append: gave up after ${APPEND_CAS_ATTEMPTS} compare-and-swap retries; another writer kept moving the head.`,
    );
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
        this.#db.prepare(INSERT_ARCHIVE_SQL).bind(this.#logKey, event.seq, event.ts, JSON.stringify(event)),
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
      .prepare("SELECT payload FROM review_logs WHERE log_key = ? AND seq > ? ORDER BY seq ASC")
      .bind(this.#logKey, after)
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
