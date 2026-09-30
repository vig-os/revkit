// `SqliteThreadStore` — the daemon's `bun:sqlite` implementation of
// `@revkit/review-core`'s `ThreadStore` (ADR-0006).
//
// One table: `events(seq INTEGER PRIMARY KEY, ts TEXT NOT NULL,
// payload TEXT NOT NULL)`. `payload` is the full `ReviewEvent` as JSON,
// including `seq` and `ts`, so a query returns a row that
// `reviewEventSchema.parse` accepts unchanged. Two columns are stored
// separately (`seq`, `ts`) purely because they are the query keys —
// `since(after)` filters on `seq`, and a future retention job filters
// on `ts` (ADR-0015).
//
// **The append path is the same rule set the in-memory store runs.**
// It uses review-core's `reviewEventSchema` for shape and
// `validateNext` (with the same `LogState` the store carries in memory)
// for transitions. One source of truth for what a well-formed log
// looks like across the append path (this store), the archive path
// (`parseArchive`) and the reference implementation
// (`InMemoryThreadStore`). Any drift is a bug in review-core, not
// something the daemon can paper over.
//
// **`seq` is contiguous here.** review-core promises consumers only
// strict monotonicity (D1 may skip; we do not); this store uses
// `head + 1` and drops the row into `events`. That is safe under
// crash-restart because the head is re-read from the max(seq) at
// startup, not held only in memory.

import { Database } from "bun:sqlite";
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
import { ThreadStoreAppendError, ThreadStoreImportError } from "@revkit/review-core";

const wallClock: Clock = () => new Date().toISOString();

/** SQL to bring a database up to the current schema. `journal_mode =
 * WAL` gives concurrent readers alongside a single writer, which the
 * daemon needs (an SSE consumer running `since(after)` while a POST
 * appends a new event). `synchronous = NORMAL` is the WAL-recommended
 * setting — durable across a process crash, not across a machine
 * crash, which matches the ADR-0006 "log is the source of truth"
 * property.
 *
 * **Snapshots (M2 item 5b).** `snapshots(revision PRIMARY KEY, source
 * TEXT, bytes INTEGER, created_at TEXT)` holds the LF-normalised
 * source text an anchor was made against, content-addressed by
 * revision hash. The re-anchoring pipeline reads `source` for the
 * old revision, runs `prepareReanchor(source, currentSource)`, and
 * (for each thread) reduces the outcome to a `thread.reanchored`
 * or `thread.orphaned` event. `bytes` is stored so the GC (see
 * `snapshotBytes()`) can name the total footprint in a log line
 * without reading every row.
 *
 * **Migration.** Every DDL statement is `IF NOT EXISTS`. An
 * existing DB from a pre-5b daemon has no `snapshots` table and
 * opens cleanly — the table is created on first `open()`, empty,
 * and the daemon backfills a snapshot for each existing thread's
 * anchor as new events land or via lazy refresh on the next GET
 * (the pipeline orphans if a snapshot is missing, so an already-
 * stale thread on an already-changed file still transitions
 * correctly). */
const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE TABLE IF NOT EXISTS snapshots (
  revision TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Options for the store. `clock` is injected so tests can pin the
 * timestamp; `filename` is `:memory:` in tests, a real path in prod. */
export interface SqliteThreadStoreOptions {
  readonly filename: string;
  readonly clock?: Clock;
  /** Optional display label the corruption error uses in place of the
   * absolute filename — the daemon passes a repo-relative path so a
   * home-directory username does not leak into an operator's log
   * scrollback (ADR-0020 in spirit). Falls back to `filename`. */
  readonly displayName?: string;
}

/** `SqliteThreadStore` — the on-disk `ThreadStore` for the daemon.
 * Open a database with `open()`, use it, `close()` on shutdown. Do not
 * call `new` on it directly — `open()` handles schema-up and log-state
 * rehydration in one place. */
export class SqliteThreadStore implements ThreadStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #logState: LogState;
  #head: number;

  private constructor(db: Database, clock: Clock, logState: LogState, head: number) {
    this.#db = db;
    this.#clock = clock;
    this.#logState = logState;
    this.#head = head;
  }

  /** Open the store, run the schema-up migration, rehydrate the
   * validator state from the existing events and cache the head.
   *
   * **Replay policy for `answer-shape-mismatch` (PR #52 round-2
   * review, ADR-0007 amendment).** The M2 item-7 branch tightened
   * `validateNext` to check ask-answer values against the ask
   * spec — a change stricter than earlier commits on the same
   * branch. Any log written by an earlier commit could therefore
   * carry an `ask.answered` event that fails the new rule. We
   * **accept** such events on replay: log a warning that names
   * the ask id, and advance the validator state as if the event
   * had been accepted (so the ask reaches `answered`, matching
   * what the reducer would already project). New appends still
   * run the strict rule via `append()`. Every OTHER rejection
   * kind (`invalid-shape`, `duplicate-thread`, `unknown-parent`,
   * …) is still fatal — those signal real log corruption. */
  static open(options: SqliteThreadStoreOptions): SqliteThreadStore {
    const db = new Database(options.filename, { create: true });
    db.exec(SCHEMA_SQL);
    const rows = db
      .query<{ payload: string }, []>("SELECT payload FROM events ORDER BY seq ASC")
      .all();
    const state = emptyLogState();
    let head = 0;
    for (const row of rows) {
      const event = reviewEventSchema.parse(JSON.parse(row.payload));
      const result = validateNext(state, event);
      if (!result.ok) {
        if (result.rejection.kind === "answer-shape-mismatch" && event.kind === "ask.answered") {
          // Log and advance state to `answered` — the reducer
          // already projects the answer, and refusing to start
          // over a historical answer is worse than accepting
          // it. Uses stderr since the store has no logger
          // handle at this call site; the daemon logs the count
          // once it has a logger.
          process.stderr.write(
            `SqliteThreadStore.open: accepting historical ask.answered on ask '${event.askId}' whose value fails the current answer-shape check ` +
              `(${result.rejection.field}: ${result.rejection.message}). See ADR-0007 amendment 2026-09-30 (asks replay policy).\n`,
          );
          const ask = state.asks.get(event.askId);
          if (ask !== undefined) ask.status = "answered";
          if (event.seq > head) head = event.seq;
          continue;
        }
        // Any other rejection is real corruption — refuse loudly.
        db.close();
        throw new Error(
          `SqliteThreadStore.open: existing events failed validation (${result.rejection.kind}: ${result.rejection.message}). Archive '${options.displayName ?? options.filename}' and start clean, or restore from backup.`,
        );
      }
      if (event.seq > head) head = event.seq;
    }
    return new SqliteThreadStore(db, options.clock ?? wallClock, state, head);
  }

  /** Close the underlying database. Idempotent. */
  close(): void {
    this.#db.close();
  }

  async append(input: ReviewEventInput): Promise<number> {
    // Take the next seq inside a `BEGIN IMMEDIATE` transaction so a
    // concurrent writer (a second `revkit serve`, a repair script)
    // that appended between two of our writes does not collide on
    // the PRIMARY KEY. We rehydrate any events we did not see, replay
    // them through the in-memory validator, and only then insert.
    //
    // If the log state has drifted such that the caller's event no
    // longer validates against the reconciled state (a duplicate
    // commentId came in from the other side), we surface the same
    // `ThreadStoreAppendError` the append path always raises and roll
    // the transaction back — the log is unchanged.
    const ts = this.#clock();
    const insertStmt = this.#db.prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)");
    const catchUpStmt = this.#db.query<{ payload: string }, [number]>(
      "SELECT payload FROM events WHERE seq > ? ORDER BY seq ASC",
    );
    const maxSeqStmt = this.#db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM events");

    // Bun's `db.transaction(fn)("immediate")` runs `fn` inside a
    // BEGIN IMMEDIATE. Errors thrown inside roll it back.
    const txn = this.#db.transaction((): { seq: number; event: ReviewEvent } => {
      // Catch up on any events another writer appended.
      const catchUp = catchUpStmt.all(this.#head);
      for (const row of catchUp) {
        const foreign = reviewEventSchema.parse(JSON.parse(row.payload));
        const result = validateNext(this.#logState, foreign);
        if (!result.ok) {
          throw new ThreadStoreAppendError({
            kind: "invalid-shape",
            message: `append: on-disk event seq=${foreign.seq} broke the local log state (${result.rejection.kind}: ${result.rejection.message}).`,
          });
        }
        if (foreign.seq > this.#head) this.#head = foreign.seq;
      }
      // Belt-and-braces: some external writer may have written to a
      // seq greater than we ever knew about (a corrupted repair)
      // — trust MAX(seq).
      const currentHead = maxSeqStmt.get()?.seq ?? 0;
      if (currentHead > this.#head) this.#head = currentHead;

      const seq = this.#head + 1;
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
      insertStmt.run(seq, ts, JSON.stringify(event));
      this.#head = seq;
      return { seq, event };
    });
    const { seq } = txn.immediate();
    return seq;
  }

  async import(archive: ThreadArchive): Promise<void> {
    // Same guarantees as `InMemoryThreadStore.import`: parse the archive
    // (Zod shape + `validateNext` from empty), refuse it as a whole if
    // its first seq is not strictly greater than the store's head, and
    // then re-play through `validateNext` against THIS store's state to
    // catch a boundary conflict (a duplicated commentId across the two
    // sides). Nothing lands unless the whole batch validates.
    const validated = parseArchive(archive);
    if (validated.events.length === 0) return;
    const firstSeq = validated.events[0]?.seq ?? 0;
    if (firstSeq <= this.#head) {
      throw new ThreadStoreImportError(
        `import: archive's first seq ${firstSeq} is not strictly greater than the store's head ${this.#head}.`,
      );
    }
    // Dry-run every event through a scratch copy of the state so the
    // real state stays untouched on a rejection.
    const scratch = cloneLogState(this.#logState);
    for (const event of validated.events) {
      const result = validateNext(scratch, event);
      if (!result.ok) throw new ThreadStoreAppendError(result.rejection);
    }
    // All events pass: commit them in one transaction and update the
    // real state alongside so a mid-batch crash leaves the store empty
    // of this import.
    const insert = this.#db.prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)");
    this.#db.transaction(() => {
      for (const event of validated.events) {
        insert.run(event.seq, event.ts, JSON.stringify(event));
      }
    })();
    for (const event of validated.events) {
      // Cannot fail — scratch already accepted this exact sequence.
      validateNext(this.#logState, event);
      this.#head = event.seq;
    }
  }

  async since(after: number): Promise<ReviewEvent[]> {
    const rows = this.#db
      .query<{ payload: string }, [number]>("SELECT payload FROM events WHERE seq > ? ORDER BY seq ASC")
      .all(after);
    return rows.map((row) => reviewEventSchema.parse(JSON.parse(row.payload)));
  }

  async threads(filter?: ThreadFilter): Promise<Thread[]> {
    // review-core owns the reduce → sort → filter sequence in
    // `selectThreads` so a new filter rule shows up on this store and
    // on `InMemoryThreadStore` at once, without a copy-paste.
    const events = await this.since(0);
    return selectThreads(events, filter);
  }

  async thread(id: string): Promise<Thread | undefined> {
    const events = await this.since(0);
    const derived = reduce(events);
    return derived.get(id);
  }

  async asks(filter?: AskFilter): Promise<AskRecord[]> {
    // Mirrors `threads()` — the review-core helper owns the
    // reduce → sort → filter sequence for both stores. Reading the
    // whole log is fine at M2 scale (an interactive session
    // rarely holds more than a handful of asks); a later index
    // would go on `ask.created` payload → seq if the log ever
    // grows big enough for it to matter.
    const events = await this.since(0);
    return selectAsks(events, filter);
  }

  async ask(id: string): Promise<AskRecord | undefined> {
    const events = await this.since(0);
    const derived = reduceAsks(events);
    return derived.get(id);
  }

  /** The current head seq. Used by `/events` to prime a new subscriber
   * with the seq the server has assigned so far, so it can spot a gap
   * on reconnect. */
  head(): number {
    return this.#head;
  }

  // ---------- Revision snapshots (M2 item 5b) ----------

  /** Insert (or leave unchanged) the LF-normalised source text for
   * `revision`. Content-addressed: a second call with the same
   * `revision` and equal `source` is a no-op (rows are keyed on
   * `revision`). `source` is stored verbatim — the caller is
   * responsible for LF normalisation before hashing and inserting;
   * `revisionOf(source)` in review-core is the one place LF
   * normalisation happens, so callers should route through the
   * pair. `bytes` is `Buffer.byteLength(source, "utf8")` (not
   * `source.length`), so JS surrogate pairs count correctly against
   * the 5 MiB cap. Returns true when a new row was inserted, false
   * when the revision was already present.
   *
   * **Cap.** The 5 MiB anchor-source cap in `resolveAnchorSource`
   * already refuses larger files before their revision is computed,
   * so a snapshot arriving here has passed that gate. This method
   * does NOT re-check the cap — it is called from the daemon's own
   * write path, never from user input. */
  putSnapshot(revision: string, source: string): boolean {
    // `INSERT OR IGNORE` on a PRIMARY KEY collision keeps content-
    // addressed dedup cheap. `changes` on the run result tells us
    // whether we inserted or ignored.
    const bytes = Buffer.byteLength(source, "utf8");
    const ts = this.#clock();
    const result = this.#db
      .prepare(
        "INSERT OR IGNORE INTO snapshots (revision, source, bytes, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(revision, source, bytes, ts);
    return result.changes > 0;
  }

  /** Read the snapshot for `revision`, or undefined if none is
   * stored. The re-anchoring pipeline calls this with the anchor's
   * revision to obtain the old source it was made against. */
  getSnapshot(revision: string): string | undefined {
    const row = this.#db
      .query<{ source: string }, [string]>(
        "SELECT source FROM snapshots WHERE revision = ? LIMIT 1",
      )
      .get(revision);
    return row?.source;
  }

  /** Total bytes stored in the snapshots table. Diagnostic only —
   * a log line before/after a GC pass names the delta. */
  snapshotBytes(): number {
    const row = this.#db
      .query<{ total: number | null }, []>("SELECT COALESCE(SUM(bytes), 0) AS total FROM snapshots")
      .get();
    return row?.total ?? 0;
  }

  /** All snapshot revisions currently held, sorted. Diagnostic — the
   * GC pass computes its delete set inside a transaction and does
   * not need this. */
  snapshotRevisions(): string[] {
    const rows = this.#db
      .query<{ revision: string }, []>("SELECT revision FROM snapshots ORDER BY revision ASC")
      .all();
    return rows.map((row) => row.revision);
  }

  /** Delete snapshots not in `retain` AND older than the grace
   * period `graceMs`. Returns the number of rows deleted so the
   * daemon can log a reclamation size.
   *
   * **The race** (PR #45 round-2 nit). `retain` is computed
   * application-side from the event log (threads are a JS reduction
   * of events, not a SQL view), so a concurrent `POST /api/threads`
   * that inserts a fresh snapshot AFTER `retain` was computed but
   * BEFORE this call runs would otherwise see its snapshot deleted:
   * the new revision is in the on-disk `snapshots` table but is not
   * in `retain`. The grace period closes the race: any snapshot
   * created within `graceMs` of NOW is retained regardless of the
   * `retain` set, so a fresh POST's snapshot always survives the
   * next GC round.
   *
   * The SELECT + DELETEs run inside ONE `BEGIN IMMEDIATE`
   * transaction so a `putSnapshot` racing this GC either lands
   * entirely before or entirely after the sweep — never mid-scan.
   * `retain` is treated as read-only. */
  gcSnapshots(retain: ReadonlySet<string>, graceMs: number = DEFAULT_SNAPSHOT_GC_GRACE_MS): number {
    // Compare against the STORE's own clock, not `Date.now()`, so a
    // test that pins the clock can drive the grace window
    // deterministically (PR #45 round-3 nit). The clock returns an
    // ISO-8601 string; `Date.parse` inverts it.
    const nowMs = Date.parse(this.#clock());
    const cutoffMs = nowMs - graceMs;
    // Turn the retain set into a stable, quoted SQL list. sqlite's
    // parameterised `IN (?, ?, …)` needs one placeholder per value,
    // which is awkward at scale; the retain set is small (one
    // revision per open+resolved+orphaned thread — a few hundred at
    // most on a realistic project), so building the list in JS and
    // filtering in-memory is fine. We STILL run the SELECT inside
    // the transaction so the row set is snapshot-consistent with the
    // DELETE.
    const selectStmt = this.#db.query<{ revision: string; created_at: string }, []>(
      "SELECT revision, created_at FROM snapshots",
    );
    const deleteStmt = this.#db.prepare("DELETE FROM snapshots WHERE revision = ?");
    let deleted = 0;
    const txn = this.#db.transaction((): void => {
      const rows = selectStmt.all();
      for (const row of rows) {
        if (retain.has(row.revision)) continue;
        const createdMs = Date.parse(row.created_at);
        if (Number.isFinite(createdMs) && createdMs > cutoffMs) continue;
        deleteStmt.run(row.revision);
        deleted += 1;
      }
    });
    // `bun:sqlite` transactions default to DEFERRED; call
    // `.immediate()` so we take the write lock at BEGIN and no
    // concurrent writer sneaks a fresh row in between our SELECT
    // and DELETEs.
    txn.immediate();
    return deleted;
  }
}

/** Default grace period for `gcSnapshots`. A snapshot created within
 * this window is retained regardless of the `retain` set. 30 s is
 * comfortably wider than the request-plus-refresh round-trip on any
 * realistic workload. Tests pass `0` to force an immediate sweep. */
export const DEFAULT_SNAPSHOT_GC_GRACE_MS = 30_000;
