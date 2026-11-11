// Redaction rules. Bearer tokens, revkit cookies, ?code= params,
// --code flag values, JSON credential fields.

import { describe, expect, test } from "bun:test";
import { redactAll, redactLine } from "../../src/dogfood/redact.ts";

describe("redactLine", () => {
  test("bearer token", () => {
    expect(redactLine("Authorization: Bearer abc.def-ghi_0123456789")).toEqual(
      "Authorization: Bearer <redacted>",
    );
  });
  test("revkit-N cookie", () => {
    expect(redactLine("cookie: revkit-42=xyz-abc-123")).toEqual("cookie: revkit-42=<redacted>");
  });
  test("?code= on a launch URL", () => {
    expect(redactLine("visiting http://x/launch?code=abcdef&next=/")).toEqual(
      "visiting http://x/launch?code=<redacted>&next=/",
    );
  });
  test("--code flag value", () => {
    expect(redactLine("revkit --code abcdef123 continue")).toEqual("revkit --code <redacted> continue");
    expect(redactLine("--code=abc.def")).toEqual("--code=<redacted>");
  });
  test("JSON credential fields", () => {
    const raw = '{"agentToken":"aaa","launchUrl":"http://x/l?code=x","other":"y"}';
    const clean = redactLine(raw);
    expect(clean).toContain('"agentToken":"<redacted>"');
    expect(clean).toContain('"launchUrl":"<redacted>');
  });
});

describe("redactAll", () => {
  test("splits into lines and redacts each", () => {
    const raw = "Bearer AAAAAAAA\nrevkit-1=BBBBBBBB";
    const clean = redactAll(raw);
    expect(clean).toEqual("Bearer <redacted>\nrevkit-1=<redacted>");
  });
});
