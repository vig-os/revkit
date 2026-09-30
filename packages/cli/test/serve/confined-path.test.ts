// Confined-path tests — the containment primitive the daemon leans on
// to refuse path traversal and symlink escape. Every test builds a
// real temporary directory and asserts on real fs behaviour; there is
// no mocking of readdir / lstat.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinRoot } from "../../src/serve/confined-path.ts";

describe("resolveWithinRoot", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    // A pair of directories: `root` is what the daemon serves; `outside`
    // is a sibling holding a file a symlink escape would want to reach.
    const base = mkdtempSync(join(tmpdir(), "revkit-confined-"));
    root = realpathSync(mkdirp(join(base, "root")));
    outside = realpathSync(mkdirp(join(base, "outside")));
    writeFileSync(join(root, "index.html"), "<h1>ok</h1>");
    writeFileSync(join(root, "app.js"), "console.log('ok')");
    mkdirp(join(root, "sub"));
    writeFileSync(join(root, "sub", "page.html"), "<h1>sub</h1>");
    writeFileSync(join(outside, "secret.txt"), "SECRET");
  });

  afterEach(() => {
    // Best-effort cleanup — one directory up from `root` holds both
    // `root` and `outside`.
    try {
      rmSync(join(root, ".."), { recursive: true, force: true });
    } catch {
      // Fine if it is already gone.
    }
  });

  test("resolves a normal file inside the root", () => {
    const result = resolveWithinRoot(root, "/index.html");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe(join(root, "index.html"));
  });

  test("resolves a nested file", () => {
    const result = resolveWithinRoot(root, "/sub/page.html");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe(join(root, "sub", "page.html"));
  });

  test("refuses a '..' segment (literal)", () => {
    const result = resolveWithinRoot(root, "/../outside/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("traversal");
  });

  test("refuses a '..' segment nested inside the path", () => {
    const result = resolveWithinRoot(root, "/sub/../../outside/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("traversal");
  });

  test("refuses a NUL byte", () => {
    const result = resolveWithinRoot(root, "/index.html\0.png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid");
  });

  test("refuses a leaf symlink even when its target is inside the root", () => {
    // A symlink whose target is inside the root is still a symlink; the
    // daemon refuses all symlinks because `astro build` never produces
    // one, so any symlink in dist is either a mistake or an attack.
    symlinkSync(join(root, "index.html"), join(root, "alias.html"));
    const result = resolveWithinRoot(root, "/alias.html");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("symlink");
  });

  test("refuses a leaf symlink whose target is outside the root", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    const result = resolveWithinRoot(root, "/escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("symlink");
  });

  test("refuses a symlinked intermediate directory (path chain check)", () => {
    // A directory-level symlink that leaves the root: reading a file
    // through that link should refuse.
    symlinkSync(outside, join(root, "outlink"));
    const result = resolveWithinRoot(root, "/outlink/secret.txt");
    expect(result.ok).toBe(false);
    // Could be "symlink" (intermediate directory is a symlink) or
    // "outside" (its realpath escapes). Both are correct rejections
    // — assert on the family, not the exact word.
    if (!result.ok) expect(["symlink", "outside"]).toContain(result.kind);
  });

  test("reports not-found for a missing file (no leak)", () => {
    const result = resolveWithinRoot(root, "/does-not-exist.html");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("not-found");
  });

  test("accepts the root itself (empty path)", () => {
    const result = resolveWithinRoot(root, "/");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe(root);
  });

  test("literal '..' in the middle of a filename is not traversal", () => {
    // The refusal is on a `..` **segment**, not on the two-dot
    // substring — a filename like `foo..bar.html` is legitimate.
    writeFileSync(join(root, "foo..bar.html"), "<h1>ok</h1>");
    const result = resolveWithinRoot(root, "/foo..bar.html");
    expect(result.ok).toBe(true);
  });
});

// A tiny "mkdir -p" wrapper used by the fixtures.
function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
