// ADR-0020 + ADR-0015 logging: A23, A24.
//
// The redaction test is the load-bearing one. "We do not log comment
// bodies" is a claim every code review has to re-verify by eye, and it is
// exactly the kind of claim that survives until the first incident. So the
// logger is built so a caller CANNOT log a credential without the redactor
// seeing it, and this file proves the redactor on a value of every
// sensitive shape the ADR names — including one under a key that looks
// innocent, which is how a leak actually happens.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, REDACTED, newRequestId, type Logger } from "../src/logger.ts";
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
    bound.log("info", "one");
    bound.log("error", "two");
    expect(lines.map((line) => parse(line)["requestId"])).toEqual(["req-2", "req-2"]);
  });

  test("A23: a line is a single line — no embedded newline can forge a record", () => {
    const { logger, lines } = captureLogger("req-3");
    logger.log("info", "a\n{\"level\":\"error\",\"msg\":\"forged\"}");
    expect(lines).toHaveLength(1);
    expect(parse(lines[0] as string)["msg"]).toBe('a\n{"level":"error","msg":"forged"}');
  });

  test("a throwing sink never takes down the caller", () => {
    const logger = createLogger({
      sink: () => {
        throw new Error("log pipeline down");
      },
      clock: () => "2026-10-03T12:00:00Z",
    });
    // A logger that throws turns a diagnostic into a 500. This must not.
    expect(() => logger.log("error", "boom")).not.toThrow();
  });

  test("a cyclic field is truncated, not hung", () => {
    const { logger, lines } = captureLogger("req-4");
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    logger.log("info", "cyclic", { cyclic });
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

  // ── A24 ───────────────────────────────────────────────────────────────
  test("A24: a comment body, an email, a GitHub token and a cookie all get redacted", () => {
    const { logger, lines } = captureLogger("req-5");
    logger.log("info", "redaction fixture", {
      body: "the reviewer wrote: this line is wrong because…",
      commentBody: "and here is a second one",
      email: "reviewer@example.com",
      displayName: "Reviewer Name",
      authorization: FAKE_BEARER,
      cookie: "revkit_session=opaque-value; revkit_launch=another",
      token: FAKE_GITHUB_TOKEN,
      nested: { secret: "hunter2", quote: "the exact text the anchor quoted" },
      arrayOfEmails: ["a@example.com", "b@example.com"],
    });
    const line = lines[0] as string;

    // Not one of the fixtures may appear anywhere in the line.
    for (const forbidden of [
      "this line is wrong because",
      "and here is a second one",
      "reviewer@example.com",
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
    logger.log("info", "innocent key", {
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

  test("A24: a token pasted into the MESSAGE is redacted too", () => {
    const { logger, lines } = captureLogger("req-7");
    logger.log("error", `retry failed with ${FAKE_FINE_GRAINED_TOKEN}`);
    expect(lines[0]).not.toContain(FAKE_FINE_GRAINED_TOKEN);
  });

  test("A24: identities are opaque ids, and a redacted value leaks no length", () => {
    const { logger, lines } = captureLogger("req-8");
    logger.log("info", "identity", { identityId: "01HZY7QK3M9", email: "someone@example.com" });
    const line = lines[0] as string;
    // The opaque id survives — it is the field ADR-0020 wants.
    expect(parse(line)["identityId"]).toBe("01HZY7QK3M9");
    // The email does not, and the replacement does not encode its length.
    expect(line).not.toContain("someone@example.com");
    expect(line).not.toContain("21");
  });

  test("A24: benign diagnostics are NOT redacted — a redactor that eats everything is useless", () => {
    const { logger, lines } = captureLogger("req-9");
    logger.log("info", "benign", { method: "GET", path: "/api/threads", status: 200, durationMs: 3 });
    const record = parse(lines[0] as string);
    expect(record["method"]).toBe("GET");
    expect(record["path"]).toBe("/api/threads");
    expect(record["status"]).toBe(200);
    expect(record["durationMs"]).toBe(3);
  });

  test("newRequestId returns a distinct UUID each call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the Worker's own log lines (end to end)", () => {
  let harness: Harness;
  /** miniflare's own `Response` type, not the DOM one — the two
   * declarations disagree (`textStream` exists on one and not the other),
   * and pinning the harness to one of them is what keeps that
   * disagreement out of every call site. */
  type DispatchResult = Awaited<ReturnType<Harness["dispatch"]>>;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  /** Capture what the Worker wrote while `run` executes. miniflare
   * forwards workerd's `console.log` to the host console, so the swap is
   * enough — and it is the real logger, not a stand-in. */
  async function captureWorkerLog(
    run: () => Promise<DispatchResult>,
  ): Promise<{ response: DispatchResult; lines: string[] }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      return { response: await run(), lines };
    } finally {
      console.log = original;
    }
  }

  test("A23: the requestId in the log is the same one in the response header", async () => {
    const { response, lines } = await captureWorkerLog(() =>
      harness.dispatch("http://localhost/api/threads"),
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
  });

  test("A24: no real Worker log line carries a comment body or a credential", async () => {
    const { response, lines } = await captureWorkerLog(() =>
      harness.dispatch("http://localhost/api/threads?since=abc"),
    );
    expect(response.status).toBe(400);
    for (const line of lines) {
      expect(line).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
      expect(line).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(line).not.toMatch(/(?:^|[^A-Za-z])cookie/i);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("the 501 branch logs that append is disabled, so the gap is visible in production logs", async () => {
    const { response, lines } = await captureWorkerLog(() =>
      harness.dispatch("http://localhost/api/threads", { method: "POST" }),
    );
    expect(response.status).toBe(501);
    expect(lines.map(parse).map((record) => record["msg"])).toContain("api.threads.append.disabled");
  });
});
