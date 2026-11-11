// Tests for `collectPagesWithNonEmptySource` and its helpers — the
// map `revkit build` hands to `checkDistDirectory` so the output gate
// can run its #237 defense-in-depth scan.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPagesWithNonEmptySource,
  distPagePathFromSourceRelPath,
  githubSlugMinimal,
  stripFrontmatter,
} from "../../src/build/source-body-map.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "revkit-sbm-"));
  dirs.push(d);
  return d;
}

describe("stripFrontmatter", () => {
  test("strips a `---` fenced yaml block at the top", () => {
    const text = "---\ntitle: X\n---\n\n# Body\n\npara\n";
    expect(stripFrontmatter(text)).toBe("\n# Body\n\npara\n");
  });
  test("strips `\\r\\n` variants", () => {
    const text = "---\r\ntitle: X\r\n---\r\nbody\r\n";
    expect(stripFrontmatter(text)).toBe("body\r\n");
  });
  test("leaves a file without frontmatter alone", () => {
    expect(stripFrontmatter("# T\n\nbody\n")).toBe("# T\n\nbody\n");
  });
  test("leaves a `---` further down the file alone", () => {
    const text = "# Title\n\nbody\n\n---\n\nfooter\n";
    expect(stripFrontmatter(text)).toBe(text);
  });
  test("a frontmatter-only file collapses to empty", () => {
    expect(stripFrontmatter("---\ntitle: Empty\n---\n").trim()).toBe("");
  });
});

describe("githubSlugMinimal", () => {
  test("lowercases a plain ASCII filename", () => {
    expect(githubSlugMinimal("FOO")).toBe("foo");
  });
  test("preserves ASCII hyphens between words", () => {
    expect(githubSlugMinimal("hello-world")).toBe("hello-world");
  });
  test("collapses underscores, dots and spaces into one hyphen", () => {
    expect(githubSlugMinimal("hello_world")).toBe("hello-world");
    expect(githubSlugMinimal("hello world")).toBe("hello-world");
    expect(githubSlugMinimal("hello.world")).toBe("hello-world");
    expect(githubSlugMinimal("hello  __  world")).toBe("hello-world");
  });
  test("drops non-alphanumeric characters", () => {
    expect(githubSlugMinimal("question?")).toBe("question");
  });
  test("trims leading / trailing hyphens", () => {
    expect(githubSlugMinimal("_private_")).toBe("private");
  });
});

describe("distPagePathFromSourceRelPath", () => {
  test("docs/index.md → index.html", () => {
    expect(distPagePathFromSourceRelPath("index.md")).toBe("index.html");
  });
  test("docs/index.mdx → index.html", () => {
    expect(distPagePathFromSourceRelPath("index.mdx")).toBe("index.html");
  });
  test("docs/guide.md → guide/index.html", () => {
    expect(distPagePathFromSourceRelPath("guide.md")).toBe("guide/index.html");
  });
  test("docs/sub/overview.md → sub/overview/index.html", () => {
    expect(distPagePathFromSourceRelPath("sub/overview.md")).toBe(
      "sub/overview/index.html",
    );
  });
  test("docs/adr/0001-record.md → adr/0001-record/index.html", () => {
    expect(distPagePathFromSourceRelPath("adr/0001-record.md")).toBe(
      "adr/0001-record/index.html",
    );
  });
  test("UPPERCASE names lower-case into the slug", () => {
    expect(distPagePathFromSourceRelPath("FOO.md")).toBe("foo/index.html");
  });
  test("non-.md(x) files return null", () => {
    expect(distPagePathFromSourceRelPath("sidebar.yaml")).toBeNull();
    expect(distPagePathFromSourceRelPath("terms.txt")).toBeNull();
  });
});

describe("collectPagesWithNonEmptySource — end to end", () => {
  test("a frontmatter-only index + a non-empty guide → only guide is listed", () => {
    const root = scratch();
    writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n");
    writeFileSync(join(root, "guide.md"), "---\ntitle: Guide\n---\n\n# Guide\n\nbody\n");
    const set = collectPagesWithNonEmptySource(root);
    expect(set.has("index.html")).toBe(false);
    expect(set.has("guide/index.html")).toBe(true);
    expect(set.size).toBe(1);
  });
  test("recurses into subdirs", () => {
    const root = scratch();
    mkdirSync(join(root, "adr"));
    writeFileSync(
      join(root, "adr", "0001-foo.md"),
      "---\ntitle: ADR 1\n---\n\n# ADR 1\n\nBody.\n",
    );
    const set = collectPagesWithNonEmptySource(root);
    expect(set.has("adr/0001-foo/index.html")).toBe(true);
  });
  test("mdx files are listed", () => {
    const root = scratch();
    writeFileSync(join(root, "page.mdx"), "---\ntitle: X\n---\n\n## X\n\ntext\n");
    const set = collectPagesWithNonEmptySource(root);
    expect(set.has("page/index.html")).toBe(true);
  });
  test("skips Starlight's `_` prefix convention", () => {
    const root = scratch();
    writeFileSync(join(root, "_skip.md"), "---\ntitle: Skip\n---\n\nbody\n");
    writeFileSync(join(root, "keep.md"), "---\ntitle: Keep\n---\n\nbody\n");
    const set = collectPagesWithNonEmptySource(root);
    expect(set.has("keep/index.html")).toBe(true);
    expect(set.size).toBe(1);
  });
  test("a non-existent docs dir yields an empty set (no throw)", () => {
    const set = collectPagesWithNonEmptySource(join(scratch(), "nope"));
    expect(set.size).toBe(0);
  });
  test("whitespace-only body counts as empty", () => {
    const root = scratch();
    writeFileSync(join(root, "ws.md"), "---\ntitle: X\n---\n\n   \n\n   \n");
    const set = collectPagesWithNonEmptySource(root);
    expect(set.size).toBe(0);
  });
});
