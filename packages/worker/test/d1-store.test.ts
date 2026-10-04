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
  ThreadStoreAppendError,
  exportArchive,
  isUnanchoredAnchor,
  revisionOf,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadArchive,
} from "@revkit/review-core";
import { APPEND_CAS_ATTEMPTS, D1ThreadStore, ThreadStoreContendedError } from "../src/d1-store.ts";
import { previewScopePath } from "../src/router.ts";
import { fixedClock } from "../../review-core/test/store-conformance.ts";
import { seedLogEvents, startWorker, type Harness } from "./harness.ts";

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "b".repeat(64),
} as const;

/**
 * Two reviews' log keys, built by the SAME function `Route.scope.logKey` comes
 * from — so these tests exercise the real key rather than a hand-written string
 * that happens to agree with it. Slice 5 made `logKey` REQUIRED on every store,
 * so every `new D1ThreadStore` below names one.
 */
const LOG = previewScopePath("revkit", 7);
const OTHER_LOG = previewScopePath("revkit", 8);
const THIRD_LOG = previewScopePath("other-repo", 7);

/** `ReviewEvent` is a union whose arms do not share one identifier — the rows
 * seeded here are identified by their `commentId` because it is the field every
 * arm has, and it is narrow rather than cast. */
function commentIdOf(event: ReviewEvent): string {
  if (!("commentId" in event)) throw new Error(`no commentId on ${event.kind}`);
  return event.commentId;
}

/** A minimal stored event payload for a hand-written row. */
function seedPayload(threadId: string, seq: number): string {
  const ts = `2026-10-03T12:00:0${seq}Z`;
  return JSON.stringify({
    seq,
    ts,
    actor: { kind: "gh-user", id: "gerchowl" },
    kind: "comment.created",
    threadId,
    commentId: `c-${threadId}`,
    anchor: { path: "docs/a.mdx", startLine: 1, endLine: 1, quote: { exact: "x", prefix: "", suffix: "" }, revision: "b".repeat(64) },
    body: `seeded ${threadId}`,
  });
}

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
    await harness.db.prepare("DELETE FROM review_logs").run();
  });

  // ── the mutation guard for A10 ────────────────────────────────────────
  test("MUTATION GUARD: the naive read-then-write A10 forbids really does collide", async () => {
    // Exactly what `D1ThreadStore.append` must NOT do: read the head
    // outside the batch, then insert inside one. The spike's scenario C
    // measured this as STILL colliding — `batch()` cannot help a read
    // that happened before it — so this is the shape A10 exists to rule
    // out, executed here so the rule is not a comment.
    async function naiveAppend(db: D1Database, index: number): Promise<number | null> {
      const head = await db.prepare(HEAD_FOR).bind(LOG).first<{ head: number }>();
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
          .prepare(INSERT_FOR)
          .bind(LOG, seq, event.ts, JSON.stringify(event))
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
    const store = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        store.append(createThread(`th-conc-${index}`, `c-conc-${index}`)),
      ),
    );
    expect(new Set(results).size).toBe(20);
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_u, i) => i + 1));

    expect(await countIn(harness.db, LOG)).toBe(20);
    // Every persisted row parses and carries the seq its column claims:
    // the payload blob and the query key cannot disagree.
    const rows = await rowsIn(harness.db, LOG);
    expect(rows).toHaveLength(20);
    for (const row of rows) {
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
    const a = new D1ThreadStore({ db: raced, logKey: LOG, clock: fixedClock(0) });
    const b = new D1ThreadStore({ db: raced, logKey: LOG, clock: fixedClock(30) });
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
    expect(await countIn(harness.db, LOG)).toBe(16);
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
        .prepare(INSERT_FOR)
        .bind(LOG, 1, competitorEvent.ts, JSON.stringify(competitorEvent))
        .run();
    });

    const store = new D1ThreadStore({ db: racingDb, logKey: LOG, clock: fixedClock() });
    const seq = await store.append(createThread("th-mine", "c-mine"));
    expect(raced).toBe(true);
    // The competitor kept seq 1; our event lands at 2. The store read the
    // competitor's row in the same batch that refused our insert, so it
    // validated against the state the competitor actually left behind.
    expect(seq).toBe(2);
    expect(await seqsIn(harness.db, LOG)).toEqual([1, 2]);
    // Both threads are visible, so the catch-up really did replay.
    expect((await store.threads()).map((t) => t.id)).toEqual(["th-competitor", "th-mine"]);
  });

  // ── slice 5: the partition ────────────────────────────────────────────
  //
  // The cases above all write one log. These write two or three and assert that
  // they cannot see each other — because the defect slice 5 removes was not a
  // missing check but an ABSENT AXIS: `events(seq, ts, payload)` held one log
  // for a whole org, so a scope check had nothing to select on and every
  // authorized caller read everything.

  test("two (repo, pr) pairs do not see each other's events", async () => {
    const a = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    const b = new D1ThreadStore({ db: harness.db, logKey: OTHER_LOG, clock: fixedClock() });
    const c = new D1ThreadStore({ db: harness.db, logKey: THIRD_LOG, clock: fixedClock() });
    await a.append(createThread("th-in-a", "c-in-a"));
    await a.append(createThread("th-in-a-2", "c-in-a-2"));
    await b.append(createThread("th-in-b", "c-in-b"));
    await c.append(createThread("th-in-c", "c-in-c"));

    // Each store sees its own events and NOTHING else — not another PR of the
    // same repo, and not another repo.
    expect((await a.threads()).map((t) => t.id)).toEqual(["th-in-a", "th-in-a-2"]);
    expect((await b.threads()).map((t) => t.id)).toEqual(["th-in-b"]);
    expect((await c.threads()).map((t) => t.id)).toEqual(["th-in-c"]);
    // The reads do not merely filter the answer: the ROWS are separate, so a
    // `head` computed over the whole table would be a shared counter.
    expect(await countIn(harness.db, LOG)).toBe(2);
    expect(await countIn(harness.db, OTHER_LOG)).toBe(1);
    expect(await countIn(harness.db, THIRD_LOG)).toBe(1);
    // And a `thread()` lookup cannot cross the key either.
    expect(await a.thread("th-in-b")).toBeUndefined();
    expect(await b.thread("th-in-a")).toBeUndefined();
    expect(await b.thread("th-in-b")).toBeDefined();
  });

  test("`seq` is per log, so each store starts at 1", async () => {
    // What `ThreadStore` has always meant by a fresh store's head — and what
    // the shared conformance suite's A5 asserts for a store with no context at
    // all. Three logs, one event each, all at `seq = 1`: with a global counter
    // the second would be 2, and `since(0)` would return somebody else's
    // event.
    const a = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    const b = new D1ThreadStore({ db: harness.db, logKey: OTHER_LOG, clock: fixedClock() });
    expect(await a.append(createThread("th-seq-a", "c-seq-a"))).toBe(1);
    expect(await b.append(createThread("th-seq-b", "c-seq-b"))).toBe(1);
    expect(await a.head()).toBe(1);
    expect(await b.head()).toBe(1);
    expect(await seqsIn(harness.db, LOG)).toEqual([1]);
    expect(await seqsIn(harness.db, OTHER_LOG)).toEqual([1]);
  });

  test("since() does not leak across keys — a resume point is per review", async () => {
    // The bug this closes is subtle and worth stating: with a flat table, a
    // client holding `head = 3` from review A and polling review B's `?since=3`
    // would silently skip B's events 1–3. `since` is a LOG-LOCAL cursor.
    await harness.db
      .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
      .bind(LOG, 1, "2026-10-03T12:00:01Z", seedPayload("th-since-a-1", 1))
      .run();
    await harness.db
      .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
      .bind(LOG, 2, "2026-10-03T12:00:02Z", seedPayload("th-since-a-2", 2))
      .run();
    for (const seq of [1, 2, 3, 4]) {
      await harness.db
        .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
        .bind(OTHER_LOG, seq, `2026-10-03T12:00:0${seq}Z`, seedPayload(`th-since-b-${seq}`, seq))
        .run();
    }
    const a = new D1ThreadStore({ db: harness.db, logKey: LOG });
    const b = new D1ThreadStore({ db: harness.db, logKey: OTHER_LOG });
    expect((await a.since(0)).map((e) => commentIdOf(e))).toEqual(["c-th-since-a-1", "c-th-since-a-2"]);
    expect((await b.since(0)).map((e) => commentIdOf(e))).toEqual([
      "c-th-since-b-1",
      "c-th-since-b-2",
      "c-th-since-b-3",
      "c-th-since-b-4",
    ]);
    // A cursor from one review is meaningless in the other, and the direction
    // that matters is the one that loses data: `since(3)` on the short log
    // returns NOTHING rather than the other log's tail.
    expect(await a.since(3)).toEqual([]);
    expect((await b.since(3)).map((e) => commentIdOf(e))).toEqual(["c-th-since-b-4"]);
    // And the heads differ, which is what makes those cursors different.
    expect(await a.head()).toBe(2);
    expect(await b.head()).toBe(4);
  });

  test("two logs appended CONCURRENTLY do not contend — the CAS is per log", async () => {
    // Before the partition this could not be written: one global `seq` and one
    // global CAS meant two reviews writing at the same moment computed the same
    // next `seq`, and the loser retried having absorbed the winner's events
    // through `validateNext`. Now each takes `seq = 1` of its own log.
    const { db: raced, casFailures } = countingDb(harness.db);
    const a = new D1ThreadStore({ db: raced, logKey: LOG, clock: fixedClock(0) });
    const b = new D1ThreadStore({ db: raced, logKey: OTHER_LOG, clock: fixedClock(30) });
    const seqs = await Promise.all([
      ...Array.from({ length: 6 }, (_u, i) => a.append(createThread(`th-par-a-${i}`, `c-par-a-${i}`))),
      ...Array.from({ length: 6 }, (_u, i) => b.append(createThread(`th-par-b-${i}`, `c-par-b-${i}`))),
    ]);
    // Six each, and both sets are 1..6 — `Promise.all` preserves input order and
    // the first six calls are store A's.
    const six = [1, 2, 3, 4, 5, 6];
    expect(seqs.slice(0, 6).sort((x, y) => x - y)).toEqual(six);
    expect(seqs.slice(6).sort((x, y) => x - y)).toEqual(six);
    expect(await countIn(harness.db, LOG)).toBe(6);
    expect(await countIn(harness.db, OTHER_LOG)).toBe(6);
    // The claim is about CONTENTION, so it is asserted: zero CAS failures means
    // neither writer ever saw the other's head. (Not a fluke — the assertion
    // would fail on an implementation with a global head, which is what this
    // replaced.)
    expect(casFailures()).toBe(0);
    // And each store's own log is whole. (`Thread.id`, which is what the
    // assertions above used — `ReviewEvent` is a union and most arms have no
    // `threadId`.)
    expect((await a.threads()).map((t) => t.id)).toEqual(Array.from({ length: 6 }, (_u, i) => `th-par-a-${i}`));
    expect((await b.threads()).map((t) => t.id)).toEqual(Array.from({ length: 6 }, (_u, i) => `th-par-b-${i}`));
  });

  test("an import lands in THIS store's log and no other", async () => {
    const source = new InMemoryThreadStore({ clock: fixedClock() });
    await source.append(createThread("th-imp-1", "c-imp-1"));
    await source.append(createThread("th-imp-2", "c-imp-2"));
    const target = new D1ThreadStore({ db: harness.db, logKey: OTHER_LOG, clock: fixedClock() });
    await target.import(await exportArchive(source));
    expect(await countIn(harness.db, OTHER_LOG)).toBe(2);
    expect(await countIn(harness.db, LOG)).toBe(0);
    // Reading the OTHER log is empty, not the imported one.
    expect(await new D1ThreadStore({ db: harness.db, logKey: LOG }).threads()).toEqual([]);
    expect((await target.threads()).map((t) => t.id)).toEqual(["th-imp-1", "th-imp-2"]);
  });

  test("a log key is not forgeable from a hand-written row, because log_key is NOT NULL", async () => {
    // The schema half of "the key comes from the authenticated path": a row
    // with no key cannot be written at all, so there is no unscoped event for a
    // query to find even if a statement forgot its predicate.
    await expect(
      harness.db
        .prepare("INSERT INTO review_logs (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(1, "2026-10-03T12:00:00Z", "{}")
        .run(),
    ).rejects.toThrow(/NOT NULL/i);
    // And a row whose payload claims a different review than its key is not
    // possible to create by accident either: the key is a column, not something
    // read out of the payload.
    const row = await rowsIn(harness.db, LOG);
    for (const one of row) {
      const parsed = JSON.parse(one.payload) as { threadId: string };
      expect(parsed.threadId).toContain(String(one.seq));
    }
  });

  // ── A11 ───────────────────────────────────────────────────────────────
  test("A11: a batch whose second statement violates the PK writes NOTHING", async () => {
    await harness.db
      .prepare(INSERT_FOR)
      .bind(LOG, 900, "2026-10-03T12:00:00Z", JSON.stringify({ seq: 900, ts: "2026-10-03T12:00:00Z" }))
      .run();

    const attempted = harness.db.batch([
      harness.db.prepare(INSERT_FOR).bind(LOG, 901, "2026-10-03T12:00:01Z", "{}"),
      // Collides with the row above — same log, same seq — so the WHOLE batch
      // must roll back. `log_key` is part of the key, so the collision is a
      // PRIMARY KEY violation and not a second row.
      harness.db.prepare(INSERT_FOR).bind(LOG, 900, "2026-10-03T12:00:02Z", "{}"),
    ]);
    await expect(attempted).rejects.toThrow();

    expect(await seqsIn(harness.db, LOG)).not.toContain(901);
    // And the pre-existing row is untouched.
    expect(await seqsIn(harness.db, LOG)).toContain(900);
  });

  test("A11(b): two stores importing the SAME archive — the loser writes nothing", async () => {
    // The scenario the bridge actually has: `revkit threads publish` runs
    // twice, or two Worker isolates both pull the same local log. The
    // second import's head-monotone rule passes (its own head is 0) and
    // its batch then collides on the PK, which must roll the WHOLE batch
    // back rather than half-apply it.
    const publisher = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock(0) });
    await publisher.append(createThread("th-pub-1", "c-pub-1"));
    await publisher.append(createThread("th-pub-2", "c-pub-2"));
    const archive = await exportArchive(publisher);

    const second = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock(30) });
    await expect(second.import(archive)).rejects.toThrow();

    const rows = await rowsIn(harness.db, LOG);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    // The winner's payloads are intact — the loser's batch overwrote none
    // of them, which a per-statement commit would have done.
    expect(JSON.parse(rows[0]?.payload ?? "{}").threadId).toBe("th-pub-1");
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
    await seedLogEvents(harness.db, LOG, 3, { prefix: "th-head", from: 1 });
    await seedLogEvents(harness.db, LOG, 1, { prefix: "th-head", from: 7 });

    const fresh = new D1ThreadStore({ db: harness.db, logKey: LOG });
    // The instance's own watermark is honestly still 0 — it has validated
    // nothing — and `head()` must not be that number.
    expect(fresh.validatedHead()).toBe(0);
    expect(await fresh.head()).toBe(7);

    // A store that HAS appended agrees with the table.
    const appended = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    const seq = await appended.append(createThread("th-head-new", "c-head-new"));
    expect(seq).toBe(8);
    expect(await appended.head()).toBe(8);
    expect(appended.validatedHead()).toBe(8);

    // And on an empty table it is still 0, so the empty case did not regress.
    await harness.db.prepare("DELETE FROM review_logs").run();
    expect(await new D1ThreadStore({ db: harness.db, logKey: LOG }).head()).toBe(0);
  });

  // ── I5: the store's one bounded-failure path ─────────────────────────
  test("I5: a permanently contended head raises ThreadStoreContendedError, not a ThreadStoreAppendError", async () => {
    // `ThreadStoreContendedError` is the store's ONLY bounded-failure path
    // and it had no test: the class, its `retryable` contract (the field a
    // future handler branches on to answer 503 rather than 400) and the
    // bound itself were all unverified, and the only other reference to it
    // in the repo was a bundle substring check.
    //
    // The harness is a D1 proxy whose `batch` ALWAYS reports a moving head
    // with a zero-change insert, which is exactly the condition the CAS
    // retries on. With it, the store must give up — bounded, loud, and with
    // no livelock.
    const always = new D1ThreadStore({ db: foreverContended(harness.db), logKey: LOG, clock: fixedClock() });
    let thrown: unknown;
    try {
      await always.append(createThread("th-contended", "c-contended"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ThreadStoreContendedError);
    // Deliberately NOT a ThreadStoreAppendError: every kind in
    // `AppendRejection` is a statement about LOG SHAPE, so a caller
    // branching on that rejection type would answer 400 — telling a
    // reviewer their comment is malformed when it is fine.
    expect(thrown).not.toBeInstanceOf(ThreadStoreAppendError);
    const error = thrown as ThreadStoreContendedError;
    expect(error.retryable).toBe(true);
    expect(error.attempts).toBe(APPEND_CAS_ATTEMPTS);
    expect(error.name).toBe("ThreadStoreContendedError");
    expect(error.message).toContain(String(APPEND_CAS_ATTEMPTS));
  });

  test("I5: the contention bound is exactly APPEND_CAS_ATTEMPTS batches, then it stops", async () => {
    // Pins the 64 as a BOUND rather than a hope: 16 concurrent appends
    // across two stores needed 9 attempts (the measurement that chose it),
    // and a permanently contended store must issue exactly that many and
    // then throw — not retry forever, and not stop early.
    const counter = contendedBatchCounter(harness.db);
    const always = new D1ThreadStore({ db: counter.db, logKey: LOG, clock: fixedClock() });
    await expect(always.append(createThread("th-bounded", "c-bounded"))).rejects.toThrow(
      ThreadStoreContendedError,
    );
    expect(counter.batches()).toBe(APPEND_CAS_ATTEMPTS);
    // Every one of those batches was a FAILED attempt, so the bound counts
    // retries rather than being padded by a successful first try.
    expect(counter.failedInserts()).toBe(APPEND_CAS_ATTEMPTS);
  });

  test("I5: no row is written when the head never settles", async () => {
    const before = await countIn(harness.db, LOG);
    const always = new D1ThreadStore({ db: foreverContended(harness.db), logKey: LOG, clock: fixedClock() });
    await expect(always.append(createThread("th-nowrite", "c-nowrite"))).rejects.toThrow();
    expect(await countIn(harness.db, LOG)).toBe(before);
  });

  test("I5: a TRANSIENTLY contended store still succeeds — the error is not the normal path", async () => {
    // The other half of the contract: refuse only when contention PERSISTS.
    // The proxy refuses the first two guarded inserts and then delegates to
    // the real database, so the third attempt must land — with a real seq
    // and a persisted row, not a swallowed error.
    await harness.db.prepare("DELETE FROM review_logs").run();
    const proxy = flakyDb(harness.db, 2);
    const flaky = new D1ThreadStore({ db: proxy, logKey: LOG, clock: fixedClock() });
    const seq = await flaky.append(createThread("th-flaky", "c-flaky"));
    expect(seq).toBe(1);
    expect(await seqsIn(harness.db, LOG)).toEqual([1]);
    // Two refused attempts, then success: the retry path ran and recovered.
    expect(proxy.attempts()).toBe(3);
  });

  // ── A13 ───────────────────────────────────────────────────────────────
  test("A13: export a D1 log and import it into a fresh in-memory store", async () => {
    const d1 = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
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
    const d1 = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    await d1.import(await exportArchive(local));
    expect(await d1.threads()).toEqual(await local.threads());
    expect(await countIn(harness.db, LOG)).toBe(2);
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
    const d1 = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
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
    const store = new D1ThreadStore({ db: harness.db, logKey: LOG, clock: fixedClock() });
    const before = await countIn(harness.db, LOG);
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
    expect(await countIn(harness.db, LOG)).toBe(before);
  });
});

/** The three direct-SQL shapes these tests use against `review_logs`, named so
 * the file has one spelling of "this log's head" and cannot drift into an
 * unscoped query by accident. Every one of them carries `log_key`; there is no
 * unscoped statement in this file. */
const HEAD_FOR = "SELECT COALESCE(MAX(seq), 0) AS head FROM review_logs WHERE log_key = ?";
const INSERT_FOR = "INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)";

/** `countIn(logKey)`, `seqsIn(logKey)`, `rowsIn(logKey)` — the three reads the
 * cases below assert on. */
async function countIn(db: D1Database, logKey: string): Promise<number> {
  const row = await db.prepare(HEAD_FOR.replace("COALESCE(MAX(seq), 0) AS head", "COUNT(*) AS n")).bind(logKey).first<{ n: number }>();
  return row?.n ?? 0;
}

async function seqsIn(db: D1Database, logKey: string): Promise<number[]> {
  const rows = await db
    .prepare("SELECT seq FROM review_logs WHERE log_key = ? ORDER BY seq ASC")
    .bind(logKey)
    .all<{ seq: number }>();
  return (rows.results ?? []).map((r) => r.seq);
}

async function rowsIn(db: D1Database, logKey: string): Promise<{ seq: number; payload: string }[]> {
  const rows = await db
    .prepare("SELECT seq, payload FROM review_logs WHERE log_key = ? ORDER BY seq ASC")
    .bind(logKey)
    .all<{ seq: number; payload: string }>();
  return (rows.results ?? []).map((r) => ({ seq: r.seq, payload: r.payload }));
}

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

/** A `D1Database` proxy that reports a MOVING head forever: every batch
 * reports a head greater than the one the caller validated against, and a
 * zero-change insert. That is precisely the condition `append`'s CAS
 * retries on, so the store must exhaust its budget and give up. */
function foreverContended(db: D1Database): D1Database {
  let head = 100;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        // Report a head one past whatever the caller validated against, and
        // a zero-change insert. Those two facts are the whole CAS contract,
        // so the rest of the batch result can be empty.
        return async () => {
          head += 1;
          return contendedBatchResults(head, 0);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The table's real `MAX(seq)`, read outside the faked batch. */
async function realMaxSeq(db: D1Database, logKey: string = LOG): Promise<number> {
  const row = await db.prepare(HEAD_FOR).bind(logKey).first<{ head: number }>();
  return row?.head ?? 0;
}

/** The three results `append`'s batch produces when the guarded insert
 * writes nothing: the head, an empty catch-up, and `changes: 0`. */
function contendedBatchResults(head: number, changes: number): D1Result[] {
  return [
    { results: [{ head }], success: true, meta: {} },
    { results: [], success: true, meta: {} },
    { results: [], success: true, meta: { changes } },
  ] as unknown as D1Result[];
}

/** Same idea, but it COUNTS, so the bound can be asserted rather than
 * described. */
function contendedBatchCounter(db: D1Database): {
  db: D1Database;
  batches: () => number;
  failedInserts: () => number;
} {
  let batches = 0;
  let failed = 0;
  let head = 100;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async () => {
          batches += 1;
          failed += 1;
          head += 1;
          return contendedBatchResults(head, 0);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as D1Database, batches: () => batches, failedInserts: () => failed };
}

/** A D1 proxy that REPORTS the first `failures` guarded inserts as refused
 * and then behaves normally — the transient-contention shape.
 *
 * It delegates to the real database and rewrites only the third result's
 * `meta.changes`. An earlier version fabricated the head and catch-up rows
 * too, which was wrong in an instructive way: a fabricated head of 101
 * advanced the store's `#head` past the real table's 0, so every SUBSEQUENT
 * attempt's guard (`MAX(seq) === #head`) could never be satisfied by the
 * real database and the append failed 64 times. Contention has to be
 * modelled as "the insert was refused", not as "the world moved", because
 * the store reconciles the two independently.
 */
function flakyDb(db: D1Database, failures: number): D1Database & { attempts: () => number } {
  let seen = 0;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: unknown) => {
          seen += 1;
          if (seen <= failures) {
            // Refused, and genuinely NOT written — but the reported head is
            // the REAL one, so the store's `#head` stays consistent and a
            // later attempt can satisfy its guard. Delegating to the real
            // batch and lying only about `changes` does not work: the row
            // is really written, and the retry then fails on
            // `duplicate-thread` instead of landing.
            return contendedBatchResults(await realMaxSeq(target), 0);
          }
          return (target.batch as (input: unknown) => Promise<D1Result[]>)(statements);
        };
      }
      if (property === "attempts") return () => seen;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy as D1Database & { attempts: () => number };
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
