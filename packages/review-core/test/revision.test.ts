// Tests for revisionOf — SHA-256 of the LF-normalised source (ADR-0006
// Acceptance). The whole point of LF-normalising is that a Windows
// checkout and a Unix checkout of the same content produce the SAME
// revision id; the tests pin this to a KNOWN hash so a regression in the
// normaliser trips loudly (an assertion that only compared two calls to
// each other would pass any consistent-but-wrong implementation).
import { describe, expect, test } from "bun:test";
import { revisionOf } from "../src/index.ts";

// Known SHA-256 of the ASCII string "hello\nworld\n" (12 bytes). Verified
// externally with `printf 'hello\nworld\n' | sha256sum`. Any drift in the
// normaliser or the encoding trips this assertion; a self-consistency
// check would not.
const KNOWN_FIXTURE_LF = "hello\nworld\n";
const KNOWN_FIXTURE_HASH = "4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92";

describe("revisionOf — fixture", () => {
  test("hashes the fixed ASCII input to a stable, externally-verified SHA-256", async () => {
    const digest = await revisionOf(KNOWN_FIXTURE_LF);
    expect(digest).toBe(KNOWN_FIXTURE_HASH);
  });

  test("returns 64 lowercase hex characters (the anchor schema's revision format)", async () => {
    const digest = await revisionOf("anything");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("revisionOf — LF normalisation", () => {
  test("CRLF and LF forms of the same content produce the same hash", async () => {
    const lf = "line one\nline two\nline three\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(await revisionOf(crlf)).toBe(await revisionOf(lf));
  });

  test("lone CR (`\\r`) is also normalised to LF", async () => {
    const lf = "old-mac\nline\n";
    const cr = "old-mac\rline\n";
    expect(await revisionOf(cr)).toBe(await revisionOf(lf));
  });

  test("the normalised output matches the known fixture when fed CRLF", async () => {
    const crlf = "hello\r\nworld\r\n";
    expect(await revisionOf(crlf)).toBe(KNOWN_FIXTURE_HASH);
  });

  test("distinct content produces a distinct hash", async () => {
    const a = await revisionOf("alpha\n");
    const b = await revisionOf("beta\n");
    expect(a).not.toBe(b);
  });
});
