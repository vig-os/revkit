// Logger tests — every emitted line is one JSON object with a fixed
// field set; comment bodies, tokens and cookies can never appear in a
// record. The `LOG_FIELD_KEYS` allowlist is the source of truth; the
// test enumerates it and asserts on shape (not on any specific field
// name, so a new field is added by editing `logger.ts` and this test
// still passes).

import { describe, expect, test } from "bun:test";
import {
  LOG_FIELD_KEYS,
  makeLogger,
  type LineSink,
  type LogFields,
} from "../../src/serve/logger.ts";

function bufferedSink(): { sink: LineSink; lines: string[] } {
  const lines: string[] = [];
  return {
    sink: {
      write(line: string): void {
        lines.push(line);
      },
    },
    lines,
  };
}

describe("logger", () => {
  test("emits one JSON object per line with a ts and level", () => {
    const { sink, lines } = bufferedSink();
    const log = makeLogger({ sink, clock: () => "2026-09-30T00:00:00.000Z" });
    log.info("serve.start", { pid: 1234, port: 40000, version: "0.0.0" });
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.ts).toBe("2026-09-30T00:00:00.000Z");
    expect(record.level).toBe("info");
    expect(record.event).toBe("serve.start");
    expect(record.pid).toBe(1234);
  });

  test("ignores fields not on the allowlist (defence against a caller cast to any)", () => {
    const { sink, lines } = bufferedSink();
    const log = makeLogger({ sink });
    // Cast to `any` and inject a forbidden field.
    (log.info as (event: string, fields: unknown) => void)("api.append.ok", {
      seq: 42,
      body: "this is a comment body that must never appear in a log line",
      agentToken: "TOKEN",
      cookie: "SESSION",
    });
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.seq).toBe(42);
    expect(record.body).toBeUndefined();
    expect(record.agentToken).toBeUndefined();
    expect(record.cookie).toBeUndefined();
    // The forbidden strings do not appear anywhere in the raw line
    // either — belt and braces.
    expect(lines[0]).not.toContain("comment body");
    expect(lines[0]).not.toContain("TOKEN");
    expect(lines[0]).not.toContain("SESSION");
  });

  test("LOG_FIELD_KEYS matches the typed field set", () => {
    // A quick smoke that the exported list has the fields tests and
    // callers rely on. Not tautological — a rename that drops a field
    // fails this test.
    for (const key of ["requestId", "method", "path", "status", "seq", "threadId", "commentId"]) {
      expect(LOG_FIELD_KEYS).toContain(key);
    }
  });

  test("emits warn and error at their levels", () => {
    const { sink, lines } = bufferedSink();
    const log = makeLogger({ sink });
    log.warn("request.rejected.host", { host: "evil.example" });
    log.error("request.error", { errorKind: "TypeError" });
    const w = JSON.parse(lines[0] ?? "{}");
    const e = JSON.parse(lines[1] ?? "{}");
    expect(w.level).toBe("warn");
    expect(e.level).toBe("error");
    expect(w.host).toBe("evil.example");
    expect(e.errorKind).toBe("TypeError");
  });
});

// A quick guard that the typed `LogFields` type still lets a caller
// pass all the documented fields (compile-time; the test exists to
// fail typecheck if the interface loses a field).
const _fields: LogFields = {
  requestId: "r",
  method: "GET",
  path: "/",
  status: 200,
};
void _fields;
