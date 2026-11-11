// Structural "did markdown actually render?" gate for the docs
// collection (issue #237).
//
// The astro glob loader catches markdown render errors and stores
// the entry with `rendered: undefined`; `assertEveryEntryRendered`
// turns that silent catch into a loud build failure. The tests
// below exercise every acceptance clause of #237 AND the round-2
// review items (underlying error in the thrown message, consumer-
// visible source path).
import { describe, expect, test } from "bun:test";
import {
  assertEveryEntryRendered,
  captureRenderError,
  captureRenderErrorsFromLogger,
  collectPagesFromStore,
  distPathFromEntryId,
  EmptyRenderedBodyError,
  hasNonEmptyBody,
  hasNonEmptyRenderedHtml,
  toConsumerPath,
  type ContentStoreEntry,
  type LoggerLike,
} from "./assert-rendered.ts";

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

describe("toConsumerPath", () => {
  test("own-repo mode (no consumer root) returns the raw path", () => {
    expect(toConsumerPath("src/content/docs/foo.md", undefined)).toBe(
      "src/content/docs/foo.md",
    );
  });
  test("consumer mode strips the `src/content/` prefix (round-2 review)", () => {
    expect(
      toConsumerPath("src/content/docs/bad-math.md", "/tmp/consumer"),
    ).toBe("docs/bad-math.md");
  });
  test("consumer mode normalises windows separators", () => {
    expect(
      toConsumerPath("src\\content\\docs\\bad-math.md", "/tmp/consumer"),
    ).toBe("docs/bad-math.md");
  });
  test("a path already under docs/ (own-repo or already-stripped) is untouched", () => {
    expect(toConsumerPath("docs/adr/0001.md", "/tmp/consumer")).toBe(
      "docs/adr/0001.md",
    );
  });
});

describe("captureRenderError", () => {
  test("picks the entry name and message out of astro's logged shape", () => {
    const map = new Map<string, string>();
    captureRenderError(
      "Error rendering bad-math.md: Failed to parse Markdown file: Undefined control sequence",
      map,
    );
    expect(map.get("bad-math.md")).toContain("Undefined control sequence");
  });
  test("tolerates a message with no colon (no capture)", () => {
    const map = new Map<string, string>();
    captureRenderError("Error rendering bad-math.md", map);
    expect(map.size).toBe(0);
  });
  test("ignores lines that do not match astro's render-error prefix", () => {
    const map = new Map<string, string>();
    captureRenderError("Some other error", map);
    captureRenderError("warning: deprecated", map);
    expect(map.size).toBe(0);
  });
});

describe("distPathFromEntryId — maps astro's store id to the built HTML path", () => {
  // Astro's glob loader stores the slug as the entry id (see
  // `astro/dist/content/loaders/glob.js`'s `generateIdDefault`), so
  // these are the shapes that reach us from `context.store`. We
  // don't need a slugger of our own; we just need to mirror
  // Starlight's `normalizeIndexSlug` for the index case.
  test("root slug (empty) → index.html", () => {
    expect(distPathFromEntryId("")).toBe("index.html");
  });
  test("literal `index` collapses to the root (Starlight normalizeIndexSlug)", () => {
    expect(distPathFromEntryId("index")).toBe("index.html");
  });
  test("single segment → <id>/index.html", () => {
    expect(distPathFromEntryId("guide")).toBe("guide/index.html");
  });
  test("nested segments pass through verbatim (underscores + hyphens kept)", () => {
    // Astro's github-slugger keeps underscores as-is, so a source
    // file `sub/My_Doc.md` has entry id `sub/my_doc`. We write
    // `sub/my_doc/index.html`.
    expect(distPathFromEntryId("sub/my_doc")).toBe("sub/my_doc/index.html");
  });
  test("deep nesting keeps structure", () => {
    expect(distPathFromEntryId("adr/0001-record")).toBe("adr/0001-record/index.html");
  });
  test("leading / trailing slashes are stripped before the suffix is attached", () => {
    expect(distPathFromEntryId("/foo/")).toBe("foo/index.html");
  });
});

describe("collectPagesFromStore — the manifest the astro loader writes", () => {
  test("records only entries with a non-empty body", () => {
    const entries: [string, ContentStoreEntry][] = [
      ["index", { id: "index", body: "" }],
      ["guide", { id: "guide", body: "# body\n" }],
      ["ws", { id: "ws", body: "   \n\n" }],
      ["sub/my_doc", { id: "sub/my_doc", body: "# x\n" }],
    ];
    const pages = collectPagesFromStore(entries);
    expect([...pages].sort()).toEqual(["guide/index.html", "sub/my_doc/index.html"]);
  });
  test("deferred entries are still counted — the dist still has to be non-empty", () => {
    const deferred = {
      id: "deferred",
      body: "# T\n",
      deferredRender: true,
    } as unknown as ContentStoreEntry;
    const entries: [string, ContentStoreEntry][] = [["deferred", deferred]];
    const pages = collectPagesFromStore(entries);
    expect(pages.has("deferred/index.html")).toBe(true);
  });
});

describe("captureRenderErrorsFromLogger", () => {
  test("records render errors from `logger.error` into the side-channel map", () => {
    const got: string[] = [];
    const errors = new Map<string, string>();
    const base: LoggerLike = { error: (msg) => got.push(msg) };
    const restore = captureRenderErrorsFromLogger(base, errors);
    try {
      base.error("Error rendering bad-math.md: KaTeX parse error at :1: \\invalidmacro");
      base.error("Unrelated error line");
    } finally {
      restore();
    }
    expect(errors.get("bad-math.md")).toContain("KaTeX parse error");
    expect(errors.size).toBe(1);
    // The underlying logger still sees everything (astro's own log keeps working).
    expect(got.length).toBe(2);
  });
  test("restore() reinstalls the original logger error method", () => {
    const got: string[] = [];
    const errors = new Map<string, string>();
    const base: LoggerLike = { error: (msg) => got.push(msg) };
    const originalError = base.error;
    const restore = captureRenderErrorsFromLogger(base, errors);
    expect(base.error).not.toBe(originalError);
    restore();
    expect(base.error).toBe(originalError);
    // After restore, further calls do not populate `errors`.
    base.error("Error rendering ignored.md: surprise");
    expect(errors.size).toBe(0);
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

  test("non-empty body with MISSING rendered throws, names the entry and the consumer path (criterion 1)", () => {
    const entries: [string, ContentStoreEntry][] = [
      [
        "bad-render",
        entry({
          id: "bad-render",
          body: "\n# Breaks\n\n$$\n\\invalidmacro{x}\n$$\n",
          filePath: "src/content/docs/bad-render.mdx",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries, { consumerRoot: "/tmp/consumer" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptyRenderedBodyError);
      const e = error as EmptyRenderedBodyError;
      expect(e.entryId).toBe("bad-render");
      // Consumer-visible path (not the staging path).
      expect(e.source).toBe("docs/bad-render.mdx");
      expect(e.message).toContain("docs/bad-render.mdx");
      expect(e.message).not.toContain("src/content/docs/bad-render.mdx");
      expect(e.message).toContain("non-empty source body");
    }
  });

  test("the thrown error carries the UNDERLYING render error at the top level (round-2 review item 1)", () => {
    // Astro's glob loader logs `Error rendering bad-render.mdx: ...`
    // for an entry at `src/content/docs/bad-render.mdx` (base is
    // `src/content/docs/`).
    const renderErrors = new Map<string, string>([
      ["bad-render.mdx", "Failed to parse Markdown: Undefined control sequence \\invalidmacro"],
    ]);
    const entries: [string, ContentStoreEntry][] = [
      [
        "bad-render",
        entry({
          id: "bad-render",
          body: "# x\n",
          filePath: "src/content/docs/bad-render.mdx",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries, {
        consumerRoot: "/tmp/consumer",
        renderErrorsByEntryBasename: renderErrors,
      });
      throw new Error("expected throw");
    } catch (error) {
      const e = error as EmptyRenderedBodyError;
      expect(e.underlying).toContain("Undefined control sequence");
      expect(e.message).toContain("Underlying render error:");
      expect(e.message).toContain("Undefined control sequence");
      // ES2022 `cause` chain is present too.
      expect((e as unknown as { cause: Error }).cause).toBeInstanceOf(Error);
    }
  });

  test("underlying error is attached for a NESTED broken doc (round-3 review item 1)", () => {
    // Reviewer repro: `docs/sub/My_Doc.md` with bad KaTeX exited
    // non-zero but the gate's message lacked `Underlying render
    // error`. Astro logs the glob-relative key `sub/My_Doc.md`
    // (base `src/content/docs/`); the fix keys the lookup on
    // `entry.filePath` minus that base, deterministically.
    const renderErrors = new Map<string, string>([
      ["sub/My_Doc.md", "KaTeX parse error: Undefined control sequence \\invalidmacro"],
    ]);
    const entries: [string, ContentStoreEntry][] = [
      [
        "sub/my_doc",
        entry({
          id: "sub/my_doc",
          body: "# x\n",
          filePath: "src/content/docs/sub/My_Doc.md",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries, {
        consumerRoot: "/tmp/consumer",
        renderErrorsByEntryBasename: renderErrors,
      });
      throw new Error("expected throw");
    } catch (error) {
      const e = error as EmptyRenderedBodyError;
      expect(e.message).toContain("docs/sub/My_Doc.md");
      expect(e.message).toContain("Underlying render error:");
      expect(e.message).toContain("KaTeX parse error");
      expect(e.underlying).toContain("Undefined control sequence");
    }
  });

  test("underlying error is attached for a NESTED broken doc whose name contains `_` (round-3 extra)", () => {
    const renderErrors = new Map<string, string>([
      ["deep/My_Nested_Doc.md", "render failed"],
    ]);
    const entries: [string, ContentStoreEntry][] = [
      [
        "deep/my_nested_doc",
        entry({
          id: "deep/my_nested_doc",
          body: "# body\n",
          filePath: "src/content/docs/deep/My_Nested_Doc.md",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries, {
        consumerRoot: "/tmp/consumer",
        renderErrorsByEntryBasename: renderErrors,
      });
      throw new Error("expected throw");
    } catch (error) {
      const e = error as EmptyRenderedBodyError;
      expect(e.underlying).toBe("render failed");
    }
  });

  test("when no matching render-error key is captured, `underlying` is null and the message is clean", () => {
    const renderErrors = new Map<string, string>([
      ["something-else.md", "unrelated"],
    ]);
    const entries: [string, ContentStoreEntry][] = [
      [
        "a",
        entry({
          id: "a",
          body: "# x\n",
          filePath: "src/content/docs/a.md",
        }),
      ],
    ];
    try {
      assertEveryEntryRendered(entries, {
        renderErrorsByEntryBasename: renderErrors,
      });
      throw new Error("expected throw");
    } catch (error) {
      const e = error as EmptyRenderedBodyError;
      expect(e.underlying).toBeNull();
      expect(e.message).not.toContain("Underlying render error:");
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
        entry({ id: "zeta", body: "# T\n\np\n", filePath: "docs/zeta.md" }),
      ],
      [
        "alpha",
        entry({ id: "alpha", body: "# T\n\np\n", filePath: "docs/alpha.md" }),
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
        }),
      ],
    ];
    expect(() => assertEveryEntryRendered(entries)).toThrow(/bad/);
  });
});
