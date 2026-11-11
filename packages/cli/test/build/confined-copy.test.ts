// Tests for `copyConfined` (packaged.ts) — the staging walker that
// refuses symlinks in the consumer's docs tree, and for the
// removal of `--skip-check` (issue #57 nit). Both would flip RED
// on b3832661: the previous staging used `cpSync({ dereference:
// true })` which chases symlinks blindly, and `parseBuildArgs`
// accepted a `--skip-check` flag that bypassed the guards.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyConfined } from "../../src/build/packaged.ts";
import { parseBuildArgs } from "../../src/build/cli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("copyConfined — refuses every symlink under the docs root", () => {
  test("copies plain files", () => {
    const src = mkdtemp("src-");
    const dst = mkdtemp("dst-");
    writeFileSync(join(src, "a.md"), "hello");
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", "b.md"), "world");
    copyConfined(join(src, "a.md"), join(dst, "a.md"), src);
    copyConfined(join(src, "sub"), join(dst, "sub"), src);
    expect(readFileSync(join(dst, "a.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(dst, "sub", "b.md"), "utf8")).toBe("world");
  });

  test("refuses a symlink that ESCAPES the docs root — the exfil case", () => {
    const src = mkdtemp("src-");
    const dst = mkdtemp("dst-");
    const outside = mkdtemp("outside-");
    writeFileSync(join(outside, "secret.md"), "leaked!");
    // `docs/leak.md -> outside/secret.md`.
    symlinkSync(join(outside, "secret.md"), join(src, "leak.md"));
    expect(() =>
      copyConfined(join(src, "leak.md"), join(dst, "leak.md"), src),
    ).toThrow(/refusing symlink/);
    // No file was written.
    expect(() => readFileSync(join(dst, "leak.md"), "utf8")).toThrow();
  });

  test("refuses a symlink that stays INSIDE the docs root too (strict rule)", () => {
    const src = mkdtemp("src-");
    const dst = mkdtemp("dst-");
    writeFileSync(join(src, "real.md"), "content");
    symlinkSync(join(src, "real.md"), join(src, "alias.md"));
    expect(() =>
      copyConfined(join(src, "alias.md"), join(dst, "alias.md"), src),
    ).toThrow(/refusing symlink/);
  });

  test("refuses when walking encounters a nested symlink deeper in the tree", () => {
    const src = mkdtemp("src-");
    const dst = mkdtemp("dst-");
    const outside = mkdtemp("outside-");
    writeFileSync(join(outside, "leak.md"), "leaked!");
    mkdirSync(join(src, "sub"));
    symlinkSync(join(outside, "leak.md"), join(src, "sub", "leak.md"));
    expect(() =>
      copyConfined(join(src, "sub"), join(dst, "sub"), src),
    ).toThrow(/refusing symlink/);
  });
});

describe("parseBuildArgs — no `--skip-check` bypass any more", () => {
  test("`--skip-check` is refused (removed in issue #57)", () => {
    const out = parseBuildArgs(["--skip-check"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("unknown argument");
  });

  test("`--dir` still works", () => {
    const out = parseBuildArgs(["--dir", "/tmp/x"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.parsed.dir).toBe("/tmp/x");
  });

  test("`--skip-check-dist` remains — test-only escape hatch", () => {
    const out = parseBuildArgs(["--skip-check-dist"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.parsed.skipCheckDist).toBe(true);
  });
});
