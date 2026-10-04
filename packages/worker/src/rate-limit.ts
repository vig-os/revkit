// ADR-0012's abuse limits: "rate limits on invite redemption and comment
// posting per identity and IP".
//
// ── Why a D1 counter and not the Durable Object the ADR names ─────────────
//
// ADR-0012 names the mechanism (Durable Object counters). Slice 3 ships a D1
// counter and amends the ADR to say so, with the measurements, because:
//
//   1. **A D1 counter is a real counter, not an approximation.** Measured on
//      workerd 2026-05-18 (miniflare 4.20260518.0, no account, no network):
//      `INSERT … ON CONFLICT(bucket) DO UPDATE SET count = count + 1
//      RETURNING count`, issued 20 times CONCURRENTLY against one bucket,
//      produced 20 distinct counts — 1..20, no lost updates. The increment and
//      the window rollover happen in ONE statement, so the whole check is a
//      single round trip and there is no read-then-write window (slice 1
//      measured what that window costs: 6 concurrent read-then-write appends
//      produced 3 distinct `seq` values).
//   2. **"We cannot test a Durable Object here" would be false.** Measured: a
//      Durable Object namespace bound in miniflare with an exported
//      `DurableObject` subclass answers 200 offline, no account. So the
//      argument for D1 is SCOPE, not tooling, and saying otherwise would be the
//      plausible-mechanism story this repo keeps warning about.
//   3. **Scope is the honest argument.** A Durable Object class in the Worker
//      entry, a `durable_objects` binding in `wrangler.jsonc`, a namespace to
//      provision, and the move of the counter off D1 are one coherent change
//      that belongs with the rest of the Durable Object work (M4 slice 6) —
//      where fan-out needs one anyway. Shipping redemption with NO limit while
//      the ADR claims one is not an option, and shipping a limit that is
//      honestly D1 is.
//
// What D1 costs, stated: one row write per limited attempt, against D1's
// daily row-write quota, so a sustained flood against one deployment spends
// that deployment's quota. A Durable Object trades that for per-isolate
// consistency at a per-request cost instead. Recorded as residual risk in the
// ADR amendment; the limit's purpose here is to make guessing infeasible, and
// a quota exhaustion is a louder failure than a leaked invite.
//
// ── The measured trap this shape avoids ───────────────────────────────────
//
// The obvious "cap" is a conditional INSERT guarded on a count:
//
//     INSERT INTO rate_limit_counters (…) SELECT ?, 1, ?
//     WHERE (SELECT count FROM rate_limit_counters WHERE bucket = ?) < ?      -- WRONG
//
// Measured: that inserts **ZERO rows on the first attempt**, because the
// subquery is NULL for a bucket that does not exist yet and `NULL < 3` is NULL,
// which is not true. So a limit written that way would admit the first attempt
// and then behave as if the bucket were full — no limit at all, and a refusal
// for the wrong reason. The `ON CONFLICT` form has no such hole because the
// insert always happens and the count is the value it writes.

/** Which half of ADR-0012's "per identity and IP" a bucket is. Exposed so a
 * log line or a response can say WHICH limit was hit without ever naming the
 * bucket — an IP address is personal data (ADR-0015, ADR-0020) and an invite
 * digest is a credential's hash, so neither appears in either. */
export type BucketKind = "invite" | "ip";

export interface RateBucket {
  readonly kind: BucketKind;
  /** The key. NEVER logged, NEVER returned, NEVER put in a response body. */
  readonly name: string;
  /** Attempts permitted per window for this bucket. */
  readonly limit: number;
}

export type RateVerdict = { readonly ok: true } | { readonly ok: false; readonly kind: BucketKind; readonly retryAfterSeconds: number };

/** The fixed window. A sliding window needs a per-attempt timestamp list to be
 * exact; a fixed window needs one column and one statement, and its known
 * shape — up to 2x the limit across a window boundary — is the right trade for
 * a limit whose job is to make a 256-bit token unguessable by volume. */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Redemption attempts per window, per invite token.
 *
 * **Derived, not chosen, because a limit below `2 x max_browsers` makes a
 * legitimate invite unusable — and that is not hypothetical.** It was `10`
 * first, against `team`'s `max_browsers = 10`, and each browser costs TWO
 * attempts (the `GET` that opens the link and the `POST` that redeems it), so
 * the tenth browser was rate-limited rather than admitted: measured over HTTP,
 * a `team` invite produced 8 x 303 and then 429s while still showing 8 of 10
 * slots unused. The limit is now twice the largest `max_browsers` plus headroom
 * for a mistyped display name and a reload, and
 * `test/invites.test.ts` asserts the relation so the two constants cannot drift
 * apart again.
 *
 * The headroom does not weaken the control against guessing: the token is 256
 * bits, so the limit bounds VOLUME, not the search, and 40 attempts per 15
 * minutes against a 2^256 space is not the thing standing between an attacker
 * and the token.
 */
export const REDEEM_TOKEN_LIMIT = 40;

/** Redemption attempts per window, per client address.
 *
 * Sized for the same reason and to the same shape: a team of ten behind one
 * office NAT spends twenty, and a NAT is the normal case for a corporate guest,
 * so this is `1.5 x REDEEM_TOKEN_LIMIT` — enough for a whole team plus slack,
 * and still a hard bound on how fast one address can work through a stolen
 * token list. It is deliberately separate from the per-token limit so one noisy
 * neighbour cannot spend everyone else's, and so rotating tokens cannot escape
 * it (both buckets are spent on every attempt).
 */
export const REDEEM_IP_LIMIT = 60;

/**
 * The address header, and why it is the ONLY one this module reads.
 *
 * `CF-Connecting-IP` is set by Cloudflare's edge and OVERWRITTEN on every
 * request, so a client cannot forge it. `X-Forwarded-For` is appended to by
 * every hop and is trivially spoofed by whoever opens the connection, so it is
 * never read: a forgeable identity half would make the whole limit forgeable
 * with it. Measured on workerd: `CF-Connecting-IP` arrives when set.
 *
 * When the header is ABSENT the caller gets `undefined` and this module builds
 * no IP bucket at all — the invite bucket still applies, so the exchange is
 * never unlimited, and the degradation is logged as a `bucketKind` with no
 * value. `workers_dev: false` plus `routes` means the Worker is only ever
 * reached through that edge, so the absent case is a local/test shape rather
 * than a production one; refusing instead would be safer still, and is the
 * change to make if a future surface exposes this Worker another way.
 */
export const CLIENT_IP_HEADER = "cf-connecting-ip";

/** The client address, or `undefined` when the header is absent or blank. */
export function clientAddress(headers: Headers): string | undefined {
  const raw = headers.get(CLIENT_IP_HEADER);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The ADDRESS bucket — the one real control — for one request.
 *
 * **Spent FIRST, on every path, before anything is parsed.** It is the only
 * bucket whose key is not derived from the request body, so it is the only one
 * that can be charged before the body exists. Its key is the edge-set address,
 * which bounds how many distinct rows an attacker can create to the number of
 * source addresses they control; the per-token key does not have that property
 * and is therefore spent later and only for a token that resolves.
 */
export function addressBucket(address: string | undefined): RateBucket[] {
  return address === undefined ? [] : [{ kind: "ip", name: `ip:${address}`, limit: REDEEM_IP_LIMIT }];
}

/**
 * The PER-TOKEN bucket, and when it is spent.
 *
 * **Only after `loadInviteByToken` has found the invite LIVE**, and only on the
 * redemption route. Two measured reasons, both from the review of slice 3:
 *
 *   1. **Charging it on the OPEN route let anyone holding the URL lock the
 *      intended guest out.** The bucket is `invite:<hmac(token)>`, and the open
 *      is unauthenticated and idempotent, so 45 `GET`s from another address
 *      spent the guest's whole window and the guest then met a 429 with no
 *      recovery — the redemption slot is single-use, so there is nothing to
 *      retry. An open must never be able to do that.
 *   2. **Charging it on a token that does not resolve gave it no defensive
 *      value at all.** Every guessed token is a distinct key, so a flood of
 *      garbage costs one D1 row write each and never touches any real invite's
 *      budget — a per-token limit that cannot defend against guessing is not
 *      defending against guessing. Since the token is 256 bits of CSPRNG, the
 *      honest position is that the per-IP bucket is the control and this one
 *      bounds repeated REDEMPTION of one known-good token.
 *
 * The consequence, stated rather than left implicit: an attacker who already
 * holds a leaked URL can burn one window of the real token's redemption budget.
 * It is bounded, it needs the token, and the alternative — an unmetered
 * redemption — is worse.
 */
export function tokenBucket(tokenHash: string): RateBucket[] {
  return [{ kind: "invite", name: `invite:${tokenHash}`, limit: REDEEM_TOKEN_LIMIT }];
}

/**
 * Spend one attempt on every bucket and report the first refusal.
 *
 * **Every bucket is incremented even when an earlier one already refused.**
 * That is deliberate: a request that blew the per-token limit must still count
 * against the address, or an attacker rotates tokens from one address and the
 * address limit never moves. It costs one extra write on a refused request and
 * it is the difference between a limit that holds under rotation and one that
 * does not.
 *
 * `results[0]` is the FIRST bucket, and its `count` decides — but the loop runs
 * to the end regardless, for the reason above.
 *
 * The counter increments on ALLOWED attempts too. A limit that only counted
 * refusals would be a counter of failures, not of attempts.
 */
export async function spendAttempts(
  db: D1Database,
  buckets: readonly RateBucket[],
  options: { readonly now?: number } = {},
): Promise<RateVerdict> {
  const now = options.now ?? Date.now();
  const windowStart = new Date(now).toISOString();
  // The window rolls when the stored `window_start` is at or before the
  // cutoff, i.e. when the current window ENDED. ISO-8601 strings sort
  // chronologically, so the comparison is a string comparison — which is why
  // every timestamp this module writes goes through `toISOString()` and never a
  // locale format.
  const cutoff = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();
  let first: RateVerdict = { ok: true };
  for (const bucket of buckets) {
    const row = await db
      .prepare(
        "INSERT INTO rate_limit_counters (bucket, count, window_start) VALUES (?, 1, ?) " +
          "ON CONFLICT(bucket) DO UPDATE SET " +
          "count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END, " +
          "window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END " +
          "RETURNING count, window_start",
      )
      .bind(bucket.name, windowStart, cutoff, cutoff, windowStart)
      .first<{ count?: unknown; window_start?: unknown }>();
    const count = typeof row?.count === "number" ? row.count : Number.MAX_SAFE_INTEGER;
    const storedWindow = typeof row?.window_start === "string" ? row.window_start : windowStart;
    if (count > bucket.limit && first.ok) {
      const windowEndsAt = Date.parse(storedWindow) + RATE_LIMIT_WINDOW_MS;
      const remaining = windowEndsAt - now;
      first = {
        ok: false,
        kind: bucket.kind,
        // At least 1, never 0 or negative: `Retry-After: 0` invites an
        // immediate retry and a negative one is a lie. A window that has
        // already ended reports 1, and the caller's next attempt rolls it.
        retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
      };
    }
  }
  return first;
}

/** The `Retry-After` header value for a refusal. ADR-0012 does not name the
 * header but every rate-limited HTTP surface needs one, and a 429 without it
 * tells a client nothing except that it should guess. */
export function retryAfterHeader(verdict: RateVerdict & { ok: false }): string {
  return String(verdict.retryAfterSeconds);
}
