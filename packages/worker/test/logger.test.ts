// ADR-0020 + ADR-0015 logging: A23, A24.
//
// The redaction test is the load-bearing one. "We do not log comment
// bodies" is a claim every code review has to re-verify by eye, and it is
// exactly the kind of claim that survives until the first incident. So the
// logger is built so a caller CANNOT log a credential without the redactor
// seeing it, and this file proves the redactor on a value of every
// sensitive shape the ADRs name — including under an INNOCENT key, which is
// how a leak actually happens.
//
// The negative cases here are not hypothetical. Every one of them was
// MEASURED leaking through an earlier version of `logger.ts`, in which
// `SENSITIVE_KEY` was key-name-driven and the value pass matched three
// credential shapes. That version's tests were green.
//
// `src/logger.ts`'s header states exactly what is and is not enforced. The
// test that matters for the boundary is "a free-form `note` is NOT
// detected" — it pins the limitation instead of hiding it.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createLogger,
  INVALID_MESSAGE,
  LOG_MESSAGES,
  REDACTED,
  newRequestId,
  type LogMessage,
  type Logger,
} from "../src/logger.ts";
import { startWorker, type Harness } from "./harness.ts";

/** Credential-SHAPED fixtures, assembled from parts.
 *
 * These are obviously fake, but a literal `ghp_<36 chars>` written into a
 * test file is a real secret to `gitleaks` (ADR-0014's pre-commit gate)
 * and to the next person who greps for leaked tokens. Splitting the prefix
 * off keeps the static text free of any secret shape while the RUNTIME
 * value is byte-for-byte the shape the redactor has to catch — which is
 * the thing under test. */
const FAKE_GITHUB_TOKEN = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
const FAKE_FINE_GRAINED_TOKEN = ["github_pat", "11ABCDEFG0abcdefghijklmnop"].join("_");
const FAKE_BEARER = `Bearer ${"a".repeat(30)}`;
const FAKE_OPENAI_KEY = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");

/** A reviewer address, assembled so no static grep for an address matches
 * this file. */
const REVIEWER_EMAIL = ["reviewer", "example.com"].join("@");
const NESTED_EMAIL = ["someone", "example.com"].join("@");

/** A logger over an array, so a test can assert on exactly what was
 * written rather than on stdout. */
function captureLogger(requestId?: string): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  let tick = 0;
  const logger = createLogger({
    sink: (line) => lines.push(line),
    clock: () => `2026-10-03T12:00:${String(tick++).padStart(2, "0")}Z`,
    ...(requestId === undefined ? {} : { requestId }),
  });
  return { logger, lines };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("structured logger", () => {
  // ── A23 ───────────────────────────────────────────────────────────────
  test("A23: every line is one JSON object with level, msg, ts and requestId", () => {
    const { logger, lines } = captureLogger("req-1");
    logger.log("info", "request.start", { method: "GET", path: "/healthz" });
    expect(lines).toHaveLength(1);
    const record = parse(lines[0] as string);
    expect(record["level"]).toBe("info");
    expect(record["msg"]).toBe("request.start");
    expect(record["requestId"]).toBe("req-1");
    expect(record["ts"]).toBe("2026-10-03T12:00:00Z");
    expect(record["method"]).toBe("GET");
    expect(record["path"]).toBe("/healthz");
  });

  test("A23: withRequestId stamps the id on EVERY subsequent line", () => {
    const { logger, lines } = captureLogger();
    const bound = logger.withRequestId("req-2");
    bound.log("info", "request.start");
    bound.log("error", "request.error");
    expect(lines.map((line) => parse(line)["requestId"])).toEqual(["req-2", "req-2"]);
  });

  test("every message the Worker uses is in the closed vocabulary", () => {
    // The union in `logger.ts` and this list must not drift: a new event
    // name added to the logger but not here, or here but not there, means
    // one of the two is wrong.
    expect([...LOG_MESSAGES].sort()).toEqual([
      "api.threads.append.disabled",
      "api.threads.read.disabled",
      "request.end",
      "request.error",
      "request.start",
    ]);
  });

  test("a throwing sink never takes down the caller", () => {
    const logger = createLogger({
      sink: () => {
        throw new Error("log pipeline down");
      },
      clock: () => "2026-10-03T12:00:00Z",
    });
    // A logger that throws turns a diagnostic into a 500. This must not.
    expect(() => logger.log("error", "request.error")).not.toThrow();
  });

  test("a cyclic field is truncated, not hung", () => {
    const { logger, lines } = captureLogger("req-4");
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    logger.log("info", "request.start", { cyclic });
    expect(lines).toHaveLength(1);
    const field = parse(lines[0] as string)["cyclic"] as Record<string, unknown>;
    // The first level keeps its useful data; the recursion terminates at
    // the depth bound rather than following `self` forever, which is the
    // whole point — a log line that costs the request its response is a
    // worse bug than a truncated field.
    expect(field["name"]).toBe("loop");
    expect(JSON.stringify(field)).toContain(REDACTED);
    // Bounded, not exponential: six levels of the same two-key object.
    expect((JSON.stringify(field).match(/loop/g) ?? []).length).toBeLessThanOrEqual(6);
  });

  // ── mechanism 1: the message is a closed vocabulary ───────────────────
  test("a free-form sentence is refused as a message, not logged", () => {
    // The comment-body case, and the one no regex can catch. Cast because
    // TypeScript already forbids it — which is the point: the cast is what
    // a JavaScript caller would do implicitly.
    const { logger, lines } = captureLogger("req-msg");
    logger.log("info", "the reviewer wrote: this cap is 30 s but wrong" as LogMessage);
    const record = parse(lines[0] as string);
    expect(record["msg"]).toBe(INVALID_MESSAGE);
    expect(lines[0]).not.toContain("this cap is 30 s");
    // The refusal is visible rather than silent, so a future author who
    // forgot to register an event name can diagnose it from the log.
    expect(lines[0]).toContain(INVALID_MESSAGE);
  });

  test("a WELL-FORMED name that is not a real event is still refused", () => {
    // The gap the #76 round-2 review found: the guard used to check only
    // the `a.b.c` SHAPE, so a dot-separated sentence passed. Measured
    // through the real logger before the fix:
    //   not.a.real.event.name        -> logged verbatim
    //   because.the.reviewer.said.so -> logged verbatim
    const shaped: [string, string][] = [
      ["not.a.real.event.name", "not.a.real.event.name"],
      ["because.the.reviewer.said.so", "because.the.reviewer.said.so"],
      // The realistic future bug: an INTERPOLATED name. It is a `string` at
      // the call site, so TypeScript cannot help, and the shipped bundle is
      // JavaScript — so only a membership check can catch it.
      ["api.threads.comment.disabled", "api.threads.comment.disabled"],
    ];
    for (const [candidate, forbidden] of shaped) {
      const { logger, lines } = captureLogger("req-shape");
      logger.log("info", candidate as LogMessage);
      expect(parse(lines[0] as string)["msg"]).toBe(INVALID_MESSAGE);
      expect(lines[0]).not.toContain(forbidden);
    }
  });

  test("every name the Worker logs at runtime is in the vocabulary", () => {
    // A call-site scan, so a new `logger.log(...)` with a name that is not
    // registered fails here rather than being silently rewritten to
    // `invalid.log.message` in production. Same shape as the allowlist
    // import scan in `headers.test.ts`.
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const used = [...source.matchAll(/logger\.log\(\s*"[^"]*"\s*,\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(LOG_MESSAGES as readonly string[], `${name} is logged but not in LOG_MESSAGES`).toContain(name);
    }
  });

  test("an email inside a refused message does not survive either", () => {
    const { logger, lines } = captureLogger("req-msg2");
    logger.log("info", `contacting ${REVIEWER_EMAIL} about the thread` as LogMessage);
    expect(lines[0]).not.toContain(REVIEWER_EMAIL);
    expect(parse(lines[0] as string)["msg"]).toBe(INVALID_MESSAGE);
  });

  test("a credential inside an event-shaped message is still redacted", () => {
    // The value pass runs on `msg` too, so bypassing the name check with a
    // dotted string is not a way through.
    const { logger, lines } = captureLogger("req-msg3");
    logger.log("error", `retry.failed.${FAKE_GITHUB_TOKEN}` as LogMessage);
    expect(lines[0]).not.toContain(FAKE_GITHUB_TOKEN);
  });

  // ── A24 ───────────────────────────────────────────────────────────────
  test("A24: a comment body, an email, a GitHub token and a cookie all get redacted", () => {
    const { logger, lines } = captureLogger("req-5");
    logger.log("info", "request.start", {
      body: "the reviewer wrote: this line is wrong because…",
      commentBody: "and here is a second one",
      email: REVIEWER_EMAIL,
      displayName: "Reviewer Name",
      authorization: FAKE_BEARER,
      cookie: "revkit_session=opaque-value; revkit_launch=another",
      token: FAKE_GITHUB_TOKEN,
      nested: { secret: "hunter2", quote: "the exact text the anchor quoted" },
      arrayOfEmails: [`a@example.com`, `b@example.com`],
    });
    const line = lines[0] as string;

    for (const forbidden of [
      "this line is wrong because",
      "and here is a second one",
      REVIEWER_EMAIL,
      "Reviewer Name",
      "a".repeat(30),
      "revkit_session",
      FAKE_GITHUB_TOKEN,
      "hunter2",
      "the exact text the anchor quoted",
      "a@example.com",
      "b@example.com",
    ]) {
      expect(line).not.toContain(forbidden);
    }
    expect(line).toContain(REDACTED);
  });

  test("A24: a token-shaped VALUE is redacted even under an innocent key", () => {
    const { logger, lines } = captureLogger("req-6");
    logger.log("info", "request.start", {
      // Nothing about this key says "credential" — which is precisely how
      // a leak gets shipped. The value-shape rule is what catches it.
      diagnostic: `Bearer ${FAKE_GITHUB_TOKEN}`,
      count: 42,
      enabled: true,
    });
    const record = parse(lines[0] as string);
    expect(record["diagnostic"]).toBe(REDACTED);
    expect(record["count"]).toBe(42);
    expect(record["enabled"]).toBe(true);
  });

  test("A24: an openai-shaped key is redacted under an innocent key", () => {
    const { logger, lines } = captureLogger("req-sk");
    logger.log("info", "request.start", { upstream: FAKE_OPENAI_KEY });
    expect(lines[0]).not.toContain(FAKE_OPENAI_KEY);
    expect(parse(lines[0] as string)["upstream"]).toBe(REDACTED);
  });

  test("A24: a cookie under a PLURAL or compound key is redacted", () => {
    // `cookies` and `cookieJar` both leaked: the key pattern required a
    // non-letter on each side of `cookie`, so a trailing letter excluded
    // them, and the value-shape pass does not match `s=1`. Under a plural
    // key that is a session credential in a log line, which is exactly what
    // ADR-0012 forbids.
    const { logger, lines } = captureLogger("req-cookie");
    logger.log("info", "request.start", {
      Cookie: "a=b",
      "set-cookie": "a=b",
      cookies: "s=1",
      cookieJar: "s=1",
      COOKIE: "s=1",
    });
    const line = lines[0] as string;
    for (const leaked of ["a=b", "s=1"]) {
      expect(line).not.toContain(leaked);
    }
    const record = parse(line);
    expect(record["cookies"]).toBe(REDACTED);
    expect(record["cookieJar"]).toBe(REDACTED);
    expect(record["Cookie"]).toBe(REDACTED);
  });

  test("A24: a guest display name is redacted under every spelling", () => {
    // ADR-0015's exact datum. A bare `name` is deliberately NOT redacted —
    // it would also catch `filename` and `name` on unrelated records — so
    // these three are the spellings a guest's name realistically arrives
    // under, and `name` alone is a declared gap, not an oversight.
    const { logger, lines } = captureLogger("req-guest");
    logger.log("info", "request.start", {
      guestName: "Ada Lovelace",
      fullName: "Ada Lovelace",
      full_name: "Ada Lovelace",
      // An opaque id must still survive: that is the field ADR-0020 wants.
      guestId: "01HZY7QK3M9",
    });
    const line = lines[0] as string;
    expect(line).not.toContain("Ada Lovelace");
    expect(parse(line)["guestId"]).toBe("01HZY7QK3M9");
  });

  test("A24: an address under an INNOCENT key is redacted, nested and arrayed", () => {
    // Measured leaks through the earlier version: `actor` holding an
    // address, an address nested under `meta.contact`, and two addresses
    // in an array under `items`. `actor` is a legitimate key that must
    // survive when it holds an opaque id, so the VALUE pass is the only
    // thing that can catch it.
    const { logger, lines } = captureLogger("req-addr");
    logger.log("info", "request.start", {
      actor: REVIEWER_EMAIL,
      meta: { contact: NESTED_EMAIL },
      items: ["a@example.com", "b@example.com"],
    });
    const line = lines[0] as string;
    for (const address of [REVIEWER_EMAIL, NESTED_EMAIL, "a@example.com", "b@example.com"]) {
      expect(line).not.toContain(address);
    }
    const record = parse(line);
    expect(record["actor"]).toBe(REDACTED);
    expect((record["meta"] as Record<string, unknown>)["contact"]).toBe(REDACTED);
    expect(record["items"]).toEqual([REDACTED, REDACTED]);
  });

  test("A24: a session identifier is redacted — it is the bearer credential", () => {
    // ADR-0012 makes the session cookie the credential for a hosted
    // request, and `sessions.id` is the schema's own identifier for it, so
    // a session id in a log line is a credential in a log line.
    const { logger, lines } = captureLogger("req-sess");
    logger.log("info", "request.start", {
      sessionId: "abc",
      session_id: "def",
      sid: "ghi",
      session: "jkl",
      // An OPAQUE identity id must still survive — that is the field
      // ADR-0020 wants.
      identityId: "01HZY7QK3M9",
    });
    const line = lines[0] as string;
    for (const leaked of ["abc", "def", "ghi", "jkl"]) {
      expect(line).not.toContain(`"${leaked}"`);
    }
    expect(parse(line)["identityId"]).toBe("01HZY7QK3M9");
  });

  test("A24: identities are opaque ids, and a redacted value leaks no length", () => {
    const { logger, lines } = captureLogger("req-8");
    logger.log("info", "request.start", { identityId: "01HZY7QK3M9", email: NESTED_EMAIL });
    const line = lines[0] as string;
    // The opaque id survives — it is the field ADR-0020 wants.
    expect(parse(line)["identityId"]).toBe("01HZY7QK3M9");
    // The email does not, and the replacement is a constant rather than
    // something that encodes how long the redacted value was.
    expect(line).not.toContain(NESTED_EMAIL);
    expect(parse(line)["email"]).toBe(REDACTED);
  });

  test("A24: a fine-grained PAT is redacted even in the field set", () => {
    const { logger, lines } = captureLogger("req-pat");
    logger.log("error", "request.error", { diagnostic: FAKE_FINE_GRAINED_TOKEN });
    expect(lines[0]).not.toContain(FAKE_FINE_GRAINED_TOKEN);
  });

  test("A24: benign diagnostics are NOT redacted — a redactor that eats everything is useless", () => {
    const { logger, lines } = captureLogger("req-9");
    logger.log("info", "request.start", {
      method: "GET",
      path: "/api/threads",
      status: 200,
      durationMs: 3,
      // A GitHub login is an opaque identity, not personal data — ADR-0020
      // says identities as opaque ids, and the daemon logs logins today.
      actor: "gerchowl",
    });
    const record = parse(lines[0] as string);
    expect(record["method"]).toBe("GET");
    expect(record["path"]).toBe("/api/threads");
    expect(record["status"]).toBe(200);
    expect(record["durationMs"]).toBe(3);
    expect(record["actor"]).toBe("gerchowl");
  });

  // ── the documented limitation, pinned ─────────────────────────────────
  test("LIMITATION: free-form prose under an unrecognised key is NOT detected", () => {
    // This test exists so the limitation in `logger.ts`'s header cannot be
    // quietly deleted. The control for it is the CALLER RULE (review
    // content is never passed as a log field) plus the closed `msg`
    // vocabulary — not the redactor.
    const { logger, lines } = captureLogger("req-limit");
    logger.log("info", "request.start", { arbitraryKey: "free-form prose that is not an address or a credential" });
    expect(lines[0]).toContain("free-form prose");
    // The keys that DO carry review content are all in `SENSITIVE_KEY`.
    for (const key of [
      "body",
      "comment",
      "text",
      "content",
      "message",
      "quote",
      "note",
      "detail",
      "excerpt",
      "cookies",
      "cookieJar",
      "guestName",
      "fullName",
    ]) {
      logger.log("info", "request.start", { [key]: "reviewer prose" });
      expect(lines[lines.length - 1]).not.toContain("reviewer prose");
    }
  });

  test("newRequestId returns a distinct UUID each call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the Worker's own log lines (end to end)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  /** miniflare's own `Response` type, not the DOM one — the two
   * declarations disagree (`textStream` exists on one and not the other),
   * and pinning the harness to one of them is what keeps that
   * disagreement out of every call site. */
  type DispatchResult = Awaited<ReturnType<Harness["dispatch"]>>;

  /** Capture what the Worker wrote while `run` executes, then WAIT for
   * miniflare to finish forwarding.
   *
   * **The drain is load-bearing, not decoration.** miniflare forwards
   * workerd's `console.log` over its own wire, so the log lines arrive on
   * the HOST some time after the response resolves. Restoring
   * `console.log` the instant `dispatchFetch` returns therefore truncates
   * the capture at an unpredictable point, and `request.end` — logged in a
   * `finally` with no `await` between it and the response — is usually
   * still in flight. That was observed on CI as
   * `Expected to contain: "request.end"` while the same test passed
   * locally, and an earlier local "fix" that swapped the route for one with
   * a database round trip only worked while the handler still had one.
   *
   * So: poll until the expected count arrives or a bounded budget expires.
   * The assertion is NOT weakened — both lines are still required, with the
   * same request id — and a line that never arrives still fails, just after
   * a second instead of immediately. */
  async function captureWorkerLog(
    run: () => Promise<DispatchResult>,
    options: { readonly expectLines?: number; readonly drainMs?: number } = {},
  ): Promise<{ response: DispatchResult; lines: string[] }> {
    const lines: string[] = [];
    const want = options.expectLines ?? 1;
    const budgetMs = options.drainMs ?? 2_000;
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const response = await run();
      const deadline = Date.now() + budgetMs;
      while (lines.length < want && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { response, lines };
    } finally {
      console.log = original;
    }
  }

  test("A23: the requestId in the log is the same one in the response header", async () => {
    // `/api/threads`, not `/healthz`: the 501 branch emits a third line
    // (`api.threads.read.disabled`) between the pair, so this capture also
    // shows the closed state. Two lines are expected and waited for.
    const { response, lines } = await captureWorkerLog(
      () => harness.dispatch("http://localhost/api/threads"),
      { expectLines: 3 },
    );
    const headerId = response.headers.get("x-revkit-request-id");
    expect(headerId).toMatch(/^[0-9a-f-]{36}$/);
    const records = lines.map(parse);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record["requestId"]).toBe(headerId);
    }
    expect(records.map((record) => record["msg"])).toContain("request.start");
    expect(records.map((record) => record["msg"])).toContain("request.end");
    expect(records.map((record) => record["msg"])).toContain("api.threads.read.disabled");
  });

  test("A24: no real Worker log line carries a comment body or a credential", async () => {
    const { lines } = await captureWorkerLog(() => harness.dispatch("http://localhost/nope"), {
      expectLines: 2,
    });
    for (const line of lines) {
      expect(line).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
      expect(line).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(line).not.toMatch(/(?:^|[^A-Za-z])cookie/i);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("the 501 branch logs that the READ is disabled, so the closed state is visible in production logs", async () => {
    const { response, lines } = await captureWorkerLog(
      () => harness.dispatch("http://localhost/api/threads"),
      { expectLines: 3 },
    );
    expect(response.status).toBe(501);
    expect(lines.map(parse).map((record) => record["msg"])).toContain("api.threads.read.disabled");
  });
});
