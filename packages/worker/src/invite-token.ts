// `invites.token_hash`: HMAC-SHA-256 under a deployment key (ADR-0012's abuse
// limits, "invite tokens are 256-bit random, stored as HMAC").
//
// ── Why this module exists, and why slice 3's first attempt got it wrong ────
//
// Slice 3 first shipped `sha256(token)` and amended ADR-0012 to say HMAC was
// unnecessary. The reviewer's rejection of that amendment was right, and the
// reasoning matters more than the conclusion:
//
//   - The amendment's own evidence said miniflare **ignores its `secrets`
//     option** — `env.INVITE_TOKEN_HMAC_KEY` came back `undefined`. The
//     conclusion drawn from that was "so a keyed hash is verified nowhere",
//     when the correct conclusion is "so the HARNESS was wrong". A miniflare
//     **`bindings`** entry IS bound and arrives as a plain string
//     (`test/harness.ts` already supplies `REVKIT_VERSION` that way), and
//     `wrangler secret put` lands in `env` the same way: from the Worker's
//     perspective the two are indistinguishable. HMAC was testable offline all
//     along, and the diagnosis was correct while the conclusion was not.
//   - "Moving to HMAC later is one function, no invalidation of live invites" was
//     **false**. `token_hash` IS the lookup key, so changing the hash function
//     invalidates every live invite unless both forms are stored. The migration
//     cost is nil; the credential cost is total. Slice 3 is the slice that
//     makes invites live, so it is the cheapest possible moment to get it right.
//
// ── What the key buys, stated narrowly so it is not oversold ──────────────
//
// HMAC's advantage over a bare hash is that an attacker holding the DATABASE
// cannot *verify a guess*: without `k` they cannot compute `HMAC_k(guess)`, so
// a dictionary of candidate tokens produces no signal. At 256 bits of CSPRNG
// there is no dictionary — so on entropy grounds alone the two are close — but
// the keyed form does not *depend* on the entropy of the token, which is the
// property worth having when the lookup key is also the row's identity and a
// future change might derive tokens rather than draw them. The bare-hash form's
// safety rested entirely on an unstated invariant about a function in another
// file; this one rests on a key.
//
// ── Why there is NO FALLBACK KEY ───────────────────────────────────────────
//
// A missing key makes every invite operation **throw**, and the Worker answers a
// uniform 500. The alternative — a default key — was measured during slice 3's
// first attempt and is strictly worse than no key: a zero-filled 32-byte key
// produces a VALID, WRONG digest, so a deployment with a missing secret would
// mint invites nobody can redeem, lookups that silently never match, and a test
// suite green against a function that is not the deployed one. A keyed hash with
// a default key is a keyed hash with no key. There is no default here, and
// `MissingInviteTokenKeyError` is the loudest available answer.
//
// ## 500 or startup refusal?
//
// **A 500, deliberately, and here is why that is the faithful choice rather than
// a compromise.** A Cloudflare Workers *module* worker has no module-scope
// initialiser: `env` does not exist until a handler is invoked, so there is no
// "start" at which to refuse. The closest available equivalent is a first-line
// check in `fetch` that refuses EVERY request, which is what
// `src/index.ts` does — including `/healthz`, and that is correct rather than
// collateral: a deployment that cannot hash an invite token is not healthy, and
// a probe that says otherwise is a probe nobody should trust. The alternative
// shapes were considered:
//
//   - **Per-call throw only** (no first-line check): `/healthz` would answer 200
//     while every invite route 500s, so a liveness probe would report a broken
//     deployment healthy. That is the worst of the three.
//   - **Refusing to start** by not exporting a handler: not expressible.
//
// So the shape is: one truthiness check on the first line of `fetch`, a typed
// error, and a log line that names the MISSING BINDING and never any value.

/** The binding name. A Worker *secret* in production (`wrangler secret put
 * INVITE_TOKEN_HMAC_KEY`), and a plain `bindings` entry in the offline harness
 * — from inside the Worker those are the same string in `env`, which is exactly
 * why the first attempt's "miniflare cannot supply secrets" diagnosis, while
 * true, said nothing about testability. */
export const INVITE_TOKEN_HMAC_KEY = "INVITE_TOKEN_HMAC_KEY";

/** The shortest key accepted, in characters. 32 characters is the 256-bit key
 * ADR-0012's line implies; anything shorter is refused rather than padded,
 * because a padded key is a key someone chose badly and will not notice. */
export const MIN_INVITE_TOKEN_HMAC_KEY_CHARS = 32;

/** Thrown when the deployment has no usable `INVITE_TOKEN_HMAC_KEY`. Never
 * carries the key, never carries a token — the Worker answers a uniform 500 and
 * the message names only the binding. */
export class MissingInviteTokenKeyError extends Error {
  readonly retryable = false;
  constructor() {
    super(
      `MissingInviteTokenKeyError: env.${INVITE_TOKEN_HMAC_KEY} is absent or shorter than ` +
        `${MIN_INVITE_TOKEN_HMAC_KEY_CHARS} characters; invite tokens cannot be hashed or verified.`,
    );
    this.name = "MissingInviteTokenKeyError";
  }
}

/** Hashes an invite token to its stored form. */
export interface InviteTokenHasher {
  /** 64 lowercase hex characters — HMAC-SHA-256 is 32 bytes. Same width as the
   * bare `sha256Hex` it replaces, so `invites.token_hash` stays `TEXT` and
   * `migrations/0001_init.sql` needs no ALTER. */
  hash(token: string): Promise<string>;
}

/**
 * Build the hasher, or throw. There is no overload that returns a working
 * hasher without a key, which is what makes "no fallback" a property of the
 * TYPE and not only of this function's body.
 *
 * The `CryptoKey` is imported ONCE and reused for every token. That is the
 * point of a keyed hash: the key is a deployment input, not a per-call cost, and
 * an implementation that re-imported it per call would be paying setup to
 * compute the same MAC.
 *
 * `compatibility_flags: []` holds: `crypto.subtle.importKey` and
 * `crypto.subtle.sign("HMAC", …)` are both native in workerd with no
 * compatibility flags, and `test/invites.test.ts` runs every case through real
 * workerd rather than asserting the API exists.
 */
export async function inviteTokenHasher(key: string | undefined): Promise<InviteTokenHasher> {
  if (typeof key !== "string" || key.length < MIN_INVITE_TOKEN_HMAC_KEY_CHARS) {
    throw new MissingInviteTokenKeyError();
  }
  const bytes = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const encoder = new TextEncoder();
  return {
    async hash(token: string): Promise<string> {
      const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(token));
      return hexOf(new Uint8Array(mac));
    },
  };
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Is this binding usable? The first line of `fetch` asks exactly this, so the
 * check exists once and both the refusal and the tests use it. */
export function hasUsableInviteTokenKey(key: string | undefined): boolean {
  return typeof key === "string" && key.length >= MIN_INVITE_TOKEN_HMAC_KEY_CHARS;
}
