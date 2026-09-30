// Authentication and request-shape guards for the daemon (ADR-0013).
//
// Three separate credentials, one per caller class.
//
// **Launch code.** A 256-bit, base64url single-use code printed at
// startup as a link. The browser opens `/-/auth?code=<code>` once
// and the daemon marks the code used, mints a session cookie and
// redirects to `/` so `history.replaceState` / the redirect strips
// the code from the URL bar. A reused or expired code is refused.
// Codes live for 60 seconds.
//
// **Session cookie.** An HttpOnly, SameSite=Strict, Path=/ cookie
// the launch flow sets. Persistence is process-lifetime — the cookie
// is opaque and stored in `sessions`; a restart of the daemon
// rotates the cookie space, which matches the ADR-0013 "new start,
// new secrets" property. The cookie value is 256-bit base64url.
//
// **Agent token.** The `agentToken` from `.revkit/serve.json`,
// presented as a `Authorization: Bearer <token>` header on `/api/*`
// and `/events?for=agent`. The token is written to the mode-600 file
// at startup and lives in memory here for constant-time comparison.
//
// Request shape (loopback-only, DNS-rebinding defence, ADR-0013).
// The **Host** header must be `127.0.0.1:<port>` or
// `localhost:<port>` — any other value, even a public IP whose DNS
// points at 127.0.0.1, is refused with 421 Misdirected Request. The
// **Origin** on every non-GET request must be the daemon's own
// origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
// **`Sec-Fetch-Site`** on every non-GET is refused unless it is
// `same-origin` or `none` (missing is accepted for older browsers
// and non-browser callers).
//
// All comparisons use `timingSafeEqual` (the launch code and the agent
// token). The session cookie also uses `timingSafeEqual` at the map
// lookup — a `Map` lookup is fine here (the attacker does not control
// the cookie space they are probing), but the belt-and-braces holds.
//
// Nothing in this file logs a token, a cookie value or a launch code.
// The logger's field allowlist (see `logger.ts`) makes this a static
// property of the daemon, not just a coding convention.

import { randomBytes, timingSafeEqual } from "node:crypto";

/** A cryptographically random 256-bit token as base64url without
 * padding. Used for the launch code, the session cookie and the agent
 * token, so all three have the same length and character class and a
 * grep for one shape catches all three. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time equality for two strings of the same character class.
 * Different lengths return false without a comparison — the length is
 * public (the token space is fixed at 32 bytes). */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** How long a launch code is valid. ADR-0013 says "single-use launch
 * code (256-bit, valid 2 min)"; we run tighter at 60 s so a code
 * scrolled into a copy buffer expires between paste and click. */
export const LAUNCH_CODE_TTL_MS = 60_000;

/** The session cookie name. Prefixed with `revkit_` and the port so a
 * daemon on another port does not clash in the browser's cookie jar. */
export function cookieName(port: number): string {
  return `revkit_session_${port}`;
}

/** Encode a Set-Cookie value with the ADR-0013 flags: HttpOnly,
 * SameSite=Strict, Path=/. Not `Secure` — the daemon serves http://
 * (loopback only) so `Secure` would prevent the browser from
 * accepting the cookie. */
export function setCookieHeader(name: string, value: string): string {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Small parser for `document.cookie`-style headers. Returns the value
 * of `name` if present, else undefined. Refuses a name with `=` or `;`
 * (defensive; the caller passes a constant). */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  if (name.includes("=") || name.includes(";")) return undefined;
  for (const raw of header.split(";")) {
    const trimmed = raw.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/** Monotonic clock injected so tests can pin time. Wall clock by
 * default. Value is a millisecond epoch (`Date.now()`), not an ISO
 * string — expiry math is easier in ms. */
export type MsClock = () => number;

const wallMs: MsClock = () => Date.now();

/** One outstanding launch code — the value + when it was minted +
 * whether it has been spent. `AuthState` keeps a small set of
 * these so an agent that mints extra codes via `/-/launch-code`
 * does not race against the startup one. */
interface OutstandingCode {
  readonly value: string;
  readonly createdAtMs: number;
  used: boolean;
}

/** State the guards keep across requests. One instance per running
 * daemon; scoped to that daemon's lifetime. */
export class AuthState {
  readonly #agentToken: string;
  readonly #codes: OutstandingCode[] = [];
  readonly #sessions = new Set<string>();
  readonly #clock: MsClock;
  readonly #ttlMs: number;

  constructor(options: { readonly agentToken: string; readonly launchCode: string; readonly clock?: MsClock; readonly launchCodeTtlMs?: number }) {
    this.#agentToken = options.agentToken;
    this.#clock = options.clock ?? wallMs;
    this.#ttlMs = options.launchCodeTtlMs ?? LAUNCH_CODE_TTL_MS;
    this.#codes.push({ value: options.launchCode, createdAtMs: this.#clock(), used: false });
  }

  /** Mint a fresh single-use launch code with the same TTL as the
   * startup one. Used by the bearer-authenticated
   * `POST /-/launch-code` endpoint so `revkit mcp`'s `review_url`
   * tool can hand a human a fresh link even after the startup
   * code has been consumed. */
  mintLaunchCode(): { value: string; createdAtMs: number } {
    const value = mintToken();
    const record: OutstandingCode = { value, createdAtMs: this.#clock(), used: false };
    this.#codes.push(record);
    return { value, createdAtMs: record.createdAtMs };
  }

  /** Try to exchange `code` for a fresh session cookie value. Returns
   * the cookie value on success, or a rejection kind on failure.
   * Checks EVERY outstanding code (start + freshly-minted) — the
   * one that matches, if any, is consumed. */
  exchangeLaunchCode(code: string): { ok: true; cookie: string } | { ok: false; reason: "expired" | "used" | "invalid" } {
    const now = this.#clock();
    // Find a matching, non-expired, unused code.
    let matched: OutstandingCode | undefined;
    let anyMatch = false;
    for (const record of this.#codes) {
      if (safeEqual(code, record.value)) {
        anyMatch = true;
        const age = now - record.createdAtMs;
        if (age > this.#ttlMs) continue;
        if (record.used) continue;
        matched = record;
        break;
      }
    }
    if (matched === undefined) {
      // Distinguish the three failure modes for the user-visible
      // message; expired takes precedence over used (a code the
      // user just tried again after 60s should say "expired").
      if (!anyMatch) return { ok: false, reason: "invalid" };
      // Find whichever matched to classify.
      for (const record of this.#codes) {
        if (safeEqual(code, record.value)) {
          const age = now - record.createdAtMs;
          if (age > this.#ttlMs) return { ok: false, reason: "expired" };
          if (record.used) return { ok: false, reason: "used" };
        }
      }
      return { ok: false, reason: "invalid" };
    }
    matched.used = true;
    const cookie = mintToken();
    this.#sessions.add(cookie);
    return { ok: true, cookie };
  }

  /** Is `cookieValue` a live session cookie? */
  hasSession(cookieValue: string | undefined): boolean {
    if (cookieValue === undefined) return false;
    // Length check first (constant-time compare needs equal length).
    // Then a linear scan with `safeEqual`; `sessions` is small (one
    // human, one browser, a handful of tabs).
    for (const known of this.#sessions) {
      if (known.length === cookieValue.length && safeEqual(known, cookieValue)) return true;
    }
    return false;
  }

  /** Does `bearer` match the agent token? */
  isAgent(bearer: string | undefined): boolean {
    if (bearer === undefined) return false;
    return safeEqual(bearer, this.#agentToken);
  }

  /** For diagnostics — never for logging. Tests use this to assert
   * the startup launch code (the first outstanding one) has been
   * consumed. */
  launchCodeUsed(): boolean {
    return this.#codes[0]?.used === true;
  }
}

/** Extract a bearer token from an `Authorization` header, or undefined
 * if none. Accepts `Bearer <token>` case-insensitively on the scheme. */
export function bearerFromHeader(header: string | null): string | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  if (space === -1) return undefined;
  const scheme = trimmed.slice(0, space).toLowerCase();
  if (scheme !== "bearer") return undefined;
  const token = trimmed.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

/** Is the request's Host header one of the two loopback names for
 * `port`? DNS-rebinding defence: a public DNS record that resolves
 * to 127.0.0.1 cannot present a matching Host. */
export function isLoopbackHost(host: string | null, port: number): boolean {
  if (host === null) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Is the request's Origin header one of the two allowed loopback
 * origins for `port`? Applied to every non-GET request. */
export function isLoopbackOrigin(origin: string | null, port: number): boolean {
  if (origin === null) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** Reject Sec-Fetch-Site values that are neither `same-origin` nor
 * `none`. Missing header is accepted (older browsers, non-browser
 * callers) — Origin already refuses a cross-site browser POST. */
export function isSecFetchAcceptable(secFetchSite: string | null): boolean {
  if (secFetchSite === null) return true;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}
