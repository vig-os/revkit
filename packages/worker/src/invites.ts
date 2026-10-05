// ADR-0009 invite links: mint, redeem, revoke, and the per-call check the
// authorization gate runs on every authorized read.
//
//   > Guests use **self-minted per-person invite links** (random token, stored
//   > hashed, scoped to repo/PR, expiring, revocable, exchanged for an HttpOnly
//   > session). (ADR-0009)
//   > **Abuse limits:** rate limits on invite redemption and comment posting
//   > per identity and IP; invite tokens are 256-bit random, stored as HMAC.
//   > (ADR-0012)
//
// ── The four properties ADR-0009 asks for, and where each one lives ────────
//
// | property        | mechanism                                                       |
// |-----------------|-----------------------------------------------------------------|
// | random token    | `mintToken()` — 256 bits of `crypto.getRandomValues`, base64url   |
// | stored hashed   | `invites.token_hash` = `sha256(token)`; see the ADR note below   |
// | scoped          | `invites.repo` + nullable `invites.pr`, checked on EVERY call     |
// | expiring        | `invites.expires_at`, 14/30 days by share type, checked per call  |
// | revocable       | `revoked_at`, checked per call — not only at redemption           |
// | exchanged       | `redeemInvite` → an HttpOnly `__Host-revkit_session` cookie        |
//
// ── "stored as HMAC" (ADR-0012) — why this is plain SHA-256 ───────────────
//
// ADR-0012's abuse-limits bullet ends "invite tokens are 256-bit random,
// stored as HMAC". This module stores `sha256(token)`, and that is a DELIBERATE
// divergence from the ADR's letter, amended rather than ignored (see the
// ADR-0012 amendment dated 2026-10-04, issue #9). The argument, and the
// measurements behind it:
//
//   1. **HMAC's advantage is for LOW-entropy secrets.** A keyed MAC stops an
//      attacker who holds the database from *verifying a guess*: they cannot
//      compute `HMAC_k(guess)` without `k`, so a dictionary of 10^6 candidate
//      passwords produces no signal. For a 256-bit value from
//      `crypto.getRandomValues` there is no dictionary — guessing one value is
//      2^256 work, which is the same for SHA-256 and for HMAC-SHA-256 because
//      both are 256-bit-output PRFs over the same input. Measured on workerd
//      2026-05-18 (`compatibility_flags: []`): both produce a 64-character hex
//      digest, and 200 interleaved calls of each are indistinguishable at the
//      platform's 0–1 ms timer resolution. So the keyed form buys nothing for
//      THIS secret and costs a second secret to provision, rotate and keep out
//      of the deploy path.
//   2. **The keyed form is not testable in this repo's harness, and the
//      failure mode is silent.** Measured: miniflare 4.20260518.0 IGNORES the
//      `secrets` option — `env.INVITE_TOKEN_HMAC_KEY` came back `undefined`
//      with `secrets: { INVITE_TOKEN_HMAC_KEY: "production-value" }`, and the
//      same key supplied through `bindings` (which miniflare DOES bind) came
//      back as the string. `crypto.subtle.importKey("raw", undefined, …)`
//      then throws `Cannot initialize … from an undefined or null value`, so a
//      real HMAC implementation would either 500 on every redemption under
//      test, or — worse, and far more likely in practice — reach for a
//      fallback key. Measured: a zero-filled 32-byte key produces a valid,
//      wrong digest (`58a98994…`), i.e. a test suite green against a function
//      that is not the deployed one. A keyed hash whose key the test harness
//      cannot supply is a control that is verified nowhere.
//   3. **The switch is not a one-way door.** `invites.token_hash` is a TEXT
//      column and both forms are 64 hex characters, so moving to HMAC later is
//      one function and one ADR line — no migration, no table rewrite, no
//      invalidation of live invites. That is what makes amending rather than
//      implementing acceptable: the cost of being wrong is a small,
//      self-contained change, not a data migration.
//
// What is NOT lost by dropping the key: a stolen database still does not yield
// a usable token. `token_hash` is the only thing stored, the plaintext exists
// once in the mint result, and every lookup is `WHERE token_hash = ?` — an
// indexed equality, so there is no candidate scan to time.
//
// ── "single use", precisely ────────────────────────────────────────────────
//
// A token is redeemable **once per browser**, and the ceiling is the invite's
// `max_browsers`. That is not a weakening of "exchanged for a session"; it is
// the only reading that satisfies ADR-0009's three share types at once, and
// the brief's own negative-test list settles it: "already-redeemed (replay)",
// "a second browser on a `personal` invite" and "`max_browsers` exceeded" are
// three DISTINCT refusals, so a token cannot have a single redemption moment.
//
//   personal (`max_browsers = 1`)  → exactly one browser, ever. This is
//                                    ADR-0009's "bound to the first browser
//                                    that opens it".
//   team / view (`max_browsers > 1`) → that many browsers, each consuming one
//                                    slot; a browser that already holds one
//                                    cannot consume a second.
//
// A token is therefore never usable by an unbounded number of browsers, which
// is the property "single use" is protecting. The residual risk is stated in
// the ADR amendment and in the PR: a leaked `personal` link admits whichever
// browser redeems it FIRST. That is inherent to a bearer token and is what
// ADR-0009's one-browser rule bounds rather than removes; revocation is what
// closes it, and revocation is per-call here.
//
// ── Why the browser binding is a cookie and not an IP or a user-agent ─────
//
// The brief asks for the mechanism and the attacks it does and does not stop,
// so here it is in one place:
//
//   - **An IP address is not a browser.** One office NAT, one VPN egress or
//     one mobile carrier CGNAT puts many real browsers behind one address, so
//     an IP binding either locks out a legitimate reviewer or, loosened to be
//     useful, binds nothing. It is also trivially shared: anyone on the same
//     egress is "the same browser".
//   - **A user-agent string is forgeable.** It is attacker-controlled text on
//     every request, so binding to it stops nobody who is willing to set a
//     header. It identifies a browser *version*, not a browser.
//   - **A cookie identifies a browser *profile*,** which is the thing the
//     property is about, and it is the one identifier here the attacker must
//     not have. `__Host-revkit_browser` is 256 bits of `crypto.getRandomValues`,
//     stored only as a digest (`invite_redemptions.binding_hash`), HttpOnly,
//     Secure, `SameSite=Lax`, and `__Host-`-prefixed so a sibling subdomain
//     cannot set one this origin will send.
//
// **What it stops:** an invite link forwarded to a second person, whose browser
// finds `max_browsers` already spent and is refused at redemption; and a
// session cookie copied out of one browser and replayed from another, refused
// on every call by the per-call binding check.
//
// **What it does NOT stop:** an attacker who steals the browser profile itself
// (both cookies, same profile), an XSS on any same-origin page (cookies are
// sent automatically even though they cannot be read), a guest who hands their
// own unlocked device to someone, or a guest who *is* the second browser the
// owner intended to exclude. It is a bound on *sharing*, not an authentication
// mechanism — nothing here proves who the guest is, which is ADR-0009's point
// about why invites exist at all and why Authentik (#4) is the follow-up.
//
// ── Why redemption is two requests, and where the token goes ──────────────
//
// `GET /invite/<token>` renders a display-name form and mints the binding
// cookie; `POST /invite/redeem` consumes the token and answers `303` to a
// token-free path. The token therefore appears in exactly one URL — the mail
// link the guest clicked — and in one POST body, and:
//
//   - the redirect target carries no token, so no `Location`, no response body
//     and no log line ever contains it
//   - `Referrer-Policy: no-referrer` is on the form response AND on the `303`,
//     so it cannot travel onward in a `Referer`
//   - a POST body is not a referrer and is not in history, and the POST's own
//     URL is token-free
//   - **and the URL is dead anyway**, which is the load-bearing half: the
//     redemption consumed the browser's slot, so re-opening the mail link is
//     refused as a replay
//
// One correction to the first bullet, because the feature matrix said it more
// strongly than it is true: the FORM's body does carry the token, in its hidden
// field, and it must — without it the guest cannot submit. The precise claim is
// "no `Location`, no `Referer`, no log line, and in a body only as the redeem
// form's hidden field". Slice 5b's review caught the looser version.
//
// That last point is the honest statement of what "stripped from the URL"
// achieves — **a phrase that appears exactly once in this repo, at DESIGN-0001
// §6, and not in ADR-0009**, which is where this and `src/index.ts` used to
// cite it. It remains true without any script: single-use plus a token-free
// redirect retires the token on the SERVER, and it is the control that does not
// depend on a browser.
//
// **The client-side belt arrived in slice 5b, and this paragraph was its
// holding statement until then.** `GET /invite/<token>` now loads one external
// script (`src/client-script.ts`) which rewrites the address bar to `/invite/`
// with `history.replaceState`, so the token does not survive in the current
// tab's history, in a Back-navigation, or in a reload — and it does so **on
// load**, before the exchange, because the token is in the form's hidden field
// and the URL is not needed for anything once the document has loaded.
//
// Three things about that belt are properties rather than good intentions, and
// each is pinned in `test/invites.test.ts`:
//
//   - `replaceState`, never `pushState`: pushing the clean URL would leave
//     `/invite/<token>` as the PREVIOUS entry, one Back press away.
//   - **the rewrite target is the PREFIX, a constant**, so no input produces a
//     URL that still names the token. The review found the first version cut at
//     the LAST slash, which made `/invite/<token>/` — a trailing slash some mail
//     products append — a no-op that left the token in the address bar of the
//     very visit a guest is most likely to back out of.
//   - it drops the query string and the fragment rather than carrying them
//     across, because a query string is the most durable part of a URL.
//
// **And the belt is CONDITIONAL, which DESIGN-0001 §6 does not say.** It needs
// JavaScript, so a guest with scripting disabled keeps the token in the URL —
// recorded as a residual risk rather than papered over, and now recorded in the
// ADR-0012 amendment as well as here. What such a guest does NOT lose is the
// redemption: the form posts natively, and the server-side control above does
// not depend on a browser at all.
//
// The display name is collected on the POST rather than through `?name=` on the
// GET for the same reason the token is: **a guest's display name is personal
// data under ADR-0015/ADR-0020**, and a query string is the most durable part
// of a URL — history, `Referer`, server logs, browser sync. Putting it in a
// POST body keeps it out of all four.

import {
  SESSION_TTL_MS,
  isTokenShaped,
  issuedFrom,
  mintSession,
  mintToken,
  readCookie,
  sessionInsertStatement,
  sha256Hex,
  type CookieLookup,
  type IssuedSession,
  type MsClock,
} from "./session.ts";
import type { InviteTokenHasher } from "./invite-token.ts";
import { isRepoName, canonicalRepoName } from "./router.ts";
import { GUEST_RETENTION_MS, GUEST_DELETED_NAME } from "./retention.ts";

// ── share types (ADR-0009's Acceptance) ───────────────────────────────────

/** ADR-0009's three `revkit invite --type` values, in one closed list. A
 * magic string a caller can typo is how `kind` ends up meaning two things. */
export const SHARE_TYPES = ["personal", "team", "view"] as const;

export type ShareType = (typeof SHARE_TYPES)[number];

/** `personal` is the DEFAULT (ADR-0009: "personal is the default"). */
export const DEFAULT_SHARE_TYPE: ShareType = "personal";

/** Invite lifetime in days, per share type — ADR-0009's Acceptance verbatim:
 * personal 14, team 30, view 30. */
export const INVITE_LIFETIME_DAYS: Readonly<Record<ShareType, number>> = Object.freeze({
  personal: 14,
  team: 30,
  view: 30,
});

/**
 * Browsers one invite admits, per share type.
 *
 * `personal: 1` IS ADR-0009's "bound to the first browser that opens it" —
 * the column exists (`max_browsers >= 1`) precisely so this case is a number
 * rather than a sentinel.
 *
 * `team`/`view`: ADR-0009 says "several browsers" and gives no number. Ten is
 * chosen and the choice is bounded deliberately: a leaked `team` link admits at
 * most ten browsers instead of an unbounded set, which is the whole reason the
 * redemption is counted rather than merely recorded, and ten is well above the
 * size of a review team. It is one constant, so a deployment that disagrees
 * changes one line.
 */
export const INVITE_MAX_BROWSERS: Readonly<Record<ShareType, number>> = Object.freeze({
  personal: 1,
  team: 10,
  view: 10,
});

/** May this share type comment? ADR-0009: `view` is read-only; the other two
 * can comment. Kept as data next to the lifetimes rather than as a `kind ===
 * "view"` test at a call site, so the answer has one home. */
export const SHARE_TYPE_CAN_COMMENT: Readonly<Record<ShareType, boolean>> = Object.freeze({
  personal: true,
  team: true,
  view: false,
});

// ── the browser binding cookie ────────────────────────────────────────────

/**
 * The browser-binding cookie's name, with the `__Host-` prefix, for the same
 * reason the session cookie has it (`src/session.ts`): a sibling subdomain
 * cannot set a cookie this origin will send, so cookie-tossing cannot put a
 * second browser's binding on a request.
 *
 * **Not `HttpOnly`-by-accident.** It is HttpOnly because nothing in the page
 * ever needs to read it — the redeem form posts to the server and the server
 * reads both cookies itself — so the one script that could have exfiltrated it
 * has no reason to hold it.
 */
export const BROWSER_COOKIE_NAME = "__Host-revkit_browser";

/** The complete `Set-Cookie` value for a browser binding. `Max-Age` is the
 * invite's REMAINING lifetime in seconds, because a binding that outlived its
 * invite would be a cookie with nothing to bind. */
export function browserCookieHeader(value: string, maxAgeSeconds: number): string {
  return [
    `${BROWSER_COOKIE_NAME}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

/** The binding cookie off a request, with the same `ambiguous` verdict as the
 * session cookie — two bindings on one request is two browsers' state and
 * picking "the first" is how one guest's invite becomes another's. */
export function readBrowserCookie(header: string | null): CookieLookup {
  return readCookie(header, BROWSER_COOKIE_NAME);
}

// ── the invite record ─────────────────────────────────────────────────────

/** An invite row that has passed every field check this module needs. */
export interface InviteRecord {
  readonly id: string;
  /** SHA-256 hex of the token. Never the token. */
  readonly tokenHash: string;
  /**
   * The repository this invite is scoped to, in the CANONICAL spelling —
   * `canonicalRepoName(input.repo)` as `mintInvite` wrote it. Never the spelling
   * the operator typed, so a caller reading this value cannot believe it holds
   * an invite for a URL the gate will refuse.
   */
  readonly repo: string;
  /** `null` covers every PR of the repo; a number covers exactly that PR. */
  readonly pr: number | null;
  readonly kind: ShareType;
  readonly canComment: boolean;
  readonly revocable: boolean;
  readonly maxBrowsers: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/** What a mint hands back. `token` exists HERE and nowhere else: it is not
 * stored, not logged, and not recoverable from D1 afterwards. The caller is
 * expected to put it in one message to one person and drop it. */
export interface MintedInvite {
  readonly invite: InviteRecord;
  readonly token: string;
}

interface InviteRow {
  readonly id?: unknown;
  readonly token_hash?: unknown;
  readonly repo?: unknown;
  readonly pr?: unknown;
  readonly kind?: unknown;
  readonly can_comment?: unknown;
  readonly revocable?: unknown;
  readonly max_browsers?: unknown;
  readonly expires_at?: unknown;
  readonly created_at?: unknown;
  readonly revoked_at?: unknown;
}

const SELECT_INVITE_BY_TOKEN_SQL =
  "SELECT id, token_hash, repo, pr, kind, can_comment, revocable, max_browsers, expires_at, created_at, revoked_at FROM invites WHERE token_hash = ?";

const SELECT_INVITE_BY_ID_SQL =
  "SELECT id, token_hash, repo, pr, kind, can_comment, revocable, max_browsers, expires_at, created_at, revoked_at FROM invites WHERE id = ?";

/**
 * Turn a row into an invite, or `undefined` when a field this module acts on
 * cannot be read.
 *
 * Blank-and-unparsable alike, and for the same reason `isRowComplete` in
 * `src/session.ts` is that shape: every one of these columns is `NOT NULL` in
 * the migration, so "absent" is unreachable and only blankness or a
 * hand-written value is producible — by someone with D1 write access, who is
 * the credential in this model anyway. The point is not to defend against them;
 * it is that "I cannot tell whether this invite is live" must resolve to
 * "not live", so an unreadable `expires_at` or `max_browsers` cannot produce a
 * grant.
 *
 * `expires_at` is checked for PARSEABILITY and not for being in the past here;
 * the past/future decision belongs to `loadInviteGrant` and to `redeemInvite`,
 * which have a clock. Keeping the two apart is what lets the redemption say
 * "expired" and the per-call check say "expired" from one implementation.
 */
function readInvite(row: InviteRow | null | undefined): InviteRecord | undefined {
  if (row === null || row === undefined) return undefined;
  const kind = row.kind;
  if (typeof row.id !== "string" || row.id.trim().length === 0) return undefined;
  if (typeof row.token_hash !== "string" || row.token_hash.trim().length === 0) return undefined;
  if (typeof row.repo !== "string" || !isRepoName(row.repo)) return undefined;
  if (!(SHARE_TYPES as readonly string[]).includes(String(kind))) return undefined;
  if (row.can_comment !== 0 && row.can_comment !== 1) return undefined;
  if (row.revocable !== 0 && row.revocable !== 1) return undefined;
  if (typeof row.max_browsers !== "number" || !Number.isSafeInteger(row.max_browsers) || row.max_browsers < 1) {
    return undefined;
  }
  if (typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at))) return undefined;
  if (typeof row.created_at !== "string" || row.created_at.trim().length === 0) return undefined;
  if (row.revoked_at !== null && (typeof row.revoked_at !== "string" || row.revoked_at.trim().length === 0)) {
    return undefined;
  }
  const pr = row.pr;
  if (pr !== null && pr !== undefined && !isPullNumber(pr)) return undefined;
  return {
    id: row.id,
    tokenHash: row.token_hash,
    repo: row.repo,
    pr: typeof pr === "number" ? pr : null,
    kind: kind as ShareType,
    canComment: row.can_comment === 1,
    revocable: row.revocable === 1,
    maxBrowsers: row.max_browsers,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  };
}

/** A PR number, matching the grammar `parsePreviewPath` accepts, so an invite
 * scoped to a PR and a preview path for one can be compared without either
 * side normalising a spelling the other did not. */
export function isPullNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 999_999_999;
}

// ── minting ───────────────────────────────────────────────────────────────

/** Why a mint was refused. `undefined` on success. */
export type MintRefusal = "bad-repo" | "bad-pr" | "bad-kind";

export type MintResult =
  | { readonly ok: true; readonly minted: MintedInvite }
  | { readonly ok: false; readonly refusal: MintRefusal };

export interface MintInviteInput {
  readonly repo: string;
  /** `undefined` or `null` covers the whole repo. */
  readonly pr?: number | null;
  /** Defaults to `personal` (ADR-0009). */
  readonly kind?: ShareType;
}

/**
 * Mint an invite: 256 bits of CSPRNG, stored hashed, scoped, expiring,
 * revocable.
 *
 * **NO HTTP ENDPOINT, and that is the design.** ADR-0009's only stated
 * consequence is "Invite minting requires write access", so this function is
 * reachable only by a caller that already holds write access to D1 — in
 * production `revkit invite` (the CLI, which will need a GitHub token of its
 * own to prove write access; #34) and in tests the harness. An endpoint that
 * mints invites is an endpoint that hands out review access, and gating it on
 * anything weaker than write access is a worse defect than "the operator mints
 * it" — the same reasoning `issueSession` uses for the operator identity, and
 * the reason `POST /api/session` does not exist.
 *
 * `repo` is validated with `isRepoName`, the SAME predicate
 * `parsePreviewPath` applies to a preview path's repository segment. That is
 * not tidiness: the per-call scope check compares an invite's `repo` against a
 * preview path's, and a predicate that accepted different character sets on
 * the two sides would make that comparison wrong for inputs only one side can
 * produce.
 *
 * ── The repo name is CANONICALISED here, and this is the only layer that is ──
 *
 * Validation and canonicalisation are deliberately separate calls, in that
 * order. `isRepoName` decides whether the name is servable; `canonicalRepoName`
 * (`src/router.ts`) decides which of its case spellings gets STORED. Measured
 * property of doing it in that order: `isRepoName(canonicalRepoName(x))` and
 * `isRepoName(x)` agree for every input, because `REPO_SEGMENT` admits only
 * ASCII and an ASCII case-fold is a bijection inside that class — so folding
 * cannot turn a refusal into a grant. `test/router.test.ts` sweeps the class.
 *
 * **Why here and not at read time** (the full argument is on
 * `canonicalRepoName`): the other side of `inviteCovers`' comparison is the URL,
 * and folding that would make `/REVKIT/` and `/revkit/` name ONE review — two
 * spellings of one path resolving, which `parsePreviewPath` forbids — and would
 * move the log key, which is the R2 partition. So the stored side moves to the
 * canonical form and the route keeps comparing exactly.
 *
 * **What that changes, measured.** Before: an invite minted `Revkit` matched
 * `/Revkit/` and refused `/revkit/`. After: it matches `/revkit/` and refuses
 * `/Revkit/`. The number of URL spellings an invite admits is ONE either way —
 * which one it is, changed. The reported defect (an operator minting `Revkit`
 * and serving `/revkit/`) is fixed; the inverse (minting `Revkit` and serving
 * `/Revkit/`) is now broken, and that trade is recorded rather than hidden by
 * `test/invites.test.ts`.
 *
 * **It cannot widen a grant**, and the two halves are asserted separately. The
 * stored value only ever moves TOWARD the canonical spelling, and the target is
 * still compared exactly, so the admitted URL set changes membership without
 * changing size. And no case difference lets two invites match each other,
 * because nothing looks an invite up BY REPO at all: a guest's grant is resolved
 * `sessions.identity_id → invite_redemptions.guest_id → invites.id`, i.e. BY ID.
 * `invites.repo` is `NOT NULL` and carries no index and no UNIQUE constraint —
 * measured over the whole shipped schema — so there is no repo-scoped key for
 * the fold to collide either.
 *
 * `expires_at` is computed from the share type and the injected clock, never
 * taken from the caller — a caller-supplied expiry is how an invite outlives
 * the retention story ADR-0015 starts from it.
 */
export async function mintInvite(
  db: D1Database,
  input: MintInviteInput,
  options: { readonly now?: MsClock; readonly keys: InviteTokenHasher },
): Promise<MintResult> {
  if (!isRepoName(input.repo)) return { ok: false, refusal: "bad-repo" };
  const repo = canonicalRepoName(input.repo);
  const pr = input.pr ?? null;
  if (pr !== null && !isPullNumber(pr)) return { ok: false, refusal: "bad-pr" };
  const kind = input.kind ?? DEFAULT_SHARE_TYPE;
  if (!(SHARE_TYPES as readonly string[]).includes(kind)) return { ok: false, refusal: "bad-kind" };
  const now = (options.now ?? Date.now)();
  const token = mintToken();
  const tokenHash = await options.keys.hash(token);
  const id = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + INVITE_LIFETIME_DAYS[kind] * 24 * 60 * 60 * 1000).toISOString();
  const canComment = SHARE_TYPE_CAN_COMMENT[kind];
  await db
    .prepare(
      "INSERT INTO invites (id, token_hash, repo, pr, kind, can_comment, revocable, max_browsers, expires_at, created_at, revoked_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)",
    )
    // `repo`, NOT `input.repo`: the column and the returned record must hold the
    // same value, or `revkit invite` (#81) would print a link for a spelling the
    // gate then refuses — the same defect one layer up.
    .bind(id, tokenHash, repo, pr, kind, canComment ? 1 : 0, INVITE_MAX_BROWSERS[kind], expiresAt, createdAt)
    .run();
  const invite: InviteRecord = {
    id,
    tokenHash,
    repo,
    pr,
    kind,
    canComment,
    revocable: true,
    maxBrowsers: INVITE_MAX_BROWSERS[kind],
    expiresAt,
    createdAt,
    revokedAt: null,
  };
  return { ok: true, minted: { invite, token } };
}

/** Look an invite up by its id, for an operator tool. Does not check
 * liveness — `revokeInvite` needs to find an expired invite to stamp it, and a
 * read that refused one would leave it un-revocable. */
export async function loadInviteById(db: D1Database, inviteId: string): Promise<InviteRecord | undefined> {
  return readInvite(await db.prepare(SELECT_INVITE_BY_ID_SQL).bind(inviteId).first<InviteRow>());
}

/** Look an invite up by the SHA-256 of a presented token. Shape-checked first,
 * so a malformed value costs zero round trips — an input filter, and NOT the
 * control: `token_hash` is `UNIQUE`, so a well-shaped forgery finds no row. */
export async function loadInviteByToken(
  db: D1Database,
  token: string,
  options: { readonly keys: InviteTokenHasher },
): Promise<InviteRecord | undefined> {
  if (!isTokenShaped(token)) return undefined;
  // **No fallback key, and the mutation run is why that sentence is here.**
  // ADR-0012 says invite tokens are "stored as HMAC"; slice 3 amended the bare
  // `sha256` proposal *back* to HMAC. Adding `?? sha256Hex(token)` here — a
  // fallback so a row minted under the old scheme would still be found — is
  // **behaviourally equivalent today and measured as such**: the mutation run
  // recorded 0 red, because `mintInvite` is the only writer of `token_hash` and it
  // always writes the HMAC, so a `sha256` probe finds no row on any database this
  // build produces.
  //
  // It is recorded rather than left implicit because "HMAC-keyed `token_hash`
  // with no fallback key" is a real control with nothing behind it, and a future
  // migration that DID write a bare digest would find this function silently
  // unable to see its own rows. The fallback, if one is ever needed, belongs in
  // that migration — which knows the rows are legacy — and not in the lookup every
  // redemption goes through.
  return readInvite(
    await db.prepare(SELECT_INVITE_BY_TOKEN_SQL).bind(await options.keys.hash(token)).first<InviteRow>(),
  );
}

// ── redemption ────────────────────────────────────────────────────────────

/** Every way a redemption can be refused. A CLOSED vocabulary, for the same
 * reason `DENIAL_REASONS` is: these strings reach a log line and a response
 * body, and a caller must not be able to build one out of the request. */
export type RedeemRefusal =
  | "unknown-token"
  | "invite-revoked"
  | "invite-expired"
  | "already-redeemed"
  | "browsers-exhausted"
  | "browser-binding-missing"
  | "display-name-rejected";

export type RedeemResult =
  | {
      readonly ok: true;
      readonly issued: IssuedSession;
      readonly guestId: string;
      readonly invite: InviteRecord;
      /** The complete `Set-Cookie` value for the browser binding, so the
       * caller can set it on the same response that sets the session cookie. */
      readonly browserCookie: string;
    }
  | { readonly ok: false; readonly refusal: RedeemRefusal };

/**
 * Exchange an invite token for a session. This is the FIRST legitimate caller
 * of the session-issuance internals, and it goes through `mintSession` +
 * `sessionInsertStatement` — the same 256-bit mint, the same digests at rest
 * and the same `__Host-` cookie `issueSession` produces. What is different is
 * only that its INSERT goes into a `db.batch` with the redemption row, because
 * D1 has no interactive transaction and a session that outlives a failed
 * redemption is a credential nobody is entitled to.
 *
 * ── The batch, and why it is shaped this way ──────────────────────────────
 *
 * Three statements, in this order, each one gated on the state the previous one
 * produced:
 *
 *   1. `INSERT INTO invite_redemptions … SELECT … FROM invites WHERE <live>`
 *      — the claim on a browser slot. Gated on the invite being unrevoked,
 *      unexpired, having fewer than `max_browsers` redemptions, AND this
 *      binding not already holding one.
 *   2. `INSERT INTO guests … WHERE EXISTS (the row statement 1 just wrote)`
 *   3. `INSERT INTO sessions … WHERE EXISTS (the row statement 1 just wrote)`
 *      — via `sessionInsertStatement`'s gate.
 *
 * `batch()` is all-or-nothing, but a conditional INSERT that matches nothing is
 * **not an error** (measured on workerd 2026-05-18: `changes: 0`, the batch
 * succeeded). So a gate cannot be a constraint violation — it has to be a
 * `WHERE` clause, and statements 2 and 3 have to be gated on statement 1's
 * effect rather than merely following it. Then `results[0].meta.changes === 0`
 * is the single "lost the race" signal, and a lost race leaves NOTHING behind:
 * no guest row, no session row, no ledger entry. That is the single-use
 * property, atomically, with no read-then-write window.
 *
 * **The `NOT EXISTS` clause is there because of a measured failure, and the
 * composite primary key is NOT enough.** An earlier version gated only on the
 * `max_browsers` count, on the reasoning that a replay collides with
 * `(invite_id, binding_hash)`. It does — and that is the problem: the collision
 * is a `SQLITE_CONSTRAINT_PRIMARYKEY` **error**, which aborts the whole batch
 * and escapes `redeemInvite` as a thrown exception. Driven over D1, re-presenting
 * one browser's token on a `team` invite produced
 * `D1_ERROR: UNIQUE constraint failed: invite_redemptions.invite_id,
 * invite_redemptions.binding_hash` — a 500 where a refusal belongs, on the one
 * input an attacker controls most. The `COUNT(*)` clause let the replay through
 * because the invite had nine slots left, so the row was attempted at all.
 * Excluding the binding in the same `WHERE` turns the replay back into
 * `changes: 0`, which is the graceful path `classifyLostRedemption` then names.
 * The primary key stays as the invariant that makes that exclusion necessary;
 * it is no longer the mechanism.
 *
 * The pre-read before the batch is not part of the decision — the batch's
 * `WHERE` clause is, because only that is inside the atomic unit. The pre-read
 * exists to produce a precise refusal REASON and the token-free redirect
 * target, and it is re-checked, not trusted: revoking an invite between the
 * read and the batch changes the outcome.
 *
 * The `max_browsers` count and the claim are in the SAME statement on purpose.
 * Slice 1 measured that `D1ThreadStore.append` cannot read a head outside its
 * batch and stay correct (6 concurrent read-then-write appends produced 3
 * distinct `seq` values and collided on the primary key), and this is that
 * lesson applied: a `COUNT(*)` before the `INSERT` would let N browsers pass N
 * simultaneous checks for one remaining slot.
 *
 * ── The session TTL is capped by the invite's REMAINING life ──────────────
 *
 * `min(SESSION_TTL_MS, expires_at - now)`. The per-call check would refuse an
 * expired invite anyway, so this is belt-and-braces — and belt-and-braces that
 * can be MEASURED: a session row's `expires_at` then never outlives the invite
 * it came from, so a database read cannot produce a credential that looks
 * live after the invite died.
 *
 * ── The display name, and why it is validated HERE ────────────────────────
 *
 * ADR-0015 requires one and the schema enforces it, so a blank name cannot reach
 * the table. What the CHECK does not bound is LENGTH, and a display name is
 * rendered into a review record and mirrored to GitHub as `"Name (guest)"`
 * (ADR-0009). An unbounded name is an unbounded mirror, so it is capped here
 * and refused rather than truncated: a silent truncation would change what a
 * guest is called without telling them. Leading/trailing whitespace is trimmed
 * because `"  "` passes the CHECK's `length(trim(x)) > 0` only if the trim
 * leaves something, and a name of `"Ada  "` would be stored with the padding.
 */
/**
 * The guarded INSERT that claims a browser slot: statement 1 of the redemption
 * batch, as a statement the caller can run.
 *
 * **Exported so its predicate is TESTABLE, because it is a control in its own
 * right and the mutation run proved the function-level tests could not see it.**
 * Removing `revoked_at IS NULL` from this `WHERE` clause changed **zero** of 87
 * tests, because `redeemInvite`'s pre-read refuses a revoked invite first — so
 * the clause looked redundant, and a reviewer could delete it on that evidence.
 * It is not redundant: it is the only check inside the ATOMIC unit, and a
 * revocation landing between the pre-read and this statement is exactly the
 * race a pre-read cannot close. `test/invites.test.ts`'s "the redemption's own
 * guard refuses …" cases drive THIS statement directly against a revoked row, an
 * expired row, a full invite and an already-bound browser, which is the only way
 * to pin a predicate the surrounding function short-circuits.
 *
 * The clause is deliberately `expires_at > ?` with the CALLER's clock rather
 * than SQLite's `datetime('now')`: the Worker has an injectable clock, the tests
 * need one, and a database-side clock would be a second, untestable one.
 */
export function redemptionClaimStatement(
  db: D1Database,
  input: {
    readonly inviteId: string;
    readonly bindingHash: string;
    readonly guestId: string;
    readonly nowIso: string;
    readonly maxBrowsers: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO invite_redemptions (invite_id, binding_hash, guest_id, created_at) " +
        "SELECT id, ?, ?, ? FROM invites WHERE id = ? AND revoked_at IS NULL AND expires_at > ? " +
        "AND (SELECT COUNT(*) FROM invite_redemptions WHERE invite_id = invites.id) < ? " +
        "AND NOT EXISTS (SELECT 1 FROM invite_redemptions WHERE invite_id = invites.id AND binding_hash = ?)",
    )
    .bind(
      input.bindingHash,
      input.guestId,
      input.nowIso,
      input.inviteId,
      input.nowIso,
      input.maxBrowsers,
      input.bindingHash,
    );
}

export async function redeemInvite(
  db: D1Database,
  input: { readonly token: string; readonly binding: string; readonly displayName: string },
  options: { readonly now?: MsClock; readonly keys: InviteTokenHasher },
): Promise<RedeemResult> {
  const now = (options.now ?? Date.now)();
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_CHARS) {
    return { ok: false, refusal: "display-name-rejected" };
  }
  // The binding is what identifies the browser. Refusing a malformed one here
  // means the ledger never holds a binding that could never be presented again,
  // which would otherwise silently consume one of the invite's slots.
  if (!isTokenShaped(input.binding)) return { ok: false, refusal: "browser-binding-missing" };
  const bindingHash = await sha256Hex(input.binding);
  // NO pre-read revocation or expiry refusal here, and that is the same
  // treatment `revokeInvite` got rather than a second opinion about the same
  // pattern: both decisions are made by `redemptionClaimStatement`'s `WHERE`
  // clause inside the atomic batch, so a pre-check could only duplicate them.
  // Deleting it leaves the mutation run's verdict unchanged (the pre-read
  // mutants M11/M31 still go red through the statement), and the refusals are
  // still reported — `classifyLostRedemption` re-derives them on the refusal
  // path.
  const invite = await loadInviteByToken(db, input.token, options);
  if (invite === undefined) return { ok: false, refusal: "unknown-token" };
  const guestId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const lifetimeMs = Math.max(0, Date.parse(invite.expiresAt) - now);
  const minted = await mintSession(
    { kind: "invite", id: guestId },
    {
      // The clock was resolved once, above, and every deadline in this
      // function is compared against THAT reading. Handing `mintSession` the
      // resolved value as a function keeps one reading per redemption.
      now: () => now,
      ttlMs: Math.min(SESSION_TTL_MS, lifetimeMs),
    },
  );
  // The ledger predicate, named once and reused verbatim in statements 2 and 3.
  // It is the whole atomicity argument in one string: "the redemption I just
  // wrote, for this invite and this binding, naming this guest".
  const claim = "EXISTS (SELECT 1 FROM invite_redemptions WHERE invite_id = ? AND binding_hash = ? AND guest_id = ?)";
  const results = await db.batch([
    redemptionClaimStatement(db, {
      inviteId: invite.id,
      bindingHash,
      guestId,
      nowIso: createdAt,
      maxBrowsers: invite.maxBrowsers,
    }),
    db
      .prepare("INSERT INTO guests (id, display_name, email, created_at, deleted_at) SELECT ?, ?, NULL, ?, NULL WHERE " + claim)
      .bind(guestId, displayName, createdAt, invite.id, bindingHash, guestId),
    sessionInsertStatement(db, minted, { where: claim, bindings: [invite.id, bindingHash, guestId] }),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    // The injected clock, not the wall clock: a refusal REASON computed from a
    // different clock than the decision is exactly the drift an injectable
    // clock exists to prevent, and it is not hypothetical — dropping the
    // pre-read and leaving this call on `Date.now()` made "an expired invite
    // cannot be redeemed" report `already-redeemed`, because the batch correctly
    // refused an invite the wall clock still considered live.
    return { ok: false, refusal: await classifyLostRedemption(db, invite, bindingHash, now) };
  }
  return {
    ok: true,
    issued: issuedFrom(minted),
    guestId,
    invite,
    browserCookie: browserCookieHeader(input.binding, Math.floor(lifetimeMs / 1000)),
  };
}

/**
 * Why a guarded redemption wrote nothing. Only reached on the refusal path,
 * and only to name the reason precisely — the DECISION was already made inside
 * the batch's `WHERE` clause, so this cannot turn a refusal into a grant.
 *
 * The order is the order a reader needs: is this browser already one of the
 * invite's (a replay), or is the invite simply full (`max_browsers`)? The
 * second needs a `COUNT`, and a ledger that is empty cannot be full, so a
 * zero-count here means the invite changed under us — revoked or expired
 * between the pre-read and the batch — and those are reported as what they are
 * rather than as a misleading "browsers exhausted".
 */
async function classifyLostRedemption(
  db: D1Database,
  invite: InviteRecord,
  bindingHash: string,
  nowMs: number,
): Promise<RedeemRefusal> {
  if (invite.revokedAt !== null) return "invite-revoked";
  const already = await db
    .prepare("SELECT 1 AS hit FROM invite_redemptions WHERE invite_id = ? AND binding_hash = ?")
    .bind(invite.id, bindingHash)
    .first<{ hit?: unknown }>();
  if (already !== null && already !== undefined) return "already-redeemed";
  const live = await loadInviteById(db, invite.id);
  if (live === undefined || live.revokedAt !== null) return "invite-revoked";
  if (Date.parse(live.expiresAt) <= nowMs) return "invite-expired";
  const slots = await db
    .prepare("SELECT COUNT(*) AS used FROM invite_redemptions WHERE invite_id = ?")
    .bind(invite.id)
    .first<{ used?: unknown }>();
  return typeof slots?.used === "number" && slots.used >= invite.maxBrowsers ? "browsers-exhausted" : "already-redeemed";
}

/** The longest display name accepted, in Unicode code points (`Array.from`
 * counts them, so an emoji is one and a 64-emoji name is 64 rather than 256
 * UTF-16 units). Bounded because ADR-0009 mirrors the name into a GitHub
 * comment and an unbounded name is an unbounded mirror. */
export const MAX_DISPLAY_NAME_CHARS = 64;

/**
 * The largest redeem body the Worker will read, in bytes.
 *
 * **This is a real bound, not a courtesy.** `/invite/redeem` is an
 * UNAUTHENTICATED route — its credential is the token in the body, so it has not
 * been checked when the body arrives — which makes an unbounded read the
 * cheapest denial of service on the surface: one request, megabytes of memory,
 * no credential needed. The limiter in front of it bounds the NUMBER of such
 * requests and not their size, so the size needs its own ceiling.
 *
 * 64 KiB is far above anything legitimate (a token is 43 characters and a
 * display name is capped at 64) and far below anything interesting. It lives
 * here, beside `MAX_DISPLAY_NAME_CHARS`, because `src/index.ts` may export
 * nothing but the Worker handler — a named export there is a module-shape error
 * at runtime, not a style note (measured: workerd refuses to start with
 * `Incorrect type for map entry`).
 */
export const MAX_REDEEM_BODY_BYTES = 64 * 1024;


// ── the per-call check ────────────────────────────────────────────────────

/** What an authorized guest session is checked against, on every call. */
export interface InviteGrant {
  readonly invite: InviteRecord;
  /** True when this session's guest is bound to THIS browser, i.e. the
   * redemption's `binding_hash` matches the cookie presented now. */
  readonly browserMatches: boolean;
}

/**
 * Why an authorized guest session cannot act. A closed vocabulary; the gate
 * maps each member to a status and a reason from ITS own list.
 *
 * `no-grant` covers "this session names a guest with no redemption row", which
 * is the fail-closed direction for ADR-0015's purge (which anonymises rather
 * than deletes, so this is not reachable that way) and for any session row a
 * hand-written D1 write invented.
 */
export type GrantRefusal =
  | "no-grant"
  | "invite-row-unreadable"
  | "invite-revoked"
  | "invite-expired"
  | "browser-mismatch";

export type GrantResult = { readonly ok: true; readonly grant: InviteGrant } | { readonly ok: false; readonly refusal: GrantRefusal };

/**
 * ADR-0012's "a guest invite is checked for scope, type and expiry on each
 * call", as one lookup the gate runs on EVERY authorized request from a guest
 * session.
 *
 * **"on each call", not "at redemption".** Revocation and expiry both move
 * AFTER a session exists, and a check that ran once would leave a revoked
 * invite working for the life of the session — which is exactly the failure
 * ADR-0012's own amendment calls revocation "the first mechanism that closes".
 * So this reads the invite row on every request and decides from the row as it
 * stands now, not from anything cached at redemption.
 *
 * The join is `sessions.identity_id` (the guest id, ADR-0015) →
 * `invite_redemptions.guest_id` → `invites.id`, and the redemption row carries
 * the binding hash, so ONE query answers all three of scope, type and expiry
 * plus the browser check. `sessions.identity_id` is not on `invite_redemptions`
 * as a prefix, which is why `migrations/0002_invites.sql` indexes
 * `guest_id`; without it this is a scan of every redemption the deployment has
 * ever made, on every authorized request.
 *
 * `expires_at` is compared against the injected clock and an UNREADABLE one is
 * refused, never defaulted — the same fail-closed rule
 * `resolveSession`'s `isParsableTimestamp` applies to a session row, for the
 * same reason. A row whose expiry cannot be read must not produce a grant.
 */
export async function loadInviteGrant(
  db: D1Database,
  input: { readonly guestId: string; readonly binding: string | null },
  options: { readonly now?: MsClock } = {},
): Promise<GrantResult> {
  const row = await db
    .prepare(
      "SELECT r.binding_hash AS binding_hash, i.id AS id, i.token_hash AS token_hash, i.repo AS repo, i.pr AS pr, " +
        "i.kind AS kind, i.can_comment AS can_comment, i.revocable AS revocable, i.max_browsers AS max_browsers, " +
        "i.expires_at AS expires_at, i.created_at AS created_at, i.revoked_at AS revoked_at " +
        "FROM invite_redemptions r JOIN invites i ON i.id = r.invite_id WHERE r.guest_id = ?",
    )
    .bind(input.guestId)
    .all<InviteRow & { binding_hash?: unknown }>();
  const results = row.results ?? [];
  // EXACTLY ONE. A guest id with two redemptions would mean the scope and type
  // rules depend on which row a query happens to return, so more than one is
  // refused rather than resolved. One redemption per guest is what
  // `redeemInvite` builds (it mints a fresh guest id per redemption), so this
  // is the invariant, not a guess.
  if (results.length !== 1) return { ok: false, refusal: "no-grant" };
  const joined = results[0] as InviteRow & { binding_hash?: unknown };
  const invite = readInvite(joined);
  if (invite === undefined) return { ok: false, refusal: "invite-row-unreadable" };
  if (invite.revokedAt !== null) return { ok: false, refusal: "invite-revoked" };
  if (Date.parse(invite.expiresAt) <= (options.now ?? Date.now)()) return { ok: false, refusal: "invite-expired" };
  // A missing or malformed binding cookie is a MISMATCH, not a separate case:
  // both mean "this request did not come from the browser the invite was
  // redeemed in", and the gate's answer is the same 403 either way.
  // No `isTokenShaped` guard on `binding`, and the reasoning is slice 2's: the
  // comparison is a digest equality, and the digest of a malformed value cannot
  // equal a stored digest, so a shape check cannot make a non-matching digest
  // match. An earlier revision had one; it was measured (the mutation run) to
  // change nothing, which is the same result that removed the CSRF shape check
  // in slice 2. `null` still short-circuits, because `sha256Hex(null)` is not a
  // call this makes — that guard is the one with teeth.
  const browserMatches = input.binding !== null && joined.binding_hash === await sha256Hex(input.binding);
  return { ok: true, grant: { invite, browserMatches } };
}

/**
 * What an invite's scope is compared against: the repo and PR a route NAMES.
 *
 * Declared here rather than imported from `src/authz.ts` so the store's log key
 * (`authz.PreviewScope.logKey`) is **not in this type** and cannot be consulted
 * by a scope check. The comparison is about the two halves an invite's
 * `repo`/`pr` columns carry, and nothing else belongs in it.
 */
export interface InviteScope {
  readonly repo: string;
  readonly pr: number;
}

/**
 * Does this invite's scope cover this target?
 *
 * ADR-0009: "scoped to the repo, optionally one PR". So an invite with
 * `pr = NULL` covers every PR of its repo and an invite with `pr = 42` covers
 * exactly PR 42. A DIFFERENT repo is never covered, whatever the PR — that is
 * the whole isolation property, and it is why the comparison is on the repo
 * first and not on a normalised composite key.
 *
 * ── `!==` here is load-bearing, and mint-time canonicalisation did not change it ──
 *
 * **`target.repo` is never folded, here or anywhere downstream.** The stored
 * side is canonical (`mintInvite`), so an invite admits the one canonical URL
 * and no other, and the comparison itself is a plain exact match.
 *
 * **Since #96 a case-differing path does not reach this function at all.**
 * `parsePreviewPath` refuses a repo segment that is not already
 * `canonicalRepoName(segment) === segment`, so `/Revkit/pr-7` is not a preview,
 * names no scope, and classifies `unknown` — a 404 before the gate runs. This
 * function still compares with `!==`, and still refuses a non-canonical target
 * it is handed directly (which is why `test/invites.test.ts` can drive it with
 * a hand-built scope), but the enforcement point moved UP to the parser and that
 * is deliberate: see below.
 *
 * **So the admitted set has one member, not two.** Folding the target as well
 * would make `/REVKIT/` and `/revkit/` both cover the same invite — two
 * spellings of one path resolving to one review, which `parsePreviewPath`
 * refuses for doubled slashes and for `%2e` and which would move the log key.
 * Refusing a non-canonical spelling is the fail-closed direction either way: an
 * unrecognised spelling denies rather than admits.
 *
 * ── The target is REQUIRED, and that is slice 5's fix ────────────────────
 *
 * This signature used to accept `undefined` and answer `true` for it, on the
 * reasoning that "this route names no repo or PR" leaves nothing to be out of
 * scope for. **That reasoning is what let a guest in scope for `repo-a/pr-7`
 * read the whole org's log:** `GET /api/threads` named nothing
 * (`events(seq, ts, payload)` had no `repo` column), so the per-call check ran on
 * every request of a stranger's session, selected nothing, and passed. The
 * defect was never a missing comparison — it was an absent scope being read as
 * an absent restriction.
 *
 * So the absent scope is no longer expressible here: a caller that has no scope
 * cannot call this, and `authorizeRequest` refuses a guest outright instead
 * (`invite-scope-unbounded`). A check that cannot be skipped by being handed
 * nothing is worth more than one that answers carefully when handed nothing.
 */
export function inviteCovers(invite: InviteRecord, target: InviteScope): boolean {
  if (invite.repo !== target.repo) return false;
  return invite.pr === null || invite.pr === target.pr;
}

// ── revocation ────────────────────────────────────────────────────────────

/**
 * Revoke an invite: stamp `revoked_at`, and from that instant every session
 * minted from it stops working.
 *
 * **The immediacy is not a property of this function.** It is a property of
 * `loadInviteGrant`, which the gate runs on every authorized request — so a
 * session already in a browser's cookie jar is refused on its NEXT request,
 * with no expiry to wait for and no revocation list to consult.
 * `test/invites.test.ts` drives exactly that: mint, redeem, revoke,
 * then present the still-unexpired cookie.
 *
 * Idempotent, and the boolean says whether THIS call was the one that revoked
 * it: an already-revoked invite is left alone rather than re-stamped, so
 * `revoked_at` stays the moment the owner revoked it and an operator tool
 * cannot make a revocation look later than it was. `revocable = 0` is honoured
 * here even though no share type mints one — the column exists, so the
 * refusal belongs here rather than in a future caller's `if`.
 *
 * An invite can be revoked while EXPIRED and that is allowed: ADR-0015's
 * retention clock starts from "revoked or expires", and revoking an expired
 * invite is the operator saying "this one is done" — it changes nothing a guest
 * can do, because `loadInviteGrant` already refuses it on expiry.
 */
export async function revokeInvite(
  db: D1Database,
  inviteId: string,
  options: { readonly now?: MsClock } = {},
): Promise<"revoked" | "already-revoked" | "not-found" | "not-revocable"> {
  const invite = await loadInviteById(db, inviteId);
  if (invite === undefined) return "not-found";
  if (!invite.revocable) return "not-revocable";
  // No "already revoked" pre-check, and that is MEASURED rather than preferred:
  // deleting one changed **zero** of 87 tests, because the `UPDATE` below is
  // already guarded on `revoked_at IS NULL`, so a second revocation matches no
  // row, changes nothing, and returns the same answer by a different route. A
  // guard that cannot change an outcome is a second thing to keep in step, so it
  // is gone rather than kept with a comment explaining itself — and `revoked_at`
  // still keeps the FIRST moment, which is what ADR-0015's retention clock is
  // measured from.
  const result = await db
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(new Date((options.now ?? Date.now)()).toISOString(), inviteId)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? "revoked" : "already-revoked";
}

// ── ADR-0015's guest clock ────────────────────────────────────────────────

export {
  GUEST_DELETED_NAME,
  GUEST_RETENTION_MS,
  purgeStaleGuests,
  type PurgeResult,
} from "./retention.ts";
