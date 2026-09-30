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
  reviewEventSchema,
  selectThreads,
  validateNext,
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
 * property. */
const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
`;

/** Options for the store. `clock` is injected so tests can pin the
 * timestamp; `filename` is `:memory:` in tests, a real path in prod. */
export interface SqliteThreadStoreOptions {
  readonly filename: string;
  readonly clock?: Clock;
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
   * validator state from the existing events and cache the head. */
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
        // A file on disk that no longer parses is a data-corruption
        // event, not something to paper over — refusing loudly is the
        // only safe move. The daemon prints a stable message that names
        // the file so the user can archive it and start clean.
        db.close();
        throw new Error(
          `SqliteThreadStore.open: existing events failed validation (${result.rejection.kind}: ${result.rejection.message}). Archive '${options.filename}' and start clean, or restore from backup.`,
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

  /** The current head seq. Used by `/events` to prime a new subscriber
   * with the seq the server has assigned so far, so it can spot a gap
   * on reconnect. */
  head(): number {
    return this.#head;
  }
}
