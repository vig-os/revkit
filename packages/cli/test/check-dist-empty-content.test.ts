// `check-dist` — defense in depth for issue #237. A page whose source
// doc has a non-empty body but whose Starlight content root
// (`<div class="sl-markdown-content">`) is empty fails, naming the
// page. Frontmatter-only pages (no source body) must NOT be flagged.
//
// The tests exercise both the pure helper (`emptyContentRootRefusal`,
// to prove intent directly) and the directory-walk end to end
// (`checkDistDirectory` with `pagesWithNonEmptySource`), which is
// how `revkit build` wires it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parse5Parse } from "parse5";
import {
  CONTENT_ROOT_CLASS,
  checkDistDirectory,
  emptyContentRootRefusal,
} from "../src/check-dist.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "revkit-cd-empty-"));
  dirs.push(d);
  return d;
}

/** Shim to parse5Parse + the right cast. */
function parse(html: string): Parameters<typeof emptyContentRootRefusal>[0] {
  return parse5Parse(html) as unknown as Parameters<typeof emptyContentRootRefusal>[0];
}

describe("emptyContentRootRefusal — direct pure-function tests", () => {
  test("a page with no sl-markdown-content returns null (non-Starlight)", () => {
    const html = `<!doctype html><html><body><h1>hi</h1><p>para</p></body></html>`;
    expect(emptyContentRootRefusal(parse(html))).toBeNull();
  });
  test("a page with a NON-empty sl-markdown-content returns null", () => {
    const html = `<!doctype html><html><body>
      <div class="${CONTENT_ROOT_CLASS}"><p>Rendered body.</p></div>
    </body></html>`;
    expect(emptyContentRootRefusal(parse(html))).toBeNull();
  });
  test("a page with a totally empty sl-markdown-content returns a refusal", () => {
    const html = `<!doctype html><html><body>
      <div class="${CONTENT_ROOT_CLASS}"></div>
    </body></html>`;
    const refusal = emptyContentRootRefusal(parse(html));
    expect(refusal).not.toBeNull();
    expect(refusal).toContain(CONTENT_ROOT_CLASS);
  });
  test("a page with only whitespace / comments inside sl-markdown-content returns a refusal", () => {
    const html = `<!doctype html><html><body>
      <div class="${CONTENT_ROOT_CLASS}">\n\n   <!-- rendered nothing -->\n\n   </div>
    </body></html>`;
    expect(emptyContentRootRefusal(parse(html))).not.toBeNull();
  });
  test("a single child element counts as non-empty content", () => {
    const html = `<!doctype html><html><body>
      <div class="${CONTENT_ROOT_CLASS}"><p></p></div>
    </body></html>`;
    expect(emptyContentRootRefusal(parse(html))).toBeNull();
  });
  test("the content root matches on the class token, not substring", () => {
    // A div whose class is `sl-markdown-content-footer` must not
    // match — otherwise we would accidentally gate neighbouring
    // Starlight chrome.
    const html = `<!doctype html><html><body>
      <div class="sl-markdown-content-footer"></div>
    </body></html>`;
    expect(emptyContentRootRefusal(parse(html))).toBeNull();
  });
});

describe("checkDistDirectory — the #237 defense in depth", () => {
  test("a dist with an empty content root + a non-empty-source entry in the map → finding names the page", () => {
    const dist = scratch();
    mkdirSync(join(dist, "bad"));
    writeFileSync(
      join(dist, "bad", "index.html"),
      `<!doctype html><html><head><title>bad</title></head><body>
        <main>
          <h1>Title lives OUTSIDE the content root (Starlight layout)</h1>
          <div class="${CONTENT_ROOT_CLASS}"></div>
        </main>
      </body></html>`,
      "utf8",
    );
    const findings = checkDistDirectory(dist, {
      pagesWithNonEmptySource: new Set(["bad/index.html"]),
    });
    expect(findings.length).toBeGreaterThan(0);
    const emptyRoot = findings.find((d) => d.message.includes("empty rendered content"));
    expect(emptyRoot, JSON.stringify(findings)).toBeDefined();
    expect(emptyRoot?.file).toBe("bad/index.html");
    expect(emptyRoot?.message).toContain("#237");
    expect(emptyRoot?.message).toContain(CONTENT_ROOT_CLASS);
  });

  test("a page with non-empty rendered content + a non-empty source entry → no empty-content finding (criterion 4-ish)", () => {
    const dist = scratch();
    writeFileSync(
      join(dist, "index.html"),
      `<!doctype html><html><body>
        <div class="${CONTENT_ROOT_CLASS}"><p>Body paragraph.</p></div>
      </body></html>`,
      "utf8",
    );
    const findings = checkDistDirectory(dist, {
      pagesWithNonEmptySource: new Set(["index.html"]),
    });
    const emptyFindings = findings.filter((d) => d.message.includes("empty rendered content"));
    expect(emptyFindings.length).toBe(0);
  });

  test("a frontmatter-only source doc (NOT in the map) still builds — no false positive (criterion 4)", () => {
    const dist = scratch();
    writeFileSync(
      join(dist, "index.html"),
      `<!doctype html><html><body>
        <div class="${CONTENT_ROOT_CLASS}"></div>
      </body></html>`,
      "utf8",
    );
    // An empty source body means the page's path is NOT in the set.
    const findings = checkDistDirectory(dist, {
      pagesWithNonEmptySource: new Set<string>(),
    });
    const emptyFindings = findings.filter((d) => d.message.includes("empty rendered content"));
    expect(emptyFindings.length).toBe(0);
  });

  test("the empty-content scan runs ONLY when `pagesWithNonEmptySource` is provided — backward-compatible default", () => {
    const dist = scratch();
    writeFileSync(
      join(dist, "index.html"),
      `<!doctype html><html><body>
        <div class="${CONTENT_ROOT_CLASS}"></div>
      </body></html>`,
      "utf8",
    );
    const findings = checkDistDirectory(dist);
    const emptyFindings = findings.filter((d) => d.message.includes("empty rendered content"));
    expect(emptyFindings.length).toBe(0);
  });

  test("round-2 reviewer repro — `sub/My_Doc.md` with underscores is flagged under its real Starlight slug", () => {
    // The previous ad-hoc slugger mapped `sub/My_Doc.md` to
    // `sub/my-doc/index.html`, so check-dist never saw an entry for
    // the real dist path `sub/my_doc/index.html`. The new manifest
    // comes from astro's own content store, so the entry's id is
    // the slug Starlight actually emits.
    const dist = scratch();
    mkdirSync(join(dist, "sub", "my_doc"), { recursive: true });
    writeFileSync(
      join(dist, "sub", "my_doc", "index.html"),
      `<!doctype html><html><body>
        <main>
          <h1>My Doc</h1>
          <div class="${CONTENT_ROOT_CLASS}">\n   <!-- rendered nothing -->\n   </div>
        </main>
      </body></html>`,
      "utf8",
    );
    const findings = checkDistDirectory(dist, {
      pagesWithNonEmptySource: new Set(["sub/my_doc/index.html"]),
    });
    const empty = findings.find((d) => d.message.includes("empty rendered content"));
    expect(empty, JSON.stringify(findings)).toBeDefined();
    expect(empty?.file).toBe("sub/my_doc/index.html");
  });

  test("check-dist still reports the other kinds of findings alongside the empty-content check", () => {
    const dist = scratch();
    writeFileSync(
      join(dist, "index.html"),
      // An `<iframe>` (refused element) AND an empty content root — both findings must surface.
      `<!doctype html><html><body>
        <iframe src="https://x/"></iframe>
        <div class="${CONTENT_ROOT_CLASS}"></div>
      </body></html>`,
      "utf8",
    );
    const findings = checkDistDirectory(dist, {
      pagesWithNonEmptySource: new Set(["index.html"]),
    });
    expect(findings.some((d) => d.message.includes("<iframe>"))).toBe(true);
    expect(findings.some((d) => d.message.includes("empty rendered content"))).toBe(true);
  });
});
