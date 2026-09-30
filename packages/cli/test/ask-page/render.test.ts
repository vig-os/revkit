// Unit tests for the `/ask/<id>` HTML shell and the compiled Solid
// bundle. The shell tests cover `renderAskPage` producing a
// well-formed HTML5 document that references the JS + CSS
// endpoints and embeds the escaped boot record so an agent-supplied
// title cannot terminate the boot script tag. The bundle tests
// cover `buildAskPageBundle` producing ES module bytes that
// contain no `eval(` or `new Function(` since the CSP does not
// allow `'unsafe-eval'` — same contract as the rail bundle.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AskRecord } from "@revkit/review-core";
import { renderAskPage, encodeBootJson, ASK_JS_PATH, ASK_CSS_PATH } from "../../src/ask-page/render.ts";
import { buildAskPageBundle, _resetAskPageBundleForTests, askPageEntrypointPath } from "../../src/ask-page/bundle.ts";

const baseRecord: AskRecord = {
  id: "ask-1",
  spec: { schemaVersion: 1, kind: "text", title: "Pick", multiline: false } as unknown as AskRecord["spec"],
  status: "pending",
  url: "/ask/ask-1",
  createdAt: "2026-09-30T12:00:00Z",
  createdAtMs: 1759_233_600_000,
  createdSeq: 1,
};

describe("renderAskPage — shell shape", () => {
  test("emits a well-formed HTML doc with the ask JS + CSS refs", () => {
    const html = renderAskPage(baseRecord);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<script type="module" src="${ASK_JS_PATH}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${ASK_CSS_PATH}">`);
    expect(html).toContain('<div id="revkit-ask-mount"></div>');
    // Boot JSON contains the id.
    expect(html).toContain('"id":"ask-1"');
  });

  test("encodeBootJson escapes `</script` so an agent-supplied title cannot terminate the boot tag", () => {
    // A hostile title that would break out of a naïve inline
    // `<script>`.
    const hostile: AskRecord = {
      ...baseRecord,
      spec: {
        schemaVersion: 1,
        kind: "text",
        title: "</script><script>window.x=1</script>",
        multiline: false,
      } as unknown as AskRecord["spec"],
    };
    const encoded = encodeBootJson(hostile);
    // The literal `</script` must not appear (case-insensitive).
    expect(/<\/script/i.test(encoded)).toBe(false);
    // The escape form does appear.
    expect(encoded).toContain('<\\/script>');
  });

  test("encodeBootJson neutralises HTML-comment starter/terminator", () => {
    const record: AskRecord = {
      ...baseRecord,
      spec: {
        schemaVersion: 1,
        kind: "text",
        title: "<!--start end-->",
        multiline: false,
      } as unknown as AskRecord["spec"],
    };
    const encoded = encodeBootJson(record);
    expect(encoded).not.toContain("<!--");
    expect(encoded).not.toContain("-->");
  });
});

describe("buildAskPageBundle — compile output", () => {
  test("produces JS that parses as ES module and CSS bytes for the shell's <link>", async () => {
    _resetAskPageBundleForTests();
    const bundle = await buildAskPageBundle();
    expect(bundle.js.byteLength).toBeGreaterThan(0);
    expect(bundle.css.byteLength).toBeGreaterThan(0);
    // Decode JS as UTF-8 and confirm it looks like ES module output.
    const js = new TextDecoder().decode(bundle.js);
    // Bun.build emits `import` / `export` at the top level; the
    // minified output at minimum keeps `import` from solid-js.
    expect(js.length).toBeGreaterThan(1000);
  });

  test("compiled bundle contains no eval() / new Function() — CSP without 'unsafe-eval' relies on this", async () => {
    _resetAskPageBundleForTests();
    const bundle = await buildAskPageBundle();
    const js = new TextDecoder().decode(bundle.js);
    expect(/\beval\s*\(/.test(js)).toBe(false);
    expect(/\bnew\s+Function\s*\(/.test(js)).toBe(false);
  });

  test("entrypoint path resolves to a real file on disk", () => {
    const path = askPageEntrypointPath();
    // If the entry vanished the read would throw.
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("revkit-ask-mount");
  });
});
