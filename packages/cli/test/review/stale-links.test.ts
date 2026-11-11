// `unlinkStale` removes only symlinks, never follows them (PR #48
// round-4 nit). A SIGKILLed prior run may leave the sandbox
// `node_modules` symlink pointing at the reviewer's real
// checkout; the next run must clear it BEFORE calling
// `symlinkSync`, and must never follow the link to touch the
// target.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkStale } from "../../src/review/build.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("unlinkStale", () => {
  test("removes a stale symlink WITHOUT touching its target", () => {
    const trusted = mkdtempSync(join(tmpdir(), "unlink-stale-trusted-"));
    const sandbox = mkdtempSync(join(tmpdir(), "unlink-stale-sandbox-"));
    dirs.push(trusted, sandbox);
    // Populate the trusted target with a file that MUST survive.
    writeFileSync(join(trusted, "keep.txt"), "keep me");
    // Simulate a stale symlink from a previous SIGKILLed run.
    const link = join(sandbox, "node_modules");
    symlinkSync(trusted, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Clear it.
    unlinkStale(link);
    // The link is gone.
    expect(existsSync(link)).toBe(false);
    // The target file is untouched.
    expect(readFileSync(join(trusted, "keep.txt"), "utf8")).toBe("keep me");
  });

  test("does NOT touch a real directory at `target`", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "unlink-stale-realdir-"));
    dirs.push(sandbox);
    const realDir = join(sandbox, "node_modules");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "keep"), "keep");
    unlinkStale(realDir);
    // The directory and file are still there.
    expect(existsSync(realDir)).toBe(true);
    expect(readFileSync(join(realDir, "keep"), "utf8")).toBe("keep");
  });

  test("no-op when target does not exist", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "unlink-stale-absent-"));
    dirs.push(sandbox);
    // Just don't throw.
    unlinkStale(join(sandbox, "does-not-exist"));
    expect(existsSync(join(sandbox, "does-not-exist"))).toBe(false);
  });
});
