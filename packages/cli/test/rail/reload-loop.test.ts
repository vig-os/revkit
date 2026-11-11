// Unit tests for the rail's two reload-loop defences (M2 item 9,
// story A4).
//
// The rejected head replayed the whole durable log on every page load
// and re-fired the reload triggers, so a page reloaded forever (212
// navigations in 8 s, measured by the reviewer). `site/tests/
// publish-settles.spec.ts` proves the fixed page SETTLES in a real
// browser. It cannot, however, tell a resume point from an idempotence
// guard — a regression in either looks identical there ("the page
// loops again"). These tests pin each mechanism separately, plus the
// arithmetic that decides the resume point, so a future change that
// removes one of them is caught by a name that says which.
//
// Reply-draft expiry lives here too: it is the same class of bug
// (state that outlives its usefulness and is then mistaken for live),
// and it is pure logic over a storage object.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RAIL_LOG_HEAD_META,
  RESUME_SEQ_KEY,
  createSeqGate,
  readPageRenderHead,
  readResumeSeq,
  sinceForSubscribe,
  writeResumeSeq,
  type ResumeStorage,
} from "../../src/rail/resume-point.ts";
import {
  DRAFT_KEY_PREFIX,
  DRAFT_TTL_MS,
  encodeDraft,
  readDraft,
  removeDraft,
  saveDraft,
  sweepExpiredDrafts,
  type DraftStorage,
} from "../../src/rail/drafts.ts";

/** A minimal in-memory Web Storage stand-in. */
function fakeStorage(initial: Record<string, string> = {}): DraftStorage & ResumeStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length(): number {
      return map.size;
    },
    key: (i: number): string | null => [...map.keys()][i] ?? null,
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
  };
}

describe("resume point — where the rail opens /events", () => {
  test("a PAGE-RENDER stamp wins over everything: it is the only value older than the attach window", () => {
    // This is the whole fix for the lost-update window. A head read
    // from the page (probe or otherwise) is taken AT OR AFTER attach,
    // so it cannot cover the window between the page's HTML GET and
    // the stream opening. The server stamps the head into the page at
    // render time; resuming from it replays the window.
    expect(sinceForSubscribe(0, 999, 40)).toBe(40);
    // Even a STALE persisted point does not override the stamp: the
    // stamp is where this page's data came from, so it is exactly the
    // right resume point for it.
    expect(sinceForSubscribe(7, 999, 40)).toBe(40);
  });

  test("a WARM tab with no stamp resumes from its persisted point", () => {
    // The fallback for a page the injector passed through untouched
    // (oversize) or a daemon too old to stamp one.
    expect(sinceForSubscribe(17, 999, 0)).toBe(17);
  });

  test("a COLD tab with neither a stamp nor a stored point probes the head", () => {
    expect(sinceForSubscribe(0, 42, 0)).toBe(42);
  });

  test("every unusable input degrades to `since=0` rather than a bogus point", () => {
    expect(sinceForSubscribe(0, 0, 0)).toBe(0);
    expect(sinceForSubscribe(0, -1, 0)).toBe(0);
    expect(sinceForSubscribe(0, Number.NaN, 0)).toBe(0);
    expect(sinceForSubscribe(0, 1.5, 0)).toBe(0);
    // A junk stamp must not be trusted over a working probe.
    expect(sinceForSubscribe(0, 42, -1)).toBe(42);
    expect(sinceForSubscribe(0, 42, 2.5)).toBe(42);
  });

  test("readPageRenderHead reads the stamp and rejects junk", () => {
    const withContent = (content: string | null): { querySelector: () => { getAttribute: (a: string) => string | null } | null } => ({
      querySelector: () => (content === null ? null : { getAttribute: () => content }),
    });
    expect(readPageRenderHead(withContent("42"))).toBe(42);
    expect(readPageRenderHead(withContent(null))).toBe(0);
    expect(readPageRenderHead(withContent("0"))).toBe(0);
    expect(readPageRenderHead(withContent("-3"))).toBe(0);
    // `Number.parseInt("42abc")` is 42 — accepting it would skip live
    // events up to 42 on a corrupt stamp.
    expect(readPageRenderHead(withContent("42abc"))).toBe(0);
    expect(readPageRenderHead(withContent("4.2"))).toBe(0);
    expect(readPageRenderHead(withContent("not a number"))).toBe(0);
  });

  test("the rail's meta name and the injector's agree", () => {
    // Duplicated as a literal in each module on purpose (the rail
    // bundle must not import the daemon's node:fs graph), so this
    // pins the duplication.
    expect(RAIL_LOG_HEAD_META).toBe("revkit-log-head");
    const injectorSource = readFileSync(
      join(import.meta.dir, "..", "..", "src", "rail", "injector.ts"),
      "utf8",
    );
    expect(injectorSource).toContain('RAIL_LOG_HEAD_META = "revkit-log-head"');
  });

  test("the daemon stamps the head at all three HTML injectRail sites", () => {
    // A site that forgets `logHead` silently serves a page whose rail
    // falls back to the weaker probe. Count the sites and the stamps.
    const daemonSource = readFileSync(
      join(import.meta.dir, "..", "..", "src", "serve", "daemon.ts"),
      "utf8",
    );
    const sites = daemonSource.match(/injectRail\(rawResponse, \{/g) ?? [];
    expect(sites.length).toBe(3);
    const stamps = daemonSource.match(/logHead: store\.head\(\),/g) ?? [];
    expect(stamps.length).toBe(3);
  });

  test("readResumeSeq rejects a corrupt value rather than trusting parseInt", () => {
    // `Number.parseInt("10abc")` is 10 — accepting it would skip every
    // live event up to seq 10 on the next load.
    expect(readResumeSeq(fakeStorage({ [RESUME_SEQ_KEY]: "10abc" }))).toBe(0);
    expect(readResumeSeq(fakeStorage({ [RESUME_SEQ_KEY]: " 7 " }))).toBe(7);
    expect(readResumeSeq(fakeStorage({ [RESUME_SEQ_KEY]: "0" }))).toBe(0);
    expect(readResumeSeq(fakeStorage({ [RESUME_SEQ_KEY]: "-3" }))).toBe(0);
    expect(readResumeSeq(fakeStorage({}))).toBe(0);
  });

  test("writeResumeSeq round-trips and refuses nonsense", () => {
    const storage = fakeStorage();
    writeResumeSeq(storage, 9);
    expect(readResumeSeq(storage)).toBe(9);
    writeResumeSeq(storage, 0);
    expect(readResumeSeq(storage)).toBe(9);
    writeResumeSeq(storage, 1.5);
    expect(readResumeSeq(storage)).toBe(9);
    writeResumeSeq(storage, -1);
    expect(readResumeSeq(storage)).toBe(9);
  });

  test("an unavailable storage degrades to 0 rather than throwing", () => {
    const hostile: ResumeStorage = {
      getItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
      setItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
    };
    expect(readResumeSeq(hostile)).toBe(0);
    expect(() => writeResumeSeq(hostile, 5)).not.toThrow();
    expect(readResumeSeq(undefined)).toBe(0);
    expect(() => writeResumeSeq(undefined, 5)).not.toThrow();
  });
});

describe("per-seq gate — a replay can never act twice", () => {
  test("accepts each durable event exactly once", () => {
    const gate = createSeqGate();
    expect(gate.accept(1)).toBe(true);
    expect(gate.accept(2)).toBe(true);
    expect(gate.accept(3)).toBe(true);
  });

  test("a REPLAY of an already-handled seq is rejected", () => {
    // This is the loop. `/events?since=0` re-delivers seq 5; if the
    // gate accepted it, the reload trigger fires again on a page that
    // just reloaded because of that same event.
    const gate = createSeqGate();
    expect(gate.accept(5)).toBe(true);
    expect(gate.accept(5)).toBe(false);
    expect(gate.accept(5)).toBe(false);
  });

  test("an out-of-order or stale seq is rejected; the mark only advances", () => {
    const gate = createSeqGate();
    expect(gate.accept(10)).toBe(true);
    expect(gate.accept(7)).toBe(false);
    expect(gate.accept(10)).toBe(false);
    expect(gate.accept(11)).toBe(true);
    // The high-water mark is 11, so 10 can never come back.
    expect(gate.accept(10)).toBe(false);
  });

  test("non-positive and non-integer seqs are refused (they are not resume points)", () => {
    const gate = createSeqGate();
    expect(gate.accept(0)).toBe(false);
    expect(gate.accept(-1)).toBe(false);
    expect(gate.accept(1.5)).toBe(false);
    expect(gate.accept(Number.NaN)).toBe(false);
  });

  test("a fresh gate SEEDED with the persisted point rejects everything at or below it", () => {
    // Models the reload. The gate MUST be seeded — a gate that starts
    // at zero would re-accept the very event that caused the reload
    // whenever the daemon replays, which is the loop. Seeding is what
    // makes the gate independent of the `?since=` query.
    const first = createSeqGate();
    expect(first.accept(4)).toBe(true);

    const afterReload = createSeqGate(4);
    expect(afterReload.accept(4)).toBe(false);
    expect(afterReload.accept(1)).toBe(false);
    expect(afterReload.accept(5)).toBe(true);

    // An UNSEEDED gate would re-accept 4 — which is why the rail seeds.
    expect(createSeqGate().accept(4)).toBe(true);
  });

  test("a nonsense seed is treated as zero rather than poisoning the gate", () => {
    expect(createSeqGate(-1).accept(1)).toBe(true);
    expect(createSeqGate(1.5).accept(1)).toBe(true);
    expect(createSeqGate(Number.NaN).accept(1)).toBe(true);
  });
});

describe("reply drafts expire", () => {
  const NOW = 1_800_000_000_000;

  test("a draft inside the TTL is restored verbatim", () => {
    const storage = fakeStorage();
    saveDraft(storage, "th-1", "half-typed prose", NOW);
    expect(readDraft(storage, "th-1", NOW + 60_000)?.text).toBe("half-typed prose");
    expect(readDraft(storage, "th-1", NOW + DRAFT_TTL_MS - 1)?.text).toBe("half-typed prose");
  });

  test("a draft past the TTL is GONE and the key is removed", () => {
    const storage = fakeStorage();
    saveDraft(storage, "th-1", "abandoned weeks ago", NOW);
    expect(readDraft(storage, "th-1", NOW + DRAFT_TTL_MS + 1)).toBeUndefined();
    // Removed, not merely hidden — otherwise it would be re-read on
    // every mount and never reclaim the space.
    expect(storage.getItem(`${DRAFT_KEY_PREFIX}th-1`)).toBeNull();
  });

  test("an empty draft clears the key instead of storing an empty envelope", () => {
    const storage = fakeStorage();
    saveDraft(storage, "th-1", "something", NOW);
    saveDraft(storage, "th-1", "", NOW + 1000);
    expect(storage.getItem(`${DRAFT_KEY_PREFIX}th-1`)).toBeNull();
    expect(readDraft(storage, "th-1", NOW + 1000)).toBeUndefined();
  });

  test("a pre-TTL bare-string draft is dropped, not restored blind", () => {
    // Restoring it would be exactly the stale-draft problem: prose of
    // unknown age, indistinguishable from something live.
    const storage = fakeStorage({ [`${DRAFT_KEY_PREFIX}th-legacy`]: "old format" });
    expect(readDraft(storage, "th-legacy", NOW)).toBeUndefined();
    expect(storage.getItem(`${DRAFT_KEY_PREFIX}th-legacy`)).toBeNull();
  });

  test("a structurally wrong envelope is dropped", () => {
    for (const value of ['{"savedAt":"nope","text":"x"}', '{"text":"x"}', '{"savedAt":1}', "[]", "null"]) {
      const storage = fakeStorage({ [`${DRAFT_KEY_PREFIX}th-1`]: value });
      expect(readDraft(storage, "th-1", NOW)).toBeUndefined();
      expect(storage.getItem(`${DRAFT_KEY_PREFIX}th-1`)).toBeNull();
    }
  });

  test("sweep drops only the expired drafts and leaves the rest alone", () => {
    const storage = fakeStorage();
    saveDraft(storage, "th-fresh", "recent", NOW);
    saveDraft(storage, "th-stale", "old", NOW - DRAFT_TTL_MS - 10_000);
    saveDraft(storage, "th-edge", "just inside", NOW - DRAFT_TTL_MS + 60_000);
    const removed = sweepExpiredDrafts(storage, NOW);
    expect(removed).toEqual([`${DRAFT_KEY_PREFIX}th-stale`]);
    expect(readDraft(storage, "th-fresh", NOW)?.text).toBe("recent");
    expect(readDraft(storage, "th-edge", NOW)?.text).toBe("just inside");
  });

  test("sweep leaves unrelated sessionStorage keys untouched", () => {
    // The rail shares sessionStorage with the resume point; a sweep
    // that swept everything would silently reset the reload-loop guard.
    const storage = fakeStorage({ [RESUME_SEQ_KEY]: "12" });
    saveDraft(storage, "th-stale", "old", NOW - DRAFT_TTL_MS - 1);
    sweepExpiredDrafts(storage, NOW);
    expect(readResumeSeq(storage)).toBe(12);
  });

  test("the envelope shape is what the module reads back", () => {
    const storage = fakeStorage();
    storage.setItem(`${DRAFT_KEY_PREFIX}th-1`, encodeDraft("text", NOW));
    expect(storage.getItem(`${DRAFT_KEY_PREFIX}th-1`)).toBe(`{"savedAt":${NOW},"text":"text"}`);
    expect(readDraft(storage, "th-1", NOW)).toEqual({ savedAt: NOW, text: "text" });
  });

  test("a future timestamp does not expire (conservative for the reviewer's words)", () => {
    const storage = fakeStorage();
    saveDraft(storage, "th-1", "typed on a skewed clock", NOW + 10 * DRAFT_TTL_MS);
    expect(readDraft(storage, "th-1", NOW)?.text).toBe("typed on a skewed clock");
  });

  test("an unavailable storage degrades instead of throwing", () => {
    const hostile: DraftStorage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => saveDraft(hostile, "th-1", "x", NOW)).not.toThrow();
    expect(readDraft(hostile, "th-1", NOW)).toBeUndefined();
    expect(sweepExpiredDrafts(hostile, NOW)).toEqual([]);
    expect(() => removeDraft(undefined, "th-1")).not.toThrow();
  });
});
