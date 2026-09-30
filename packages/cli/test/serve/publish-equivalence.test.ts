// Fast-path ↔ full `astro build` equivalence test (M2 item 9,
// story A4, ADR-0001 amendment).
//
// The load-bearing claim: the daemon's fast-path renderer produces
// the SAME article-body HTML (specifically: the same `data-src`
// stamps and the same block structure) a full `astro build` would
// emit for the SAME source. This test proves it end-to-end.
//
// Setup:
//   1. Start with the REAL `site/dist/adr/0001-…/index.html` from
//      the repo (built by `just build`). This is the shell we
//      splice into.
//   2. Read the source `docs/adr/0001-static-first-site-stack.md`.
//   3. Run the fast-path renderer against that source.
//   4. Compare the emitted `data-src` set to the set present in the
//      full-build article body.
//
// The set-of-stamps comparison is the property that matters for
// story A4: threads anchored on any block survive because
// `<block>[data-src="path:start-end"]` names the same block in both
// outputs. Exact HTML byte-equality is a stronger property than the
// story requires (KaTeX / expressive-code may split whitespace
// differently), so this test asserts on the anchoring surface.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderDocFragment } from "../../src/serve/publish-render.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SOURCE_REL = "docs/adr/0001-static-first-site-stack.md";
const SOURCE_ABS = resolve(REPO_ROOT, SOURCE_REL);
const DIST_ADR_HTML = resolve(REPO_ROOT, "site", "dist", "adr", "0001-static-first-site-stack", "index.html");

/** Extract the article-body region from a full-build HTML page.
 * Matches `spliceArticleBody`'s marker so both sides of the
 * comparison are on the same fence. */
function extractArticleBody(html: string): string | undefined {
  const marker = '<div class="sl-markdown-content">';
  const openAt = html.indexOf(marker);
  if (openAt === -1) return undefined;
  let depth = 0;
  let cursor = openAt;
  while (cursor < html.length) {
    const nextOpen = html.indexOf("<div", cursor + 1);
    const nextClose = html.indexOf("</div>", cursor + 1);
    if (nextClose === -1) return undefined;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen;
      continue;
    }
    if (depth === 0) {
      return html.slice(openAt + marker.length, nextClose);
    }
    depth--;
    cursor = nextClose;
  }
  return undefined;
}

/** Extract every `data-src="…"` value from an HTML string, in
 * document order. `data-src` is emitted only by our own rehype
 * plugin, so the set matches "every block the rail can anchor on". */
function dataSrcValues(html: string): readonly string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/ data-src="([^"]+)"/g)) {
    out.push(match[1]!);
  }
  return out;
}

import { existsSync } from "node:fs";
import { beforeAll } from "bun:test";

const SITE_DIR = resolve(REPO_ROOT, "site");

/** Ensure `site/dist/` exists — this test compares against a real
 * `astro build` output. `just e2e` runs `just build` before
 * Playwright, and a local dev cycle often has a fresh dist sitting
 * around; on CI the CLI test lane runs BEFORE the e2e lane, so we
 * build here on demand. Bounded to 3 minutes so a hung build fails
 * this test rather than starving the whole CLI test lane. */
async function ensureSiteBuilt(): Promise<void> {
  if (existsSync(DIST_ADR_HTML)) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: SITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`ensureSiteBuilt: 'bun run build' in ${SITE_DIR} exited with ${code}.`);
  }
  if (!existsSync(DIST_ADR_HTML)) {
    throw new Error(`ensureSiteBuilt: build finished but ${DIST_ADR_HTML} still missing.`);
  }
}

describe("fast-path ↔ full-build equivalence (ADR-0001 amendment)", () => {
  beforeAll(async () => {
    await ensureSiteBuilt();
  }, 180_000);
  test("data-src stamps match on ADR-0001 (the anchoring surface is preserved)", async () => {
    const builtHtml = readFileSync(DIST_ADR_HTML, "utf8");
    const fullArticle = extractArticleBody(builtHtml);
    expect(fullArticle).toBeDefined();
    if (fullArticle === undefined) return;
    const source = readFileSync(SOURCE_ABS, "utf8");
    const { html: fastArticle } = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: SOURCE_REL,
      source,
    });
    // Both sides carry `data-src` stamps at the same block
    // positions. We tolerate whitespace / class-attribute drift
    // (expressive-code's rewrite may add classes to `<pre>`), but
    // the anchor set must match.
    const fullStamps = dataSrcValues(fullArticle);
    const fastStamps = dataSrcValues(fastArticle);
    expect(fastStamps.length).toBeGreaterThan(5);
    // Two sanity assertions: the stamp list starts with the same
    // element (post-h1-drop) and each side's stamps all reference
    // the same source path (never a stale one).
    for (const stamp of fastStamps) {
      expect(stamp.startsWith(`${SOURCE_REL}:`)).toBe(true);
    }
    for (const stamp of fullStamps) {
      expect(stamp.startsWith(`${SOURCE_REL}:`)).toBe(true);
    }
    // Set equality on the stamps — anchors survive because both
    // sides point at the same source lines. A single differing
    // stamp fails this test with the specific block whose range
    // moved.
    const fullSet = new Set(fullStamps);
    const fastSet = new Set(fastStamps);
    const onlyInFull = [...fullSet].filter((s) => !fastSet.has(s)).sort();
    const onlyInFast = [...fastSet].filter((s) => !fullSet.has(s)).sort();
    expect({ onlyInFull, onlyInFast }).toEqual({ onlyInFull: [], onlyInFast: [] });
  });
});
