// The store conformance suite — the artefact that makes ADR-0025's "one
// core, three surfaces" a TESTED claim rather than a comment.
//
// `ThreadStore` is an interface (`packages/review-core/src/store.ts`) with
// three implementations — `InMemoryThreadStore`, which is the reference,
// `SqliteThreadStore`, the daemon's `bun:sqlite` backing, and
// `D1ThreadStore`, the hosted Worker's D1 backing. An interface with three
// implementations and no shared suite is three claims, not one: every rule
// added to `append` has to be remembered three times, and the third
// implementation is the one nobody tests against.
//
// So this file is ONE suite, parameterised over a factory, and it lives
// HERE rather than in any one package because all three backings have to
// run it:
//
//   packages/review-core/test/store-conformance.test.ts  -> InMemoryThreadStore
//   packages/cli/test/serve/store-conformance-sqlite.test.ts -> SqliteThreadStore
//   packages/worker/test/store-conformance.test.ts        -> D1ThreadStore
//
// It is a helper, not a `.test.ts`, so `bun test` does not run it directly
// in whichever package it sits in. The CONTRACT it exercises is
// runtime-neutral — nothing names a concrete store, there is no I/O
// assumption, and nothing outside the factory imports `bun:` or `node:` — so
// the CLI can run it against `bun:sqlite` without leaking a Bun-only API
// into the shared rules. (`bun:test` is imported above, but that is the test
// runner talking, not the contract.)
//
// **A previous revision of this header claimed the three-implementation
// problem and shipped only two**, which is the same class of error the
// suite exists to prevent: an argument for a property that is not
// established. `SqliteThreadStore` — 455 shipped lines with its own
// `BEGIN IMMEDIATE` allocator, i.e. the most likely place for a rule to
// diverge — was not running any of this.
//
// Cases here are the ones that hold for ANY `ThreadStore` — the ones a new
// backing must pass to be a `ThreadStore` at all.
//
// **Cases covered:** A5 (seq starts at 1, strictly increasing), A6
// (`since(n)`), A7 (`threads()` ordering), A8 (invalid event refused, log
// unchanged), A9 (`validateNext` refusal leaves the store byte-identical),
// A12 (import is refused whole; every refusal is a
// `ThreadStoreImportError` with a typed `rejection` — #72; and an import
// is judged against the log the STORE holds, not against what one instance
// validated — #107/#108), A14 (gaps are legal).
//
// **Not here, and deliberately:** A10 (20 concurrent appends) and A11
// (batch atomicity). Those are properties of D1's concurrency model, and
// the in-memory store has no analogue — the brief assigns them to
// `d1-store.test.ts`, with the reason recorded in that file's header.
//
// **The rule for a reviewer of this file:** if a case has to be SKIPPED
// for one store, that is a finding to file, not a convenience to grant.
// Every case below runs unconditionally for both stores, and the
// parameterisation is deliberately unable to express a skip — there is
// no `skip` field on `StoreFactory` to reach for.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  InMemoryThreadStore,
  ThreadStoreAppendError,
  ThreadStoreImportError,
  exportArchive,
  parseArchive,
  type Clock,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadArchive,
  type ThreadStore,
} from "@revkit/review-core";

/** One store implementation under test. There is deliberately no `skip`
 * field: a case that cannot run against a real `ThreadStore` is a defect
 * in the store or in the suite, and both need to be visible. */
export interface StoreFactory {
  /** Shown in the describe block, so a red case names its backing. */
  readonly name: string;
  /** A store over an EMPTY log. */
  make(): Promise<ThreadStore>;
  /** **Another store instance over the SAME storage `make()` hands
   * out** — a reopened `bun:sqlite` file, a second `D1ThreadStore` on the
   * same `logKey`. Required, not optional, because the hosted lane builds
   * a fresh store per request (`src/index.ts`), so "the instance that
   * wrote the log" and "the instance that judges an archive against it"
   * are different objects in production, and a factory that cannot
   * express that cannot express a `ThreadStore` property (#107/#108).
   *
   * A backing whose log does not outlive its instance answers this
   * honestly — the in-memory reference returns a new empty store, because
   * its log IS instance fields — and the case that uses this reads the
   * storage rather than assuming which answer it got. */
  reopen(): Promise<ThreadStore>;
  /** Drop all state so the next `make()` starts clean. Callers use it
   * between cases; the suite calls it in `beforeEach`. */
  reset(): Promise<void>;
}

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "b".repeat(64),
} as const;

const human = { kind: "gh-user", id: "gerchowl" } as const;
const agent = { kind: "agent", id: "revkit-live" } as const;

/** A `comment.created` opening `threadId` on `path`. Typed as the
 *  `ReviewEventInput` union member rather than `ReviewEventInput`, so a
 *  caller can pass `body: ""` to exercise A8 without a cast — the suite
 *  deliberately exercises events the schema REFUSES, which is
 *  unrepresentable in the accepted type. */
function commentCreated(
  threadId: string,
  commentId: string,
  overrides: { readonly path?: string; readonly body?: string } = {},
): ReviewEventInput {
  return {
    actor: human,
    kind: "comment.created",
    threadId,
    commentId,
    anchor: { ...anchor, path: overrides.path ?? anchor.path },
    body: overrides.body ?? "why 30 s?",
  };
}

/** A `comment.created` opening thread `threadId`. Distinct
 *  `commentId`s across calls, so a case can control uniqueness itself. */
function createThread(threadId: string, commentId: string, body = "why 30 s?"): ReviewEventInput {
  return commentCreated(threadId, commentId, { body });
}

/** A canned clock, so `ts` is predictable and a test asserts against
 * known values rather than against itself. */
export function fixedClock(startSecond = 0): Clock {
  let cursor = startSecond;
  return () => {
    const ts = `2026-10-03T12:00:${String(cursor).padStart(2, "0")}Z`;
    cursor += 1;
    return ts;
  };
}

export function storeConformance(factory: StoreFactory): void {
  describe(`store conformance — ${factory.name}`, () => {
    let store: ThreadStore;

    beforeEach(async () => {
      await factory.reset();
      store = await factory.make();
    });

    // ── A5 ────────────────────────────────────────────────────────────────
    test("A5: append returns seq 1 first, then strictly increasing, with no gaps", async () => {
      expect(await store.append(createThread("th-a5", "c-a5-1"))).toBe(1);
      expect(await store.append(createThread("th-a5b", "c-a5-2"))).toBe(2);
      const seqs: number[] = [];
      for (let i = 3; i <= 10; i++) {
        seqs.push(await store.append(createThread(`th-a5-${i}`, `c-a5-${i}`)));
      }
      expect(seqs).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test("A5: a ten-event log reads back with seq 1..10 in order", async () => {
      for (let i = 1; i <= 10; i++) {
        await store.append(createThread(`th-order-${i}`, `c-order-${i}`));
      }
      const events = await store.since(0);
      expect(events).toHaveLength(10);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    // ── A6 ────────────────────────────────────────────────────────────────
    test("A6: since(n) returns exactly the events with seq > n, ascending", async () => {
      for (let i = 1; i <= 5; i++) {
        await store.append(createThread(`th-since-${i}`, `c-since-${i}`));
      }
      expect((await store.since(0)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect((await store.since(2)).map((e) => e.seq)).toEqual([3, 4, 5]);
      expect((await store.since(4)).map((e) => e.seq)).toEqual([5]);
    });

    test("A6: since(head) is empty — the reconnect probe a client issues", async () => {
      await store.append(createThread("th-head", "c-head"));
      const head = (await store.since(0)).at(-1)?.seq ?? 0;
      expect(await store.since(head)).toEqual([]);
    });

    test("A6: since beyond the head is empty rather than an error", async () => {
      await store.append(createThread("th-beyond", "c-beyond"));
      expect(await store.since(9_999)).toEqual([]);
    });

    // ── A7 ────────────────────────────────────────────────────────────────
    test("A7: threads() is ordered by createdSeq ascending, deterministically", async () => {
      await store.append(createThread("th-3", "c-3"));
      await store.append(createThread("th-1", "c-1"));
      await store.append(createThread("th-2", "c-2"));
      const threads = await store.threads();
      // Creation order on the wire, NOT alphabetical id order — so a
      // store that sorted by id or by the ISO `ts` string would differ
      // here. (The `ts`-insensitivity half of the claim needs a
      // descending-clock log, which `ThreadStore` cannot express —
      // `ts` is store-assigned and no case can inject one. The gapped
      // archive in A14 below carries DESCENDING ts and proves it.)
      expect(threads.map((t) => t.id)).toEqual(["th-3", "th-1", "th-2"]);
      expect(threads.map((t) => t.createdSeq)).toEqual([1, 2, 3]);
    });

    test("A7: the order is stable across repeated reads", async () => {
      for (let i = 1; i <= 4; i++) await store.append(createThread(`th-rep-${i}`, `c-rep-${i}`));
      const first = (await store.threads()).map((t) => t.id);
      const second = (await store.threads()).map((t) => t.id);
      expect(second).toEqual(first);
    });

    test("A7: threads() on an empty log is empty, not undefined", async () => {
      expect(await store.threads()).toEqual([]);
      expect(await store.asks()).toEqual([]);
    });

    test("A7: a path filter applies and does not disturb ordering", async () => {
      await store.append(commentCreated("th-a", "c-a", { path: "docs/a.mdx" }));
      await store.append(commentCreated("th-b", "c-b", { path: "docs/b.mdx" }));
      expect((await store.threads({ path: "docs/a.mdx" })).map((t) => t.id)).toEqual(["th-a"]);
      expect((await store.threads()).map((t) => t.id)).toEqual(["th-a", "th-b"]);
    });

    // ── A8 ────────────────────────────────────────────────────────────────
    test("A8: an invalid event throws ThreadStoreAppendError with a rejection kind", async () => {
      // `body: ""` violates the schema's `.min(1)`.
      await expect(store.append(commentCreated("th-bad", "c-bad", { body: "" }))).rejects.toThrow(
        ThreadStoreAppendError,
      );
      let caught: unknown;
      try {
        await store.append(commentCreated("th-bad", "c-bad", { body: "" }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreAppendError);
      const rejection = (caught as InstanceType<typeof ThreadStoreAppendError>).rejection;
      expect(rejection.kind).toBe("invalid-shape");
      expect(rejection.message.length).toBeGreaterThan(0);
    });

    test("A8: a refused append leaves the log unchanged and the head unmoved", async () => {
      await store.append(createThread("th-keep", "c-keep"));
      await expect(store.append(commentCreated("th-x", "c-x", { body: "" }))).rejects.toThrow();
      const events = await store.since(0);
      expect(events.map((e) => e.seq)).toEqual([1]);
      expect((events[0] as { threadId?: string } | undefined)?.threadId).toBe("th-keep");
      // The store is still usable: the next append gets seq 2, not 3.
      expect(await store.append(createThread("th-next", "c-next"))).toBe(2);
    });

    // ── A9 ────────────────────────────────────────────────────────────────
    test("A9: a validateNext refusal throws and leaves the log byte-identical", async () => {
      await store.append(createThread("th-dup", "c-same"));
      const before = JSON.stringify(await store.since(0));
      // A second thread reusing the same commentId: Zod-valid (the shape
      // is fine) but `validateNext` refuses it as `duplicate-comment-id`.
      let caught: unknown;
      try {
        await store.append(createThread("th-other", "c-same"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreAppendError);
      expect((caught as InstanceType<typeof ThreadStoreAppendError>).rejection.kind).toBe(
        "duplicate-comment-id",
      );
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A9: a reply to a thread that does not exist is refused as unknown-thread", async () => {
      const before = JSON.stringify(await store.since(0));
      let caught: unknown;
      try {
        await store.append({
          actor: agent,
          kind: "comment.replied",
          threadId: "th-absent",
          commentId: "c-reply",
          parentId: "c-nothing",
          body: "hello",
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as InstanceType<typeof ThreadStoreAppendError>).rejection.kind).toBe("unknown-thread");
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    // ── A12 ───────────────────────────────────────────────────────────────
    test("A12: an archive that duplicates WITHIN itself is refused whole", async () => {
      await store.append(createThread("th-imp-1", "c-imp-1"));
      const before = JSON.stringify(await store.since(0));

      // Two events, each individually Zod-valid, the second reusing the
      // first's commentId. `parseArchive` plays the archive through
      // `validateNext` from an empty state, so it catches this at the
      // BYTE boundary — the store is never reached, and therefore cannot
      // have written the first event.
      const intra = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [
          archiveEvent(3, "th-imp-3", "c-imp-3"),
          archiveEvent(4, "th-imp-4", "c-imp-3"),
        ],
      };
      expect(() => parseArchive(intra)).toThrow();
      await expect(store.import(intra)).rejects.toThrow();
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: an archive that duplicates the STORE's log is refused whole", async () => {
      await store.append(createThread("th-imp-1", "c-imp-1"));
      await store.append(createThread("th-imp-2", "c-imp-2"));
      const before = JSON.stringify(await store.since(0));

      // This one is individually fine AND internally consistent —
      // `parseArchive` therefore does NOT throw, which is correct: it can
      // only see the archive, not the store it is about to land in. The
      // refusal has to come from the store's own dry-run against its
      // state. A store that committed events one at a time would have
      // written this one and then thrown, leaving a half-import.
      const cross = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [archiveEvent(3, "th-imp-3", "c-imp-1")],
      } satisfies ThreadArchive;
      expect(() => parseArchive(cross)).not.toThrow();
      await expect(store.import(cross)).rejects.toThrow(ThreadStoreImportError);
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    // ── A12 (error taxonomy) ──────────────────────────────────────────────
    // Every `import` refusal must leave the store boundary as a
    // `ThreadStoreImportError`. Before #72 a schema failure escaped as a
    // raw `ZodError` from `threadArchiveSchema.parse` and the per-event
    // dry run raised `ThreadStoreAppendError` from INSIDE `import`, so a
    // caller branching on the documented class got neither. The
    // structural `issues` check stands in for `instanceof ZodError`: this
    // shared file runs in `packages/worker`, which has no `zod` dependency
    // to import the class from, and a ZodError is defined by carrying an
    // `issues` array.
    test("A12: a schema-invalid archive is refused as ThreadStoreImportError, never a ZodError", async () => {
      await store.append(createThread("th-tax", "c-tax"));
      const before = JSON.stringify(await store.since(0));

      // The #72 repro: the FIRST event is a bare `comment.replied` naming
      // a thread the log does not have. The event's own shape is valid —
      // `reviewEventSchema` accepts it — so the failure is the archive's
      // `validateNext` play-through, which runs inside
      // `threadArchiveSchema.superRefine` and therefore raises a ZodError.
      const broken = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [
          {
            seq: 7,
            ts: "2026-10-03T12:00:07Z",
            actor: agent,
            kind: "comment.replied",
            threadId: "th-does-not-exist",
            commentId: "c-orphan",
            parentId: "c-nothing",
            body: "reply into the void",
          },
        ],
      };
      // A raw object, not `parseArchive`'s output: the caller hands an
      // in-memory object straight to `import`, so the refusal has to
      // happen INSIDE `import` — which is the behaviour under test.
      let caught: unknown;
      try {
        await store.import(broken as ThreadArchive);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      expect(Array.isArray((caught as { issues?: unknown }).issues)).toBe(false);
      // The message names the offending event and the invariant it broke,
      // in one line — not a Zod path/issue blob. The seq is asserted in
      // the exact phrase the message builds, not as a bare `toContain("7")`,
      // which a `ts` of `…:07Z` would satisfy just as well.
      expect((caught as Error).message).toContain("event 0 (seq 7)");
      expect((caught as Error).message).toContain("unknown-thread");
      expect((caught as Error).message.split("\n")).toHaveLength(1);
      // The typed field, so a caller branches without parsing the message.
      // `kind` is the REAL invariant, not `invalid-shape`: this archive is
      // shape-valid, so reporting it as malformed would be the same
      // distinction the dry run already gets right.
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.seq).toBe(7);
      expect(rejection?.index).toBe(0);
      expect(rejection?.kind).toBe("unknown-thread");
      expect(rejection?.transition?.kind).toBe("unknown-thread");
      // The original ZodError is preserved, not swallowed.
      expect((caught as { cause?: unknown }).cause).toBeDefined();
      // And the refusal itself is unchanged: nothing landed.
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: a mid-archive transition failure is refused as ThreadStoreImportError carrying the rejection", async () => {
      await store.append(createThread("th-mid", "c-mid-1"));
      const before = JSON.stringify(await store.since(0));

      // Internally consistent — `parseArchive` accepts it, because the
      // commentIds are distinct WITHIN the archive — so the refusal can
      // only come from the store's own dry run against its state, at the
      // SECOND event. `duplicate-comment-id` is the same kind the append
      // path raises for the same conflict, which is what lets a caller
      // reuse the branch it already has.
      const mid = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [archiveEvent(3, "th-mid-a", "c-mid-a"), archiveEvent(4, "th-mid-b", "c-mid-1")],
      } satisfies ThreadArchive;
      expect(() => parseArchive(mid)).not.toThrow();
      let caught: unknown;
      try {
        await store.import(mid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("duplicate-comment-id");
      expect(rejection?.seq).toBe(4);
      expect(rejection?.index).toBe(1);
      // The `validateNext` rejection itself is reachable, not flattened
      // into the message.
      expect(rejection?.transition?.kind).toBe("duplicate-comment-id");
      // `cause` is set only on the shape path, so a caller that reaches
      // for it never gets a non-`Error` — the transition is on the typed
      // field instead.
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      // No partial import: the first event of the archive did not land.
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: the head precondition refusal carries its own rejection kind and changes nothing", async () => {
      await store.append(createThread("th-head-1", "c-head-1"));
      await store.append(createThread("th-head-2", "c-head-2"));
      const before = JSON.stringify(await store.since(0));
      const stale = await exportArchive(store);
      let caught: unknown;
      try {
        await store.import(stale);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("head-not-monotone");
      // This refusal DOES name an event — `events[0]`, whose seq is the
      // one that failed the check. Pinned because `ImportRejection.seq`'s
      // doc used to say the opposite, and a caller branching on
      // `seq === undefined` would have mis-routed this case.
      expect(rejection?.seq).toBe(1);
      expect(rejection?.index).toBe(0);
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: a genuinely malformed archive still reports invalid-shape", async () => {
      await store.append(createThread("th-mal", "c-mal"));
      const before = JSON.stringify(await store.since(0));

      // The counterpart to the repro above: this archive's BYTES are
      // wrong (`body: ""` violates the schema's `.min(1)`), so there is no
      // transition to carry and `kind` is `invalid-shape` — which is what
      // makes that kind mean something rather than being the default for
      // every schema-path refusal.
      const malformed = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [
          {
            seq: 9,
            ts: "2026-10-03T12:00:09Z",
            actor: human,
            kind: "comment.created",
            threadId: "th-mal",
            commentId: "c-mal-2",
            anchor,
            body: "",
          },
        ],
      };
      let caught: unknown;
      try {
        await store.import(malformed as ThreadArchive);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("invalid-shape");
      expect(rejection?.seq).toBe(9);
      expect(rejection?.index).toBe(0);
      // No transition to report — the Zod issues are on `cause`, which is
      // an `Error` whenever it is present at all.
      expect(rejection?.transition).toBeUndefined();
      expect((caught as { cause?: unknown }).cause).toBeDefined();
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: an archive whose first seq is not above the head is refused", async () => {
      await store.append(createThread("th-mon-1", "c-mon-1"));
      await store.append(createThread("th-mon-2", "c-mon-2"));
      const before = JSON.stringify(await store.since(0));
      // The archive of THIS store, so its first seq (1) is not strictly
      // above this store's own head (2) — the re-import a careless
      // client would attempt after a failed publish.
      const stale = await exportArchive(store);
      await expect(store.import(stale)).rejects.toThrow(ThreadStoreImportError);
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: a well-formed archive from an INDEPENDENT log imports whole", async () => {
      // The source is an `InMemoryThreadStore` on purpose. It has to be a
      // log the store under test has never seen, and the in-memory store
      // is the cheapest independent one — for the D1 factory this is also
      // the real bridge direction (`revkit threads export` from a local
      // log, `import` into the hosted database), which is the case this
      // suite exists to prove. The D1 -> in-memory direction is A13 in
      // `d1-store.test.ts`.
      const source = new InMemoryThreadStore({ clock: fixedClock() });
      await source.append(createThread("th-src-1", "c-src-1"));
      await source.append(createThread("th-src-2", "c-src-2"));
      await store.import(await exportArchive(source));
      expect((await store.since(0)).map((e) => e.seq)).toEqual([1, 2]);
      expect((await store.threads()).map((t) => t.id)).toEqual(["th-src-1", "th-src-2"]);
    });

    // ── A12 (divergence, #73) ─────────────────────────────────────────────
    // The issue's exact repro, verbatim: a store at head 2, handed an
    // archive whose tail is a NEW thread's `comment.created` at seq 3.
    // Every check the store already had passed on this one — the
    // archive is shape-clean, its first seq (3) is strictly above the
    // head (2), and the dry run finds no conflict, because the foreign
    // thread shares no id with this log. So it landed, and `since(2)`
    // then handed a client reconnecting with `after=2` an event from
    // another repo's history as this log's seq 3.
    test("A12: a DIVERGENT archive is refused whole — a foreign log's tail at head+1", async () => {
      await store.append(createThread("th-div-1", "c-div-1"));
      await store.append(createThread("th-div-2", "c-div-2"));
      const before = JSON.stringify(await store.since(0));

      const divergent = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [archiveEvent(3, "th-div-3", "c-div-3")],
      } satisfies ThreadArchive;
      // The parser accepts it, which is the point: `parseArchive` plays
      // the archive through `validateNext` from an EMPTY state, and this
      // archive is self-contained, so nothing short of a comparison
      // against THIS store can see the divergence. The refusal has to
      // come from the store.
      expect(() => parseArchive(divergent)).not.toThrow();

      let caught: unknown;
      try {
        await store.import(divergent);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("divergent-archive");
      // It DOES name an event — `events[0]`, whose seq is the one that
      // failed — and no transition, because no `validateNext` rule
      // broke: the gap between two logs is a store-local fact, the same
      // class of refusal as `head-not-monotone`.
      expect(rejection?.seq).toBe(3);
      expect(rejection?.index).toBe(0);
      expect(rejection?.transition).toBeUndefined();
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      // One line, naming the offending seq AND the head it collides
      // with — the two numbers a caller needs to reconcile by hand.
      const message = (caught as Error).message;
      expect(message.split("\n")).toHaveLength(1);
      expect(message).toContain("first seq 3");
      expect(message).toContain("head 2");
      // Nothing landed, and the log is byte-identical.
      expect(JSON.stringify(await store.since(0))).toBe(before);
      // The head never moved either: a refused archive must not consume
      // a seq, or the next `append` would skip one.
      expect(await store.append(createThread("th-div-next", "c-div-next"))).toBe(3);
    });

    test("A12: a gap archive above a store that already holds a log is refused", async () => {
      await store.append(createThread("th-gp-1", "c-gp-1"));
      await store.append(createThread("th-gp-2", "c-gp-2"));
      const before = JSON.stringify(await store.since(0));

      // The A14 shape — a log whose first 40 events this store never
      // had — aimed at a store that is NOT empty. On a fresh store that
      // is legal (A14); here it would leave seqs 3..40 permanently
      // empty in a log whose head claims 43, which is precisely the
      // `since(lastSeen)` catch-up ADR-0006 warns about.
      const gap = await buildGappedArchive([41, 42, 43]);
      let caught: unknown;
      try {
        await store.import(gap);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("seq-gap");
      expect(rejection?.seq).toBe(41);
      expect(rejection?.index).toBe(0);
      expect(rejection?.transition).toBeUndefined();
      const message = (caught as Error).message;
      expect(message.split("\n")).toHaveLength(1);
      expect(message).toContain("first seq 41");
      expect(message).toContain("head 2");
      expect(JSON.stringify(await store.since(0))).toBe(before);
    });

    test("A12: the guard keys off a store that already holds a log, not off `append`", async () => {
      // The scope of the guard, in one case: on an EMPTY store this
      // archive is just a log whose first event sits at seq 3 (A14's
      // shape, and the only shape `exportArchive` can produce), so it
      // imports — the guard is not "import is broken". Once that store
      // holds a log, the very next archive is refused, because nothing
      // shows the two belong together. Building the log by `import`
      // rather than by `append` is the half worth pinning: the guard
      // reads the store's state, not how that state got there.
      await store.import(await buildGappedArchive([3, 4]));
      expect((await store.since(0)).map((e) => e.seq)).toEqual([3, 4]);

      const next = await buildGappedArchive([5]);
      let caught: unknown;
      try {
        await store.import(next);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("divergent-archive");
      expect(rejection?.seq).toBe(5);
      expect((await store.since(0)).map((e) => e.seq)).toEqual([3, 4]);
    });

    test("A12: a fresh instance over a non-empty log refuses a DIVERGENT archive (#107)", async () => {
      // #107, one case, all three backings. It was invisible here because
      // every case so far used ONE instance to do everything: the instance
      // that appended was the instance that imported, so its head and its
      // log state WERE the log's. In production they are not the same
      // object — `src/index.ts` builds a fresh `D1ThreadStore` per request
      // — and a fresh instance's head is 0 and its validator state is
      // empty, so the #73 guard had nothing to fire on.
      const { fresh, stored } = await secondInstanceOverSeededLog(factory, store);
      if (stored.length === 0) {
        // The in-memory reference: its log IS its instance, so there is
        // nothing to be judged against and the archive lands. The honest
        // answer for a backing with no storage behind the handle.
        await fresh.import(await buildGappedArchive([3]));
        expect((await fresh.since(0)).map((e) => e.seq)).toEqual([3]);
        return;
      }

      // #73's repro, through the instance that did not write the log: a
      // foreign thread's `comment.created` at seq 3, refused exactly as
      // the writer instance refuses it.
      const foreign = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [archiveEvent(3, "th-inst-3", "c-inst-3")],
      } satisfies ThreadArchive;
      expect(() => parseArchive(foreign)).not.toThrow();
      let caught: unknown;
      try {
        await fresh.import(foreign);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      expect(rejection?.kind).toBe("divergent-archive");
      expect(rejection?.seq).toBe(3);
      // The log the storage held is byte-identical, and the second
      // instance can still append onto it — a refusal is not a wedged
      // store.
      expect(JSON.stringify(await fresh.since(0))).toBe(JSON.stringify(stored));
      expect(await fresh.append(createThread("th-inst-next", "c-inst-next"))).toBe(3);
    });

    test("A12: a fresh instance over a non-empty log refuses an archive whose ids collide with it (#108)", async () => {
      // #108 is the same root cause with a worse consequence: it
      // COMMITTED rather than merely failing to refuse. An archive at
      // non-colliding seqs 7, 8 whose first event re-opens `th-inst-1`
      // under a new commentId — internally consistent, so `parseArchive`
      // accepts it, and refused only by the store's dry run against the
      // log the storage holds. Against an empty state there is nothing to
      // collide with, and both events land.
      const { fresh, stored } = await secondInstanceOverSeededLog(factory, store);
      if (stored.length === 0) {
        await fresh.import(await buildGappedArchive([7, 8]));
        expect((await fresh.since(0)).map((e) => e.seq)).toEqual([7, 8]);
        return;
      }

      const collides = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        events: [archiveEvent(7, "th-inst-1", "c-inst-7"), archiveEvent(8, "th-inst-b", "c-inst-b")],
      } satisfies ThreadArchive;
      expect(() => parseArchive(collides)).not.toThrow();
      let caught: unknown;
      try {
        await fresh.import(collides);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThreadStoreImportError);
      const rejection = (caught as InstanceType<typeof ThreadStoreImportError>).rejection;
      // `duplicate-thread`, NOT `divergent-archive`: the dry run runs
      // before the guard, so the more specific invariant still wins and
      // the kinds a caller branched on since #72 are unchanged.
      expect(rejection?.kind).toBe("duplicate-thread");
      expect(rejection?.seq).toBe(7);
      expect(rejection?.transition?.kind).toBe("duplicate-thread");
      // Nothing landed — neither event — and the derived view has no
      // duplicate threadId, which is the property #108 broke. (The view
      // alone would not show it: the reduce absorbs the second
      // `comment.created` as another comment on the same thread, so only
      // the event log shows the fork.)
      expect(JSON.stringify(await fresh.since(0))).toBe(JSON.stringify(stored));
      expect((await fresh.threads()).map((t) => t.id)).toEqual(["th-inst-1", "th-inst-2"]);
    });

    // ── A14 ───────────────────────────────────────────────────────────────
    test("A14: a store whose seq jumps still satisfies since/threads and never throws", async () => {
      // An archive starting at seq 41 — a fresh store on a log whose
      // first 40 events were never imported (a forked Worker, a restored
      // snapshot, a scope whose history predates this database). ADR-0006
      // blesses this: consumers use `since(lastSeen)` and never assume
      // contiguity.
      const jumped = await buildGappedArchive([41, 42, 43]);
      await store.import(jumped);
      expect((await store.since(0)).map((e) => e.seq)).toEqual([41, 42, 43]);
      expect((await store.since(41)).map((e) => e.seq)).toEqual([42, 43]);
      expect((await store.since(43))).toEqual([]);
      expect((await store.threads()).map((t) => t.id)).toEqual(["th-gap-41", "th-gap-42", "th-gap-43"]);
      // The clock half of A7: the log's `ts` values DESCEND, so this
      // result is only reachable by ordering on `createdSeq`.
      const timestamps = (await store.since(0)).map((e) => e.ts);
      expect(timestamps).toEqual([...timestamps].sort().reverse());
      expect(timestamps).not.toEqual([...timestamps].sort());
      // A follow-up append continues from the head it knows, with a gap.
      const next = await store.append(createThread("th-gap-44", "c-gap-44"));
      expect(next).toBe(44);
    });

    test("A14: exportArchive of a gapped log preserves the gaps verbatim", async () => {
      await store.import(await buildGappedArchive([41, 42, 43]));
      const archive = await exportArchive(store);
      expect(archive.events.map((e) => e.seq)).toEqual([41, 42, 43]);
    });
  });
}

/** Seed two events through `store`, then hand back a SECOND instance over
 * the SAME storage (`StoreFactory.reopen`) together with what that storage
 * holds — read, not assumed.
 *
 * `stored` is empty exactly when the backing's log does not outlive its
 * instance, which is true of the in-memory reference and nothing else. The
 * two #107/#108 cases branch on it rather than on a declared flag, so the
 * branch follows an observed fact about the store rather than a property
 * the factory claimed about itself.
 *
 * Two events, not one: the repro's head is 2, and a head of 2 is also the
 * smallest store where `since(2)` (the daemon's catch-up cursor) has
 * something to be wrong about. */
async function secondInstanceOverSeededLog(
  factory: StoreFactory,
  store: ThreadStore,
): Promise<{ fresh: ThreadStore; stored: readonly ReviewEvent[] }> {
  await store.append(createThread("th-inst-1", "c-inst-1"));
  await store.append(createThread("th-inst-2", "c-inst-2"));
  const fresh = await factory.reopen();
  return { fresh, stored: await fresh.since(0) };
}

/** One `comment.created` as it appears inside an archive — i.e. WITH the
 * `seq`/`ts` the store assigned, because `parseArchive` validates the
 * complete `ReviewEvent`, not an append input. */
function archiveEvent(seq: number, threadId: string, commentId: string): ReviewEvent {
  return {
    seq,
    ts: `2026-10-03T12:00:${String(seq % 60).padStart(2, "0")}Z`,
    actor: human,
    kind: "comment.created",
    threadId,
    commentId,
    anchor,
    body: `body ${seq}`,
  };
}

/** An archive whose events sit at `seqs`, with the comment/thread ids
 * derived from each seq so the log validates. Built by hand rather than
 * by appending, because no store can produce a gap: they assign
 * contiguous seqs by construction. That asymmetry is the whole reason
 * this helper exists. */
async function buildGappedArchive(seqs: readonly number[]): Promise<ThreadArchive> {
  // `ts` DESCENDS as `seq` ascends, deliberately. `ThreadStore` cannot
  // express this through `append` — the store assigns `ts` — so an
  // imported archive is the only way to hand a store a log whose
  // timestamps disagree with its sequence. A store that ordered
  // `threads()` by the ISO string instead of by `createdSeq` returns
  // them reversed; one that orders by `createdSeq` does not care.
  const events: ReviewEvent[] = seqs.map((seq, index) => ({
    seq,
    ts: `2026-10-03T12:00:${String(seqs.length - index).padStart(2, "0")}Z`,
    actor: human,
    kind: "comment.created",
    threadId: `th-gap-${seq}`,
    commentId: `c-gap-${seq}`,
    anchor,
    body: `gap ${seq}`,
  }));
  return parseArchive({ schemaVersion: CURRENT_SCHEMA_VERSION, events });
}
