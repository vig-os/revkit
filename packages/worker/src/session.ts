// Sessions: minting, hashing, storage and validation against D1
// (ADR-0012's "Sessions: HttpOnly, Secure, SameSite=Lax cookies; every
// state-changing call needs a per-session CSRF token in a header").
//
// ── Where a session id lives, and what is stored ──────────────────────────
//
// THE COOKIE carries a 256-bit session id, base64url, 43 characters, no
// padding. `sessions.id` — the column `migrations/0001_init.sql` created as
// the PRIMARY KEY — stores its **SHA-256 hex digest**, never the id itself.
//
// Why hashed, and why that is a real difference rather than tidiness:
//
//   - A D1 read (an operator with the database, a dump, a leaked backup, a
//     future analytics query) is then NOT enough to impersonate anybody.
//     `invites.token_hash` is hashed for the same reason; the migration says
//     so, and this is that constraint applied to the session as well.
//   - The lookup is `WHERE id = sha256(cookie)`, so the comparison is an
//     indexed equality on a fixed-width hex string. There is no linear scan
//     over candidate secrets and therefore no scan to time — the gate does
//     not need `timingSafeEqual` on the session id at all. The CSRF token
//     comparison DOES need one, because that one compares two values the
//     caller can both influence; see `constantTimeEquals` below.
//
// The cost, stated rather than hidden: an expired-or-not row's id is not
// recoverable from the database, so `revkit deploy init` (slice 8) must
// PRINT the cookie value once at issuance and the operator must keep it.
// That is the same trust model as ADR-0013's process-lifetime daemon
// sessions ("a restart rotates the cookie space"), not a new one.
//
// ── Entropy ───────────────────────────────────────────────────────────────
//
// 32 bytes from `crypto.getRandomValues`. Not `crypto.subtle.generateKey`
// (which yields a non-extractable CryptoKey, unusable as a cookie value) and
// emphatically not `Math.random`, which is not a CSPRNG and whose output is
// reproducible from a few observed values. `crypto.getRandomValues` exists in
// workerd with `compatibility_flags: []` (measured; `test/worker-runtime.ts`
// pins the neighbouring `crypto.randomUUID`) and in Bun, so the same code
// mints on both.
//
// ── Why the CSRF token is also hashed at rest ─────────────────────────────
//
// `sessions.csrf_hash` is the SHA-256 of the per-session CSRF token, and the
// token is returned to the caller ONCE, at issuance. So neither the session
// id nor the CSRF token is recoverable from the database: an attacker who
// reads D1 gets two digests and no credential. The token is then compared by
// hashing the presented header value and comparing digests, which is what
// binds it to the session — the expected digest comes from the session's own
// row, so a token minted for session A cannot satisfy session B's check.
//
// ── How a stolen-but-unexpired cookie is bounded ──────────────────────────
//
// Four bounds, and the honest statement is that they are BOUNDS, not
// prevention:
//
//   1. `expires_at` is checked on EVERY request, not only at issue. A row
//      whose expiry is in the past — or unparsable, which is treated as
//      expired — is refused (`lookupSession` returns undefined).
//   2. `SESSION_TTL_MS` bounds the initial lifetime.
//   3. `POST /api/session/refresh` ROTATES: it mints a new id AND a new CSRF
//      token and DELETES the row it replaced, so the legitimate browser can
//      invalidate a stolen copy at any time, and the stolen copy's window is
//      the shorter of "until the next refresh" and "the original expiry".
//   4. The rotation is a single `db.batch`, so there is no window in which
//      both ids are live — see `rotateSession`'s compare-and-swap.
//
// NOT bounded here, and named as residual risk in the PR: there is no
// logout-all-sessions, no per-identity revocation list, no device list, and
// no way to distinguish the thief from the owner. Slice 3's invite
// revocation is the first mechanism that closes any of those.

// ── the cookie ────────────────────────────────────────────────────────────

/**
 * The session cookie's name, with the `__Host-` prefix.
 *
 * `__Host-` is not decoration: a browser REJECTS a `__Host-` cookie unless
 * it is `Secure`, has `Path=/`, and carries **no** `Domain` attribute. That
 * makes it impossible for `evil.review.exoma.org` — or any other subdomain
 * of the hosted origin — to set a cookie that `review.exoma.org` will send
 * to this Worker, which is the cookie-tossing half of a session-fixation
 * attack. ADR-0012 asks for HttpOnly/Secure/SameSite=Lax; the prefix buys the
 * fourth property the ADR does not name.
 *
 * The name is fixed (not per-org, not per-port as the daemon's is) because
 * one org's Worker serves one origin and the cookie is scoped to the host,
 * not to a deployment.
 */
export const SESSION_COOKIE_NAME = "__Host-revkit_session";

/** ADR-0012: "every state-changing call needs a per-session CSRF token in
 * a header". This is that header. The name is prefixed like the request-id
 * header (`x-revkit-request-id`, `src/headers.ts`) so a revkit header is
 * recognisable in a log or a proxy trace, and it is NOT a secret name: the
 * value is a bearer credential, which is why `SENSITIVE_KEY` in
 * `src/logger.ts` matches `csrf` and the gate never logs the value. */
export const CSRF_HEADER = "x-revkit-csrf";

/** Entropy per token, in bytes. 32 bytes = 256 bits, the size ADR-0009
 * names for invite tokens and ADR-0012 repeats for CSRF. */
export const TOKEN_BYTES = 32;

/** Base64url length of a 32-byte token without padding: 32 = 3x10 + 2, so
 * 10 full groups (40 chars) plus one 3-char group = 43. Derived from
 * `TOKEN_BYTES` so the two cannot drift apart and turn the shape check into
 * a check for a length nothing produces. */
export const TOKEN_CHARS = Math.ceil((TOKEN_BYTES * 4) / 3);

/** The base64url alphabet. Anchored and exact-length: a session id is
 * 43 characters from this set and nothing else, so a cookie carrying
 * whitespace, a `;`, a `%`, or 42 characters is refused BEFORE a database
 * round trip. This is an input filter, NOT the security control — a
 * correctly-shaped forgery passes it and is still refused, which is a test. */
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_CHARS}}$`);

/** Default session lifetime. ADR-0012 sets no number (ADR-0009's 14/30 days
 * are INVITE lifetimes, and a session must not outlive the invite it was
 * exchanged from by much). 12 hours is chosen deliberately: long enough for a
 * review session that spans a working day, short enough that a stolen cookie
 * is worthless by the next morning. Slice 3 sets the real TTL from the
 * invite's share type at redemption time. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** How long a session may live even when refreshed. Without a cap,
 * `POST /api/session/refresh` would let a holder keep one credential alive
 * forever, which defeats bound 3 above. `refreshSession`'s caller passes the
 * ORIGINAL `created_at` through, so sliding cannot extend past this. */
export const SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The identity kinds this build recognises. See
 * `RECOGNISED_IDENTITY_KINDS`'s own comment for why the set is closed HERE
 * and open in the table. */
export type IdentityKind = (typeof RECOGNISED_IDENTITY_KINDS)[number];

/**
 * Identity kinds the AUTHORIZATION GATE honours, in one place, because two
 * modules must agree on it: `issueSession` will not mint a kind the gate
 * would refuse, and the gate refuses everything that is not in this list.
 *
 * `operator` is the one slice 2 mints, and naming it is the answer to
 * "where does a session come from with no invites and no App?" — see the
 * `issueSession` header. `github` and `invite` are ADR-0009's two real
 * classes; they are ABSENT here on purpose. When slice 3/4 adds the code
 * that redeems an invite or completes a GitHub OAuth exchange, it adds the
 * arm HERE, in the gate, where the review will see it — that is the point of
 * the gate refusing unknown kinds rather than defaulting them to "allowed".
 *
 * The TABLE stays open (`migrations/0001_init.sql` records why: adding a
 * provider must not mean a table rewrite). Open in the schema, closed in the
 * gate: a provider revkit cannot honour is denied, not guessed at.
 */
export const RECOGNISED_IDENTITY_KINDS = ["operator"] as const;

/** The identity a session is bound to: a kind from the closed set and an
 * opaque id (ADR-0020 — never a login, an email, or a guest display name). */
export interface SessionIdentity {
  readonly kind: IdentityKind;
  readonly id: string;
}

/** A session row that has passed every check: found by digest, kind
 * recognised, and unexpired AS OF THIS LOOKUP. */
export interface SessionPrincipal extends SessionIdentity {
  /** SHA-256 of the CSRF token. Never the token. */
  readonly csrfHash: string;
  /** ISO-8601 UTC, exactly as stored. */
  readonly expiresAt: string;
  /** ISO-8601 UTC, exactly as stored. The refresh cap is measured from it. */
  readonly createdAt: string;
}

/** What issuance hands back. Both plaintext values exist ONLY here and in the
 * response to the caller that asked for the session; neither is ever stored,
 * ever logged, and (for the id) never recoverable from D1 afterwards. */
export interface IssuedSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  /** The complete `Set-Cookie` header value, flags included. */
  readonly cookie: string;
  readonly identity: SessionIdentity;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Seconds, for the cookie's own `Max-Age`. */
  readonly maxAgeSeconds: number;
}

// ── primitives ────────────────────────────────────────────────────────────

/** Monotonic millisecond clock, injected so a test can pin time instead of
 * sleeping. Wall clock by default. */
export type MsClock = () => number;

const wallClock: MsClock = () => Date.now();

/** 256 bits of CSPRNG output, base64url, unpadded.
 *
 * `btoa` is a standard global in the Workers runtime and in Bun; nothing
 * here needs `Buffer` (which workerd does not have, and whose absence is
 * deliberate — `wrangler.jsonc`). */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** base64url of raw bytes, without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when `value` has the exact shape of a minted token. An INPUT filter,
 * never an authorization decision — see `TOKEN_SHAPE`. */
export function isTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * Length-independent-of-content, branch-free string equality.
 *
 * Used for the CSRF digest comparison, which is the one comparison where both
 * sides are attacker-influenceable and a timing signal would be worth
 * collecting: an attacker who can measure how long the rejection took learns
 * how many leading hex characters were right.
 *
 * The session-id lookup does NOT need this: it is a database equality on a
 * digest, so there is no scan over candidate secrets to time. That
 * asymmetry is why there are two mechanisms and not one blanket helper.
 *
 * Length is compared first and returned early, which leaks only the length —
 * and both sides here are SHA-256 hex, so the length is a constant.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** SHA-256 of `text`, lowercase hex. `crypto.subtle` is native in workerd
 * with no compatibility flags — the same primitive `revisionOf` uses inside
 * the runtime probe, so this is not a new platform assumption. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hexOf(new Uint8Array(digest));
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// ── the cookie ────────────────────────────────────────────────────────────

/**
 * The complete `Set-Cookie` value for a session.
 *
 * The attribute set is ADR-0012's, plus what `__Host-` requires:
 *
 *   HttpOnly      — `document.cookie` cannot read it, so an XSS in any
 *                   preview page cannot exfiltrate the session.
 *   Secure        — required by `__Host-`, and correct: the hosted origin
 *                   is HTTPS. (The daemon omits `Secure` because it serves
 *                   loopback `http://`; see `packages/cli/src/serve/auth.ts`.)
 *   SameSite=Lax  — ADR-0012 says Lax, not Strict, and the reason is the
 *                   invite link: a guest arriving from a mail client on a
 *                   top-level GET navigation MUST carry the cookie, which
 *                   Strict would strip. Lax still refuses the cookie on a
 *                   cross-site POST/PUT/DELETE, which is the CSRF case
 *                   `CSRF_HEADER` covers in depth.
 *   Path=/        — required by `__Host-`, and correct: the whole surface is
 *                   one origin.
 *   Max-Age       — the browser stops sending it when the server would stop
 *                   accepting it. Server-side expiry is the real control;
 *                   this only keeps the two from drifting apart.
 *
 * NO `Domain` attribute, deliberately: `__Host-` is rejected without it, and
 * omitting it is what scopes the cookie to this exact host.
 */
export function sessionCookieHeader(sessionId: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** What reading the cookie off a request found.
 *
 * `ambiguous` is a real case, not a hypothetical: two cookies with the same
 * name and different paths/domains both arrive, and picking "the first" is
 * how one origin's session gets silently replaced by another's. Browsers
 * order by specificity, which is not something this Worker gets to reason
 * about, so the honest answer is to refuse. */
export type CookieLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: string }
  | { readonly kind: "ambiguous" };

/** Parse one named cookie out of a `Cookie` request header. Total: no input
 * makes it throw, and it never reads anything but the requested name. */
export function readSessionCookie(header: string | null): CookieLookup {
  if (header === null) return { kind: "absent" };
  let found: string | undefined;
  for (const raw of header.split(";")) {
    const pair = raw.trim();
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals) !== SESSION_COOKIE_NAME) continue;
    if (found !== undefined) return { kind: "ambiguous" };
    found = pair.slice(equals + 1);
  }
  return found === undefined ? { kind: "absent" } : { kind: "present", value: found };
}

// ── the store ─────────────────────────────────────────────────────────────

const INSERT_SESSION_SQL =
  "INSERT INTO sessions (id, identity_kind, identity_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)";

const SELECT_SESSION_SQL = "SELECT identity_kind, identity_id, csrf_hash, created_at, expires_at FROM sessions WHERE id = ?";

/**
 * Mint a session and write its row.
 *
 * ── WHERE A SESSION COMES FROM, IN THIS SLICE ─────────────────────────────
 *
 * ADR-0012 says every request is authorized, so a session must be issued by
 * something. Slice 2 has neither the GitHub App (owner-gated, #34) nor an
 * invite (slice 3), so this function has exactly ONE caller shape available
 * today: **out of band, by whoever holds write access to the D1 database** —
 * in production that is `revkit deploy init` (slice 8), and in these tests
 * the harness. The identity kind it mints is `operator`, meaning "the person
 * or process that provisioned this deployment".
 *
 * That is safe to ship because of WHAT IT IS NOT: it is not an HTTP route, so
 * no request can reach it, so there is no unauthenticated endpoint that
 * hands a session to whoever asks — the failure mode a "POST /api/session"
 * would be. It is also not a forgery defence on its own: write access to D1
 * is, in this model, the credential, exactly as ADR-0013's daemon makes
 * process memory the credential. The forgery defence is the OTHER half —
 * `lookupSession` resolves a cookie by digest against a row that must exist,
 * be unexpired, and carry a recognised identity kind, so no cookie VALUE
 * that a client can construct reaches data. `test/authorization.test.ts`
 * drives each of those refusals through a real request.
 *
 * The alternative considered and rejected: a `POST /api/session` guarded by a
 * deployment secret. It needs a Worker secret, so it cannot be built or
 * tested without provisioning (#34), it would add an unauthenticated
 * endpoint to the shipped surface, and it would be the first thing a future
 * refactor widens. An unbuildable, unreachable control is worse than an
 * honest "the operator mints it".
 */
export async function issueSession(
  db: D1Database,
  identity: SessionIdentity,
  options: { readonly ttlMs?: number; readonly now?: MsClock } = {},
): Promise<IssuedSession> {
  const now = (options.now ?? wallClock)();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const sessionId = mintToken();
  const csrfToken = mintToken();
  const createdAt = isoAt(now);
  const expiresAt = isoAt(now + ttlMs);
  await db
    .prepare(INSERT_SESSION_SQL)
    .bind(await sha256Hex(sessionId), identity.kind, identity.id, await sha256Hex(csrfToken), createdAt, expiresAt)
    .run();
  return {
    sessionId,
    csrfToken,
    cookie: sessionCookieHeader(sessionId, Math.floor(ttlMs / 1000)),
    identity,
    createdAt,
    expiresAt,
    maxAgeSeconds: Math.floor(ttlMs / 1000),
  };
}

interface SessionRow {
  readonly identity_kind?: unknown;
  readonly identity_id?: unknown;
  readonly csrf_hash?: unknown;
  readonly created_at?: unknown;
  readonly expires_at?: unknown;
}

/** What resolving a cookie's session id found, or why it did not.
 *
 * The distinction between "unknown", "expired" and "kind not recognised" is
 * for the OPERATOR, not the attacker: the log line names the reason, so a
 * failure to authenticate is diagnosable. It leaks nothing a 401 does not
 * already say to someone who already holds the cookie — that the credential
 * is dead — and it is only reachable by a caller who presented a
 * correctly-shaped 256-bit token, i.e. by someone who has one.
 */
export type SessionResolution =
  | { readonly outcome: "resolved"; readonly principal: SessionPrincipal }
  /** The presented id is not even a minted token's shape, so no lookup ran. */
  | { readonly outcome: "malformed" }
  /** Well-shaped, hashed, and no row has that digest. The forgery case. */
  | { readonly outcome: "unknown" }
  | { readonly outcome: "expired" }
  /** A row exists but a field it needs is blank. */
  | { readonly outcome: "incomplete-row" }
  /** A row exists, complete, and names a provider this build has no rules for. */
  | { readonly outcome: "unrecognised-identity-kind" };

/**
 * Resolve a cookie's session id to a principal, or say why not.
 *
 * **Expiry is enforced HERE, on every read** — that is the requirement, and
 * doing it only at issuance would make an expired cookie work forever after
 * the moment it was handed out. Two failure shapes are reported as EXPIRED
 * rather than as errors, because for this decision the only safe answer to
 * "I cannot tell whether this row is still valid" is "no":
 *
 *   - `expires_at` in the past.
 *   - `expires_at` that does not parse at all (an operator wrote it by hand,
 *     a future migration changed the format). `Date.parse` returning `NaN`
 *     fails CLOSED here; a `>=` comparison against `NaN` would not.
 *
 * A row whose `identity_kind` is not in `RECOGNISED_IDENTITY_KINDS` is
 * refused too, and for the same reason: this build cannot know what that
 * provider's scope, expiry and revocation rules are, so honouring it would be
 * a guess. See that constant's comment.
 */
export async function resolveSession(
  db: D1Database,
  sessionId: string,
  options: { readonly now?: MsClock } = {},
): Promise<SessionResolution> {
  if (!isTokenShaped(sessionId)) return { outcome: "malformed" };
  const row = await db.prepare(SELECT_SESSION_SQL).bind(await sha256Hex(sessionId)).first<SessionRow>();
  if (row === null || row === undefined) return { outcome: "unknown" };
  const identity = readPrincipal(row);
  if (identity === undefined) return { outcome: isRowComplete(row) ? "unrecognised-identity-kind" : "incomplete-row" };
  const now = (options.now ?? wallClock)();
  const expiresAt = Date.parse(String(row.expires_at));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { outcome: "expired" };
  return {
    outcome: "resolved",
    principal: {
      ...identity,
      csrfHash: String(row.csrf_hash),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    },
  };
}

/** Is this column usable at all? Every one of them is `NOT NULL` in
 * `migrations/0001_init.sql`, so "absent" is unreachable and a
 * `typeof === "string"` test alone would guard nothing a caller could
 * produce. A BLANK string can be produced — a half-written row, an
 * operator's hand edit, a future migration with a default — so blankness is
 * what has to be refused, and each column checked here is load-bearing:
 * `identity_id` says who the caller is, `csrf_hash` is what the CSRF
 * comparison is measured against, `created_at` is what the refresh lifetime
 * cap is measured from. Refusing beats defaulting: a partial row must not
 * authorise a partial request. */
function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Every field a principal is built from is present. Kept separate from
 * `readPrincipal` so a refusal can say WHICH problem it was — an incomplete
 * row is an operator's data problem, an unrecognised kind is a slice that
 * forgot to add its arm, and they have different fixes. */
function isRowComplete(row: SessionRow): boolean {
  return (
    isPresent(row.identity_kind) &&
    isPresent(row.identity_id) &&
    isPresent(row.csrf_hash) &&
    isPresent(row.created_at) &&
    isPresent(row.expires_at)
  );
}

/** Turn a row into a principal, or undefined when a field is blank or the
 * kind is not one this build honours. `undefined` here means "refuse", never
 * "assume". */
function readPrincipal(row: SessionRow): SessionIdentity | undefined {
  if (!isRowComplete(row)) return undefined;
  const kind = row.identity_kind as string;
  if (!(RECOGNISED_IDENTITY_KINDS as readonly string[]).includes(kind)) return undefined;
  return { kind: kind as IdentityKind, id: row.identity_id as string };
}

/** What a rotation needs: the row to replace, named by the plaintext id the
 * request's cookie carried, plus the resolved principal so the new row keeps
 * the same identity. `src/authz.ts`'s gate assembles this and hands it to the
 * refresh handler; nothing else can, because the gate's output type is
 * branded and the brand is not exported. */
export interface RotationInput {
  /** The plaintext session id from the request's cookie. Held for exactly
   * this call and never stored or logged. */
  readonly sessionId: string;
  readonly principal: SessionPrincipal;
}

/** Thrown when a refresh loses a race, or when the session vanished between
 * the gate's lookup and the rotation. **Not** "unknown session": the caller
 * knows who it is, so the honest status is 409 with a "start again"
 * instruction, not 401. */
export class SessionAlreadyRotatedError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "SessionAlreadyRotatedError";
  }
}

/**
 * Replace one session with a brand-new id and CSRF token, atomically.
 *
 * This is `POST /api/session/refresh`, and it is the ONLY state-changing
 * route this slice opens — deliberately the smallest one that exists, so the
 * CSRF control has a real end-to-end path to be load-bearing on without
 * opening `POST /api/threads` (which needs the bridge and is slice 4's
 * shape). It touches no review data: one `sessions` row out, one in.
 *
 * The two statements are ordered INSERT-then-DELETE, and the INSERT is
 * guarded on the old row still being there:
 *
 *     INSERT … SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)
 *     DELETE FROM sessions WHERE id = ?
 *
 * D1 serialises a `batch()` as one unit and executes its statements in order
 * (the same property `D1ThreadStore.append` relies on to put its head read
 * and its compare-and-swap in one critical section). So:
 *
 *   - Fresh session: the row exists, the INSERT lands, the DELETE removes
 *     it. One live session, and no window in which both ids work.
 *   - Already-rotated session: the row is gone, `EXISTS` is false, the
 *     INSERT writes ZERO rows, the DELETE matches nothing. The batch is
 *     still all-or-nothing, so this is a clean no-op rather than a second
 *     live session nobody holds — which is what an unguarded
 *     DELETE-then-INSERT would produce under a double refresh.
 *
 * `meta.changes === 0` on the INSERT is therefore the "lost the race" signal,
 * and it is reported as a typed error rather than a success with an unusable
 * cookie.
 *
 * The new expiry SLIDES to `now + ttlMs` but is capped at
 * `SESSION_MAX_LIFETIME_MS` after the ORIGINAL `created_at`, so a refresh
 * loop cannot keep one credential alive indefinitely.
 */
export async function rotateSession(
  db: D1Database,
  input: RotationInput,
  options: { readonly ttlMs?: number; readonly now?: MsClock } = {},
): Promise<IssuedSession> {
  const principal = input.principal;
  const now = (options.now ?? wallClock)();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const sessionId = mintToken();
  const csrfToken = mintToken();
  const createdAt = principal.createdAt;
  const slidingExpiry = now + ttlMs;
  const hardCap = Date.parse(createdAt) + SESSION_MAX_LIFETIME_MS;
  const expiresAtMs = Number.isFinite(hardCap) ? Math.min(slidingExpiry, hardCap) : slidingExpiry;
  const expiresAt = isoAt(expiresAtMs);
  // Named once, used twice. The old row's digest is the DELETE's key and the
  // INSERT's `EXISTS` probe; it is derived from the cookie, never stored in
  // `RotationInput`.
  const replacedDigest = await sha256Hex(input.sessionId);
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO sessions (id, identity_kind, identity_id, csrf_hash, created_at, expires_at) " +
          "SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)",
      )
      .bind(
        await sha256Hex(sessionId),
        principal.kind,
        principal.id,
        await sha256Hex(csrfToken),
        createdAt,
        expiresAt,
        replacedDigest,
      ),
    db.prepare("DELETE FROM sessions WHERE id = ?").bind(replacedDigest),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new SessionAlreadyRotatedError(
      "rotateSession: the session was already replaced by a concurrent refresh; the caller must re-authenticate.",
    );
  }
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAtMs - now) / 1000));
  return {
    sessionId,
    csrfToken,
    cookie: sessionCookieHeader(sessionId, maxAgeSeconds),
    identity: { kind: principal.kind, id: principal.id },
    createdAt,
    expiresAt,
    maxAgeSeconds,
  };
}

/** ISO-8601 UTC with millisecond precision and a literal `Z`. Fixed width
 * matters: it is what makes a string comparison of two timestamps equal to a
 * comparison of the instants, and it is what `Date.parse` round-trips. */
function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

// ── CSRF ──────────────────────────────────────────────────────────────────

/**
 * Does the presented header value satisfy THIS session's CSRF check?
 *
 * Bound to the session by construction: `expectedHash` is
 * `sessions.csrf_hash` from the caller's own row, and the presented value is
 * hashed before comparison, so:
 *
 *   - a missing or empty header is refused;
 *   - a constant is refused (there is no constant — the expected side is a
 *     per-row digest);
 *   - a token minted for a DIFFERENT session hashes differently and is
 *     refused;
 *   - a token minted for this session's PREDECESSOR is refused, because
 *     rotation rewrites `csrf_hash`.
 *
 * `CSRF_HEADER`'s name is on the logger's sensitive-key list, so even a
 * future call site that passes the raw header to the logger has its value
 * replaced.
 *
 * **There is deliberately NO shape check on `presented`, and that is a
 * measured decision rather than an oversight.** An earlier revision refused a
 * wrong-shaped value before hashing it, which reads like a second control.
 * It is not one: the mutation run replaced that line with `if (false)` and
 * **0 of 68 tests went red**, because the digest comparison already refuses
 * every value that is not this session's token — a shape check cannot make a
 * non-matching digest match. A line that looks like a control and cannot fail
 * is worse than no line, so it is gone. The cost it avoided (hashing a
 * malformed header) is bounded by the platform's own request-header limit.
 */
export async function csrfSatisfied(expectedHash: string, presented: string | null): Promise<boolean> {
  if (presented === null || presented.length === 0) return false;
  return constantTimeEquals(await sha256Hex(presented), expectedHash);
}
