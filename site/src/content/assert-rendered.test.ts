// Structural "did markdown actually render?" gate for the docs
// collection (issue #237).
//
// The astro glob loader catches markdown render errors and stores
// the entry with `rendered: undefined`; `assertEveryEntryRendered`
// turns that silent catch into a loud build failure. The tests
// below exercise every acceptance clause of #237:
//
//   - A non-empty body with missing `rendered` throws.
//   - A non-empty body with empty-string `rendered.html` throws
//     (the astro catch branch leaves `rendered` unset, but a
//     different silent-error path could still produce `{html: ""}`
//     and the guard catches that too).
//   - A frontmatter-only entry (empty body) does NOT throw
//     (criterion 4: no false positives).
//   - A deferred render is skipped (astro will render it later).
//   - The error names the entry's filePath (criterion 1).
//
// Before this module existed `revkit build` silently shipped an
// empty `sl-markdown-content`. Calling a function that does not
// exist is itself a compile-time "fails before" result; the test
// file is also an executable failure of the invariant the function
// now enforces.
import { describe, expect, test } from "bun:test";
import {
  assertEveryEntryRendered,
  EmptyRenderedBodyError,
  hasNonEmptyBody,
  hasNonEmptyRenderedHtml,
  type ContentStoreEntry,
} from "../../src/content/assert-rendered.ts";

function entry(part: Partial<ContentStoreEntry> & { id: string }): ContentStoreEntry {
  return { ...part };
}

describe("hasNonEmptyBody", () => {
  test("undefined body is empty", () => {
    expect(hasNonEmptyBody(undefined)).toBe(false);
  });
  test("empty string is empty", () => {
    expect(hasNonEmptyBody("")).toBe(false);
  });
  test("whitespace-only is empty", () => {
    expect(hasNonEmptyBody("   \n\t\r\n  ")).toBe(false);
  });
  test("a single character is non-empty", () => {
    expect(hasNonEmptyBody("x")).toBe(true);
  });
  test("a heading is non-empty", () => {
    expect(hasNonEmptyBody("\n# Title\n\nparagraph\n")).toBe(true);
  });
});

describe("hasNonEmptyRenderedHtml", () => {
  test("undefined rendered is empty", () => {
    expect(hasNonEmptyRenderedHtml(undefined)).toBe(false);
  });
  test("empty html string is empty", () => {
    expect(hasNonEmptyRenderedHtml({ html: "" })).toBe(false);
  });
  test("whitespace-only html is empty", () => {
    expect(hasNonEmptyRenderedHtml({ html: "   \n\n   " })).toBe(false);
  });
  test("a single character of html is non-empty", () => {
    expect(hasNonEmptyRenderedHtml({ html: "x" })).toBe(true);
  });
  test("a wrapper tag is non-empty", () => {
    expect(hasNonEmptyRenderedHtml({ html: "<p>hi</p>" })).toBe(true);
  });
});

describe("assertEveryEntryRendered — the acceptance clauses of #237", () => {
  test("no entries → no throw", () => {
    expect(() => assertEveryEntryRendered([])).not.toThrow();
  });

  test("frontmatter-only doc (empty body) with no render does NOT throw (criterion 4)", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "index",
        entry({
          id: "index",
          body: "",
          filePath: "src/content/docs/index.mdx",
          // no rendered field — frontmatter-only entries legitimately have one
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).not.toThrow();
  });

  test("whitespace-only body is treated as empty (criterion 4, whitespace case)", () => {
    const entries: [string, ContentStoreEntry][] = [
      ["index", entry({ id: "index", body: "   \n\t\n", filePath: "docs/index.md" })],
    ];
    expect(() => assertEveryEntryRendered(entries)).not.toThrow();
  });

  test("non-empty body with non-empty rendered html → no throw", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "good",
        entry({
          id: "good",
          body: "\n# Title\n\nA paragraph.\n",
          filePath: "src/content/docs/good.md",
          rendered: { html: "<h1>Title</h1>\n<p>A paragraph.</p>\n" },
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).not.toThrow();
  });

  test("non-empty body with MISSING rendered throws, names the entry and the source (criterion 1)", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "bad-render",
        entry({
          id: "bad-render",
          body: "\n# Breaks\n\n$$\n\\invalidmacro{x}\n$$\n",
          filePath: "src/content/docs/bad-render.mdx",
          // rendered intentionally left undefined — this is what the
          // astro glob loader stores when the per-entry render throws.
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).toThrow(EmptyRenderedBodyError);
    try {
      assertEveryEntryRendered(entries);
    } catch (error) {
      expect(error).toBeInstanceOf(EmptyRenderedBodyError);
      const e = error as EmptyRenderedBodyError;
      expect(e.entryId).toBe("bad-render");
      expect(e.source).toBe("src/content/docs/bad-render.mdx");
      expect(e.message).toContain("bad-render");
      expect(e.message).toContain("src/content/docs/bad-render.mdx");
      expect(e.message).toContain("non-empty source body");
    }
  });

  test("non-empty body with an EMPTY rendered.html string throws", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "empty-html",
        entry({
          id: "empty-html",
          body: "\n# T\n\np\n",
          filePath: "docs/empty-html.md",
          rendered: { html: "" },
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).toThrow(EmptyRenderedBodyError);
  });

  test("non-empty body with whitespace-only rendered.html throws", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "ws",
        entry({
          id: "ws",
          body: "\n# T\n\np\n",
          filePath: "docs/ws.md",
          rendered: { html: "   \n\n\t   " },
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).toThrow(EmptyRenderedBodyError);
  });

  test("falls back to the entry id when filePath is missing", () => {
    const entries: [string, ContentStoreEntry][] = [
      ["only-id", entry({ id: "only-id", body: "# X\n\nY\n" })],
    ];
    try {
      assertEveryEntryRendered(entries);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptyRenderedBodyError);
      expect((error as EmptyRenderedBodyError).source).toBe("only-id");
    }
  });

  test("deferred renders are skipped (criterion 4 extension)", () => {
    // The astro loaders.ts shape has `deferredRender?: boolean`.
    // Deferred entries render later from a virtual module; the guard's
    // precondition (`rendered` must be present) does not apply. The
    // cast widens past our minimal `ContentStoreEntry` interface so
    // this branch stays testable without pulling in astro's full type.
    const deferred = {
      id: "deferred",
      body: "# T\n\nbody\n",
      filePath: "docs/deferred.md",
      deferredRender: true,
    } as unknown as ContentStoreEntry;
    const entries: [string, ContentStoreEntry][] = [["deferred", deferred]];
    expect(() => assertEveryEntryRendered(entries)).not.toThrow();
  });

  test("the FIRST violation in id order is reported (deterministic failure)", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "zeta",
        entry({
          id: "zeta",
          body: "# T\n\np\n",
          filePath: "docs/zeta.md",
        }),
      ],
      [
        "alpha",
        entry({
          id: "alpha",
          body: "# T\n\np\n",
          filePath: "docs/alpha.md",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EmptyRenderedBodyError).entryId).toBe("alpha");
    }
  });

  test("a mix of good + bad entries still throws on the bad one", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "good",
        entry({
          id: "good",
          body: "# OK\n",
          filePath: "docs/good.md",
          rendered: { html: "<h1>OK</h1>" },
        }),
      ],
      [
        "bad",
        entry({
          id: "bad",
          body: "# BAD\n",
          filePath: "docs/bad.md",
          // rendered undefined
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).toThrow(/bad/);
  });
});
