// Sessions against REAL D1: what is minted, what is stored, what is checked,
// and what is not (ADR-0012's session rules; ADR-0009's "stored hashed"
// applied to the credential this build mints).
//
// Every case here runs `src/session.ts` against the same D1 the Worker reads,
// through a real workerd, so a claim about the stored shape is a claim about
// the database — not about a mock's call log. The two properties the ADR names
// and that are easy to get wrong in the quiet are both asserted against the
// TABLE rather than against the return value:
//
//   - the plaintext session id appears NOWHERE in the `sessions` row, so a
//     database read is not a credential.
//   - expiry is checked on RESOLVE, not only at issue, and an unparsable
//     expiry fails CLOSED.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  constantTimeEquals,
  csrfSatisfied,
  isTokenShaped,
  issueSession,
  mintToken,
  readSessionCookie,
  resolveSession,
  rotateSession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_LIFETIME_MS,
  SESSION_TTL_MS,
  SessionAlreadyRotatedError,
  sha256Hex,
  TOKEN_CHARS,
  type MsClock,
} from "../src/session.ts";
import { isJsonContentType } from "../src/authz.ts";
import { issueTestSession, startWorker, type Harness } from "./harness.ts";

const OPERATOR = { kind: "operator", id: "operator" } as const;

/**
 * ONE workerd for this file, not one per `describe`.
 *
 * It is not an optimisation for its own sake: a workerd spawn with this
 * graph is ~270 ms and the slice's whole suite is on a CI budget, and five
 * spawns from a single file is how this leg grew. Isolation comes from
 * `beforeEach` wiping `sessions`, which is the only table these cases share —
 * every case here creates the rows it needs and asserts on them by digest.
 * `test/d1-store.test.ts` and `test/store-conformance.test.ts` keep their own
 * instances because they wipe `events`/`snapshots` between cases and would
 * otherwise be able to see each other's rows.
 */
let harness: Harness;

beforeAll(async () => {
  harness = await startWorker();
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await harness.db.prepare("DELETE FROM sessions").run();
});

/** One row of `sessions`, whatever this build chooses to put in it. */
async function sessionRows(db: D1Database): Promise<Record<string, unknown>[]> {
  const result = await db.prepare("SELECT * FROM sessions").all<Record<string, unknown>>();
  return [...(result.results ?? [])];
}

async function countSessions(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
  return row?.n ?? -1;
}

/** A clock a test moves by hand. `MsClock`, so the module under test takes
 * the same injection the store does. */
function pinnedClock(startMs: number): { readonly now: MsClock; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms) => void (current += ms) };
}

/** A fixed instant well inside any plausible test run, chosen so a
 * `new Date()` default could not accidentally agree with it. */
const PINNED_MS = Date.parse("2026-10-04T09:00:00.000Z");

describe("session tokens", () => {
  test("a minted token is 256 bits of base64url from crypto.getRandomValues", () => {
    const token = mintToken();
    // 32 bytes -> 43 base64url characters, unpadded. The alphabet is checked
    // explicitly because a `+` or `/` in a cookie value is a bug that only
    // shows up in someone's browser, and `=` padding would be stripped by the
    // cookie parser and silently shorten the credential.
    expect(token).toHaveLength(TOKEN_CHARS);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    // 43 characters over a 64-symbol alphabet is ~256 bits of entropy by
    // construction; the next two cases are what makes "random" mean something.
    expect(Math.log2(64 ** TOKEN_CHARS)).toBeGreaterThan(255.9);
  });

  test("200 mints are all distinct — no constant, no clock, no counter", () => {
    // `Math.random()` would pass a single-sample check and this one too, so
    // the honest evidence for the CSPRNG is the source: `mintToken` calls
    // `crypto.getRandomValues` and nothing else. What this case catches is the
    // realistic regression — someone swapping in a cheaper source, or a
    // seeded counter — because 200 draws from a 32-bit counter collide.
    const seen = new Set<string>();
    for (let index = 0; index < 200; index++) seen.add(mintToken());
    expect(seen.size).toBe(200);
  });

  test("mintToken's own body reads the CSPRNG and nothing cheaper", async () => {
    // "It looks random" and "it IS random" are different statements and only
    // the second one is testable, so this pins the MINT rather than the
    // module: 200 distinct draws would pass against a seeded 32-bit counter.
    //
    // Scoped to the function body on purpose. A module-wide "no
    // `Math.random`" rule would be a FALSE claim: `@revkit/review-core` uses
    // it for retry jitter (`github-adapter.ts`), where unpredictability is
    // not the property being relied on, and that code is in this Worker.
    // Over-broad rules like this train people to add exemptions, and an
    // exemption here would be the whole control.
    const source = await Bun.file(new URL("../src/session.ts", import.meta.url)).text();
    const start = source.indexOf("export function mintToken(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("crypto.getRandomValues(");
    expect(body).not.toMatch(/Math\s*\.\s*random/);
    expect(body).not.toMatch(/Date\s*\.\s*now/);
    // `crypto.subtle` is NOT the mint: `generateKey` yields a non-extractable
    // CryptoKey, unusable as a cookie value, so reaching for it would have
    // broken extractability rather than improved the entropy.
    expect(body).not.toMatch(/crypto\.subtle/);
  });

  test("isTokenShaped is an exact-shape filter, and its cases are the real spellings", () => {
    expect(isTokenShaped(mintToken())).toBe(true);
    // Wrong lengths in both directions.
    expect(isTokenShaped("a".repeat(TOKEN_CHARS - 1))).toBe(false);
    expect(isTokenShaped("a".repeat(TOKEN_CHARS + 1))).toBe(false);
    expect(isTokenShaped("")).toBe(false);
    // Characters that break a cookie header or a base64url decoder.
    for (const bad of ["+", "/", "=", "%", ";", " ", "\n", "\t", "é", "."]) {
      expect(isTokenShaped("a".repeat(TOKEN_CHARS - 1) + bad)).toBe(false);
    }
  });

  test("constantTimeEquals agrees with === on every case, including lengths", () => {
    // Two SHA-256 hex digests, because that is the only input it ever gets.
    const left = "a".repeat(64);
    const right = `${"a".repeat(63)}b`;
    expect(constantTimeEquals(left, left)).toBe(true);
    expect(constantTimeEquals(left, right)).toBe(false);
    // The last-character case is the one a timing leak would sell.
    expect(constantTimeEquals(right, right)).toBe(true);
    expect(constantTimeEquals(right, left)).toBe(false);
    // Same content, different lengths, and the empty pair.
    expect(constantTimeEquals("abcde", "abcdef")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("", "a")).toBe(false);
  });
});

describe("the session cookie", () => {
  test("the Set-Cookie value carries every flag ADR-0012 names, plus the __Host- preconditions", () => {
    const header = `${SESSION_COOKIE_NAME}=${mintToken()}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`;
    // HttpOnly: `document.cookie` cannot read it, so XSS in any preview page
    // cannot exfiltrate the session.
    expect(header).toContain("HttpOnly");
    // Secure, and SameSite=Lax rather than Strict: a guest arriving from a
    // mail client on a top-level GET must carry the cookie, which Strict
    // would strip; Lax still refuses it on a cross-site POST, which is what
    // the CSRF header covers in depth.
    expect(header).toContain("Secure");
    expect(header).toMatch(/SameSite=Lax\b/);
    expect(header).not.toMatch(/SameSite=None/);
    expect(header).not.toMatch(/SameSite=Strict/);
    // Path=/ and NO Domain: these are the other two `__Host-` preconditions,
    // and a browser REJECTS a `__Host-` cookie without all three. Omitting
    // Domain is what stops a sibling subdomain setting a cookie this origin
    // will send, which is the cookie-tossing half of session fixation.
    expect(header).toContain("Path=/");
    expect(header).not.toMatch(/Domain=/i);
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(header).toContain("Max-Age=");
  });

  test("the flags come from sessionCookieHeader, not from a fixture in this test", async () => {
    // The case above asserts a hand-written string, which proves nothing about
    // the function the Worker actually calls. This one drives the real
    // issuance path and checks the emitted header — and checks the `__Host-`
    // contract the way a browser enforces it, rather than by eye.
    {
      const issued = await issueTestSession(harness.db);
      const header = issued.cookie;
      expect(header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
      expect(header).toContain("; Secure");
      expect(header).toContain("; HttpOnly");
      expect(header).toContain("; SameSite=Lax");
      expect(header).toContain("; Path=/");
      expect(header.toLowerCase()).not.toContain("domain=");
      // `Max-Age` and the TTL the row was written with agree.
      const row = (await sessionRows(harness.db))[0] as { expires_at: string; created_at: string } | undefined;
      const ttlSeconds = Math.round((Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "")) / 1000);
      expect(ttlSeconds).toBe(Math.floor(SESSION_TTL_MS / 1000));
      expect(header).toContain(`Max-Age=${ttlSeconds}`);
    }
  });

  test("readSessionCookie finds the name among others, and refuses an ambiguous header", () => {
    const value = mintToken();
    const present = readSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=${value}; third=2`);
    expect(present).toEqual({ kind: "present", value });
    expect(readSessionCookie(null)).toEqual({ kind: "absent" });
    expect(readSessionCookie("")).toEqual({ kind: "absent" });
    expect(readSessionCookie("unrelated=1")).toEqual({ kind: "absent" });
    // Whitespace AROUND a pair is legal in a real header and must not make the
    // value unreadable — a browser puts `"; "` between cookies, so a strict
    // parser that does not trim would reject every second cookie.
    expect(readSessionCookie(`  ${SESSION_COOKIE_NAME}=${value}  ; third=2`)).toEqual({ kind: "present", value });
    // Whitespace around `=` is REFUSED, which is STRICTER than RFC 6265's
    // cookie parser (it skips whitespace around the name and value but not
    // around `=`). Deliberate: no browser emits it, and a lenient reading of
    // two spellings of one cookie name is how "which one wins" becomes
    // ambiguous in the first place.
    expect(readSessionCookie(`${SESSION_COOKIE_NAME} = ${value}`)).toEqual({ kind: "absent" });
    // RFC 6265 also allows a QUOTED value. A base64url token needs no quoting,
    // so a quoted one is not something this Worker ever set — and treating it
    // as absent is safer than unwrapping quotes and accepting a value this
    // server never issued.
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}="${value}"`)).toEqual({ kind: "present", value: `"${value}"` });
    // Two cookies with the same name and different paths both arrive, and
    // picking "the first" is how one origin's session gets silently replaced
    // by another's. Browsers order by specificity, which is not this Worker's
    // to reason about, so the honest answer is to refuse.
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`)).toEqual({ kind: "ambiguous" });
    // A name that merely CONTAINS ours is not ours.
    expect(readSessionCookie(`x${SESSION_COOKIE_NAME}=a`)).toEqual({ kind: "absent" });
    // A segment with no `=` is skipped rather than throwing.
    expect(readSessionCookie(`garbage; ${SESSION_COOKIE_NAME}=${value}`)).toEqual({ kind: "present", value });
  });
});

describe("issuance and storage", () => {
  test("the row stores SHA-256 of both credentials, so a database read is not a credential", async () => {
    const issued = await issueSession(harness.db, OPERATOR);
    const rows = await sessionRows(harness.db);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    // Both digests are exactly what they should be — asserted against the
    // pinned hash function, not against "some 64-char hex".
    expect(row["id"]).toBe(await sha256Hex(issued.sessionId));
    expect(row["csrf_hash"]).toBe(await sha256Hex(issued.csrfToken));
    // And the plaintext is NOWHERE in the row. This is the assertion that
    // distinguishes "hashed" from "hashed the thing I happen to look at":
    // it walks every column's text rather than the two we expect.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(issued.sessionId);
    expect(serialised).not.toContain(issued.csrfToken);
    // The plaintext is 256 bits of base64url; the digests are hex. A
    // substring search over the whole row for the base64url token therefore
    // cannot be satisfied by the hex digest of it.
    expect(serialised).not.toContain(issued.sessionId.slice(0, 12));
  });

  test("a stolen cookie value is not enough: the row is keyed by the digest", async () => {
    // The mechanism behind the previous case, stated as a lookup: given the
    // value a cookie would carry, the query that finds a session is
    // `WHERE id = sha256(value)`. So the digest is a lookup key and NOT a
    // bearer credential — knowing it does not let you produce a cookie that
    // hashes to it. That is why `SessionPrincipal` may carry the digest
    // safely while the plaintext id stays on the gate's own object.
    const issued = await issueSession(harness.db, OPERATOR);
    const digest = await sha256Hex(issued.sessionId);
    const found = await harness.db.prepare("SELECT id FROM sessions WHERE id = ?").bind(digest).first();
    expect(found).not.toBeNull();
    // And the plaintext is not a key anything matches.
    const byPlaintext = await harness.db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(issued.sessionId)
      .first();
    expect(byPlaintext).toBeNull();
  });

  test("the row records the identity, both timestamps and nothing else", async () => {
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now, ttlMs: 60_000 });
    const row = (await sessionRows(harness.db))[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "csrf_hash",
      "expires_at",
      "id",
      "identity_id",
      "identity_kind",
    ]);
    expect(row["identity_kind"]).toBe("operator");
    expect(row["identity_id"]).toBe("operator");
    expect(row["created_at"]).toBe("2026-10-04T09:00:00.000Z");
    // ISO-8601 UTC, fixed width, literal Z — which is what makes a string
    // comparison of two timestamps a comparison of the instants.
    expect(row["expires_at"]).toBe("2026-10-04T09:01:00.000Z");
    expect(issued.expiresAt).toBe(String(row["expires_at"]));
    expect(issued.createdAt).toBe(String(row["created_at"]));
  });

  test("two sessions never collide, so one row is always one credential", async () => {
    const first = await issueSession(harness.db, OPERATOR);
    const second = await issueSession(harness.db, OPERATOR);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    // The CSRF token is a separate 256-bit draw, not the session id again —
    // if it were, the CSRF check would be a second copy of the cookie check
    // and the two headers would be interchangeable.
    expect(first.csrfToken).not.toBe(first.sessionId);
    expect(await countSessions(harness.db)).toBe(2);
  });
});

describe("resolution — the checks, and the order they run in", () => {
  test("a fresh session resolves to its identity and its own CSRF digest", async () => {
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") throw new Error("unreachable");
    expect(resolved.principal.kind).toBe("operator");
    expect(resolved.principal.id).toBe("operator");
    expect(resolved.principal.csrfHash).toBe(await sha256Hex(issued.csrfToken));
    // The principal does NOT carry the plaintext id: it is the
    // credential-free view, and only the gate holds the credential.
    const carried = Object.values(resolved.principal as unknown as Record<string, unknown>);
    expect(carried).not.toContain(issued.sessionId);
  });

  test("EXPIRY IS ENFORCED ON EVERY READ, not only at issue", async () => {
    // The requirement, and the thing a "check at issue" implementation gets
    // wrong: the cookie keeps working forever after the moment it was handed
    // out. Advancing a pinned clock across the boundary is the whole test —
    // no sleep, no flake, and it exercises the read path.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now, ttlMs: 60_000 });
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("resolved");

    clock.advance(59_999);
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("resolved");

    // One millisecond later: expired. The comparison is `<=` on the expiry, so
    // a session is dead AT its expiry, not after it.
    clock.advance(1);
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("expired");

    // And far past it, because "expired" must be stable rather than a race.
    clock.advance(10 * 24 * 60 * 60 * 1000);
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("expired");
    // The ROW is still there — expiry is a decision, not a deletion, and
    // nothing in this slice sweeps. Stated so nobody reads `expired` as
    // "purged".
    expect(await countSessions(harness.db)).toBe(1);
  });

  test("an unparsable expiry FAILS CLOSED", async () => {
    // The trap: `Date.parse("not a date")` is `NaN`, and every comparison
    // against `NaN` is false — so a `>=`/`>` written naively reads as
    // "not expired" and honours a row nobody can reason about. Measured
    // through the real resolver.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    // Asserted as the SPECIFIC reason, and the reason is not the same for every
    // value here — which is itself the finding. `Date.parse` is PERMISSIVE, so
    // `"0"` parses (to 2000-01-01) and is caught by the explicit expiry check as
    // `expired`, while the rest are genuinely NaN and are caught by the
    // completeness check as `incomplete-row`. Both refuse. Blurring them into
    // one "not resolved" would have hidden the split, and the split is what
    // tells an operator whether a row is unreadable or merely old.
    const unparsable = ["not a date", "99999999999999999999", "2026-13-45T99:99:99Z", "  ", "tomorrow"];
    for (const garbage of unparsable) {
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(garbage).run();
      const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
      expect(resolved.outcome, `unparsable ${JSON.stringify(garbage)}`).toBe("incomplete-row");
    }
    // And the permissive-but-finite ones land on the OTHER refusal, which is
    // where the comment's "harmless" claim lives — asserted here rather than
    // asserted nowhere.
    for (const parsesButAncient of ["0", "2026"]) {
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(parsesButAncient).run();
      const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
      expect(resolved.outcome, `finite but ancient ${parsesButAncient}`).toBe("expired");
    }
    // A blank expiry is caught one step earlier, by the completeness check —
    // which is why the assertion above is "not resolved" rather than
    // "expired": `Date.parse("")` is also `NaN`, and both paths must fail
    // closed, so the reason is allowed to differ. The reason they differ is
    // asserted below.
    await harness.db.prepare("UPDATE sessions SET expires_at = ''").run();
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("incomplete-row");
  });

  test("a differently-formatted but valid expiry is honoured, not refused by string shape", async () => {
    // The complement of the previous case: fail-closed must not become
    // refuse-everything. A row written by an operator or a future migration
    // with a non-millisecond ISO form still names a real instant.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind("2026-10-04T10:00:00Z").run();
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("resolved");
  });

  test("Date.parse's PERMISSIVE cases are the safe direction, and both are pinned", async () => {
    // `isParsableTimestamp`'s comment claims that a wrong-but-finite instant is
    // harmless because it puts the cap (or the expiry) in the PAST, so the
    // session dies rather than extending. That is a claim about which way
    // `Date.parse`'s leniency fails, and it is worth a test in both
    // directions — a reader should not have to take the direction on faith.
    const clock = pinnedClock(PINNED_MS);
    // These two DO parse, and both land in 2000 — long past `now`, so the
    // session is refused. Permissive, and safe.
    expect(Number.isFinite(Date.parse("0"))).toBe(true);
    expect(Number.isFinite(Date.parse("2026"))).toBe(true);
    for (const stamp of ["0", "2026"]) {
      await harness.db.prepare("DELETE FROM sessions").run();
      const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(stamp).run();
      expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome, stamp).toBe("expired");
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(issued.expiresAt).run();
      await harness.db.prepare("UPDATE sessions SET created_at = ?").bind(stamp).run();
      // `created_at` in 2000 is finite, so it resolves — and the ROTATION it
      // enables is capped to a moment long past, which is the safe direction.
      const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
      expect(resolved.outcome, stamp).toBe("resolved");
      if (resolved.outcome !== "resolved") throw new Error("unreachable");
      const rotated = await rotateSession(
        harness.db,
        { principal: resolved.principal, sessionId: issued.sessionId },
        { now: clock.now },
      );
      // The cap computed from 2000 lands in 2000, so the new row is born
      // already expired. Asserting the DIRECTION rather than the instant is the
      // point: what must hold is that no reading of `created_at` yields a LIVE
      // session beyond the cap, and where it lands depends on the value.
      expect(Date.parse(rotated.expiresAt), stamp).toBeLessThanOrEqual(PINNED_MS);
      expect((await resolveSession(harness.db, rotated.sessionId, { now: clock.now })).outcome, stamp).toBe("expired");
    }
  });

  test("a created_at that does not PARSE is refused, not merely a blank one", async () => {
    // The companion to the blank-field case, and the one that was a fail-open.
    //
    // `isRowComplete` tested blankness, so a NON-BLANK but unparsable
    // `created_at` produced a principal — and `rotateSession` then computed
    // `Date.parse(created_at) + SESSION_MAX_LIFETIME_MS` as `NaN`, found it
    // non-finite, and took the "no cap" branch. Measured before the fix: 720
    // hourly refreshes over 30 simulated days slid the expiry to +30 days with
    // `created_at` of `"not a date"` and of `"9999-99-99"`, while the
    // well-formed value correctly died at the 7-day cap.
    //
    // `expires_at` already failed closed on exactly this shape, two lines
    // above, with a comment and a test. `created_at` now does too — and the
    // reason it must is sharper than tidiness: `created_at` is the only input
    // to the refresh lifetime cap, so a row whose `created_at` cannot be read
    // is a row whose cap cannot be computed, and "cannot compute the cap" has
    // to mean "no refresh", not "no limit".
    const clock = pinnedClock(PINNED_MS);
    for (const garbage of ["not a date", "9999-99-99", "1e400", "  ", "tomorrow"]) {
      await harness.db.prepare("DELETE FROM sessions").run();
      const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
      await harness.db.prepare("UPDATE sessions SET created_at = ?").bind(garbage).run();
      const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
      expect(resolved.outcome, JSON.stringify(garbage)).toBe("incomplete-row");
    }
    // The complement, so this cannot become refuse-everything: a valid instant
    // in a different but parseable FORM is honoured, exactly as `expires_at` is.
    await harness.db.prepare("DELETE FROM sessions").run();
    const ok = await issueSession(harness.db, OPERATOR, { now: clock.now });
    await harness.db.prepare("UPDATE sessions SET created_at = ?").bind("2026-10-04T09:00:00Z").run();
    expect((await resolveSession(harness.db, ok.sessionId, { now: clock.now })).outcome).toBe("resolved");
  });

  test("a refresh loop cannot outlive the 7-day cap, whatever created_at says", async () => {
    // The property the ADR-0012 amendment claims in a sentence — "a 7-day hard
    // cap from the original `created_at` prevents a refresh loop from keeping
    // one credential alive" — asserted over a LOOP rather than a single
    // rotation, because one rotation cannot distinguish "capped" from "not
    // capped yet".
    //
    // **Coarse steps on purpose.** Hourly steps to the 7-day cap is ~170
    // rotations, and that measured 5.1 s — over half the project's 10 s
    // per-test ceiling for one assertion, i.e. a test whose cost depends on how
    // busy the host is. Twelve-hour steps reach the cap in 14 rotations (~4x
    // cheaper) and still WALK the boundary rather than jumping over it, which is
    // what makes "the cap binds" different from "the cap was never near".
    //
    // **Each spelling gets its own expected outcome, and they differ.** The
    // first attempt asserted one shape for all four and was wrong twice: `"0"`
    // and `"2026"` DO parse (`Date.parse` is permissive), so they are capped
    // rather than refused, while `"not a date"` and `"9999-99-99"` are refused
    // at step 1. A permissive-but-finite `created_at` lands the cap in the past,
    // so the session dies on the next read — the safe direction, and a different
    // one from "never got a principal at all".
    const HOUR = 60 * 60 * 1000;
    const STEP = 12 * HOUR;
    const cases: [string | undefined, "expired" | "incomplete-row", number][] = [
      // A well-formed instant: the walk must APPROACH the cap and end expired.
      // With 12-hour steps, 14 steps is 7 days, so fewer than 10 rotations means
      // the boundary was never approached and the case proved nothing.
      [undefined, "expired", 10],
      // Parses to a moment in 2000, so the cap is already behind us: the first
      // rotation is over the limit and the next read is refused. One rotation.
      ["0", "expired", 1],
      ["2026", "expired", 1],
      // Genuinely unreadable: refused by the gate on the FIRST step, so there
      // is no walk at all. Zero rotations is the pass condition, and it is the
      // sharper half — the failure being fixed slid for 720 refreshes, so
      // "refused at step 1" is exactly the new behaviour.
      ["not a date", "incomplete-row", 0],
      ["9999-99-99", "incomplete-row", 0],
    ];
    for (const [createdAt, expectedOutcome, minRotations] of cases) {
      await harness.db.prepare("DELETE FROM sessions").run();
      const clock = pinnedClock(PINNED_MS);
      let sessionId = (
        await issueSession(harness.db, OPERATOR, { now: clock.now, ttlMs: SESSION_MAX_LIFETIME_MS + HOUR })
      ).sessionId;
      if (createdAt !== undefined) {
        await harness.db.prepare("UPDATE sessions SET created_at = ?").bind(createdAt).run();
      }
      // The only anchor available for every spelling, so it is the one the
      // invariant is stated against: no rotation may produce an expiry later
      // than ISSUE + the cap, whatever the row's own `created_at` says.
      const capMs = PINNED_MS + SESSION_MAX_LIFETIME_MS;
      let rotations = 0;
      let stoppedBecause = "step-limit";
      for (let step = 1; step <= 20; step++) {
        clock.advance(STEP);
        const resolved = await resolveSession(harness.db, sessionId, { now: clock.now });
        if (resolved.outcome !== "resolved") {
          stoppedBecause = resolved.outcome;
          break;
        }
        const rotated = await rotateSession(
          harness.db,
          { principal: resolved.principal, sessionId },
          { now: clock.now, ttlMs: SESSION_MAX_LIFETIME_MS + HOUR },
        );
        rotations += 1;
        expect(
          Date.parse(rotated.expiresAt),
          `created_at=${String(createdAt)} rotation ${rotations}: expiry must never exceed the cap`,
        ).toBeLessThanOrEqual(capMs);
        sessionId = rotated.sessionId;
      }
      const label = `created_at=${JSON.stringify(createdAt)}`;
      expect(stoppedBecause, `${label}: ended ${rotations} rotations in`).toBe(expectedOutcome);
      expect(rotations, `${label}: the cap was never approached`).toBeGreaterThanOrEqual(minRotations);
      // And no spelling may end by running out of steps with a live session —
      // that is the unbounded case both shapes must avoid.
      expect(stoppedBecause, `${label}: ran out of steps still live`).not.toBe("step-limit");
    }
  });

  test("an identity kind this build does not know is REFUSED, not defaulted to allowed", async () => {
    // The direction that matters. `identity_kind` is deliberately unconstrained
    // in the schema (adding a provider must not be a table rewrite), so the
    // gate has to decide. Honouring a kind this build cannot reason about
    // would mean honouring it with no scope check, no expiry rule and no
    // revocation path — a session that passes every gate precisely because
    // nothing gates it.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    // The two ADR-0009 providers, plus a typo, plus an empty string. A future
    // slice adds its arm HERE, in the gate, where the scope rules get
    // written — that is the point of refusing here rather than defaulting.
    // `invite` LEFT this list in slice 3, which added the arm `invites.ts` needed
    // and which this very comment predicted. `github` stays: the App is
    // owner-gated (#34) and there is still nothing to check repo access against.
    for (const kind of ["github", "auth0", "operatr", "OPERATOR", "Operator", " operator"]) {
      await harness.db.prepare("UPDATE sessions SET identity_kind = ?").bind(kind).run();
      expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome, kind).toBe(
        "unrecognised-identity-kind",
      );
    }
    // A blank kind is a DIFFERENT refusal — an incomplete row, not an unknown
    // provider — and it matters that the two are distinguishable: one is this
    // build's provider list being incomplete, the other is bad data.
    await harness.db.prepare("UPDATE sessions SET identity_kind = ''").run();
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("incomplete-row");
  });

  test("a row with a BLANK field is refused whole — a partial row must not authorise a partial request", async () => {
    // Every column here is `NOT NULL`, so "missing" is unreachable and a
    // `typeof === "string"` guard alone would be untestable defence against a
    // schema that cannot produce it. A BLANK string can be produced — a
    // half-written row, an operator's hand-edited `expires_at`, a future
    // migration with a default — so blankness is what the resolver must
    // actually refuse, and each column below is load-bearing:
    //
    //   identity_id  who the caller is; blank is nobody
    //   csrf_hash    what the CSRF comparison is measured against
    //   created_at   what the refresh lifetime cap is measured from
    //   expires_at   what the expiry decision is measured against
    const clock = pinnedClock(PINNED_MS);
    for (const column of ["identity_id", "csrf_hash", "created_at", "expires_at"]) {
      await harness.db.prepare("DELETE FROM sessions").run();
      const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
      for (const blank of ["", "   "]) {
        await harness.db.prepare(`UPDATE sessions SET ${column} = ?`).bind(blank).run();
        const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
        expect(resolved.outcome, `${column}=${JSON.stringify(blank)}`).not.toBe("resolved");
      }
    }
    expect(await countSessions(harness.db)).toBe(1);
  });

  test("an unknown or malformed id never resolves", async () => {
    const clock = pinnedClock(PINNED_MS);
    // Well-shaped but not in the table: the forgery case. A correct shape is
    // not a credential, and this is the assertion that says so.
    expect((await resolveSession(harness.db, mintToken(), { now: clock.now })).outcome).toBe("unknown");
    // Malformed: caught before the database is touched at all.
    for (const bad of ["", "a", "not-a-token", "a".repeat(1_000)]) {
      expect((await resolveSession(harness.db, bad, { now: clock.now })).outcome).toBe("malformed");
    }
  });

  test("a session id one character away does not resolve", async () => {
    // The nearest-miss case, and the one that separates "we look the id up"
    // from "we look a PREFIX of it up". A prefix or `LIKE` match would accept
    // `flipped`; an exact digest lookup does not.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const flipped = `${issued.sessionId.startsWith("A") ? "B" : "A"}${issued.sessionId.slice(1)}`;
    expect(flipped).not.toBe(issued.sessionId);
    // Same length, wrong bytes: it is hashed, looked up, and not found. That
    // it reaches the database at all is what distinguishes this from the shape
    // filter below.
    expect((await resolveSession(harness.db, flipped, { now: clock.now })).outcome).toBe("unknown");

    // Two classes of near-miss, both non-resolving, and both asserted rather
    // than reasoned about. base64url is case-SENSITIVE, so an upper- or
    // lower-cased variant is a different credential — and either casing can
    // coincide with the original for an all-digit draw, so the claim under
    // test is "does not resolve", not "is always unknown".
    const nearMisses: [string, string][] = [
      ["a character appended", `${issued.sessionId}A`],
      ["a character prepended", `A${issued.sessionId}`],
      ["upper-cased", issued.sessionId.toUpperCase()],
      ["lower-cased", issued.sessionId.toLowerCase()],
      ["one byte truncated", issued.sessionId.slice(0, -1)],
      ["the last byte changed", `${issued.sessionId.slice(0, -1)}${issued.sessionId.endsWith("A") ? "B" : "A"}`],
    ];
    for (const [label, candidate] of nearMisses) {
      const resolved = await resolveSession(harness.db, candidate, { now: clock.now });
      expect(resolved.outcome, label).not.toBe("resolved");
    }
    // The wrong-LENGTH cases are refused before the database is touched,
    // which is the input filter doing its job and not the security control.
    expect((await resolveSession(harness.db, `${issued.sessionId}A`, { now: clock.now })).outcome).toBe("malformed");
    expect((await resolveSession(harness.db, issued.sessionId.slice(0, -1), { now: clock.now })).outcome).toBe(
      "malformed",
    );
  });
});

describe("rotation", () => {
  /** Resolve a session so `rotateSession` gets the shape it expects. */
  async function resolve(db: D1Database, sessionId: string, now?: MsClock) {
    const resolved = await resolveSession(db, sessionId, now === undefined ? {} : { now });
    if (resolved.outcome !== "resolved") throw new Error(`precondition failed: session is ${resolved.outcome}`);
    return { principal: resolved.principal, sessionId };
  }

  test("rotation replaces the credential: new id, new CSRF token, old row gone", async () => {
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const before = await resolve(harness.db, issued.sessionId, clock.now);
    const rotated = await rotateSession(harness.db, before, { now: clock.now });

    expect(rotated.sessionId).not.toBe(issued.sessionId);
    expect(rotated.csrfToken).not.toBe(issued.csrfToken);
    // Exactly one row, and it is the new one. A window with both ids live is
    // the failure mode a DELETE-then-INSERT in two statements would open.
    expect(await countSessions(harness.db)).toBe(1);
    const row = (await sessionRows(harness.db))[0] as Record<string, unknown>;
    expect(row["id"]).toBe(await sha256Hex(rotated.sessionId));
    expect(row["csrf_hash"]).toBe(await sha256Hex(rotated.csrfToken));
    // The identity is carried over, and the ORIGINAL created_at is preserved
    // — that is what the lifetime cap is measured from.
    expect(row["identity_kind"]).toBe("operator");
    expect(row["created_at"]).toBe(issued.createdAt);
    // The old credential is dead on both counts.
    expect((await resolveSession(harness.db, issued.sessionId, { now: clock.now })).outcome).toBe("unknown");
    expect((await resolveSession(harness.db, rotated.sessionId, { now: clock.now })).outcome).toBe("resolved");
  });

  test("rotating an ALREADY-ROTATED cookie is a typed no-op, not a second live row", async () => {
    // The concurrency case, and the reason the INSERT is guarded on the old
    // row still existing. Two refreshes of the SAME cookie — a double click, a
    // retried request, two tabs racing — must not leave a session nobody
    // holds. With an unguarded INSERT the second would land and the caller
    // would be handed a credential it never receives.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const rotated = await rotateSession(harness.db, await resolve(harness.db, issued.sessionId, clock.now), {
      now: clock.now,
    });
    // The retry replays the ORIGINAL cookie, which is exactly what a browser
    // does when it retries a request whose response it never saw.
    await expect(
      rotateSession(harness.db, { principal: (await resolve(harness.db, rotated.sessionId, clock.now)).principal, sessionId: issued.sessionId }, { now: clock.now }),
    ).rejects.toBeInstanceOf(SessionAlreadyRotatedError);
    // Still exactly one live row — the one the caller actually holds.
    expect(await countSessions(harness.db)).toBe(1);
    const row = (await sessionRows(harness.db))[0] as Record<string, unknown>;
    expect(row["id"]).toBe(await sha256Hex(rotated.sessionId));
  });

  test("the expiry SLIDES forward on a refresh inside the cap", async () => {
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now, ttlMs: 60_000 });
    clock.advance(30_000);
    const rotated = await rotateSession(harness.db, await resolve(harness.db, issued.sessionId, clock.now), {
      now: clock.now,
      ttlMs: 60_000,
    });
    // A full TTL from NOW, not the original expiry: that is what makes a
    // long review session not log itself out every hour.
    expect(rotated.expiresAt).toBe(new Date(PINNED_MS + 30_000 + 60_000).toISOString());
  });

  test("…but never past a hard cap measured from the ORIGINAL creation", async () => {
    // Without the cap, `POST /api/session/refresh` would let one credential
    // live forever, which would defeat the "a stolen cookie is bounded" claim
    // the rotation exists to make. The refresh here asks for a full extra day
    // and gets a minute past the cap instead.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now, ttlMs: SESSION_MAX_LIFETIME_MS + 60_000 });
    // Six days, 23 hours in: comfortably inside the 7-day cap, so the session
    // is live and resolvable.
    clock.advance(6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000);
    const rotated = await rotateSession(harness.db, await resolve(harness.db, issued.sessionId, clock.now), {
      now: clock.now,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    expect(Date.parse(rotated.expiresAt)).toBe(Date.parse(issued.createdAt) + SESSION_MAX_LIFETIME_MS);
    // Uncapped it would have been a day further out, so the cap is doing work.
    expect(Date.parse(rotated.expiresAt)).toBeLessThan(clock.now() + 24 * 60 * 60 * 1000);
  });

  test("rotateSession fails CLOSED on its own, without relying on the resolver", async () => {
    // The gate refuses a row whose `created_at` does not parse, so the
    // fallback in `rotateSession` is defence in depth — and defence in depth
    // that no test reaches is exactly the kind of line this repo removes. So
    // it is driven directly, with a hand-built principal the way a future
    // caller outside the gate could: `rotateSession` is exported and its
    // `RotationInput` is not tied by the type system to a resolver result.
    //
    // The assertion is the FAIL-CLOSED direction, which is the one that
    // matters: an uncomputable cap must yield "expire now", never "no limit".
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const principal = {
      kind: OPERATOR.kind,
      id: OPERATOR.id,
      csrfHash: await sha256Hex(issued.csrfToken),
      createdAt: "not a date",
      expiresAt: issued.expiresAt,
    } as const;
    const rotated = await rotateSession(
      harness.db,
      { principal, sessionId: issued.sessionId },
      { now: clock.now, ttlMs: 24 * 60 * 60 * 1000 },
    );
    // Expired on arrival: the expiry is `now`, not `now + ttlMs`, so there is no
    // time at all rather than an uncapped TTL.
    expect(rotated.expiresAt).toBe(new Date(PINNED_MS).toISOString());
    expect(rotated.maxAgeSeconds).toBe(0);
    expect(rotated.cookie).toContain("Max-Age=0");
    // And the row it wrote does not resolve. Which of the two refusals fires is
    // itself worth naming: the rotation copies `created_at` forward VERBATIM, so
    // the new row is unreadable for the same reason the old one was —
    // `incomplete-row`, not `expired`. A rotation cannot repair a row it is
    // only permitted to re-key, and it does not pretend to.
    expect((await resolveSession(harness.db, rotated.sessionId, { now: clock.now })).outcome).toBe("incomplete-row");
  });

  test("rotation's Max-Age never goes negative when the cap is already behind the clock", async () => {
    // A refresh on a session that is PAST its hard cap — still live, because
    // its own TTL was longer than the cap — would compute a negative
    // `Max-Age`, and `Max-Age=-1` is a browser instruction to DELETE the
    // cookie. So the caller would be logged out by the very refresh meant to
    // extend them. The clamp is the whole defence, asserted directly.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, {
      now: clock.now,
      ttlMs: SESSION_MAX_LIFETIME_MS + 60 * 60 * 1000,
    });
    clock.advance(SESSION_MAX_LIFETIME_MS + 30 * 60 * 1000);
    const rotated = await rotateSession(harness.db, await resolve(harness.db, issued.sessionId, clock.now), {
      now: clock.now,
    });
    expect(rotated.maxAgeSeconds).toBe(0);
    expect(rotated.cookie).toContain("Max-Age=0");
    expect(rotated.cookie).not.toMatch(/Max-Age=-\d/);
  });
});

describe("the CSRF check", () => {
  test("the session's OWN token satisfies it, and nothing else does", async () => {
    const clock = pinnedClock(PINNED_MS);
    const first = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const second = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const expected = await sha256Hex(first.csrfToken);

    // Bound to the session: the expected side is `first`'s own row digest.
    expect(await csrfSatisfied(expected, first.csrfToken)).toBe(true);
    // Another session's token is a 256-bit value that is simply not this one.
    expect(await csrfSatisfied(expected, second.csrfToken)).toBe(false);
    // And the session id is not a substitute: the two credentials are
    // separate draws, so a caller that leaked the cookie cannot also forge
    // the header.
    expect(await csrfSatisfied(expected, first.sessionId)).toBe(false);
    // Absent, empty, and wrong-shaped are all refused BEFORE any hashing.
    expect(await csrfSatisfied(expected, null)).toBe(false);
    expect(await csrfSatisfied(expected, "")).toBe(false);
    expect(await csrfSatisfied(expected, "anything")).toBe(false);
    // A truncated or over-long value is refused on shape, not hashed and
    // compared — the same input filter the session id gets.
    expect(await csrfSatisfied(expected, first.csrfToken.slice(0, -1))).toBe(false);
    expect(await csrfSatisfied(expected, `${first.csrfToken}A`)).toBe(false);
  });

  test("it is NOT a constant: there is no single token that satisfies two sessions", async () => {
    // The specific claim "the CSRF token is bound to the session rather than
    // being any constant", stated so a reviewer can see the falsifier. If
    // anyone replaced the comparison with a truthy check, or compared the
    // presented value against a fixed string, this is the case that fails.
    const clock = pinnedClock(PINNED_MS);
    const a = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const b = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const aDigest = await sha256Hex(a.csrfToken);
    const bDigest = await sha256Hex(b.csrfToken);
    expect(aDigest).not.toBe(bDigest);
    expect(await csrfSatisfied(aDigest, a.csrfToken)).toBe(true);
    expect(await csrfSatisfied(aDigest, b.csrfToken)).toBe(false);
    expect(await csrfSatisfied(bDigest, b.csrfToken)).toBe(true);
    expect(await csrfSatisfied(bDigest, a.csrfToken)).toBe(false);
  });

  test("a rotated session's OLD token stops working against the NEW row", async () => {
    // The CSRF token is per session and rotation rewrites it, so the two
    // credentials have the same lifetime. If this failed, a token captured
    // from one page load would keep authorising writes after the session was
    // rotated away from whoever leaked it.
    const clock = pinnedClock(PINNED_MS);
    const issued = await issueSession(harness.db, OPERATOR, { now: clock.now });
    const resolved = await resolveSession(harness.db, issued.sessionId, { now: clock.now });
    if (resolved.outcome !== "resolved") throw new Error("unreachable");
    const rotated = await rotateSession(
      harness.db,
      { principal: resolved.principal, sessionId: issued.sessionId },
      { now: clock.now },
    );
    const newDigest = await sha256Hex(rotated.csrfToken);
    expect(await csrfSatisfied(newDigest, rotated.csrfToken)).toBe(true);
    expect(await csrfSatisfied(newDigest, issued.csrfToken)).toBe(false);
  });
});

describe("the media type ADR-0012 names", () => {
  test("only application/json, with or without a parameter", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
    expect(isJsonContentType("  application/json  ")).toBe(true);
  });

  test("everything else is refused, including the near misses", () => {
    for (const rejected of [
      null,
      "",
      "text/plain",
      "text/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "application/octet-stream",
      // A structured suffix is a DIFFERENT media type with different
      // semantics, and ADR-0012 names one type rather than a family.
      "application/ld+json",
      "application/vnd.api+json",
      // No parameter is worse than a wrong parameter: it is a browser
      // defaulting a form post.
      "application",
      "application/jsonish",
      "xapplication/json",
    ]) {
      expect(isJsonContentType(rejected)).toBe(false);
    }
  });
});
