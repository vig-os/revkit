// D1-specific store tests: the cases a `ThreadStore` conformance suite
// cannot hold, because they are properties of D1's CONCURRENCY MODEL
// rather than of the interface.
//
//   A10 — 20 concurrent appends produce 20 distinct seqs and 20 rows.
//   A11 — a `batch()` whose second statement violates a constraint writes
//         nothing.
//   A13 — the local <-> hosted bridge, both directions.
//
// A10 exists because the naive implementation is not merely slower, it is
// WRONG, and "wrong" here means silently losing a review comment. The
// spike measured six concurrent naive read-then-write appends on
// miniflare 4.20260518.0 producing THREE distinct seqs, a
// `UNIQUE constraint failed: events.seq` and two rows persisted. The
// first test in this file REPRODUCES that failure on purpose, so A10
// cannot go quietly green against an implementation that has regressed to
// it: the mutation guard and the property are asserted in the same file,
// against the same database.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  InMemoryThreadStore,
  exportArchive,
  isUnanchoredAnchor,
  revisionOf,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadArchive,
} from "@revkit/review-core";
import { D1ThreadStore } from "../src/d1-store.ts";
import { fixedClock } from "../../review-core/test/store-conformance.ts";
import { startWorker, type Harness } from "./harness.ts";

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "b".repeat(64),
} as const;

function createThread(threadId: string, commentId: string): ReviewEventInput {
  return {
    actor: { kind: "gh-user", id: "gerchowl" },
    kind: "comment.created",
    threadId,
    commentId,
    anchor,
    body: `body for ${commentId}`,
  };
}

describe("D1ThreadStore — D1 concurrency model", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.db.prepare("DELETE FROM events").run();
  });

  // ── the mutation guard for A10 ────────────────────────────────────────
  test("MUTATION GUARD: the naive read-then-write A10 forbids really does collide", async () => {
    // Exactly what `D1ThreadStore.append` must NOT do: read the head
    // outside the batch, then insert inside one. The spike's scenario C
    // measured this as STILL colliding — `batch()` cannot help a read
    // that happened before it — so this is the shape A10 exists to rule
    // out, executed here so the rule is not a comment.
    async function naiveAppend(db: D1Database, index: number): Promise<number | null> {
      const head = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events").first<{ head: number }>();
      const seq = (head?.head ?? 0) + 1;
      const event: ReviewEvent = {
        seq,
        ts: "2026-10-03T12:00:00Z",
        actor: { kind: "gh-user", id: "gerchowl" },
        kind: "comment.created",
        threadId: `th-naive-${index}`,
        commentId: `c-naive-${index}`,
        anchor,
        body: `naive ${index}`,
      };
      try {
        await db
          .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
          .bind(seq, event.ts, JSON.stringify(event))
          .run();
        return seq;
      } catch {
        return null;
      }
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => naiveAppend(harness.db, index)),
    );
    const distinct = new Set(results.filter((seq): seq is number => seq !== null));
    expect(distinct.size).toBeLessThan(6);
    // This is the assertion that makes A10 meaningful: the naive shape
    // loses writes, so a passing A10 above is a real result.
    expect(results.filter((seq) => seq === null).length).toBeGreaterThan(0);
  });

  // ── A10 ───────────────────────────────────────────────────────────────
  //
  // READ THIS BEFORE TRUSTING THE CASE BELOW. The 20 `append` calls are
  // issued concurrently, but `D1ThreadStore.append` enters `#serialise`, so
  // they execute STRICTLY ONE AT A TIME (measured: 0 CAS failures, so
  // max-one-batch-in-flight). A naive read-then-write allocator would pass
  // this test unchanged, which means it is NOT evidence that the CAS works.
  //
  // What it IS evidence of: seq assignment is strictly increasing and
  // gap-free for a queued writer, and every assigned seq reaches the table
  // with a payload that agrees with its column. The genuine concurrency
  // evidence is the two cases below it — the hand-rolled naive collision,
  // and the two-independent-stores case with its CAS-failure count.
  test("A10 (queued): 20 appends issued concurrently execute serially, and give 20 distinct seqs and 20 rows", async () => {
    const store = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        store.append(createThread(`th-conc-${index}`, `c-conc-${index}`)),
      ),
    );
    expect(new Set(results).size).toBe(20);
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_u, i) => i + 1));

    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(20);
    // Every persisted row parses and carries the seq its column claims:
    // the payload blob and the query key cannot disagree.
    const rows = await harness.db.prepare("SELECT seq, payload FROM events ORDER BY seq ASC").all<{
      seq: number;
      payload: string;
    }>();
    expect(rows.results).toHaveLength(20);
    for (const row of rows.results ?? []) {
      expect(JSON.parse(row.payload).seq).toBe(row.seq);
    }
  });

  test("A10 (contended): two INDEPENDENT store instances interleave, and the CAS is what makes it safe", async () => {
    // This is the case that actually exercises the compare-and-swap.
    // Separate `D1ThreadStore` objects each carry their own `#logState` AND
    // their own `#queue`, so `#serialise` does NOT order them against each
    // other — which is production: two Worker isolates, or one isolate
    // before and after a redeploy.
    //
    // The count is the assertion. `casFailures` is incremented whenever a
    // batch's guarded INSERT wrote zero rows, i.e. whenever the head moved
    // between an attempt's read and its insert and the retry path ran. A
    // positive count proves the CAS was hit and recovered from; zero would
    // mean this test had degenerated into the queued case above.
    const { db: raced, casFailures, batches } = countingDb(harness.db);
    const a = new D1ThreadStore({ db: raced, clock: fixedClock(0) });
    const b = new D1ThreadStore({ db: raced, clock: fixedClock(30) });
    const seqs = await Promise.all([
      ...Array.from({ length: 8 }, (_u, i) => a.append(createThread(`th-a-${i}`, `c-a-${i}`))),
      ...Array.from({ length: 8 }, (_u, i) => b.append(createThread(`th-b-${i}`, `c-b-${i}`))),
    ]);
    expect(new Set(seqs).size).toBe(16);
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 16 }, (_u, i) => i + 1));
    // The CAS was genuinely contended: at least one insert was refused and
    // retried. Without this the test would pass just as happily against an
    // allocator with no guard at all.
    expect(casFailures()).toBeGreaterThan(0);
    expect(batches()).toBeGreaterThan(16);
    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(16);
    // Both instances see the whole log, so a caller that reads through
    // either store gets all sixteen threads.
    expect(await a.threads()).toHaveLength(16);
    expect(await b.threads()).toHaveLength(16);
  });

  test("A10: the compare-and-swap retry path runs and lands the next seq, not the contested one", async () => {
    // Force the race the CAS exists for: a competing writer commits
    // BETWEEN this store's validation and its insert. The proxy below is
    // the only way to open that window from a test, and it is also the
    // honest description of the hazard — a head read taken outside the
    // batch can always be stale by the time the batch runs.
    const competitor = createThread("th-competitor", "c-competitor");
    const competitorEvent: ReviewEvent = {
      seq: 1,
      ts: "2026-10-03T12:00:00Z",
      ...competitor,
    } as ReviewEvent;

    let raced = false;
    const racingDb = proxyDb(harness.db, async () => {
      if (raced) return;
      raced = true;
      await harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(1, competitorEvent.ts, JSON.stringify(competitorEvent))
        .run();
    });

    const store = new D1ThreadStore({ db: racingDb, clock: fixedClock() });
    const seq = await store.append(createThread("th-mine", "c-mine"));
    expect(raced).toBe(true);
    // The competitor kept seq 1; our event lands at 2. The store read the
    // competitor's row in the same batch that refused our insert, so it
    // validated against the state the competitor actually left behind.
    expect(seq).toBe(2);
    const rows = await harness.db.prepare("SELECT seq FROM events ORDER BY seq ASC").all<{ seq: number }>();
    expect(rows.results?.map((r) => r.seq)).toEqual([1, 2]);
    // Both threads are visible, so the catch-up really did replay.
    expect((await store.threads()).map((t) => t.id)).toEqual(["th-competitor", "th-mine"]);
  });

  // ── A11 ───────────────────────────────────────────────────────────────
  test("A11: a batch whose second statement violates the PK writes NOTHING", async () => {
    await harness.db
      .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
      .bind(900, "2026-10-03T12:00:00Z", JSON.stringify({ seq: 900, ts: "2026-10-03T12:00:00Z" }))
      .run();

    const attempted = harness.db.batch([
      harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(901, "2026-10-03T12:00:01Z", "{}"),
      // Collides with the row above, so the WHOLE batch must roll back.
      harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(900, "2026-10-03T12:00:02Z", "{}"),
    ]);
    await expect(attempted).rejects.toThrow();

    const present = await harness.db.prepare("SELECT seq FROM events WHERE seq = 901").first<{ seq: number }>();
    expect(present).toBeNull();
    // And the pre-existing row is untouched.
    const kept = await harness.db.prepare("SELECT seq FROM events WHERE seq = 900").first<{ seq: number }>();
    expect(kept?.seq).toBe(900);
  });

  test("A11(b): two stores importing the SAME archive — the loser writes nothing", async () => {
    // The scenario the bridge actually has: `revkit threads publish` runs
    // twice, or two Worker isolates both pull the same local log. The
    // second import's head-monotone rule passes (its own head is 0) and
    // its batch then collides on the PK, which must roll the WHOLE batch
    // back rather than half-apply it.
    const publisher = new D1ThreadStore({ db: harness.db, clock: fixedClock(0) });
    await publisher.append(createThread("th-pub-1", "c-pub-1"));
    await publisher.append(createThread("th-pub-2", "c-pub-2"));
    const archive = await exportArchive(publisher);

    const second = new D1ThreadStore({ db: harness.db, clock: fixedClock(30) });
    await expect(second.import(archive)).rejects.toThrow();

    const rows = await harness.db
      .prepare("SELECT seq, payload FROM events ORDER BY seq ASC")
      .all<{ seq: number; payload: string }>();
    expect(rows.results?.map((r) => r.seq)).toEqual([1, 2]);
    // The winner's payloads are intact — the loser's batch overwrote none
    // of them, which a per-statement commit would have done.
    expect(JSON.parse((rows.results?.[0]?.payload ?? "{}").toString()).threadId).toBe("th-pub-1");
  });

  // ── head() on a NON-EMPTY log (the #76 review's I1) ──────────────────
  test("head() reads MAX(seq) from D1, so it is right on a log this instance never appended to", async () => {
    // The bug: `#head` started at 0 and only `append`/`import` moved it,
    // while `src/index.ts` builds a fresh store per request — so a
    // non-empty log reported `head: 0`. The test that missed it asserted
    // only the EMPTY case, which is the one that was correct.
    //
    // Gapped on purpose (1, 2, 3, 7): the bridge imports archives that do
    // not start at 1, and a `MAX`-based head has to be indifferent to the
    // gap. `SqliteThreadStore` re-reads `max(seq)` at construction, so this
    // also stops the two implementations of the same method name from
    // disagreeing.
    for (const seq of [1, 2, 3, 7]) {
      await harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(
          seq,
          `2026-10-03T12:00:0${seq}Z`,
          JSON.stringify({
            seq,
            ts: `2026-10-03T12:00:0${seq}Z`,
            actor: { kind: "gh-user", id: "gerchowl" },
            kind: "comment.created",
            threadId: `th-head-${seq}`,
            commentId: `c-head-${seq}`,
            anchor: {
              path: "docs/a.mdx",
              startLine: 1,
              endLine: 1,
              quote: { exact: "x", prefix: "", suffix: "" },
              revision: "b".repeat(64),
            },
            body: "head probe",
          }),
        )
        .run();
    }

    const fresh = new D1ThreadStore({ db: harness.db });
    // The instance's own watermark is honestly still 0 — it has validated
    // nothing — and `head()` must not be that number.
    expect(fresh.validatedHead()).toBe(0);
    expect(await fresh.head()).toBe(7);

    // A store that HAS appended agrees with the table.
    const appended = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    const seq = await appended.append(createThread("th-head-new", "c-head-new"));
    expect(seq).toBe(8);
    expect(await appended.head()).toBe(8);
    expect(appended.validatedHead()).toBe(8);

    // And on an empty table it is still 0, so the empty case did not regress.
    await harness.db.prepare("DELETE FROM events").run();
    expect(await new D1ThreadStore({ db: harness.db }).head()).toBe(0);
  });

  // ── A13 ───────────────────────────────────────────────────────────────
  test("A13: export a D1 log and import it into a fresh in-memory store", async () => {
    const d1 = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    await d1.append(createThread("th-bridge-1", "c-bridge-1"));
    await d1.append(createThread("th-bridge-2", "c-bridge-2"));

    const local = new InMemoryThreadStore({ clock: fixedClock() });
    await local.import(await exportArchive(d1));

    expect(await local.threads()).toEqual(await d1.threads());
    expect((await local.since(0)).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("A13: export a local log and import it into a fresh D1 store", async () => {
    const local = new InMemoryThreadStore({ clock: fixedClock() });
    await local.append(createThread("th-up-1", "c-up-1"));
    await local.append(createThread("th-up-2", "c-up-2"));
    const d1 = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    await d1.import(await exportArchive(local));
    expect(await d1.threads()).toEqual(await local.threads());
    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(2);
  });

  test("A13: a round trip preserves each anchor's revision, which is what re-anchoring trusts", async () => {
    // Cross-runtime determinism of the revision hash is A2's job in
    // `worker-runtime.test.ts`; this is the bridge half — the value that
    // crosses the wire is the value both ends compute.
    const revision = await revisionOf("line one\nline two\n");
    const local = new InMemoryThreadStore({ clock: fixedClock() });
    await local.append({
      actor: { kind: "gh-user", id: "gerchowl" },
      kind: "comment.created",
      threadId: "th-rev",
      commentId: "c-rev",
      anchor: { ...anchor, revision },
      body: "anchored",
    });
    const d1 = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    await d1.import(await exportArchive(local));
    const threads = await d1.threads();
    const thread = threads[0];
    if (thread === undefined) throw new Error("expected one thread after the round trip");
    // `Thread.anchor` is a union and the `unanchored` kind has no
    // `revision` at all, so narrow with review-core's own predicate rather
    // than casting.
    expect(isUnanchoredAnchor(thread.anchor)).toBe(false);
    if (isUnanchoredAnchor(thread.anchor)) throw new Error("expected a line anchor");
    expect(thread.anchor.revision).toBe(revision);
  });

  test("A13: an import whose FIRST event is fine and whose SECOND is not leaves no rows", async () => {
    const store = new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    const before = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    // Reply to a parent that does not exist — individually Zod-valid,
    // rejected only on the second event.
    const broken = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      events: [
        {
          seq: 1,
          ts: "2026-10-03T12:00:01Z",
          actor: { kind: "gh-user", id: "gerchowl" },
          kind: "comment.created",
          threadId: "th-half",
          commentId: "c-half",
          anchor,
          body: "first",
        },
        {
          seq: 2,
          ts: "2026-10-03T12:00:02Z",
          actor: { kind: "agent", id: "revkit-live" },
          kind: "comment.replied",
          threadId: "th-half",
          commentId: "c-half-reply",
          parentId: "c-absent",
          body: "reply to nothing",
        },
      ],
    };
    // The raw object, not `parseArchive`'s output: the archive parser
    // rejects this one itself (it plays the sequence through
    // `validateNext` from empty), and the store calls the parser too —
    // so the refusal happens INSIDE `import`, which is the behaviour
    // under test.
    await expect(store.import(broken as ThreadArchive)).rejects.toThrow();
    const after = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(after?.n).toBe(before?.n ?? 0);
  });
});

/** A `D1Database` proxy that COUNTS compare-and-swap failures.
 *
 * `D1ThreadStore`'s append batch is three statements, and the third is the
 * guarded `INSERT ... WHERE MAX(seq) = <expected>`. So "the guarded insert
 * wrote zero rows" is observable from the batch's own results: `meta.changes`
 * of 0 on the LAST statement, while the batch as a whole succeeded. That is
 * the CAS failing and the store about to retry, and counting it is what turns
 * "the appends were issued concurrently" into "the CAS was exercised".
 *
 * Deliberately reads the SHAPE rather than reaching into the store: a test
 * that had to import a counter the production code maintains for its own
 * sake would be measuring the instrumentation as much as the behaviour. */
function countingDb(db: D1Database): { db: D1Database; casFailures: () => number; batches: () => number } {
  let failures = 0;
  let count = 0;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: unknown) => {
          const results = (await (target.batch as (input: unknown) => Promise<D1Result[]>)(statements)) ?? [];
          count += 1;
          const last = results[results.length - 1];
          const statements_ = statements as { length: number } | undefined;
          // Only the append batch ends in a guarded INSERT, and it always
          // has three statements; an import batch has one per event.
          if (statements_?.length === 3 && (last?.meta?.changes ?? 0) === 0) {
            failures += 1;
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as D1Database, casFailures: () => failures, batches: () => count };
}

/** A `D1Database` whose `batch` runs `onBatch` FIRST, then delegates.
 * Used only to open the read-then-insert window deterministically. */
function proxyDb(db: D1Database, onBatch: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: unknown) => {
          await onBatch();
          return (target.batch as (input: unknown) => unknown)(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
