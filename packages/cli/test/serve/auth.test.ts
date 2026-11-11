// Auth guards — launch-code exchange (single-use, TTL), session cookie
// bookkeeping and the Host / Origin / Sec-Fetch-Site helpers. Time is
// injected so the TTL test is deterministic; nothing here reaches the
// wall clock.

import { describe, expect, test } from "bun:test";
import {
  AuthState,
  bearerFromHeader,
  cookieName,
  isLoopbackHost,
  isLoopbackOrigin,
  isSecFetchAcceptable,
  mintToken,
  readCookie,
  safeEqual,
  setCookieHeader,
} from "../../src/serve/auth.ts";

describe("mintToken / safeEqual", () => {
  test("mintToken produces distinct 43-char base64url tokens", () => {
    const a = mintToken();
    const b = mintToken();
    // 32 bytes → 43 chars base64url (no padding).
    expect(a.length).toBe(43);
    expect(b.length).toBe(43);
    expect(a).not.toBe(b);
    // The character class is base64url — [A-Za-z0-9_-].
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("safeEqual is true only on identical strings", () => {
    const a = mintToken();
    expect(safeEqual(a, a)).toBe(true);
    expect(safeEqual(a, mintToken())).toBe(false);
    expect(safeEqual("short", "longer-string")).toBe(false);
  });
});

describe("bearerFromHeader", () => {
  test("parses a Bearer token, case-insensitive on scheme", () => {
    expect(bearerFromHeader("Bearer abc")).toBe("abc");
    expect(bearerFromHeader("bearer abc")).toBe("abc");
    expect(bearerFromHeader("BEARER abc")).toBe("abc");
  });
  test("returns undefined for non-bearer schemes", () => {
    expect(bearerFromHeader("Basic abc")).toBeUndefined();
    expect(bearerFromHeader(null)).toBeUndefined();
    expect(bearerFromHeader("")).toBeUndefined();
    expect(bearerFromHeader("Bearer ")).toBeUndefined();
  });
});

describe("cookie helpers", () => {
  test("setCookieHeader carries HttpOnly, SameSite=Strict, Path=/", () => {
    const header = setCookieHeader(cookieName(4321), "abc");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    // No `Secure` — daemon serves http:// on loopback.
    expect(header).not.toContain("Secure");
    expect(header.startsWith(`${cookieName(4321)}=abc;`)).toBe(true);
  });
  test("readCookie picks out the named value", () => {
    expect(readCookie("session=abc; other=def", "session")).toBe("abc");
    expect(readCookie("other=def; session=abc", "session")).toBe("abc");
    expect(readCookie("other=def", "session")).toBeUndefined();
    expect(readCookie(null, "session")).toBeUndefined();
  });
});

describe("host / origin / sec-fetch", () => {
  test("isLoopbackHost accepts 127.0.0.1:<port> and localhost:<port>", () => {
    expect(isLoopbackHost("127.0.0.1:8080", 8080)).toBe(true);
    expect(isLoopbackHost("localhost:8080", 8080)).toBe(true);
    expect(isLoopbackHost("evil.example:8080", 8080)).toBe(false);
    expect(isLoopbackHost("127.0.0.1:8081", 8080)).toBe(false);
    expect(isLoopbackHost(null, 8080)).toBe(false);
  });
  test("isLoopbackOrigin accepts the two loopback origins for the port", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:8080", 8080)).toBe(true);
    expect(isLoopbackOrigin("http://localhost:8080", 8080)).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1:8080", 8080)).toBe(false);
    expect(isLoopbackOrigin("http://evil.example", 8080)).toBe(false);
    expect(isLoopbackOrigin(null, 8080)).toBe(false);
  });
  test("isSecFetchAcceptable accepts same-origin / none / missing", () => {
    expect(isSecFetchAcceptable("same-origin")).toBe(true);
    expect(isSecFetchAcceptable("none")).toBe(true);
    expect(isSecFetchAcceptable(null)).toBe(true);
    expect(isSecFetchAcceptable("cross-site")).toBe(false);
    expect(isSecFetchAcceptable("same-site")).toBe(false);
  });
});

describe("AuthState launch-code exchange", () => {
  const opts = () => ({ agentToken: "agent-tok", launchCode: "launch-tok", clock: mockClock(0) });

  test("first exchange mints a session cookie; the code is then used", () => {
    const state = new AuthState(opts());
    const outcome = state.exchangeLaunchCode("launch-tok");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.cookie.length).toBe(43);
    expect(state.launchCodeUsed()).toBe(true);
  });

  test("second exchange is refused with reason 'used'", () => {
    const state = new AuthState(opts());
    state.exchangeLaunchCode("launch-tok");
    const second = state.exchangeLaunchCode("launch-tok");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("used");
  });

  test("a wrong code is refused with reason 'invalid'", () => {
    const state = new AuthState(opts());
    const outcome = state.exchangeLaunchCode("wrong");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid");
    expect(state.launchCodeUsed()).toBe(false);
  });

  test("an expired code is refused with reason 'expired'", () => {
    let now = 0;
    const clock = (): number => now;
    const state = new AuthState({
      agentToken: "agent-tok",
      launchCode: "launch-tok",
      clock,
      launchCodeTtlMs: 100,
    });
    now = 200; // past TTL
    const outcome = state.exchangeLaunchCode("launch-tok");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("expired");
  });

  test("hasSession recognises a minted cookie and refuses a foreign one", () => {
    const state = new AuthState(opts());
    const outcome = state.exchangeLaunchCode("launch-tok");
    if (!outcome.ok) throw new Error("setup failed");
    expect(state.hasSession(outcome.cookie)).toBe(true);
    expect(state.hasSession(mintToken())).toBe(false);
    expect(state.hasSession(undefined)).toBe(false);
  });

  test("isAgent constant-time-matches the agent token", () => {
    const state = new AuthState(opts());
    expect(state.isAgent("agent-tok")).toBe(true);
    expect(state.isAgent("nope")).toBe(false);
    expect(state.isAgent(undefined)).toBe(false);
  });
});

function mockClock(value: number): () => number {
  return () => value;
}
