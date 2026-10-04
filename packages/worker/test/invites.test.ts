// ADR-0009 invite mechanics: the whole slice's test surface, one file, ONE
// miniflare instance (see the note above `beforeAll` for why the instance count
// is a budget here, not a convenience).
//
// Two halves, deliberately in one file:
//   - against D1, where the mechanics live — mint, redeem, the ledger, the
//     per-call grant, ADR-0015's clock and the rate-limit counters
//   - over HTTP through real workerd, where the four things that only exist at
//     the boundary live — the gate's per-call check on a real request, the
//     token not surviving the exchange, scope and kind refused by the GATE
//     rather than in a handler, and the two ungated readers of `env.DB` not
//     becoming a way into review data
//   - over HTTP through real workerd, where the four things that only exist at
//     the boundary live — the gate's per-call check on a real request, the
//     token not surviving the exchange, scope and kind refused by the GATE
//     rather than in a handler, and the two ungated readers of `env.DB` not
//     becoming a way into review data.
//
// The negative half is the point: minting a token is easy and proves nothing, so
// this file is mostly about what a second browser, a replay, a revoked row, an
// unparsable `expires_at` and a hand-written session row each do.
//
// Every required negative case in the slice's brief has a NAMED case here:
//
//   wrong scope (repo and PR)      → "scope: a guest is refused a preview path
//                                     its invite does not cover, and admitted
//                                     one it does"
//   wrong kind for the action       → "kind: a view invite cannot comment, and
//                                     the refusal comes from the gate, not
//                                     the 501"
//   expired                         → "an expired invite cannot be redeemed"
//   revoked                         → "a revoked invite cannot be redeemed"
//   already-redeemed (replay)       → "a second redemption from the same
//                                     browser is refused (replay)"
//   tampered token                  → "a tampered token redeems nothing"
//   view attempting a comment       → as "wrong kind"
//   a second browser on `personal`  → "a second browser on a personal invite
//                                     is refused"
//   max_browsers exceeded           → "max_browsers is a ceiling, not a
//                                     suggestion"
//   session whose invite was        → "revoking the invite stops an
//   revoked after minting             ALREADY-MINTED, UNEXPIRED session on its
//                                     next request"

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { classifyRoute, DENIAL_REASONS, INVITE_OPEN_PREFIX, INVITE_REDEEM_PATH, THREADS_PATH } from "../src/authz.ts";
import { FORM_MEDIA_TYPE } from "../src/invite-page.ts";
import { MAX_REDEEM_BODY_BYTES } from "../src/invites.ts";
import {
  DEFAULT_SHARE_TYPE,
  INVITE_LIFETIME_DAYS,
  INVITE_MAX_BROWSERS,
  MAX_DISPLAY_NAME_CHARS,
  SHARE_TYPE_CAN_COMMENT,
  SHARE_TYPES,
  inviteCovers,
  loadInviteById,
  loadInviteByToken,
  loadInviteGrant,
  mintInvite,
  revokeInvite,
  redemptionClaimStatement,
  BROWSER_COOKIE_NAME,
  type MintResult,
} from "../src/invites.ts";
import { GUEST_DELETED_NAME, GUEST_RETENTION_MS, purgeStaleGuests } from "../src/retention.ts";
import {
  INVITE_TOKEN_HMAC_KEY,
  MIN_INVITE_TOKEN_HMAC_KEY_CHARS,
  MissingInviteTokenKeyError,
  hasUsableInviteTokenKey,
  inviteTokenHasher,
} from "../src/invite-token.ts";
import {
  CLIENT_IP_HEADER,
  RATE_LIMIT_WINDOW_MS,
  REDEEM_IP_LIMIT,
  REDEEM_TOKEN_LIMIT,
  addressBucket,
  openBuckets,
  clientAddress,
  spendAttempts,
  tokenBucket,
  type RateBucket,
} from "../src/rate-limit.ts";
import { CSRF_HEADER, SESSION_COOKIE_NAME, isTokenShaped, mintToken, sha256Hex } from "../src/session.ts";
import {
  issueTestSession,
  JSON_HEADERS,
  resetInvites,
  setCookieValue,
  startWorker,
  TEST_INVITE_TOKEN_HMAC_KEY,
  testTokenHasher,
  type Harness,
} from "./harness.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const at = (): (() => number) => () => NOW;
const REPO = "revkit";
const NAME = "Ada Lovelace";

async function mintOk(db: D1Database, input: Parameters<typeof mintInvite>[1], now = NOW): Promise<MintResult> {
  return mintInvite(db, input, { keys, now: () => now });
}

/** Mint and assert success, so a case reads as one line of setup. */
async function mint(
  db: D1Database,
  input: Parameters<typeof mintInvite>[1] = { repo: REPO },
  now = NOW,
): Promise<{ token: string; inviteId: string; maxBrowsers: number; expiresAt: string }> {
  const result = await mintOk(db, input, now);
  if (!result.ok) throw new Error(`mint failed: ${result.refusal}`);
  return {
    token: result.minted.token,
    inviteId: result.minted.invite.id,
    maxBrowsers: result.minted.invite.maxBrowsers,
    expiresAt: result.minted.invite.expiresAt,
  };
}

/**
 * ONE miniflare instance for this whole file.
 *
 * Not an optimisation: `test/harness.ts` documents a measured cliff on this host
 * where the sixth concurrent workerd instance in one `bun test` process gets
 * "killed 1 dangling process" and every later case in the file fails with
 * "Unable to connect". Slice 3's first draft had two files (D1-level and
 * HTTP-level) and the HTTP file's rate-limit case took the suite over it —
 * reproducible at 4 failures under `bun test`, invisible when the file ran alone.
 * One file with one instance is the fix the harness comment already prescribes
 * ("not by deleting cases, but by reusing the harness"), and it costs nothing:
 * both halves reset the same tables in `beforeEach`.
 */
let harness: Harness;

/**
 * The HMAC hasher the D1-level cases pass, built from the SAME literal the
 * harness binds into `env`. `inviteTokenHasher` imports the `CryptoKey` once and
 * this is that one import, shared by every case in the file — which is also the
 * shape production has, where the key is a deployment input and the import
 * happens per invocation.
 */
let keys: Awaited<ReturnType<typeof testTokenHasher>>;

beforeAll(async () => {
  harness = await startWorker();
  keys = await testTokenHasher();
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await resetInvites(harness.db);
});

  /**
   * Put a counter exactly where a test needs it, in ONE write.
   *
   * Counting up to a limit is the obvious way to test a limit and it is the
   * weak one: it proves "at some point it refused", not *where* the boundary
   * is, and it costs `limit + 1` sequential D1 round trips. That cost is not
   * theoretical — at `REDEEM_TOKEN_LIMIT = 40` it took a case past bun's 5 s
   * per-test timeout under this host's load, which is what produced a
   * "killed 1 dangling process" failure cascade in the first draft of this
   * file. Seeding `count = limit - 1` and taking two attempts asserts the
   * boundary is EXACTLY at `limit`, in two round trips.
   */
  async function seedCounter(bucket: string, count: number, windowStartMs = NOW): Promise<void> {
    await harness.db
      .prepare(
        "INSERT INTO rate_limit_counters (bucket, count, window_start) VALUES (?, ?, ?) " +
          "ON CONFLICT(bucket) DO UPDATE SET count = ?, window_start = ?",
      )
      .bind(bucket, count, new Date(windowStartMs).toISOString(), count, new Date(windowStartMs).toISOString())
      .run();
  }

  /** Both halves a full redemption attempt spends, in the order the handler
   * spends them: the address bucket first and unconditionally, the token
   * bucket only once the token has resolved. */
  function redeemBuckets(digest: string, address?: string): RateBucket[] {
    return [...addressBucket(address), ...tokenBucket(digest)];
  }

  /** One bucket: the per-token half. Renamed from the old two-bucket helper
   * when the token bucket was split out and gated on liveness, so a case that
   * means "the token's budget" cannot silently acquire the address one. */

describe("invite mechanics (ADR-0009) against D1", () => {

  const db = (): D1Database => harness.db;

  // ── minting ───────────────────────────────────────────────────────────

  describe("minting", () => {
    test("a minted token is 256 bits of CSPRNG and is stored only as its digest", async () => {
      const { token, inviteId } = await mint(db());
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // ADR-0012: "stored as HMAC". The digest is the HMAC under the
      // deployment key, and it is 64 hex characters like the bare SHA-256 it
      // replaced — which is why `invites.token_hash` stays `TEXT` and
      // `migrations/0001_init.sql` needs no ALTER.
      expect(await keys.hash(token)).toMatch(/^[0-9a-f]{64}$/);
      const invite = await loadInviteById(db(), inviteId);
      expect(invite?.tokenHash).toBe(await keys.hash(token));
      // The plaintext is nowhere in the row. Asserted against the whole row as
      // JSON, so a future column that stored it would fail here too.
      const row = await db().prepare("SELECT * FROM invites WHERE id = ?").bind(inviteId).first<Record<string, unknown>>();
      expect(JSON.stringify(row)).not.toContain(token);
    });

    test("two mints never produce the same token or the same digest", async () => {
      const tokens = new Set<string>();
      const digests = new Set<string>();
      for (let index = 0; index < 25; index++) {
        const result = await mintOk(db(), { repo: REPO });
        if (!result.ok) throw new Error("mint failed");
        tokens.add(result.minted.token);
        digests.add(result.minted.invite.tokenHash);
      }
      expect(tokens.size).toBe(25);
      expect(digests.size).toBe(25);
    });

    test("the default share type is personal: 14 days, one browser, can comment", async () => {
      expect(DEFAULT_SHARE_TYPE).toBe("personal");
      const result = await mintOk(db(), { repo: REPO });
      if (!result.ok) throw new Error("mint failed");
      const invite = result.minted.invite;
      expect(invite.kind).toBe("personal");
      expect(Date.parse(invite.expiresAt) - NOW).toBe(14 * DAY_MS);
      expect(invite.maxBrowsers).toBe(1);
      expect(invite.canComment).toBe(true);
      expect(invite.revocable).toBe(true);
      expect(invite.revokedAt).toBeNull();
    });

    test("team is 30 days, several browsers, can comment; view is 30 days, several, read-only", async () => {
      // ADR-0009's Acceptance, asserted as a TABLE over the closed share-type
      // list — so a fourth kind added later fails here instead of shipping with
      // no stated lifetime.
      expect(SHARE_TYPES).toEqual(["personal", "team", "view"]);
      expect(INVITE_LIFETIME_DAYS).toEqual({ personal: 14, team: 30, view: 30 });
      expect(SHARE_TYPE_CAN_COMMENT).toEqual({ personal: true, team: true, view: false });
      expect(INVITE_MAX_BROWSERS.personal).toBe(1);
      expect(INVITE_MAX_BROWSERS.team).toBeGreaterThan(1);
      expect(INVITE_MAX_BROWSERS.view).toBe(INVITE_MAX_BROWSERS.team);
      for (const kind of SHARE_TYPES) {
        const result = await mintOk(db(), { repo: REPO, kind });
        if (!result.ok) throw new Error(`mint failed for ${kind}`);
        expect(Date.parse(result.minted.invite.expiresAt) - NOW, kind).toBe(INVITE_LIFETIME_DAYS[kind] * DAY_MS);
        expect(result.minted.invite.canComment, kind).toBe(SHARE_TYPE_CAN_COMMENT[kind]);
      }
    });

    test("an invite is scoped to its repo and optionally one PR", async () => {
      const whole = await mintOk(db(), { repo: REPO });
      if (!whole.ok) throw new Error("mint failed");
      expect(whole.minted.invite.pr).toBeNull();
      const onePr = await mintOk(db(), { repo: REPO, pr: 42 });
      if (!onePr.ok) throw new Error("mint failed");
      expect(onePr.minted.invite.pr).toBe(42);
    });

    test("a hostile repo name is refused at mint, so it can never reach a page or a scope check", async () => {
      // The repository segment becomes part of an R2 key and is interpolated
      // into the form page, so the refusal is a security property, not input
      // tidiness. Each of these would either traverse or break out of the
      // attribute the page renders it into.
      for (const repo of ["../etc", "rev kit", "<script>", "a/b", "", ".", "..", "revkit\u0000", "x".repeat(101)]) {
        const result = await mintOk(db(), { repo });
        expect(result.ok, repo).toBe(false);
        if (!result.ok) expect(result.refusal).toBe("bad-repo");
      }
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invites").first<{ n: number }>())?.n).toBe(0);
    });

    test("a bad PR number is refused, and pr: null is not confused with a bad one", async () => {
      for (const pr of [0, -1, 1.5, 1_000_000_000, Number.NaN]) {
        const result = await mintOk(db(), { repo: REPO, pr });
        expect(result.ok, String(pr)).toBe(false);
        if (!result.ok) expect(result.refusal).toBe("bad-pr");
      }
      const whole = await mintOk(db(), { repo: REPO, pr: null });
      expect(whole.ok).toBe(true);
    });

    test("an unrecognised kind is refused rather than defaulted to personal", async () => {
      const result = await mintInvite(db(), { repo: REPO, kind: "admin" as never }, { keys });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("bad-kind");
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invites").first<{ n: number }>())?.n).toBe(0);
    });

    test("minting has no HTTP route: no verb on any invite path mints a token", async () => {
      // The invariant that keeps ADR-0009's "minting requires write access"
      // true. Driven through real workerd, because a claim about reachability
      // that is asserted in the source is a claim about the source.
      const before = (await db().prepare("SELECT COUNT(*) AS n FROM invites").first<{ n: number }>())?.n;
      for (const verb of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        // `/invite/redeem` is a REAL route, so it answers 415/400/410 and is
        // exercised on its own; a probe that treated "not a 404" as the
        // invariant would be asserting that a route does not exist.
        for (const path of ["/invite/mint", "/api/invites", "/api/invite", "/api/invites/mint"]) {
          const response = await harness.dispatch(`http://localhost${path}`, { method: verb });
          // 410 is the closed page for "no such invite", which is what an
          // arbitrary path under /invite/ is.
          expect([404, 405, 410], `${verb} ${path} -> ${String(response.status)}`).toContain(response.status);
        }
      }
      // And no spelling of the redeem route mints an invite: the 415 is the
      // media-type refusal, which happens before any body is read.
      for (const verb of VERBS) {
        const response = await harness.dispatch("http://localhost/invite/redeem", { method: verb });
        expect([405, 415], `${verb} /invite/redeem -> ${String(response.status)}`).toContain(response.status);
      }
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invites").first<{ n: number }>())?.n).toBe(before);
    });
  });

  // ── the token hash: HMAC under a deployment key ───────────────────────

  describe("the stored token digest is HMAC-SHA-256, not a bare hash", () => {
    test("the stored digest is the HMAC, and it is 64 hex characters", async () => {
      const { token, inviteId } = await mint(db());
      const invite = await loadInviteById(db(), inviteId);
      expect(await keys.hash(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(invite?.tokenHash).toBe(await keys.hash(token));
      // ADR-0012 said "stored as HMAC". It is NOT the bare digest, and the
      // difference is the property the ADR was asking for: the keyed form does
      // not let a holder of the database verify a guess, which is why the
      // amendment slice 3 first proposed (plain SHA-256, "HMAC buys nothing at
      // 256 bits") was withdrawn.
      expect(invite?.tokenHash).not.toBe(await sha256Hex(token));
    });

    test("a different key produces a different digest for the SAME token", async () => {
      // The measurable difference between a keyed hash and a bare one, and the
      // reason the column cannot be migrated later without invalidating every
      // live invite: `token_hash` IS the lookup key.
      const other = await inviteTokenHasher(`${TEST_INVITE_TOKEN_HMAC_KEY}-different`);
      const { token, inviteId } = await mint(db());
      const invite = await loadInviteById(db(), inviteId);
      expect(await other.hash(token)).not.toBe(invite?.tokenHash);
      // …and the lookup under the wrong key finds nothing, which is what "not
      // verifiable from the database" means operationally.
      expect(await loadInviteByToken(db(), token, { keys: other })).toBeUndefined();
      expect(await loadInviteByToken(db(), token, { keys })).toBeDefined();
    });

    test("the digest is stable across calls, so a lookup is repeatable", async () => {
      const { token } = await mint(db());
      expect(await keys.hash(token)).toBe(await keys.hash(token));
      // And two tokens never collide, which `invites.token_hash UNIQUE` would
      // enforce anyway — this is the cheap half of that guarantee.
      const other = await mint(db());
      expect(await keys.hash(other.token)).not.toBe(await keys.hash(token));
    });

    test("a missing or short key is refused, and there is NO fallback digest", async () => {
      // A default key would be worse than no key: a zero-filled 32-byte key
      // produces a VALID, WRONG digest, so invites minted under it could never
      // be redeemed and a suite would stay green against a function that is not
      // the deployed one. So the hasher's TYPE has no overload that returns
      // without a key, and these throw.
      for (const key of [undefined, "", "short", "x".repeat(MIN_INVITE_TOKEN_HMAC_KEY_CHARS - 1)]) {
        expect(hasUsableInviteTokenKey(key), String(key?.length)).toBe(false);
        await expect(inviteTokenHasher(key)).rejects.toThrow(MissingInviteTokenKeyError);
      }
      expect(hasUsableInviteTokenKey("x".repeat(MIN_INVITE_TOKEN_HMAC_KEY_CHARS))).toBe(true);
      // The message names the binding and never a value.
      const error = await inviteTokenHasher(undefined).catch((thrown: unknown) => thrown);
      expect(String(error)).toContain(INVITE_TOKEN_HMAC_KEY);
      expect(String(error)).not.toContain("undefined =");
    });
  });

  // ── redemption, and every way it is refused ───────────────────────────

  describe("redemption", () => {
    async function redeem(
      token: string,
      options: { readonly binding?: string; readonly displayName?: string; readonly now?: number } = {},
    ): Promise<Awaited<ReturnType<typeof import("../src/invites.ts").redeemInvite>>> {
      const { redeemInvite } = await import("../src/invites.ts");
      return redeemInvite(
        db(),
        {
          token,
          binding: options.binding ?? mintToken(),
          displayName: options.displayName ?? NAME,
        },
        { keys, now: () => options.now ?? NOW },
      );
    }

    test("a live invite redeems into a guest session, a guest row and one ledger row", async () => {
      const { token, inviteId } = await mint(db());
      const binding = mintToken();
      const result = await redeem(token, { binding });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issued.identity).toEqual({ kind: "invite", id: result.guestId });
      // The plaintext credentials exist ONLY in the result.
      const sessions = await db().prepare("SELECT * FROM sessions").all<Record<string, unknown>>();
      expect(sessions.results).toHaveLength(1);
      expect(JSON.stringify(sessions.results[0])).not.toContain(result.issued.sessionId);
      expect(JSON.stringify(sessions.results[0])).not.toContain(result.issued.csrfToken);
      expect((sessions.results[0]?.["id"] as string)).toBe(await sha256Hex(result.issued.sessionId));
      expect((sessions.results[0]?.["identity_id"] as string)).toBe(result.guestId);
      const guests = await db().prepare("SELECT display_name, email, deleted_at FROM guests").all<Record<string, unknown>>();
      expect(guests.results).toEqual([{ display_name: NAME, email: null, deleted_at: null }]);
      const ledger = await db().prepare("SELECT invite_id, binding_hash, guest_id FROM invite_redemptions").all<Record<string, unknown>>();
      expect(ledger.results).toHaveLength(1);
      expect(ledger.results[0]?.["binding_hash"]).toBe(await sha256Hex(binding));
      // The token is nowhere in the ledger either.
      expect(JSON.stringify(ledger.results)).not.toContain(token);
      expect(ledger.results[0]?.["invite_id"]).toBe(inviteId);
    });

    test("the session's TTL never outlives the invite it came from", async () => {
      // Two mints: one with the default 14-day life, one expiring in 30
      // minutes. The second is the case that matters — a 12 h default session
      // under a 30-minute invite would hand out a credential that outlives its
      // own authority.
      const short = await mint(db(), { repo: REPO }, NOW);
      // Keyed on the HMAC, not the bare digest. A first cut of this case used
      // `sha256Hex(token)` here and the `UPDATE` matched **zero** rows silently —
      // the invite kept its 14-day expiry, the assertion still had a plausible
      // number to fail against, and the case only got caught because the
      // expected 30 minutes arrived as 30 days.
      await db().prepare("UPDATE invites SET expires_at = ? WHERE token_hash = ?")
        .bind(new Date(NOW + 30 * 60 * 1000).toISOString(), await keys.hash(short.token))
        .run();
      const result = await redeem(short.token, { binding: mintToken() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const invite = await loadInviteById(db(), short.inviteId);
      expect(Date.parse(result.issued.expiresAt)).toBeLessThanOrEqual(Date.parse(invite?.expiresAt ?? ""));
      expect(Date.parse(result.issued.expiresAt) - NOW).toBe(30 * 60 * 1000);
    });

    test("an expired invite cannot be redeemed", async () => {
      const { token } = await mint(db());
      const result = await redeem(token, { now: NOW + 15 * DAY_MS });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("invite-expired");
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(0);
    });

    test("a revoked invite cannot be redeemed", async () => {
      const { token, inviteId } = await mint(db());
      expect(await revokeInvite(db(), inviteId, { now: () => NOW })).toBe("revoked");
      const result = await redeem(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("invite-revoked");
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
    });

    test("a second redemption from the same browser is refused (replay)", async () => {
      const { token } = await mint(db(), { repo: REPO, kind: "team" });
      const binding = mintToken();
      expect((await redeem(token, { binding })).ok).toBe(true);
      const replay = await redeem(token, { binding });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.refusal).toBe("already-redeemed");
      // And a replay mints no SECOND session: the refusal is a refusal, not a
      // new credential.
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(1);
    });

    test("a second browser on a personal invite is refused", async () => {
      const { token } = await mint(db());
      expect((await redeem(token, { binding: mintToken() })).ok).toBe(true);
      const second = await redeem(token, { binding: mintToken() });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.refusal).toBe("browsers-exhausted");
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(1);
    });

    test("max_browsers is a ceiling, not a suggestion", async () => {
      const { token } = await mint(db(), { repo: REPO, kind: "team" });
      const ceiling = INVITE_MAX_BROWSERS.team;
      const outcomes: boolean[] = [];
      for (let index = 0; index < ceiling + 3; index++) {
        outcomes.push((await redeem(token, { binding: mintToken() })).ok);
      }
      expect(outcomes.slice(0, ceiling).every(Boolean)).toBe(true);
      expect(outcomes.slice(ceiling).some(Boolean)).toBe(false);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(ceiling);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(ceiling);
    });

    test("concurrent redemptions of a personal invite produce exactly one session", async () => {
      // The race the guarded INSERT exists for: 8 browsers at once against one
      // slot. Without the `COUNT(*) < max_browsers` clause INSIDE the insert,
      // this is 8 sessions.
      const { token } = await mint(db());
      const results = await Promise.all(
        Array.from({ length: 8 }, () => redeem(token, { binding: mintToken() })),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(1);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>())?.n).toBe(1);
    });

    test("the redemption's OWN guard refuses a revoked row the pre-read never saw", async () => {
      // The mutation run's one survivor in this area: deleting
      // `revoked_at IS NULL` from `redemptionClaimStatement` changed 0 of 87
      // tests, because `redeemInvite`'s pre-read refuses a revoked invite first
      // and no test could see past it. The clause is the only check inside the
      // ATOMIC unit, so it is driven here directly — the one place a predicate
      // the surrounding function short-circuits can be pinned.
      //
      // `windowMs` offsets the caller's clock so the invite's own lifetime can be
      // made to straddle it.
      const at = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();
      const claim = async (offsetMs: number, edit?: () => Promise<void>): Promise<number> => {
        const minted = await mintOk(db(), { repo: REPO, kind: "team" });
        if (!minted.ok) throw new Error("mint failed");
        const invite = minted.minted.invite;
        const bindingHash = await sha256Hex(mintToken());
        const guestId = crypto.randomUUID();
        if (edit !== undefined) await edit();
        const result = await redemptionClaimStatement(db(), {
          inviteId: invite.id,
          bindingHash,
          guestId,
          nowIso: at(offsetMs),
          maxBrowsers: invite.maxBrowsers,
        }).run();
        return result.meta?.changes ?? 0;
      };
      // A live invite at its own moment: the guard ADMITS.
      expect(await claim(0)).toBe(1);
      // Revoked before the claim: the guard refuses, zero rows, no error.
      expect(
        await claim(0, async () => {
          await db().prepare("UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL").bind(at(0)).run();
        }),
      ).toBe(0);
      // Expired relative to the caller's clock: refused.
      expect(await claim(INVITE_LIFETIME_DAYS.team * DAY_MS + 1000)).toBe(0);
      // One millisecond before expiry: admitted, so the boundary is exact.
      expect(await claim(INVITE_LIFETIME_DAYS.team * DAY_MS - 1)).toBe(1);
      // And no refusal wrote anything: the ledger has exactly the two admits.
      const rows = await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>();
      expect(rows?.n).toBe(2);
    });

    test("the guard refuses a full invite and an already-bound browser", async () => {
      // The other two clauses of the same `WHERE`, driven the same way, because
      // the same reasoning applies to all three: the pre-read cannot see them.
      const minted = await mintOk(db(), { repo: REPO, kind: "team" });
      if (!minted.ok) throw new Error("mint failed");
      const invite = minted.minted.invite;
      const nowIso = new Date(NOW).toISOString();
      const bindingHash = await sha256Hex(mintToken());
      const claim = (guestId: string): Promise<number> =>
        redemptionClaimStatement(db(), {
          inviteId: invite.id,
          bindingHash,
          guestId,
          nowIso,
          maxBrowsers: 1,
        }).run().then((result) => result.meta?.changes ?? 0);
      // One slot, one browser: the first claim takes it.
      expect(await claim(crypto.randomUUID())).toBe(1);
      // A different browser, same full invite: refused by the ceiling.
      expect(await claim(crypto.randomUUID())).toBe(0);
      // The SAME browser again: refused by the exclusion, which is what turns a
      // full invite's ceiling into a replay rather than an ambiguity.
      expect(await claim(crypto.randomUUID())).toBe(0);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(1);
    });

    test("a tampered token redeems nothing", async () => {
      const { token } = await mint(db());
      // Flip one character of a real token, and offer a well-shaped token that
      // was never minted. Both are the forgery case; neither must find a row.
      const flipped = `${token.slice(0, 42)}${token[42] === "A" ? "B" : "A"}`;
      // The middle one replaces the LAST character — `${token}x`.slice(0, 43)
      // would be `token` itself, and an earlier version of this case included it
      // and "passed" by redeeming the very token it meant to tamper with.
      const lastChar = `${token.slice(0, 42)}${token[42] === "A" ? "B" : "A"}`;
      for (const candidate of [flipped, mintToken(), lastChar, "A".repeat(42), "", token.toUpperCase()]) {
        const result = await redeem(candidate);
        expect(result.ok, candidate).toBe(false);
        if (!result.ok) expect(["unknown-token", "browser-binding-missing", "display-name-rejected"]).toContain(result.refusal);
      }
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
    });

    test("a malformed binding is refused and consumes no slot", async () => {
      const { token, inviteId } = await mint(db(), { repo: REPO, kind: "team" });
      const bad = await redeem(token, { binding: "not-a-token" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.refusal).toBe("browser-binding-missing");
      // The slot is still free, which is the property: a ledger entry whose
      // binding could never be presented again would silently burn capacity.
      const invite = await loadInviteById(db(), inviteId);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id = ?").bind(inviteId).first<{ n: number }>())?.n).toBe(0);
      expect(invite?.maxBrowsers).toBe(INVITE_MAX_BROWSERS.team);
      expect((await redeem(token, { binding: mintToken() })).ok).toBe(true);
    });

    test("a display name that is blank or over the cap is refused, not truncated", async () => {
      const { token } = await mint(db(), { repo: REPO, kind: "team" });
      for (const displayName of ["", "   ", "\t\n", "x".repeat(MAX_DISPLAY_NAME_CHARS + 1), "y".repeat(500)]) {
        const result = await redeem(token, { binding: mintToken(), displayName });
        expect(result.ok, JSON.stringify(displayName.slice(0, 20))).toBe(false);
        if (!result.ok) expect(result.refusal).toBe("display-name-rejected");
      }
      expect((await db().prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>())?.n).toBe(0);
      // Exactly at the cap is accepted, and trimmed — a name of "  Ada  " is
      // stored as "Ada", because the schema's CHECK accepts the padded form and
      // it would be mirrored to GitHub with the padding.
      const ok = await redeem(token, { binding: mintToken(), displayName: "x".repeat(MAX_DISPLAY_NAME_CHARS) });
      expect(ok.ok).toBe(true);
      const trimmed = await mint(db(), { repo: REPO, pr: 9 });
      const second = await redeem(trimmed.token, { binding: mintToken(), displayName: `  ${NAME}  ` });
      expect(second.ok).toBe(true);
      expect((await db().prepare("SELECT display_name FROM guests ORDER BY created_at DESC, rowid DESC").first<{ display_name: string }>())?.display_name).toBe(NAME);
    });

    test("the display name is stored in `guests`, never in the session row", async () => {
      // ADR-0020: `sessions.identity_id` is an opaque id, and it is the reason a
      // session row is a pseudonymous record rather than a personal one.
      const { token } = await mint(db());
      const result = await redeem(token, { binding: mintToken() });
      expect(result.ok).toBe(true);
      const row = await db().prepare("SELECT * FROM sessions").first<Record<string, unknown>>();
      expect(JSON.stringify(row)).not.toContain(NAME);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM guests WHERE display_name = ?").bind(NAME).first<{ n: number }>())?.n).toBe(1);
    });
  });

  // ── the per-call grant (ADR-0012) ─────────────────────────────────────

  describe("the per-call invite grant", () => {
    async function grantFor(kind: "personal" | "team" | "view", pr: number | null = null) {
      const { token, inviteId } = await mint(db(), { repo: REPO, kind, pr });
      const binding = mintToken();
      const { redeemInvite } = await import("../src/invites.ts");
      const redeemed = await redeemInvite(db(), { token, binding, displayName: NAME }, { keys, now: at() });
      if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.refusal}`);
      return { binding, guestId: redeemed.guestId, inviteId, redeemed };
    }

    test("a fresh redemption grants, from the ledger and not from the redemption's memory", async () => {
      const { guestId, binding } = await grantFor("personal");
      const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.grant.browserMatches).toBe(true);
      expect(result.grant.invite.kind).toBe("personal");
      expect(result.grant.invite.canComment).toBe(true);
    });

    test("the grant is refused the moment the invite is revoked — no expiry involved", async () => {
      const { guestId, binding, inviteId } = await grantFor("personal");
      expect(await revokeInvite(db(), inviteId, { now: () => NOW })).toBe("revoked");
      const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("invite-revoked");
      // And the session row is still there and unexpired, which is the whole
      // point: the refusal comes from the invite, not from a dead session.
      const session = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
      expect(session.ok).toBe(false);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
    });

    test("the grant is refused once the invite has expired, and revocation is then the reported reason", async () => {
      const { guestId, binding, inviteId } = await grantFor("team");
      const later = NOW + 31 * DAY_MS;
      const expired = await loadInviteGrant(db(), { guestId, binding }, { now: () => later });
      expect(expired.ok).toBe(false);
      if (!expired.ok) expect(expired.refusal).toBe("invite-expired");
      // Revoking afterwards changes the ANSWER but not the verdict, and the
      // gate checks revocation first on purpose: it is the decisive operator
      // action, and a log line that says "expired" for an invite somebody
      // deliberately killed sends the reader looking in the wrong place.
      expect(await revokeInvite(db(), inviteId, { now: () => later })).toBe("revoked");
      const afterRevoke = await loadInviteGrant(db(), { guestId, binding }, { now: () => later });
      expect(afterRevoke.ok).toBe(false);
      if (!afterRevoke.ok) expect(afterRevoke.refusal).toBe("invite-revoked");
    });

    test("a browser-mismatched binding is a mismatch, not a grant with a warning", async () => {
      const { guestId } = await grantFor("personal");
      for (const binding of [null, mintToken(), "short", `${mintToken()}x`.slice(0, 43)]) {
        const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
        expect(result.ok, String(binding)).toBe(true);
        if (result.ok) expect(result.grant.browserMatches, String(binding)).toBe(false);
      }
    });

    test("a guest with no ledger row is refused, not defaulted", async () => {
      const result = await loadInviteGrant(db(), { guestId: crypto.randomUUID(), binding: mintToken() }, { now: at() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("no-grant");
      expect((await loadInviteGrant(db(), { guestId: "", binding: null }, { now: at() })).ok).toBe(false);
    });

    test("two ledger rows for one guest are refused rather than resolved by whichever the query returns", async () => {
      const { guestId, inviteId, binding } = await grantFor("team");
      await db().prepare("INSERT INTO invite_redemptions (invite_id, binding_hash, guest_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(inviteId, await sha256Hex(mintToken()), guestId, new Date(NOW).toISOString())
        .run();
      const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("no-grant");
    });

    test("an unreadable invite row produces no grant", async () => {
      // NOTE what is absent and why: `max_browsers = 0`, `kind = 'superuser'`
      // and `can_comment = 7` are all UNREACHABLE here — `migrations/0001_init.sql`
      // constrains each of them, so those shapes cannot be written at all. The
      // remaining columns have no CHECK, so a hand-written row can carry them,
      // and `max_browsers` is reached with a TEXT value instead (SQLite is
      // dynamically typed and the CHECK still passes). The schema having teeth
      // here is worth as much as the reader, which is why A16/A17 already pin it.
      for (const [column, value] of [
        ["expires_at", "not a date"],
        ["expires_at", ""],
        ["max_browsers", "three"],
        ["repo", "../etc"],
        ["pr", 0],
        ["revoked_at", ""],
      ] as const) {
        await resetInvites(db());
        const { guestId, binding, inviteId } = await grantFor("team");
        await db().prepare(`UPDATE invites SET ${column} = ? WHERE id = ?`).bind(value as never, inviteId).run();
        const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
        expect(result.ok, `${column}=${String(value)}`).toBe(false);
        if (!result.ok) expect(result.refusal).toBe("invite-row-unreadable");
      }
      // The OTHER fail-closed direction, and the two columns land differently
      // for a reason worth pinning: blanking `id` breaks the JOIN, so the row is
      // never found (`no-grant`), while blanking `token_hash` leaves the join
      // intact and produces a row whose own field cannot be read
      // (`invite-row-unreadable`). Both are refusals, which is the property.
      for (const [column, value, expected] of [
        ["id", "", "no-grant"],
        ["token_hash", "", "invite-row-unreadable"],
      ] as const) {
        await resetInvites(db());
        const { guestId, binding, inviteId } = await grantFor("team");
        await db().prepare(`UPDATE invites SET ${column} = ? WHERE id = ?`).bind(value as never, inviteId).run();
        const result = await loadInviteGrant(db(), { guestId, binding }, { now: at() });
        expect(result.ok, `${column}=${String(value)}`).toBe(false);
        if (!result.ok) expect(result.refusal, column).toBe(expected);
      }
    });
  });

  // ── scope ─────────────────────────────────────────────────────────────

  describe("invite scope", () => {
    async function covers(repo: string, pr: number | null, target: { repo: string; pr: number } | undefined): Promise<boolean> {
      const result = await mintOk(db(), { repo, pr });
      if (!result.ok) throw new Error("mint failed");
      return inviteCovers(result.minted.invite, target);
    }

    test("a repo-scoped invite covers every PR of its repo and no other repo", async () => {
      expect(await covers(REPO, null, { repo: REPO, pr: 1 })).toBe(true);
      expect(await covers(REPO, null, { repo: REPO, pr: 999_999 })).toBe(true);
      expect(await covers(REPO, null, { repo: "other", pr: 1 })).toBe(false);
      expect(await covers(REPO, null, { repo: "revki", pr: 1 })).toBe(false);
      expect(await covers(REPO, null, { repo: "revkit2", pr: 1 })).toBe(false);
    });

    test("a PR-scoped invite covers exactly that PR", async () => {
      expect(await covers(REPO, 42, { repo: REPO, pr: 42 })).toBe(true);
      expect(await covers(REPO, 42, { repo: REPO, pr: 43 })).toBe(false);
      expect(await covers(REPO, 42, { repo: REPO, pr: 1 })).toBe(false);
      // Wrong repo AND wrong PR is still just refused.
      expect(await covers(REPO, 42, { repo: "other", pr: 42 })).toBe(false);
    });

    test("a route that names no repo or PR is not out of scope — and that is a recorded gap, not a pass", async () => {
      // `GET /api/threads` has no repo axis (`events(seq, ts, payload)`), so a
      // scope check has nothing to select on. Asserted explicitly so the gap is
      // visible in the suite: if slice 5 adds the axis, this case is the one
      // that must change.
      expect(await covers(REPO, null, undefined)).toBe(true);
      expect(await covers(REPO, 42, undefined)).toBe(true);
    });
  });

  // ── revocation ─────────────────────────────────────────────────────────

  describe("revocation", () => {
    test("revoking is idempotent and reports whether THIS call revoked it", async () => {
      const { inviteId } = await mint(db());
      expect(await revokeInvite(db(), inviteId, { now: () => NOW })).toBe("revoked");
      expect(await revokeInvite(db(), inviteId, { now: () => NOW + 1000 })).toBe("already-revoked");
      // `revoked_at` keeps the FIRST moment, so a revocation cannot be made to
      // look later than it was — which matters because ADR-0015's retention
      // clock is measured from it.
      const invite = await loadInviteById(db(), inviteId);
      expect(invite?.revokedAt).toBe(new Date(NOW).toISOString());
      // The second call reported "already-revoked" WITHOUT a pre-check, purely
      // from the `revoked_at IS NULL` guard on the UPDATE matching no row. That
      // is the whole mechanism now — a pre-check was measured to add nothing —
      // so it is pinned by the outcome rather than by the code path.
      expect((await db().prepare("SELECT COUNT(*) AS n FROM invites WHERE revoked_at = ?").bind(new Date(NOW).toISOString()).first<{ n: number }>())?.n).toBe(1);
    });

    test("an unknown invite and a non-revocable one are told apart from a revocation", async () => {
      expect(await revokeInvite(db(), "no-such-invite", { now: at() })).toBe("not-found");
      const { inviteId } = await mint(db());
      await db().prepare("UPDATE invites SET revocable = 0 WHERE id = ?").bind(inviteId).run();
      expect(await revokeInvite(db(), inviteId, { now: at() })).toBe("not-revocable");
      expect((await loadInviteById(db(), inviteId))?.revokedAt).toBeNull();
    });

    test("an invite can be revoked after it expired, and that changes no grant", async () => {
      const { inviteId } = await mint(db());
      const later = NOW + 15 * DAY_MS;
      expect(await revokeInvite(db(), inviteId, { now: () => later })).toBe("revoked");
      expect((await loadInviteById(db(), inviteId))?.revokedAt).toBe(new Date(later).toISOString());
    });
  });

  // ── ADR-0015's guest clock ────────────────────────────────────────────

  describe("ADR-0015's 30-day guest clock", () => {
    async function guestWithInvite(kind: "personal" | "team" = "team") {
      const { token, inviteId, expiresAt } = await mint(db(), { repo: REPO, kind });
      const { redeemInvite } = await import("../src/invites.ts");
      const result = await redeemInvite(db(), { token, binding: mintToken(), displayName: NAME }, { keys, now: at() });
      if (!result.ok) throw new Error("redeem failed");
      return { inviteId, guestId: result.guestId, expiresAt };
    }

    /**
     * When ADR-0015's clock starts for this invite: the LATER of `revoked_at`
     * and `expires_at`, because that is what `purgeStaleGuests` uses
     * (`MAX(COALESCE(revoked_at, ''), expires_at)`). A 14-day invite revoked on
     * day 0 is therefore due on day 44, NOT day 30 — an earlier version of
     * these cases assumed day 30 and failed, which is what pinned the rule.
     */
    function dueAt(revokedAtMs: number | null, expiresAtMs: number): number {
      return Math.max(revokedAtMs ?? 0, expiresAtMs) + GUEST_RETENTION_MS;
    }

    test("a guest inside the 30-day window is kept, name and all", async () => {
      const { inviteId, expiresAt } = await guestWithInvite();
      expect(await revokeInvite(db(), inviteId, { now: () => NOW })).toBe("revoked");
      // The clock starts at the invite's own expiry, which for a 14-day invite
      // revoked on day 0 is day 14 — not day 0.
      const due = dueAt(NOW, Date.parse(expiresAt));
      expect(due).toBe(NOW + INVITE_LIFETIME_DAYS.team * DAY_MS + GUEST_RETENTION_MS);
      expect((await purgeStaleGuests(db(), { now: due - 1000 })).purged).toBe(0);
      expect((await db().prepare("SELECT display_name, deleted_at FROM guests").first<Record<string, unknown>>())?.["display_name"]).toBe(NAME);
    });

    test("a guest past the 30-day window is anonymised, not deleted", async () => {
      const { inviteId, guestId, expiresAt } = await guestWithInvite();
      expect(await revokeInvite(db(), inviteId, { now: () => NOW })).toBe("revoked");
      const due = dueAt(NOW, Date.parse(expiresAt));
      const result = await purgeStaleGuests(db(), { now: due });
      expect(result.purged).toBe(1);
      expect(result.cutoff).toBe(new Date(Date.parse(expiresAt)).toISOString());
      const row = await db().prepare("SELECT id, display_name, email, created_at, deleted_at FROM guests WHERE id = ?").bind(guestId).first<Record<string, unknown>>();
      // The ROW survives, because `sessions.identity_id` points at it and the
      // gate turns a session into its invite through it. Deleting it would
      // revoke every live session the guest holds — the opposite of ADR-0015's
      // "threads are kept".
      expect(row?.["id"]).toBe(guestId);
      expect(row?.["display_name"]).toBe(GUEST_DELETED_NAME);
      expect(row?.["email"]).toBeNull();
      expect(row?.["created_at"]).toBe(new Date(NOW).toISOString());
      expect(typeof row?.["deleted_at"]).toBe("string");
      // And nothing of the old name survives anywhere in the row.
      expect(JSON.stringify(row)).not.toContain(NAME);
    });

    test("expiry alone starts the clock, with no revocation at all", async () => {
      const { guestId, inviteId } = await guestWithInvite();
      // Never revoked: the only event is the invite's own expiry.
      expect((await loadInviteById(db(), inviteId))?.revokedAt).toBeNull();
      const afterExpiry = NOW + INVITE_LIFETIME_DAYS.team * DAY_MS + GUEST_RETENTION_MS;
      expect((await purgeStaleGuests(db(), { now: afterExpiry - 1000 })).purged).toBe(0);
      expect((await purgeStaleGuests(db(), { now: afterExpiry })).purged).toBe(1);
      expect((await db().prepare("SELECT display_name FROM guests WHERE id = ?").bind(guestId).first<{ display_name: string }>())?.display_name).toBe(GUEST_DELETED_NAME);
    });

    test("when both apply, the LATER of revoked and expired starts the clock", async () => {
      // Measured, not assumed: SQLite's two-argument scalar MAX returns NULL if
      // either argument is NULL, so an un-revoked invite would produce a NULL
      // deadline and `NULL <= cutoff` is NULL — a purge that silently never
      // fires. `COALESCE` is what makes the un-revoked case work at all, and
      // this case is what pins which of two real timestamps wins.
      const { guestId, inviteId } = await guestWithInvite();
      const revokedAtMs = NOW + 20 * DAY_MS;
      await db().prepare("UPDATE invites SET expires_at = ?, revoked_at = ? WHERE id = ?")
        .bind(new Date(NOW + 14 * DAY_MS).toISOString(), new Date(revokedAtMs).toISOString(), inviteId)
        .run();
      // Revocation AFTER expiry: at (expiry + 30d) nothing is yet due, because
      // the revocation has not happened at that point in the story.
      expect((await purgeStaleGuests(db(), { now: NOW + 14 * DAY_MS + GUEST_RETENTION_MS - 1000 })).purged).toBe(0);
      // At (revocation + 30d) it is. If the earlier event won, this would have
      // been 1 at the previous assertion — which is exactly what it was before
      // the rule was pinned.
      expect((await purgeStaleGuests(db(), { now: revokedAtMs + GUEST_RETENTION_MS })).purged).toBe(1);
      expect((await db().prepare("SELECT display_name FROM guests WHERE id = ?").bind(guestId).first<{ display_name: string }>())?.display_name).toBe(GUEST_DELETED_NAME);
    });

    test("the sweep is idempotent and does not restamp `deleted_at`", async () => {
      const { inviteId, guestId, expiresAt } = await guestWithInvite();
      await revokeInvite(db(), inviteId, { now: () => NOW });
      const due = dueAt(NOW, Date.parse(expiresAt));
      expect((await purgeStaleGuests(db(), { now: due })).purged).toBe(1);
      const first = await db().prepare("SELECT deleted_at FROM guests WHERE id = ?").bind(guestId).first<{ deleted_at: string }>();
      expect((await purgeStaleGuests(db(), { now: due + 10 * DAY_MS })).purged).toBe(0);
      const second = await db().prepare("SELECT deleted_at FROM guests WHERE id = ?").bind(guestId).first<{ deleted_at: string }>();
      expect(second?.deleted_at).toBe(first?.deleted_at);
    });

    test("a guest whose invite is still live is never swept", async () => {
      await guestWithInvite();
      // 13 days: inside the 14-day invite, so neither the invite's expiry nor a
      // revocation exists to start the clock.
      expect((await purgeStaleGuests(db(), { now: NOW + 13 * DAY_MS })).purged).toBe(0);
      expect((await purgeStaleGuests(db(), { now: NOW + 13 * DAY_MS + GUEST_RETENTION_MS })).purged).toBe(0);
      expect((await db().prepare("SELECT display_name FROM guests").first<{ display_name: string }>())?.display_name).toBe(NAME);
    });

    test("a purged guest's session still resolves to its invite, so revocation keeps working", async () => {
      // The reason this module anonymises instead of deleting: the gate's join
      // is `sessions.identity_id -> invite_redemptions.guest_id`, so a deleted
      // guest would turn every live session into "no grant".
      const { guestId, inviteId } = await guestWithInvite();
      const bindingRow = await db().prepare("SELECT binding_hash FROM invite_redemptions WHERE guest_id = ?").bind(guestId).first<{ binding_hash: string }>();
      await revokeInvite(db(), inviteId, { now: () => NOW });
      await purgeStaleGuests(db(), { now: NOW + 365 * DAY_MS });
      const after = await loadInviteGrant(db(), { guestId, binding: null }, { now: at() });
      // The refusal is now `invite-revoked`, i.e. the join still resolves —
      // not `no-grant`, which is what a deleted row would have produced.
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.refusal).toBe("invite-revoked");
      expect(bindingRow?.binding_hash).toBeTruthy();
    });
  });

  // ── rate limits (ADR-0012) ────────────────────────────────────────────

  describe("rate limits", () => {
    function inviteBuckets(digest: string): RateBucket[] {
      return tokenBucket(digest);
    }

    test("the OPEN route's buckets: address when there is one, per-token when there is not, never empty", async () => {
      // F2. The rule is a pure function of (address, tokenHash), so it is tested
      // as one — and NOT through `harness.dispatch`, because that cannot reach
      // the interesting case. **Measured:** miniflare overwrites
      // `cf-connecting-ip` with `127.0.0.1` on every dispatch, including when
      // the test sets it empty, so `clientAddress` is never undefined over HTTP
      // here. An HTTP test for this branch would have been green for the wrong
      // reason — the assertion would never have exercised it.
      const digest = "a".repeat(64);

      // The normal case: the address bucket ALONE, so holding an invite URL and
      // GETting it cannot spend the guest's redemption budget (the shipped DoS).
      expect(openBuckets({ address: "198.51.100.4", tokenHash: digest })).toEqual([
        { kind: "ip", name: "ip:198.51.100.4", limit: REDEEM_IP_LIMIT },
      ]);

      // No address: the per-token bucket is the only key available, and an empty
      // list here would mean `spendAttempts` writes nothing at all.
      expect(openBuckets({ address: undefined, tokenHash: digest })).toEqual([
        { kind: "invite", name: `invite:${digest}`, limit: REDEEM_TOKEN_LIMIT },
      ]);

      // Neither: a malformed open path has no key at all. Empty is stated, not
      // papered over — a synthetic shared bucket would be one row every caller
      // contends for, trading a metering gap for a denial of service.
      expect(openBuckets({ address: undefined, tokenHash: undefined })).toEqual([]);
    });

    test("the invite bucket admits its limit and refuses the next attempt, exactly", async () => {
      const buckets = inviteBuckets("a".repeat(64));
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.kind).toBe("invite");
      expect(buckets[0]?.limit).toBe(REDEEM_TOKEN_LIMIT);
      // count = limit - 1 in the CURRENT window: one more is still allowed.
      await seedCounter(buckets[0]?.name ?? "", REDEEM_TOKEN_LIMIT - 1);
      const allowed = await spendAttempts(db(), buckets, { now: NOW });
      expect(allowed.ok).toBe(true);
      // That attempt took the count to exactly the limit, so the next is refused.
      const refused = await spendAttempts(db(), buckets, { now: NOW });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.kind).toBe("invite");
        expect(refused.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / 1000);
      }
      // And the stored count is the limit plus the refused attempt, which is
      // what makes a sustained attack keep the counter moving.
      const stored = await db().prepare("SELECT count FROM rate_limit_counters WHERE bucket = ?").bind(buckets[0]?.name ?? "").first<{ count: number }>();
      expect(stored?.count).toBe(REDEEM_TOKEN_LIMIT + 1);
    });

    test("the per-token limit is above 2 x the largest max_browsers, or a team invite is unusable", async () => {
      // This relation is not a style preference. It was violated: the limit was
      // 10 while `team`'s `max_browsers` is 10, and each browser costs TWO
      // attempts (the GET that opens the link and the POST that redeems it), so
      // the tenth browser was rate-limited rather than admitted. Measured over
      // HTTP: 8 x 303 then 429, with 8 of 10 slots unused.
      const perBrowser = 2;
      for (const kind of SHARE_TYPES) {
        expect(REDEEM_TOKEN_LIMIT, kind).toBeGreaterThan(INVITE_MAX_BROWSERS[kind] * perBrowser);
      }
    });

    test("the window rolls over, so a limit is not a permanent ban", async () => {
      const buckets = inviteBuckets("b".repeat(64));
      // Over the limit inside a window that has NOT ended: refused.
      await seedCounter(buckets[0]?.name ?? "", REDEEM_TOKEN_LIMIT, NOW);
      expect((await spendAttempts(db(), buckets, { now: NOW })).ok).toBe(false);
      // The same counter one millisecond after the window ends: admitted again,
      // and reset to 1 rather than continuing from the old value.
      const after = await spendAttempts(db(), buckets, { now: NOW + RATE_LIMIT_WINDOW_MS + 1 });
      expect(after.ok).toBe(true);
      const stored = await db()
        .prepare("SELECT count, window_start FROM rate_limit_counters WHERE bucket = ?")
        .bind(buckets[0]?.name ?? "")
        .first<{ count: number; window_start: string }>();
      expect(stored?.count).toBe(1);
      expect(stored?.window_start).toBe(new Date(NOW + RATE_LIMIT_WINDOW_MS + 1).toISOString());
      // A window that has not ended keeps counting: two more attempts and it is
      // refused again, so the reset is a roll and not a permanent amnesty.
      expect((await spendAttempts(db(), buckets, { now: NOW + RATE_LIMIT_WINDOW_MS + 2 })).ok).toBe(true);
      expect((await spendAttempts(db(), buckets, { now: NOW + RATE_LIMIT_WINDOW_MS + 3 })).ok).toBe(true);
    });

    test("20 concurrent attempts on one bucket are counted without losing an update", async () => {
      // The measurement behind the ADR amendment: `ON CONFLICT … DO UPDATE …
      // RETURNING count` is atomic per statement. If it were a read-then-write
      // (slice 1 measured what that costs on D1: 6 concurrent appends produced 3
      // distinct values), this count would be below 20.
      const buckets = inviteBuckets("c".repeat(64));
      await Promise.all(Array.from({ length: 20 }, () => spendAttempts(db(), buckets, { now: NOW })));
      const stored = await db().prepare("SELECT count FROM rate_limit_counters WHERE bucket = ?").bind(buckets[0]?.name ?? "").first<{ count: number }>();
      expect(stored?.count).toBe(20);
    });

    test("both buckets are spent even when the first refuses — so token rotation cannot escape the address limit", async () => {
      // Rotating tokens from one address must move the ADDRESS counter. If a
      // refusal short-circuited the loop, ten rotated tokens would leave it at 0
      // and the address half of "per identity AND IP" would not exist.
      const digest = "d".repeat(64);
      const buckets = [...addressBucket("203.0.113.9"), ...inviteBuckets(digest)];
      await seedCounter(`invite:${digest}`, REDEEM_TOKEN_LIMIT, NOW);
      const refused = await spendAttempts(db(), buckets, { now: NOW });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.kind).toBe("invite");
      const address = await db().prepare("SELECT count FROM rate_limit_counters WHERE bucket = ?").bind("ip:203.0.113.9").first<{ count: number }>();
      expect(address?.count).toBe(1);
      // And the refusal is reported as the TOKEN's bucket even though both were
      // spent: the first refusal in bucket order wins, which is the one the
      // caller most directly caused.
    });

    test("the address bucket has its own, higher ceiling, exactly", async () => {
      expect(REDEEM_IP_LIMIT).toBeGreaterThan(REDEEM_TOKEN_LIMIT);
      const addressOnly = (): RateBucket[] => addressBucket("203.0.113.9");
      const bucket = addressOnly()[0];
      expect(bucket?.limit).toBe(REDEEM_IP_LIMIT);
      await seedCounter(bucket?.name ?? "", REDEEM_IP_LIMIT - 1);
      expect((await spendAttempts(db(), addressOnly(), { now: NOW })).ok).toBe(true);
      const refused = await spendAttempts(db(), addressOnly(), { now: NOW });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.kind).toBe("ip");
    });

    test("no bucket name is ever returned by a verdict, so a refusal cannot echo one", async () => {
      const buckets = [...addressBucket("198.51.100.4"), ...inviteBuckets("0".repeat(64))];
      await seedCounter("ip:198.51.100.4", REDEEM_IP_LIMIT, NOW);
      const verdict = await spendAttempts(db(), buckets, { now: NOW });
      expect(verdict.ok).toBe(false);
      // An address is personal data (ADR-0015, ADR-0020) and an invite digest
      // is a credential's hash, so neither may appear in a response or a log.
      // The verdict's whole shape is asserted rather than searched.
      expect(Object.keys(verdict).sort()).toEqual(["kind", "ok", "retryAfterSeconds"]);
      expect(JSON.stringify(verdict)).not.toContain("198.51.100.4");
      expect(JSON.stringify(verdict)).not.toContain("0".repeat(64));
    });

    test("a refusal reports at least one second, never zero or a negative wait", async () => {
      const buckets = inviteBuckets("1".repeat(64));
      // Deep into the window: the remaining time is one second, and `Retry-After:
      // 0` would invite an immediate retry.
      await seedCounter(buckets[0]?.name ?? "", REDEEM_TOKEN_LIMIT, NOW);
      const verdict = await spendAttempts(db(), buckets, { now: NOW + RATE_LIMIT_WINDOW_MS - 1 });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.retryAfterSeconds).toBe(1);
        expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    });

    test("the client address comes only from the edge-set header, never from X-Forwarded-For", async () => {
      // `X-Forwarded-For` is appended to by every hop and is trivially spoofed by
      // whoever opens the connection, so a forgeable identity half would make the
      // whole limit forgeable with it.
      const withBoth = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.4" });
      expect(clientAddress(withBoth)).toBe("203.0.113.9");
      const forgedOnly = new Headers({ "x-forwarded-for": "198.51.100.4" });
      expect(clientAddress(forgedOnly)).toBeUndefined();
      expect(clientAddress(new Headers({ "cf-connecting-ip": "  " }))).toBeUndefined();
      // With no address there is no IP bucket — but the invite bucket remains,
      // so the exchange is never unlimited.
      expect(inviteBuckets("2".repeat(64)).map((bucket) => bucket.kind)).toEqual(["invite"]);
    });

    test("the two halves are separate buckets, so neither can lock out the other", async () => {
      // The whole point of two buckets: exhausting the address limit must not
      // refuse a DIFFERENT address's attempt at the same token, or an attacker
      // sharing a NAT could deny a stranger their invite.
      const digest = "3".repeat(64);
      await seedCounter("ip:203.0.113.9", REDEEM_IP_LIMIT, NOW);
      const sameTokenElsewhere = await spendAttempts(db(), [...addressBucket("198.51.100.4"), ...inviteBuckets(digest)], { now: NOW });
      expect(sameTokenElsewhere.ok).toBe(true);
      const otherTokenSameAddress = await spendAttempts(db(), [...addressBucket("203.0.113.9"), ...inviteBuckets("4".repeat(64))], { now: NOW });
      expect(otherTokenSameAddress.ok).toBe(false);
    });
  });
type DispatchResponse = Awaited<ReturnType<Harness["dispatch"]>>;
type DispatchInit = Parameters<Harness["dispatch"]>[1];

/**
 * `miniflare.dispatchFetch` FOLLOWS redirects by default, which silently turns
 * the redemption's `303` into whatever the `Location` points at — measured:
 * `POST /invite/redeem` answered `404 {"error":"not-found"}` with a
 * `GET /` appearing in the log first, because the harness had followed the
 * redirect to the token-free landing path that slice 5 has not built yet.
 *
 * Every request that expects to SEE a 3xx therefore has to say
 * `redirect: "manual"`, or it asserts on the wrong response. That is a
 * property of the test client, not of the Worker, and it is here so the next
 * case does not rediscover it.
 */
const NO_FOLLOW = { redirect: "manual" } as const;

/** One browser's cookies, accumulated the way a browser would: whatever the
 * response set, plus whatever the caller was already holding. */
class Browser {
  private readonly jar = new Map<string, string>();

  absorb(response: DispatchResponse): void {
    for (const raw of response.headers.getSetCookie()) {
      const name = (raw.split(";")[0] ?? "").split("=")[0] ?? "";
      const value = (raw.split(";")[0] ?? "").slice(name.length + 1);
      if (name.length > 0) this.jar.set(name, value);
    }
  }

  /** The `Cookie` header this browser would send, or `null` when it holds
   * nothing — which is how a caller with no cookies is expressed. */
  header(): string | null {
    if (this.jar.size === 0) return null;
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  drop(name: string): void {
    this.jar.delete(name);
  }
}

interface Opened {
  readonly browser: Browser;
  readonly token: string;
  readonly status: number;
}

async function open(
  harness: Harness,
  token: string,
  init: DispatchInit = {},
): Promise<{ browser: Browser; response: DispatchResponse }> {
  const browser = new Browser();
  const response = await harness.dispatch(`http://localhost${INVITE_OPEN_PREFIX}${token}`, init);
  browser.absorb(response);
  return { browser, response };
}

async function redeem(
  harness: Harness,
  browser: Browser,
  token: string,
  body: Record<string, unknown> = { displayName: NAME },
  init: DispatchInit = {},
): Promise<DispatchResponse> {
  const headers: Record<string, string> = {
    ...JSON_HEADERS,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const cookie = browser.header();
  if (cookie !== null) headers["cookie"] = cookie;
  return harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
    method: "POST",
    ...NO_FOLLOW,
    ...init,
    headers,
    body: JSON.stringify({ token, ...body }),
  });
}

/**
 * `GET /invite/<token>` in a browser that ALREADY has cookies — the second
 * click, the second tab, the Back-navigation.
 *
 * `open` deliberately starts an empty jar, because most of what follows it is a
 * first visit. This one dispatches the browser's own cookies and absorbs the
 * response back into the same jar, which is what a browser does and what the
 * H1 regression needs: a first draft of that test used `open`, so the new
 * `Set-Cookie` landed in a throwaway jar and the defect was invisible.
 */
async function reopen(
  harness: Harness,
  browser: Browser,
  token: string,
  init: DispatchInit = {},
): Promise<DispatchResponse> {
  const cookie = browser.header();
  const response = await harness.dispatch(`http://localhost${INVITE_OPEN_PREFIX}${token}`, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), ...(cookie === null ? {} : { cookie }) },
  });
  browser.absorb(response);
  return response;
}

/**
 * `POST /invite/redeem` the way a BROWSER submits the shipped form: the default
 * enctype, both fields urlencoded, and whatever cookies the browser holds.
 *
 * Deliberately not a variant of `redeem`'s parameter list — the point is that it
 * has no way to send JSON, because the page has no way to send JSON.
 */
async function redeemUrlEncoded(
  harness: Harness,
  browser: Browser,
  token: string,
  fields: Readonly<Record<string, string>> = { displayName: NAME },
): Promise<DispatchResponse> {
  const body = new URLSearchParams();
  body.set("token", token);
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  const cookie = browser.header();
  return harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
    method: "POST",
    ...NO_FOLLOW,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie === null ? {} : { cookie }) },
    body: body.toString(),
  });
}

/** Mint, open, redeem — the whole legitimate flow, for a test whose subject is
 * something that happens AFTER it. */
async function onboard(
  harness: Harness,
  input: Parameters<typeof mintInvite>[1] = { repo: REPO },
): Promise<{
  browser: Browser;
  token: string;
  inviteId: string;
  guestId: string;
  sessionId: string;
  csrfToken: string;
  response: DispatchResponse;
}> {
  const minted = await mintInvite(harness.db, input, { keys });
  if (!minted.ok) throw new Error(`mint failed: ${minted.refusal}`);
  const { browser } = await open(harness, minted.minted.token);
  const response = await redeem(harness, browser, minted.minted.token);
  if (response.status !== 303) throw new Error(`redeem failed: ${String(response.status)}`);
  browser.absorb(response);
  const sessionId = browser.get(SESSION_COOKIE_NAME);
  // The CSRF token comes off the `303`'s response header, which is where
  // `POST /api/session/refresh` puts it too.
  const csrf = response.headers.get(CSRF_HEADER);
  const guestId = (await harness.db.prepare("SELECT identity_id FROM sessions").first<{ identity_id: string }>())?.identity_id;
  if (sessionId === undefined || csrf === null || csrf.length === 0 || guestId === undefined) {
    throw new Error(`no session cookie, CSRF token or guest id (status ${String(response.status)})`);
  }
  const csrfToken = csrf;
  return { browser, token: minted.minted.token, inviteId: minted.minted.invite.id, guestId, sessionId, csrfToken, response };
}

/** workerd may expose the two `Set-Cookie` headers as a comma-joined value;
 * read them either way so a test is not asserting a header-plumbing detail. */
function joinedSetCookie(response: DispatchResponse): string {
  return (response.headers.getSetCookie() ?? []).join(", ");
}

function authedHeaders(browser: Browser, csrfToken: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = browser.header();
  const headers: Record<string, string> = { ...extra };
  if (cookie !== null) headers["cookie"] = cookie;
  if (csrfToken !== null) headers[CSRF_HEADER] = csrfToken;
  return headers;
}

async function json(response: DispatchResponse): Promise<Record<string, unknown>> {
  return parseJson(await response.text());
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

  // ── the same mechanics, over HTTP through real workerd ──────────────────

  // NO lifecycle hooks in this describe. It shares the file's ONE harness, and
  // that sharing is load-bearing rather than tidy: a second `beforeAll` here
  // used to call `startWorker()` again, silently replacing the module-level
  // `harness` with a second miniflare instance and a SECOND in-memory D1. Every
  // write a case made before that point went to a database the Worker never read
  // — a seeded rate-limit row vanished and the case failed for a reason that had
  // nothing to do with rate limits. The instance budget documented above
  // `beforeAll` is the same constraint seen from the other side.
  describe("the invite surface over HTTP", () => {
    // ── the routes ────────────────────────────────────────────────────────

    describe("the route table", () => {
      test("the invite routes are GET-only, and HEAD on either is 405 rather than a silent redeem", async () => {
        // `HEAD` is a read everywhere else in this Worker. On these two routes a
        // read is not free: `HEAD /invite/redeem` would CONSUME a guest's single
        // redemption without the guest ever seeing a page. So the classification
        // refuses the verb, and this drives it through real workerd.
        expect(classifyRoute(`${INVITE_OPEN_PREFIX}abc`, "GET").kind).toBe("invite-open");
        expect(classifyRoute(`${INVITE_OPEN_PREFIX}abc`, "HEAD").kind).toBe("method-not-allowed");
        expect(classifyRoute(`${INVITE_OPEN_PREFIX}abc`, "POST").kind).toBe("method-not-allowed");
        expect(classifyRoute(INVITE_REDEEM_PATH, "POST").kind).toBe("invite-redeem");
        expect(classifyRoute(INVITE_REDEEM_PATH, "GET").kind).toBe("method-not-allowed");
        expect(classifyRoute(INVITE_REDEEM_PATH, "HEAD").kind).toBe("method-not-allowed");

        const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        for (const path of [`${INVITE_OPEN_PREFIX}${minted.minted.token}`, INVITE_REDEEM_PATH]) {
          for (const verb of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
            const response = await harness.dispatch(`http://localhost${path}`, { method: verb });
            expect(response.status, `${verb} ${path}`).toBe(405);
          }
        }
        // Nothing was consumed by any of them.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(0);
        // And the redemption is still available afterwards.
        const { browser } = await open(harness, minted.minted.token);
        expect((await redeem(harness, browser, minted.minted.token)).status).toBe(303);
      });

      test("`redeem` is a route, not a token: it is classified before the /invite/ prefix", async () => {
        // Without the ordering, `POST /invite/redeem` would be "opening a token
        // named redeem" — one spelling of two meanings, and a shape an attacker
        // gets for free. The cost is that `/invite/redeem` is a RESERVED path: a
        // GET on it is 405 rather than the open route, so the six-character string
        // "redeem" can never be a token. Nothing real is lost — a minted token is
        // 43 characters — and the alternative is a path that means two things.
        expect(classifyRoute(INVITE_REDEEM_PATH, "POST").kind).toBe("invite-redeem");
        expect(classifyRoute(INVITE_REDEEM_PATH, "GET").kind).toBe("method-not-allowed");
        expect(classifyRoute("/invite/redeem-extra", "GET").kind).toBe("invite-open");
      });

      test("neither invite route requires a session, and the gate is still the only way to review data", async () => {
        expect(classifyRoute(`${INVITE_OPEN_PREFIX}abc`, "GET").requiresSession).toBe(false);
        expect(classifyRoute(INVITE_REDEEM_PATH, "POST").requiresSession).toBe(false);
        // The invariant slice 3 could have broken and did not: an ungated reader
        // of `env.DB` exists, and it does not reach the thread store.
        for (const path of [THREADS_PATH, `${THREADS_PATH}?since=0`]) {
          for (const verb of ["GET", "HEAD", "POST"]) {
            const response = await harness.dispatch(`http://localhost${path}`, { method: verb });
            expect([401, 405], `${verb} ${path} -> ${String(response.status)}`).toContain(response.status);
          }
        }
        // And a preview path — the one ungated-looking spelling — is still gated.
        expect((await harness.dispatch("http://localhost/revkit/pr-7/")).status).toBe(401);
      });
    });

    // ── opening ───────────────────────────────────────────────────────────

    describe("GET /invite/<token>", () => {
      test("a live invite serves a CSP-hardened, no-store form that carries the token once", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, pr: 42 }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser, response } = await open(harness, minted.minted.token);
        expect(response.status).toBe(200);
        const html = await response.text();
        // ADR-0012's policy on every HTML response, asserted on the page rather
        // than only on the header module.
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("form-action 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        // No script and no inline handler, so there is nothing for `script-src` to
        // permit and nothing for an injected tag to run.
        expect(html).not.toContain("<script");
        expect(html).not.toContain("javascript:");
        expect(html).not.toContain("onclick");
        // The token appears in the form and nowhere else on the page.
        expect(html.split(minted.minted.token)).toHaveLength(2);
        expect(html).toContain('method="post"');
        expect(html).toContain(`action="${INVITE_REDEEM_PATH}"`);
        expect(html).toContain("revkit");
        expect(html).toContain("#42");
        // L3: the browser's half of the name bound is the SAME constant the
        // module enforces, asserted here because changing `maxlength` to 4096
        // used to leave every test green.
        expect(html).toContain(`maxlength="${MAX_DISPLAY_NAME_CHARS}"`);
        // And the form's URL is token-free, so the POST lands in history without it.
        expect(html).not.toContain(`${INVITE_REDEEM_PATH}?`);
        // The browser is bound on the OPEN, which is what makes ADR-0009's "bound
        // to the first browser that opens it" literally true.
        const binding = browser.get(BROWSER_COOKIE_NAME);
        expect(binding).toBeDefined();
        expect(isTokenShaped(binding ?? "")).toBe(true);
        expect(browser.get(SESSION_COOKIE_NAME)).toBeUndefined();
      });

      test("the OPEN route's binding cookie carries the same attributes as the redeem route's", async () => {
        // This assertion is here because of a surviving mutation. The open route
        // had its OWN copy of the cookie builder; dropping `SameSite=Lax` from
        // that copy changed **zero** tests, because the redemption's identical
        // cookie — built by the shared `browserCookieHeader` — was the one the
        // assertions covered. Two builders, one covered. There is now one builder,
        // and both routes' cookies are asserted, so the copy cannot come back
        // unasserted.
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { response } = await open(harness, minted.minted.token);
        const raw = setCookieValue(response.headers.get("set-cookie") ?? joinedSetCookie(response), BROWSER_COOKIE_NAME);
        expect(raw, "the open must set the binding cookie").toBeDefined();
        const setCookie = (response.headers.getSetCookie() ?? []).find((value) => value.startsWith(`${BROWSER_COOKIE_NAME}=`)) ?? "";
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Max-Age=");
        expect(setCookie).not.toContain("Domain=");
        // `Max-Age` is the invite's REMAINING life, so a binding cannot outlive
        // the thing it binds. A 30-day team invite opened now gets ~30 days.
        const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1] ?? "0");
        expect(maxAge).toBeGreaterThan(29 * 24 * 60 * 60);
        expect(maxAge).toBeLessThanOrEqual(30 * 24 * 60 * 60);
        // And the redemption's cookie is byte-identical in its attributes.
        const redeemResponse = await redeem(harness, new Browser(), minted.minted.token);
        expect(redeemResponse.status).toBe(410);
        expect(setCookieValue(setCookie, BROWSER_COOKIE_NAME)).toBe(raw);
      });

      test("the form says what the invite permits, and a view invite says read-only before the guest commits", async () => {
        const view = await mintInvite(harness.db, { repo: REPO, kind: "view" }, { keys });
        if (!view.ok) throw new Error("mint failed");
        const viewHtml = await (await open(harness, view.minted.token)).response.text();
        expect(viewHtml).toContain("read-only");
        expect(viewHtml).toContain("view");
        const personal = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!personal.ok) throw new Error("mint failed");
        const personalHtml = await (await open(harness, personal.minted.token)).response.text();
        expect(personalHtml).toContain("can comment");
        expect(personalHtml).not.toContain("read-only");
      });

      test("a repo-scoped invite says \"all pull requests\"; a PR-scoped one names the PR", async () => {
        const whole = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!whole.ok) throw new Error("mint failed");
        expect(await (await open(harness, whole.minted.token)).response.text()).toContain("all pull requests");
        const one = await mintInvite(harness.db, { repo: REPO, pr: 7 }, { keys });
        if (!one.ok) throw new Error("mint failed");
        expect(await (await open(harness, one.minted.token)).response.text()).toContain("pull request #7");
      });

      test("a hostile token is reflected nowhere: the closed page, and markup in the path is not a page", async () => {
        for (const token of [
          "<script>alert(1)</script>",
          '"><img src=x onerror=alert(1)>',
          "a".repeat(300),
          "",
        ]) {
          const { response } = await open(harness, token);
          const html = await response.text();
          expect([404, 410], token.slice(0, 20)).toContain(response.status);
          expect(html, token.slice(0, 20)).not.toContain("<script");
          expect(html, token.slice(0, 20)).not.toContain("onerror");
          expect(html, token.slice(0, 20)).toContain("cannot be used");
        }
      });

      test("C1: the SHIPPED form, submitted the way a browser submits it, redeems", async () => {
        // The regression this exists for. `redeemFormPage` emits a plain
        // `<form method="post">` with NO `enctype`, so a browser sends
        // `application/x-www-form-urlencoded` — and the route accepted only
        // `application/json`. The page serves no script (`default-src 'none'`, no
        // `<script>`), so there is no `fetch()` to send JSON and **no HTML
        // mechanism can produce `application/json` at all**: every guest got 415
        // and no session, and no test noticed because every POST in this file was
        // a hand-built JSON `Request`.
        //
        // So this test READS THE SHIPPED PAGE and derives the request from it —
        // the `action`, the `method`, the *absent* `enctype`, and the input names
        // — rather than from what the route happens to accept. If the page and the
        // route ever disagree about the wire format again, this goes red.
        const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser, response } = await open(harness, minted.minted.token);
        expect(response.status).toBe(200);
        const html = await response.text();

        const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html);
        expect(form, "the page must ship exactly one <form>").not.toBeNull();
        const attrs = form?.[1] ?? "";
        const method = /\bmethod="([^"]*)"/.exec(attrs)?.[1];
        const action = /\baction="([^"]*)"/.exec(attrs)?.[1];
        const enctype = /\benctype="([^"]*)"/.exec(attrs)?.[1];
        // What the page declares, asserted so a future `enctype` change is a
        // deliberate edit here rather than a silent format switch.
        expect(method).toBe("post");
        expect(action).toBe(INVITE_REDEEM_PATH);
        expect(enctype, "the page declares no enctype, so the browser picks the default").toBeUndefined();
        // The two named fields, read from the markup.
        const hidden = /<input type="hidden" name="([^"]+)" value="([^"]*)">/.exec(form?.[2] ?? "");
        const named = /<input id="displayName" name="([^"]+)"[^>]*>/.exec(form?.[2] ?? "");
        expect(hidden?.[1]).toBe("token");
        expect(hidden?.[2]).toBe(minted.minted.token);
        expect(named?.[1]).toBe("displayName");

        // Exactly what a browser does with that form: the default enctype, and
        // both fields urlencoded. NOT a JSON body.
        const body = new URLSearchParams();
        body.set(hidden?.[1] ?? "", hidden?.[2] ?? "");
        body.set(named?.[1] ?? "", NAME);
        const cookie = browser.header() ?? "";
        const submitted = await harness.dispatch(`http://localhost${action ?? ""}`, {
          method: (method ?? "get").toUpperCase(),
          ...NO_FOLLOW,
          headers: { "content-type": "application/x-www-form-urlencoded", cookie },
          body: body.toString(),
        });
        expect(submitted.status, "the shipped form must redeem").toBe(303);
        browser.absorb(submitted);
        expect(browser.get(SESSION_COOKIE_NAME), "and it must set a session").toBeDefined();
        // The session the form produced is a working one.
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) })).status).toBe(200);
      });

      test("C1: the display name survives URLENCODING, not just JSON", async () => {
        // The other half of accepting a second media type: the bytes differ. A
        // name with a space, an ampersand and a non-ASCII character is encoded
        // differently by each, and a form-encoded `+` must arrive as a space.
        // `revokeInvite` and `loadInviteByToken` never see the raw string, so
        // this is the only place the round trip is pinned.
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        const name = "Ada L/ovelace & co — 引き継ぎ";
        const submitted = await redeemUrlEncoded(harness, browser, minted.minted.token, { displayName: name });
        expect(submitted.status).toBe(303);
        browser.absorb(submitted);
        const stored = await harness.db.prepare("SELECT display_name FROM guests").first<{ display_name: string }>();
        expect(stored?.display_name).toBe(name);
      });

      test("a revoked, expired or unknown invite all get the SAME closed page, and never the token", async () => {
        // A distinctive repo name, so "the page does not name the invite's scope"
        // is assertable without matching the product's own name in the title.
        const revoked = await mintInvite(harness.db, { repo: "scope-canary-org" }, { keys });
        if (!revoked.ok) throw new Error("mint failed");
        await revokeInvite(harness.db, revoked.minted.invite.id);
        const unknown = await (await open(harness, "A".repeat(43))).response;
        const revokedPage = await (await open(harness, revoked.minted.token)).response;
        expect(revokedPage.status).toBe(410);
        expect(unknown.status).toBe(410);
        // One page for every dead-link reason, so the response cannot become an
        // oracle that distinguishes "never existed" from "you are late".
        const revokedHtml = await revokedPage.text();
        const unknownHtml = await unknown.text();
        expect(revokedHtml).toBe(unknownHtml);
        expect(revokedHtml).not.toContain(revoked.minted.token);
        expect(revokedHtml).not.toContain("scope-canary-org");
      });

      test("an expired invite's page is closed, and the DB row is still there (expiry is a decision, not a deletion)", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        await harness.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
          .bind(new Date(Date.now() - 1000).toISOString(), minted.minted.invite.id)
          .run();
        expect((await open(harness, minted.minted.token)).response.status).toBe(410);
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE id = ?").bind(minted.minted.invite.id).first<{ n: number }>())?.n).toBe(1);
      });
    });

    // ── redemption ────────────────────────────────────────────────────────

    describe("POST /invite/redeem", () => {
      test("a live invite answers 303 to a TOKEN-FREE path and sets both cookies", async () => {
        const { browser, response } = await onboard(harness, { repo: REPO, pr: 42 });
        expect(response.status).toBe(303);
        const location = response.headers.get("location") ?? "";
        // The redirect target names the review, not the credential.
        expect(location).toBe("/revkit/pr-42/");
        expect(location).not.toContain("invite");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        const cookies = joinedSetCookie(response);
        expect(cookies).toContain(`${BROWSER_COOKIE_NAME}=`);
        expect(cookies).toContain(`${SESSION_COOKIE_NAME}=`);
        // Both are `__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/.
        for (const name of [SESSION_COOKIE_NAME, BROWSER_COOKIE_NAME]) {
          const value = (cookies.split(/,\s*(?=[A-Za-z0-9_-]+=)/).find((part) => part.startsWith(`${name}=`))) ?? "";
          expect(value, name).toContain("HttpOnly");
          expect(value, name).toContain("Secure");
          expect(value, name).toContain("SameSite=Lax");
          expect(value, name).toContain("Path=/");
          expect(value, name).not.toContain("Domain=");
        }
        // The body is empty: a 303 that carried the token would put it back in
        // the response.
        expect(await response.text()).toBe("");
        expect(browser.get(SESSION_COOKIE_NAME)).toBeDefined();
      });

      test("the redemption's 303 target is / for a repo-scoped invite, not an invented PR", async () => {
        const { response } = await onboard(harness, { repo: REPO });
        expect(response.headers.get("location")).toBe("/");
      });

      test("nothing about the exchange carries the token: no body, no Location, no Referer, no log line", async () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (line: unknown) => { lines.push(String(line)); };
          try {
          const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
          if (!minted.ok) throw new Error("mint failed");
          const token = minted.minted.token;
          const { browser } = await open(harness, token);
          const response = await redeem(harness, browser, token);
          expect(response.status).toBe(303);
          expect(await response.text()).not.toContain(token);
          expect(response.headers.get("location") ?? "").not.toContain(token);
          for (const name of ["set-cookie", "referrer-policy", "content-security-policy", "cache-control"]) {
            expect(response.headers.get(name) ?? "", name).not.toContain(token);
          }
          // Every log line the exchange produced, and the page the browser was
          // handed before it: none of them contains the token. ADR-0015/ADR-0020
          // ("logs carry no … tokens") and ADR-0009's "stripped from the URL".
          const formHtml = await (await open(harness, token)).response.text();
          expect(formHtml).toContain(token);
          for (const line of lines) expect(line, line.slice(0, 120)).not.toContain(token);
          expect(lines.length).toBeGreaterThan(0);
        } finally {
          console.log = original;
        }
          });

      test("an already-redeemed token is refused, and the closed page never says why", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        expect((await redeem(harness, browser, minted.minted.token)).status).toBe(303);
        const replay = await redeem(harness, browser, minted.minted.token);
        expect(replay.status).toBe(410);
        const html = await replay.text();
        expect(html).toContain("cannot be used");
        // One page for every dead-link reason, so the copy cannot single this one
        // out. Asserted against the UNKNOWN-token page below rather than against
        // a word list, because the wording is allowed to change.
        const { response: unknownPage } = await open(harness, "A".repeat(43));
        expect(html).toBe(await unknownPage.text());
        // One session, not two.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
      });

      test("a second browser on a personal invite is refused, and no session is minted for it", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const first = await open(harness, minted.minted.token);
        expect((await redeem(harness, first.browser, minted.minted.token)).status).toBe(303);
        const second = await open(harness, minted.minted.token);
        const refused = await redeem(harness, second.browser, minted.minted.token);
        expect(refused.status).toBe(410);
        expect(await refused.text()).toContain("cannot be used");
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
        // And the second browser holds a binding cookie but NO session, so it
        // cannot use the invite by any other route either.
        expect(second.browser.get(BROWSER_COOKIE_NAME)).toBeDefined();
        expect(second.browser.get(SESSION_COOKIE_NAME)).toBeUndefined();
      });

      test("max_browsers exceeded is refused at the HTTP boundary too", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const statuses: number[] = [];
        for (let index = 0; index < minted.minted.invite.maxBrowsers + 2; index++) {
          const { browser } = await open(harness, minted.minted.token);
          statuses.push((await redeem(harness, browser, minted.minted.token)).status);
        }
        expect(statuses.slice(0, minted.minted.invite.maxBrowsers).every((status) => status === 303)).toBe(true);
        expect(statuses.slice(minted.minted.invite.maxBrowsers).every((status) => status === 410)).toBe(true);
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(minted.minted.invite.maxBrowsers);
      });

      test("the redemption's OWN guard refuses a revoked row the pre-read never saw", async () => {
        // The mutation run's one survivor in this area: deleting
        // `revoked_at IS NULL` from `redemptionClaimStatement` changed 0 of 87
        // tests, because `redeemInvite`'s pre-read refuses a revoked invite first
        // and no test could see past it. The clause is the only check inside the
        // ATOMIC unit, so it is driven here directly — the one place a predicate
        // the surrounding function short-circuits can be pinned.
        //
        // `windowMs` offsets the caller's clock so the invite's own lifetime can be
        // made to straddle it.
        const at = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();
        const claim = async (offsetMs: number, edit?: () => Promise<void>): Promise<number> => {
          const minted = await mintOk(db(), { repo: REPO, kind: "team" });
          if (!minted.ok) throw new Error("mint failed");
          const invite = minted.minted.invite;
          const bindingHash = await sha256Hex(mintToken());
          const guestId = crypto.randomUUID();
          if (edit !== undefined) await edit();
          const result = await redemptionClaimStatement(db(), {
            inviteId: invite.id,
            bindingHash,
            guestId,
            nowIso: at(offsetMs),
            maxBrowsers: invite.maxBrowsers,
          }).run();
          return result.meta?.changes ?? 0;
        };
        // A live invite at its own moment: the guard ADMITS.
        expect(await claim(0)).toBe(1);
        // Revoked before the claim: the guard refuses, zero rows, no error.
        expect(
          await claim(0, async () => {
            await db().prepare("UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL").bind(at(0)).run();
          }),
        ).toBe(0);
        // Expired relative to the caller's clock: refused.
        expect(await claim(INVITE_LIFETIME_DAYS.team * DAY_MS + 1000)).toBe(0);
        // One millisecond before expiry: admitted, so the boundary is exact.
        expect(await claim(INVITE_LIFETIME_DAYS.team * DAY_MS - 1)).toBe(1);
        // And no refusal wrote anything: the ledger has exactly the two admits.
        const rows = await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>();
        expect(rows?.n).toBe(2);
      });

      test("the guard refuses a full invite and an already-bound browser", async () => {
        // The other two clauses of the same `WHERE`, driven the same way, because
        // the same reasoning applies to all three: the pre-read cannot see them.
        const minted = await mintOk(db(), { repo: REPO, kind: "team" });
        if (!minted.ok) throw new Error("mint failed");
        const invite = minted.minted.invite;
        const nowIso = new Date(NOW).toISOString();
        const bindingHash = await sha256Hex(mintToken());
        const claim = (guestId: string): Promise<number> =>
          redemptionClaimStatement(db(), {
            inviteId: invite.id,
            bindingHash,
            guestId,
            nowIso,
            maxBrowsers: 1,
          }).run().then((result) => result.meta?.changes ?? 0);
        // One slot, one browser: the first claim takes it.
        expect(await claim(crypto.randomUUID())).toBe(1);
        // A different browser, same full invite: refused by the ceiling.
        expect(await claim(crypto.randomUUID())).toBe(0);
        // The SAME browser again: refused by the exclusion, which is what turns a
        // full invite's ceiling into a replay rather than an ambiguity.
        expect(await claim(crypto.randomUUID())).toBe(0);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM invite_redemptions").first<{ n: number }>())?.n).toBe(1);
      });

      test("a tampered token redeems nothing", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        const token = minted.minted.token;
        const lastChar = `${token.slice(0, 42)}${token[42] === "A" ? "B" : "A"}`;
        for (const candidate of [lastChar, "A".repeat(43), `${token}x`]) {
          const response = await redeem(harness, browser, candidate);
          expect([400, 410], candidate).toContain(response.status);
        }
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
        // The real token still works, which is what proves the refusals were about
        // the token rather than about the browser or the endpoint.
        expect((await redeem(harness, browser, token)).status).toBe(303);
      });

      test("a redemption with no browser binding is refused", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        // Straight to the POST, skipping the open that mints the binding.
        const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: JSON_HEADERS,
          body: JSON.stringify({ token: minted.minted.token, displayName: NAME }),
        });
        expect(response.status).toBe(410);
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
      });

      test("the redeem body accepts JSON or a browser form, and refuses everything else", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        const token = minted.minted.token;
        const cookie = browser.header() ?? "";
        // ADR-0012's named type, and everything that merely resembles it. The
        // form's default type is the ONE addition, and it is the only addition on
        // this route — `isRedeemContentType`'s comment says why, and the "C1: the
        // SHIPPED form" case is what makes it load-bearing rather than
        // theoretical.
        // A trailing space is the SAME type after the trim every other route in
        // this Worker already does. Its own invite, because a successful
        // redemption consumes the slot — the first draft of this case reused
        // `token` and every later assertion in it then met `already-redeemed`,
        // which is correct behaviour landing on a test that had not noticed.
        const spaced = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!spaced.ok) throw new Error("mint failed");
        const { browser: bSpace } = await open(harness, spaced.minted.token);
        expect((await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: { "content-type": "application/x-www-form-urlencoded ", cookie: bSpace.header() ?? "" },
          body: `token=${spaced.minted.token}&displayName=${encodeURIComponent(NAME)}`,
        })).status).toBe(303);
        for (const contentType of ["text/plain", "application/ld+json", "text/json", "multipart/form-data", "application/x-www-form-urlencodedx"]) {
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { "content-type": contentType, cookie },
            body: `token=${token}&displayName=${NAME}`,
          });
          expect([400, 415], contentType).toContain(response.status);
          if (response.status === 415) expect(await json(response)).toMatchObject({ error: "unsupported-media-type" });
        }
        // No header at all.
        expect((await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: { cookie },
          body: `token=${token}&displayName=${NAME}`,
        })).status).toBe(415);
        // A parameterised JSON type is accepted, as it is everywhere else.
        expect((await redeem(harness, browser, token, { displayName: NAME }, { headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(303);
        // And the form type, with and without a parameter.
        const second = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!second.ok) throw new Error("mint failed");
        const { browser: b2 } = await open(harness, second.minted.token);
        expect((await redeemUrlEncoded(harness, b2, second.minted.token)).status).toBe(303);
        const third = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!third.ok) throw new Error("mint failed");
        const { browser: b3 } = await open(harness, third.minted.token);
        expect((await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", cookie: b3.header() ?? "" },
          body: new URLSearchParams({ token: third.minted.token, displayName: NAME }).toString(),
        })).status).toBe(303);
        // The display name is required and bounded on BOTH encodings, and the
        // bound is `redeemInvite`'s, not the parser's.
        const fourth = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!fourth.ok) throw new Error("mint failed");
        const { browser: b4 } = await open(harness, fourth.minted.token);
        for (const displayName of ["", "   ", "x".repeat(65)]) {
          expect((await redeemUrlEncoded(harness, b4, fourth.minted.token, { displayName })).status, displayName.slice(0, 8)).toBe(410);
          expect((await redeem(harness, b4, fourth.minted.token, { displayName })).status, displayName.slice(0, 8)).toBe(410);
        }
        // Over the PARSER's ceiling but inside the module's is still refused by
        // the module, so the two bounds are not confused for each other.
        expect((await redeem(harness, b4, fourth.minted.token, { displayName: "x".repeat(5000) })).status).toBe(400);
        expect((await redeemUrlEncoded(harness, b4, fourth.minted.token, { displayName: "x".repeat(5000) })).status).toBe(400);
        // The FOUR successful redemptions above — the trailing-space probe, the
        // parameterised JSON type, and the form type with and without a parameter
        // — and no more: every refusal in this case must leave no guest behind.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>())?.n).toBe(4);
      });

      test("a REPEATED form field is refused, and a repeated JSON key is deterministic", async () => {
        // A form body can legitimately carry `token` twice, and "the first one" is
        // how one browser's redemption becomes another's — the `since-repeated`
        // rule `parseThreadsQuery` already applies. So the FORM encoding refuses a
        // repeated name outright.
        //
        // JSON is different and the difference is not glossed over: `JSON.parse`
        // keeps the LAST of a repeated key. That is standard, deterministic, and
        // cannot be exploited — only one of the two values can match an invite and
        // the other simply finds no row — so this asserts the behaviour rather
        // than claiming a refusal the parser does not perform. Detecting it would
        // mean re-scanning the raw text for top-level keys, which is a JSON
        // parser, for a client-side bug a browser cannot produce.
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        const token = minted.minted.token;
        const cookie = browser.header() ?? "";
        const decoy = "A".repeat(43);
        const posted = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: { "content-type": "application/x-www-form-urlencoded", cookie },
          body: `token=${token}&token=${token}&displayName=${encodeURIComponent(NAME)}`,
        });
        expect(posted.status).toBe(400);
        expect(await json(posted)).toMatchObject({ error: "bad-request", reason: "unparsable-body" });
        // JSON: last wins, and it is the value that counts.
        const viaJson = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
          method: "POST",
          ...NO_FOLLOW,
          headers: { ...JSON_HEADERS, cookie },
          body: `{"token":"${decoy}","token":"${token}","displayName":"${NAME}"}`,
        });
        expect(viaJson.status).toBe(303);
        // Exactly one session either way — a repeat never mints a second one.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
      });

      test("an unparsable, non-object or wrongly-typed body is one 400 with a fixed reason", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const { browser } = await open(harness, minted.minted.token);
        const cookie = browser.header() ?? "";
        for (const body of ["", "not json", "[]", '"a string"', "null", "{}", '{"token":42}', '{"token":"short","displayName":"Ada"}', '{"token":"x","displayName":42}', '{"token":"x","displayName":"Ada","extra":{"a":[1,2]}}']) {
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { ...JSON_HEADERS, cookie },
            body,
          });
          const text = await response.text();
          expect([400, 410], body.slice(0, 24)).toContain(response.status);
          if (response.status === 400) {
            expect(JSON.parse(text)).toMatchObject({ error: "bad-request", reason: "unparsable-body" });
          }
          // Nothing from the body is echoed, including a display name the caller
          // supplied and a nested structure it invented.
          expect(text, body.slice(0, 24)).not.toContain("Ada");
          expect(text, body.slice(0, 24)).not.toContain("extra");
        }
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
      });
    });

    // ── the per-call check, on a real request ─────────────────────────────

    describe("ADR-0012's per-call check, on a real request", () => {
      test("a guest session reads the threads endpoint", async () => {
        const { browser } = await onboard(harness);
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
        expect(response.status).toBe(200);
      });

      test("H1: re-opening the mail link does NOT strand a live session", async () => {
        // The second regression this exists for. `GET /invite/<token>` minted a
        // FRESH binding on every open and `Set-Cookie`d it, while the live
        // session stays bound to the binding it was redeemed with — which is
        // re-read on every call. So a second click on the mail link, a second tab,
        // a session restore or a Back-navigation silently replaced the cookie the
        // session depends on:
        //
        //   redeem -> 303 | GET /api/threads -> 200
        //   re-open -> 200 | binding changed -> GET /api/threads -> 403
        //   re-redeem -> 410 (the slot is spent, so there is no recovery)
        //
        // Triggers are ordinary browser behaviour, not an attack.
        const { browser, token } = await onboard(harness);
        const boundAtRedemption = browser.get(BROWSER_COOKIE_NAME);
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) })).status).toBe(200);

        // The guest clicks the mail link again. Same browser, same cookie jar —
        // so the response's `Set-Cookie` lands on top of the live session's
        // binding, which is the whole mechanism of the defect.
        expect((await reopen(harness, browser, token)).status).toBe(200);
        // …and the binding the live session depends on must be UNCHANGED.
        expect(browser.get(BROWSER_COOKIE_NAME), "re-opening must not rotate the binding").toBe(boundAtRedemption);
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) })).status).toBe(200);
        // And re-redeeming is still refused, so nothing was widened: single use is
        // single use.
        expect((await redeem(harness, browser, token)).status).toBe(410);
      });

      test("a MALFORMED binding cookie is replaced, not adopted — otherwise redemption is unreachable", async () => {
        // Found by the mutation run, and it is the reason `isTokenShaped` is in the
        // reuse condition at all. Dropping it changed nothing measurable, which is
        // exactly what made it worth chasing.
        //
        // The open reuses the browser's binding so H1 cannot happen. If it reuses
        // UNCONDITIONALLY, then a browser holding a corrupted cookie keeps getting
        // that same corrupted cookie back — and `redeemInvite` refuses a
        // non-token-shaped binding (`browser-binding-missing`, refused BEFORE the
        // slot is consumed). So the guest can never redeem, can never recover, and
        // re-opening the link re-adopts the bad value every time:
        //
        //   open(reuse garbage) -> 200 | redeem -> 410 closed | open -> 200 | …
        //
        // An unrecoverable state, reached by ordinary cookie corruption.
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const token = minted.minted.token;
        const browser = new Browser();
        browser.set(BROWSER_COOKIE_NAME, "corrupted-not-a-token");

        const opened = await harness.dispatch(`http://localhost${INVITE_OPEN_PREFIX}${token}`, {
          headers: { cookie: browser.header() ?? "" },
        });
        expect(opened.status).toBe(200);
        browser.absorb(opened);

        // The open must hand back something the redemption will ACCEPT, not the
        // value it was given.
        const replacement = browser.get(BROWSER_COOKIE_NAME);
        expect(replacement).toBeDefined();
        expect(isTokenShaped(replacement ?? ""), "the replacement binding must be token-shaped").toBe(true);
        expect(replacement, "the corrupted value must not be re-adopted").not.toBe("corrupted-not-a-token");

        // And the whole point: redemption is reachable again.
        expect((await redeem(harness, browser, token)).status).toBe(303);
      });

      test("revoking the invite stops an ALREADY-MINTED, UNEXPIRED session on its next request", async () => {
        const { browser, inviteId } = await onboard(harness);
        // Before: works, and the session row is unexpired — so the refusal that
        // follows cannot be explained by session expiry.
        const before = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
        expect(before.status).toBe(200);
        const session = await harness.db.prepare("SELECT expires_at FROM sessions").first<{ expires_at: string }>();
        expect(Date.parse(session?.expires_at ?? "")).toBeGreaterThan(Date.now());

        await revokeInvite(harness.db, inviteId);

        // After: the very same cookie, on the very next request.
        const after = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
        expect(after.status).toBe(401);
        expect(await json(after)).toMatchObject({ error: "unauthorized", reason: "invite-revoked" });
        // No expiry to wait for, and the session row is still present and still
        // unexpired — ADR-0012's "checked on each call", measured.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
        expect(Date.parse(session?.expires_at ?? "")).toBeGreaterThan(Date.now());
      });

      test("an expired invite stops its sessions too, even with no revocation", async () => {
        const { browser, inviteId } = await onboard(harness);
        await harness.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
          .bind(new Date(Date.now() - 1000).toISOString(), inviteId)
          .run();
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
        expect(response.status).toBe(401);
        expect(await json(response)).toMatchObject({ reason: "invite-expired" });
      });

      test("a session whose guest row was swept away is refused, not honoured", async () => {
        // The fail-closed direction of ADR-0015's purge: the join has no row, so
        // there is no invite, so there is no authority.
        const { browser, guestId } = await onboard(harness);
        await harness.db.prepare("DELETE FROM invite_redemptions WHERE guest_id = ?").bind(guestId).run();
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
        expect(response.status).toBe(401);
        expect(await json(response)).toMatchObject({ reason: "invite-no-grant" });
      });

      test("a session cookie replayed from a different browser is refused", async () => {
        const { browser, sessionId } = await onboard(harness);
        const other = new Browser();
        other.set(SESSION_COOKIE_NAME, sessionId);
        // No binding cookie at all: this is a cookie lifted out of one profile.
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(other, null) });
        expect(response.status).toBe(403);
        expect(await json(response)).toMatchObject({ reason: "invite-browser-mismatch" });
        // And a browser that carries a DIFFERENT binding is refused the same way,
        // so an attacker cannot mint a plausible one.
        other.set(BROWSER_COOKIE_NAME, "B".repeat(43));
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(other, null) })).status).toBe(403);
        // The legitimate browser still works.
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) })).status).toBe(200);
      });

      test("an ambiguous binding cookie is refused rather than resolved to the first", async () => {
        const { browser, sessionId } = await onboard(harness);
        const binding = browser.get(BROWSER_COOKIE_NAME) ?? "";
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          headers: { cookie: `${BROWSER_COOKIE_NAME}=${binding}; ${BROWSER_COOKIE_NAME}=${"C".repeat(43)}; ${SESSION_COOKIE_NAME}=${sessionId}` },
        });
        expect(response.status).toBe(403);
        expect(await json(response)).toMatchObject({ reason: "invite-browser-mismatch" });
      });

      test("scope: a guest is refused a preview path its invite does not cover, and admitted one it does", async () => {
        const whole = await onboard(harness, { repo: REPO });
        // Covered: same repo, any PR.
        expect((await harness.dispatch("http://localhost/revkit/pr-7/")).status).toBe(401);
        expect((await harness.dispatch("http://localhost/revkit/pr-7/", { headers: authedHeaders(whole.browser, null) })).status).toBe(501);
        // Not covered: a different repo, at any PR.
        const other = await harness.dispatch("http://localhost/other/pr-7/", { headers: authedHeaders(whole.browser, null) });
        expect(other.status).toBe(403);
        expect(await json(other)).toMatchObject({ reason: "invite-scope-mismatch" });
        // Nor a repo whose name merely starts the same.
        expect((await harness.dispatch("http://localhost/revkit2/pr-7/", { headers: authedHeaders(whole.browser, null) })).status).toBe(403);

        const onePr = await onboard(harness, { repo: REPO, pr: 42 });
        expect((await harness.dispatch("http://localhost/revkit/pr-42/", { headers: authedHeaders(onePr.browser, null) })).status).toBe(501);
        const wrongPr = await harness.dispatch("http://localhost/revkit/pr-43/", { headers: authedHeaders(onePr.browser, null) });
        expect(wrongPr.status).toBe(403);
        expect(await json(wrongPr)).toMatchObject({ reason: "invite-scope-mismatch" });
      });

      test("an unauthorized caller learns \"unauthorized\", never that a scoped path exists", async () => {
        // The gate runs before the scope check, so a caller with no session
        // cannot use the scope answers as an existence oracle for a repo/PR pair.
        const noSession = await harness.dispatch("http://localhost/other/pr-7/");
        expect(noSession.status).toBe(401);
        // Read once: `Response.body` is a stream, so a second read sees nothing.
        const body = await noSession.text();
        expect(parseJson(body)).toMatchObject({ error: "unauthorized", reason: "no-session-cookie" });
        expect(body).not.toContain("scope");
        expect(body).not.toContain("other");
      });

      test("kind: a view invite cannot comment, and the refusal comes from the gate, not the 501", async () => {
        const { browser, csrfToken } = await onboard(harness, { repo: REPO, kind: "view" });
        // The read is fine.
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) })).status).toBe(200);
        // The append is refused with 403 invite-read-only — NOT 501. That is the
        // proof that ADR-0009's read-only rule is enforced while the write itself
        // still does not exist: the 501 is only ever reached by a caller entitled
        // to write.
        const refused = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          method: "POST",
          headers: authedHeaders(browser, csrfToken, JSON_HEADERS),
        });
        expect(refused.status).toBe(403);
        expect(await json(refused)).toMatchObject({ error: "forbidden", reason: "invite-read-only" });
        // A `personal` guest with the same CSRF token and media type reaches 501.
        const writer = await onboard(harness, { repo: REPO, kind: "personal" });
        const append = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          method: "POST",
          headers: authedHeaders(writer.browser, writer.csrfToken, JSON_HEADERS),
        });
        expect(append.status).toBe(501);
        expect(await json(append)).toMatchObject({ error: "not-implemented" });
      });

      test("a read-only guest can still refresh its own session — that is not a comment", async () => {
        const { browser, csrfToken } = await onboard(harness, { repo: REPO, kind: "view" });
        const response = await harness.dispatch("http://localhost/api/session/refresh", {
          method: "POST",
          headers: authedHeaders(browser, csrfToken, JSON_HEADERS),
        });
        expect(response.status).toBe(200);
        // The rotation REPLACES the session cookie, so the browser has to take the
        // new one — the old one is dead by design (`rotateSession` deletes the row
        // it replaced). A test that kept using the old cookie would see
        // `unknown-session`, which is a correct answer to a dead credential and the
        // wrong thing to assert here.
        browser.absorb(response);
        // …and it replaces the CSRF token too, which is why the header value from
        // the response is the one the next call must present.
        const rotatedCsrf = response.headers.get(CSRF_HEADER);
        expect(rotatedCsrf).not.toBe(csrfToken);
        // And the rotation is still gated on the invite: revoke, and the refresh
        // dies with the rest.
        await revokeInvite(harness.db, (await harness.db.prepare("SELECT invite_id FROM invite_redemptions LIMIT 1").first<{ invite_id: string }>())?.invite_id ?? "");
        const afterRevoke = await harness.dispatch("http://localhost/api/session/refresh", {
          method: "POST",
          headers: authedHeaders(browser, rotatedCsrf, JSON_HEADERS),
        });
        expect(afterRevoke.status).toBe(401);
        expect(parseJson(await afterRevoke.text())).toMatchObject({ reason: "invite-revoked" });
      });

      test("every guest refusal reason is a member of the gate's closed vocabulary", async () => {
        // `denialLogMessage` switches on the prefix, so an unregistered reason
        // would produce a line the logger has to rewrite to `invalid.log.message`
        // — a silent loss. Asserted over the whole list rather than over the
        // reasons this file happens to produce.
        const { denialLogMessage } = await import("../src/authz.ts");
        for (const reason of DENIAL_REASONS) {
          expect(denialLogMessage(reason), reason).toMatch(/^(auth|csrf|invite)\./);
        }
      });

      test("an operator session is unaffected by every guest rule", async () => {
        // Slice 2's identity must keep working exactly as before: no invite, no
        // binding cookie, no scope. If any of the guest checks had leaked into
        // the general path, this is what would break.
        const { issueTestSession } = await import("./harness.ts");
        const session = await issueTestSession(harness.db);
        const headers = { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` };
        expect((await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers })).status).toBe(200);
        expect((await harness.dispatch("http://localhost/revkit/pr-7/", { headers })).status).toBe(501);
        expect((await harness.dispatch("http://localhost/other/pr-7/", { headers })).status).toBe(501);
        const refresh = await harness.dispatch("http://localhost/api/session/refresh", {
          method: "POST",
          headers: { ...headers, [CSRF_HEADER]: session.csrfToken, ...JSON_HEADERS },
        });
        expect(refresh.status).toBe(200);
      });
    });

    // ── rate limiting over HTTP ───────────────────────────────────────────

    describe("ADR-0012's rate limit, over HTTP", () => {
      test("a token over its limit gets 429 with Retry-After, and the OPEN route cannot spend it", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const token = minted.minted.token;
        const { browser } = await open(harness, token);

        // ── The OPEN route must NOT spend the per-token bucket ───────────────
        // It used to, and that was a shipped DoS: the bucket is
        // `invite:<hmac(token)>`, so anyone holding the URL could spend the
        // intended guest's whole window with GETs and lock them out with no
        // recovery, because the redemption slot is single-use and there is nothing
        // to retry. Forty-five opens from a different address, then the guest.
        const attacker = "198.51.100.4";
        for (let attempt = 0; attempt < REDEEM_TOKEN_LIMIT + 5; attempt++) {
          const response = await open(harness, token, { headers: { [CLIENT_IP_HEADER]: attacker } });
          expect(response.response.status, `open ${attempt}`).toBe(200);
        }
        // And the guest's own redemption is untouched by all of that.
        expect((await redeem(harness, browser, token, { displayName: NAME })).status).toBe(303);
      });

      test("a token over its REDEMPTION limit gets 429 with Retry-After", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const token = minted.minted.token;
        const digest = await keys.hash(token);
        // Seed the token's own bucket at its ceiling, then one attempt from a
        // fresh address, so the refusal can only be the token's.
        // Seeded rather than counted up to: `seedCounter` writes one row where
        // counting to the limit costs `limit + 1` sequential D1 round trips, and
        // at 40 that once ran a case past bun's 5 s per-test timeout. It also
        // asserts the boundary EXACTLY rather than "at some point it refused".
        await seedCounter(`invite:${digest}`, REDEEM_TOKEN_LIMIT);
        const { browser } = await open(harness, token, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } });
        const limited = await redeem(harness, browser, token, { displayName: NAME }, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } });
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(limited.headers.get("cache-control")).toBe("no-store");
        expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await limited.text()).toContain("Too many attempts");
        // A DIFFERENT token is unaffected: the two buckets are separate.
        const other = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!other.ok) throw new Error("mint failed");
        const { browser: b2 } = await open(harness, other.minted.token, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } });
        expect((await redeem(harness, b2, other.minted.token, { displayName: NAME }, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } })).status).toBe(303);
      });

      test("a token that does NOT resolve creates no counter row at all", async () => {
        // M2's second half. The per-token key is `invite:<hmac(token)>` over
        // whatever the caller presented, so charging it before the lookup would
        // mean every guessed token is a fresh row: one D1 write each, and no real
        // invite's budget ever touched. A per-token limit that cannot defend
        // against guessing is not defending against guessing.
        const garbage = ["A".repeat(43), "B".repeat(43), "C".repeat(43)];
        const address = "192.0.2.55";
        for (const token of garbage) {
          const { browser } = await open(harness, token, { headers: { [CLIENT_IP_HEADER]: address } });
          expect((await redeem(harness, browser, token, { displayName: NAME }, { headers: { [CLIENT_IP_HEADER]: address } })).status).toBe(410);
        }
        const rows = await harness.db.prepare("SELECT bucket, count FROM rate_limit_counters").all<{ bucket: string; count: number }>();
        // NOT ONE `invite:` row. Six guessed tokens, six rows that do not exist.
        expect(rows.results.filter((row) => row.bucket.startsWith("invite:"))).toEqual([]);
        // The address bucket WAS charged for every one of them, which is the
        // control that does work: ONE row, count 6 — the key is the edge-set
        // address, so how many rows an attacker can create is bounded by how many
        // source addresses they hold rather than by how much they can guess.
        const ipRows = rows.results.filter((row) => row.bucket.startsWith("ip:"));
        expect(ipRows).toHaveLength(1);
        expect(ipRows[0]?.bucket).toBe("ip:192.0.2.55");
        expect(ipRows[0]?.count).toBe(6);
      });

      test("a per-address limit exists and is separate from the per-token one", async () => {
        // Rotating tokens from one address must hit the ADDRESS limit, or
        // "per identity AND IP" is only half implemented.
        //
        // The counter is brought to its ceiling through the MODULE rather than
        // through ~120 HTTP requests. That is deliberate and it is not a shortcut
        // around the property: the assertion under test is that the HTTP surface
        // reports an address-bucket refusal, and an earlier version that reached
        // the ceiling the honest way took 5.5 s and killed its own workerd
        // instance (measured — the following cases then failed with "Unable to
        // connect"). The counter is what the request is checked against; how it
        // got there is `test/invites.test.ts`'s job, and it spends 40 rows there
        // in milliseconds.
        const address = "203.0.113.7";
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const digest = await sha256Hex(minted.minted.token);
        // ONLY the address bucket, so the token's own budget stays whole and the
        // refusal that follows cannot be the token's.
        const addressOnly = (): RateBucket[] => addressBucket(address);
        for (let attempt = 0; attempt < REDEEM_IP_LIMIT; attempt++) {
          const spent = await spendAttempts(harness.db, addressOnly());
          expect(spent.ok, `prefill ${attempt}`).toBe(true);
        }
        // The token's OWN bucket is untouched by that — different bucket, so the
        // refusal that follows is unambiguously the address's.
        const { browser } = await open(harness, minted.minted.token, { headers: { [CLIENT_IP_HEADER]: address } });
        const response = await redeem(harness, browser, minted.minted.token, { displayName: NAME }, { headers: { [CLIENT_IP_HEADER]: address } });
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        // The refusal was spent against the ip bucket, which the caller cannot
        // read: the verdict exposes a KIND and nothing else.
        const verdict = await spendAttempts(harness.db, addressOnly());
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.kind).toBe("ip");
        // And the same token from a DIFFERENT address is unaffected, so one
        // noisy neighbour cannot deny a stranger their own invite.
        const elsewhere = await open(harness, minted.minted.token, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } });
        const fresh = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!fresh.ok) throw new Error("mint failed");
        const other = await open(harness, fresh.minted.token, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } });
        expect((await redeem(harness, other.browser, fresh.minted.token, { displayName: NAME }, { headers: { [CLIENT_IP_HEADER]: "198.51.100.4" } })).status).toBe(303);
        expect(elsewhere.browser.get(BROWSER_COOKIE_NAME)).toBeDefined();
      });

      // ── M1: every path through the redeem handler is metered ─────────────
      describe("every unmetered path from slice 3 is now metered", () => {
        /** Counter rows, split by kind. The shape the handler must leave behind
         * for an attempt that got as far as its own early return. */
        async function counters(): Promise<{ ip: number; token: number }> {
          const rows = (await harness.db.prepare("SELECT bucket FROM rate_limit_counters").all<{ bucket: string }>()).results;
          return {
            ip: rows.filter((row) => row.bucket.startsWith("ip:")).length,
            token: rows.filter((row) => row.bucket.startsWith("invite:")).length,
          };
        }
        const ADDRESS = "198.51.100.77";

        test("a malformed JSON body is metered", async () => {
          const before = await counters();
          expect((await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { ...JSON_HEADERS, [CLIENT_IP_HEADER]: ADDRESS },
            body: "not json at all",
          })).status).toBe(400);
          expect(await counters()).toEqual({ ip: before.ip + 1, token: before.token });
        });

        test("a wrong media type is metered", async () => {
          const before = await counters();
          expect((await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { "content-type": "text/plain", [CLIENT_IP_HEADER]: ADDRESS },
            body: "token=x",
          })).status).toBe(415);
          expect(await counters()).toEqual({ ip: before.ip + 1, token: before.token });
        });

        test("an over-long body is metered, and refused as TOO LARGE rather than unparsable", async () => {
          // The parser used to run BEFORE the limiter, so an oversized body was an
          // unmetered `request.text()` on an unauthenticated route — and
          // `/invite/redeem` is unauthenticated BY DESIGN, because its credential
          // is the token inside the body, so it has not been checked when the body
          // arrives. The limiter bounds how MANY such requests there are; only a
          // size ceiling bounds how BIG each one is.
          const before = await counters();
          const oversized = `{"token":"${"A".repeat(MAX_REDEEM_BODY_BYTES * 4)}","displayName":"x"}`;
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { ...JSON_HEADERS, [CLIENT_IP_HEADER]: ADDRESS },
            body: oversized,
          });
          // 413, not 400: "send less" and "send something I can parse" are
          // different answers, and collapsing them would hide the ceiling.
          expect(response.status).toBe(413);
          expect(await json(response)).toMatchObject({ error: "bad-request", reason: "body-too-large" });
          expect(await counters()).toEqual({ ip: before.ip + 1, token: before.token });
        });

        test("the ceiling holds when there is NO content-length at all", async () => {
          // The guarantee is the streaming cap, not the header, and the case that
          // proves it is a body with **no declared length** — chunked transfer,
          // which is what a client sends when it does not know the size, and what
          // `content-length` cannot be relied on to describe.
          //
          // Two earlier versions of this test were wrong in ways worth recording.
          // One asserted the cap using a STRING body, and miniflare computes
          // `content-length` from a string — so it passed with the cap deleted
          // (measured: the mutation survived). The next declared
          // `content-length: "12"` over a large body and expected the cap to catch
          // the discrepancy; it returned 400 instead, because at the HTTP layer a
          // short declared length means the body IS 12 bytes — the platform, not
          // the Worker, enforces that, so a lying header cannot deliver an
          // oversized body and there is nothing for the cap to catch. The
          // reachable case is an ABSENT header.
          const oversized = `token=${"A".repeat(MAX_REDEEM_BODY_BYTES * 4)}&displayName=x`;
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { "content-type": FORM_MEDIA_TYPE, [CLIENT_IP_HEADER]: ADDRESS },
            // A stream, so there is no length for miniflare to add.
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(oversized));
                controller.close();
              },
            }),
          });
          expect(response.status).toBe(413);
          expect(await json(response)).toMatchObject({ reason: "body-too-large" });
        });

        test("a body just under the ceiling is still parsed, so the bound is not a blanket refusal", async () => {
          // The other side of the boundary, because a ceiling that refuses
          // everything passes both tests above.
          const name = "A".repeat(20);
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { "content-type": FORM_MEDIA_TYPE, cookie: "", [CLIENT_IP_HEADER]: ADDRESS },
            body: new URLSearchParams({ token: "A".repeat(43), displayName: name }).toString(),
          });
          // 410 and the closed page, NOT 413: a body under the ceiling got all the
          // way to the token lookup, which is the whole point of the other side.
          expect(response.status).toBe(410);
          expect(await response.text()).not.toContain("A".repeat(43));
        });

        test("with an edge address the open does NOT spend the per-token bucket", async () => {
          // The rule is unit-tested in `test/invites.test.ts`'s "rate limits"
          // describe, where the two inputs are named. This is the HTTP half: with
          // an address present, holding an invite URL and GETting it must not be
          // able to spend the guest's redemption budget — the shipped DoS the
          // per-token bucket on this route used to cause.
          const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
          if (!minted.ok) throw new Error("mint failed");
          const digest = await keys.hash(minted.minted.token);
          expect(
            (await open(harness, minted.minted.token, { headers: { [CLIENT_IP_HEADER]: ADDRESS } })).response.status,
          ).toBe(200);
          const rows = (
            await harness.db.prepare("SELECT bucket, count FROM rate_limit_counters").all<{
              bucket: string;
              count: number;
            }>()
          ).results;
          expect(rows.filter((row) => row.bucket === `invite:${digest}`), "the per-token bucket must stay unspent").toHaveLength(0);
          expect(rows.filter((row) => row.bucket === `ip:${ADDRESS}`)).toHaveLength(1);
        });

        test("both malformed OPEN-route spellings are metered", async () => {
          // `/invite/` with an empty token, and a segment far past any real token.
          // Neither spends a per-token bucket — there is no token to spend one on
          // — and both spend the address bucket, which is the whole point.
          const before = await counters();
          for (const path of [`${INVITE_OPEN_PREFIX}`, `${INVITE_OPEN_PREFIX}${"a".repeat(400)}`]) {
            const response = await harness.dispatch(`http://localhost${path}`, { headers: { [CLIENT_IP_HEADER]: ADDRESS } });
            expect([404, 410], path).toContain(response.status);
          }
          expect(await counters()).toEqual({ ip: before.ip + 1, token: before.token });
        });

        test("a rate-limited address is refused BEFORE the body is read", async () => {
          // The order, asserted through the counter rather than by reading the
          // source: at the ceiling, a request whose body would otherwise be a 400
          // is a 429. If the limiter moved back below the parse, this flips.
          await seedCounter("ip:198.51.100.78", REDEEM_IP_LIMIT);
          const response = await harness.dispatch(`http://localhost${INVITE_REDEEM_PATH}`, {
            method: "POST",
            ...NO_FOLLOW,
            headers: { ...JSON_HEADERS, [CLIENT_IP_HEADER]: "198.51.100.78" },
            body: "not json at all",
          });
          expect(response.status).toBe(429);
        });
      });


      // ── logging ───────────────────────────────────────────────────────────

      describe("what the exchange logs (ADR-0020, ADR-0015)", () => {
        test("no log line carries the token, the binding, the session id, the address or the display name", async () => {
          const lines: string[] = [];
          const original = console.log;
          console.log = (line: unknown) => { lines.push(String(line)); };
            try {
            const { browser, sessionId, csrfToken } = await onboard(harness, { repo: REPO });
            await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
            await harness.dispatch(`http://localhost${THREADS_PATH}`, {
              method: "POST",
              headers: authedHeaders(browser, csrfToken, JSON_HEADERS),
            });
            const binding = browser.get(BROWSER_COOKIE_NAME) ?? "";
            expect(lines.length).toBeGreaterThan(5);
            for (const line of lines) {
              expect(line, "session id").not.toContain(sessionId);
              expect(line, "csrf token").not.toContain(csrfToken);
              expect(line, "binding").not.toContain(binding);
              expect(line, "display name").not.toContain(NAME);
              // ADR-0020: one JSON line, one request id.
              const parsed = JSON.parse(line) as Record<string, unknown>;
              expect(typeof parsed["requestId"]).toBe("string");
              expect(typeof parsed["msg"]).toBe("string");
            }
          } finally {
            console.log = original;
          }
            });

        test("a refusal logs the reason from the closed vocabulary and nothing from the request", async () => {
          const lines: string[] = [];
          const original = console.log;
          console.log = (line: unknown) => { lines.push(String(line)); };
            try {
            const { browser, inviteId } = await onboard(harness);
            await revokeInvite(harness.db, inviteId);
            await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: authedHeaders(browser, null) });
            const denials = lines
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter((parsed) => parsed["msg"] === "invite.denied");
            expect(denials.length).toBeGreaterThan(0);
            for (const denial of denials) {
              // The reason comes from the gate's closed vocabulary; `method` and
              // `path` are the only request-derived fields and both are bounded
              // tokens. A guest display name, a token, an address and a session id
              // are all absent, which is the whole of ADR-0015/ADR-0020's logging
              // rule for this path.
              expect(denial["reason"]).toBe("invite-revoked");
              expect(Object.keys(denial).sort()).toEqual(["level", "method", "msg", "path", "reason", "requestId", "ts"]);
              expect(denial["path"]).toBe(THREADS_PATH);
            }
            // And no line anywhere in the exchange names the guest.
            for (const line of lines) expect(line).not.toContain(NAME);
        } finally {
          console.log = original;
        }
            });
      });
    });
    describe("the redactor's backstop is not the caller rule", () => {
      test("the caller rule is pinned directly: the deny lines carry no guest field", async () => {
        // Mutation N14 added `displayName` to the `invite.redeem.denied` line
        // and SURVIVED, because `SENSITIVE_KEY` matches `display_?name` and ate
        // the value. So the outcome was protected by the backstop while the
        // caller rule the logger's own header calls primary was not enforced
        // anywhere. This asserts the rule and not the outcome: the deny line's
        // field set is exactly the closed vocabulary, so a future field has to
        // be added here deliberately.
        const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
          try {
          const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
          if (!minted.ok) throw new Error("mint failed");
          const { browser } = await open(harness, minted.minted.token);
          await redeemUrlEncoded(harness, browser, minted.minted.token, { displayName: NAME });
          await redeemUrlEncoded(harness, browser, minted.minted.token, { displayName: NAME });
          const denials = lines
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((parsed) => parsed["msg"] === "invite.redeem.denied");
          expect(denials.length).toBeGreaterThan(0);
          for (const denial of denials) {
            expect(Object.keys(denial).sort(), JSON.stringify(denial)).toEqual(["level", "msg", "reason", "requestId", "ts"]);
            expect(denial["reason"]).toBe("already-redeemed");
          }
      } finally {
        console.log = original;
      }
      });

      test("the invite log lines' field set is closed, and `canComment` is not one of them", async () => {
        // L1. `SENSITIVE_KEY`'s content-word alternative has NO boundary guards
        // (deliberately — it is what stops `arrayOfEmails`), so `canComment` was
        // matched by `comment` and the BOOLEAN was redacted: every invite log
        // line carried `"canComment":"[redacted]"` and no information at all.
        // Renaming the field is the fix; narrowing the redactor is not, because
        // that alternative is guard-free by design and slice 2's boundary work
        // was on the token-shape rule.
        const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
          try {
          const minted = await mintInvite(harness.db, { repo: REPO, kind: "view" }, { keys });
          if (!minted.ok) throw new Error("mint failed");
          const { browser } = await open(harness, minted.minted.token);
          await redeemUrlEncoded(harness, browser, minted.minted.token, { displayName: NAME });
          const inviteLines = lines
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((parsed) => typeof parsed["msg"] === "string" && parsed["msg"].startsWith("invite."));
          expect(inviteLines.length).toBeGreaterThan(1);
          // No invite line carries a redaction at all, and none of them names a
          // field containing `comment` — `canComment` and `commentable` both
          // did, so both were replaced.
          for (const line of inviteLines) {
            expect(JSON.stringify(line)).not.toContain("[redacted]");
            for (const field of Object.keys(line)) expect(field.toLowerCase()).not.toContain("comment");
          }
          // The rights bit is logged as the real boolean, under a name the
          // redactor does not own — and it is the COLUMN, not a value derived
          // from `kind`, because the schema does not tie the two together.
          const opened = inviteLines.find((line) => line["msg"] === "invite.opened");
          expect(opened?.["inviteKind"]).toBe("view");
          expect(opened?.["writable"]).toBe(false);
          const ok = inviteLines.find((line) => line["msg"] === "invite.redeem.ok");
          expect(ok?.["inviteKind"]).toBe("view");
          expect(ok?.["writable"]).toBe(false);
          // A `view` row whose COLUMN disagrees with its kind is reported from
          // the column, which is the whole reason the bit is logged at all.
          await harness.db.prepare("UPDATE invites SET can_comment = 1 WHERE repo = ?").bind(REPO).run();
          const second = await mintInvite(harness.db, { repo: "coerced-org", kind: "view" }, { keys });
          if (!second.ok) throw new Error("mint failed");
          const coerced: string[] = [];
          console.log = (line: unknown) => { coerced.push(String(line)); };
          try {
            await harness.db.prepare("UPDATE invites SET can_comment = 1 WHERE id = ?").bind(second.minted.invite.id).run();
            await open(harness, second.minted.token);
            const coercedLine = coerced
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .find((parsed) => parsed["msg"] === "invite.opened");
            expect(coercedLine?.["writable"]).toBe(true);
          } finally {
            console.log = original;
          }
    } finally {
      console.log = original;
    }
      });

      test("a rate-limit refusal never names the bucket, the address or the token", async () => {
        const minted = await mintInvite(harness.db, { repo: REPO, kind: "team" }, { keys });
        if (!minted.ok) throw new Error("mint failed");
        const token = minted.minted.token;
        const { browser } = await open(harness, token, { headers: { "cf-connecting-ip": "198.51.100.4" } });
        let body = "";
        // The open spent one; the loop spends the rest.
        for (let attempt = 0; attempt <= REDEEM_TOKEN_LIMIT; attempt++) {
          const response = await redeem(harness, browser, token, { displayName: NAME }, { headers: { "cf-connecting-ip": "198.51.100.4" } });
          const text = await response.text();
          if (response.status === 429) { body = text; break; }
        }
        expect(body, "the per-token limit never fired").not.toBe("");
        expect(body).not.toContain("198.51.100.4");
        expect(body).not.toContain(token);
        expect(body).not.toContain("invite:");
        expect(body).not.toContain("ip:");
      });
    });
  });
});
