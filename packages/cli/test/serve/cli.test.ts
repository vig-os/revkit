// CLI-glue tests for `revkit serve`: argv parsing and the persistent
// local-user id. The `runServeCommand` full path (start → block →
// stop) is covered by the integration suite via `startDaemon`; this
// file keeps the pure functions honest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServeArgs, readOrMintLocalUserId } from "../../src/serve/cli.ts";

describe("parseServeArgs", () => {
  test("accepts an empty argv", () => {
    const outcome = parseServeArgs([]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBeUndefined();
      expect(outcome.port).toBeUndefined();
    }
  });

  test("parses --dir <path> and --port <n>", () => {
    const outcome = parseServeArgs(["--dir", "build", "--port", "4321"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBe("build");
      expect(outcome.port).toBe(4321);
    }
  });

  test("parses --dir=<path> and --port=<n>", () => {
    const outcome = parseServeArgs(["--dir=build", "--port=0"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBe("build");
      expect(outcome.port).toBe(0);
    }
  });

  test("rejects --port with a non-integer", () => {
    const outcome = parseServeArgs(["--port", "abc"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("--port");
  });

  test("rejects --port out of range", () => {
    const outcome = parseServeArgs(["--port", "70000"]);
    expect(outcome.ok).toBe(false);
  });

  test("rejects an unknown flag", () => {
    const outcome = parseServeArgs(["--nope"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unknown");
  });

  test("rejects --dir with no value", () => {
    const outcome = parseServeArgs(["--dir"]);
    expect(outcome.ok).toBe(false);
  });
});

describe("readOrMintLocalUserId", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-local-user-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("mints an id on first call and persists it at mode 600", () => {
    const first = readOrMintLocalUserId(root);
    expect(first.startsWith("local-")).toBe(true);
    // The id is base64url after the "local-" prefix.
    expect(first.length).toBeGreaterThan("local-".length);
    const path = join(root, ".revkit", "local-user");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // Persisted content equals what was returned.
    expect(readFileSync(path, "utf8").trim()).toBe(first);
  });

  test("returns the same id on subsequent calls", () => {
    const first = readOrMintLocalUserId(root);
    const second = readOrMintLocalUserId(root);
    expect(second).toBe(first);
  });
});
