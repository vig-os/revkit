import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { parseDataSrc } from "../../src/data-src-format.ts";
import { renderProvenance } from "../../src/serve/source-provenance.ts";
import { startDaemon } from "../../src/serve/daemon.ts";
import { extractDocRevision } from "../../src/rehype-stamp-revision.ts";

const source = '---\ntitle: Provenance\ndescription: Raw snapshot\n---\n\n## Heading\n\n```js\nconst value = 1;\n```\n\nReview this paragraph.\n';
const pages = [
  { path: "docs/page.md", output: "page/index.html", route: "/page/" },
  { path: "docs/index.mdx", output: "index.html", route: "/" },
];
let root: string;
let dist: string;

// Exercise the real Astro content loader and MDX compiler with the shared
// production pipeline, without consumer staging's dependency-layout assumptions.
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "raw-source-"));
  dist = join(root, ".revkit/dist");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "provenance-fixture", private: true }));
  for (const page of pages) writeFileSync(join(root, page.path), source);
  const checkout = resolve(import.meta.dir, "../../../..");
  symlinkSync(join(checkout, "site/node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "src/pages"), { recursive: true });
  writeFileSync(join(root, "astro.config.mjs"), `import mdx from '@astrojs/mdx';
import { buildSharedMarkdownConfig } from ${JSON.stringify(pathToFileURL(join(checkout, "site/src/lib/markdown-processor.ts")).href)};
export default { integrations: [mdx()], markdown: { ...buildSharedMarkdownConfig(${JSON.stringify(root)}, { readSource: true }), syntaxHighlight: false } };`);
  writeFileSync(join(root, "src/content.config.ts"), `import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { docs: defineCollection({ loader: glob({ base: './docs', pattern: '**/*.{md,mdx}' }) }) };`);
  writeFileSync(join(root, "src/pages/[...slug].astro"), `---
import { getCollection, render } from 'astro:content';
export async function getStaticPaths() { return (await getCollection('docs')).map(entry => ({ params: { slug: entry.id === 'index' ? undefined : entry.id }, props: { entry } })); }
const { Content } = await render(Astro.props.entry);
---
<html><body><article><Content /></article></body></html>`);
  const build = Bun.spawn(["node", join(checkout, "site/node_modules/.bin/astro"), "build", "--root", root, "--outDir", dist], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  expect(exitCode, stdout + stderr).toBe(0);
}, 60_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function builtPage(page: typeof pages[number]) {
  const html = readFileSync(join(dist, page.output), "utf8");
  const { document } = parseHTML(html);
  const stamps = new Set([...document.querySelectorAll("[data-src]")].map((el) => el.getAttribute("data-src")));
  return { html, document, stamps };
}

for (const page of pages) test(`full build of ${page.path} stamps raw lines and revision`, () => {
  const { html, stamps } = builtPage(page);
  expect(stamps).toEqual(new Set([`${page.path}:6-6`, `${page.path}:8-10`, `${page.path}:12-12`]));
  expect(extractDocRevision(html)).toBe(createHash("sha256").update(source).digest("hex"));
});

test("build and request-time renderers produce identical provenance", async () => {
  for (const page of pages) {
    const built = builtPage(page);
    const fast = await renderProvenance(root, page.path, source);
    expect(built.stamps).toEqual(new Set(fast.blocks));
    const leaves = (document: Document) => [...document.querySelectorAll("p [data-revkit-leaf]")].map((el) => [el.getAttribute("data-revkit-leaf"), el.getAttribute("data-revkit-map")]);
    expect(leaves(built.document)).toEqual(leaves(fast.document));
  }
});

test("rail comments using built-page provenance are accepted over HTTP", async () => {
  const daemon = await startDaemon({ dir: dist, repoRoot: root, port: 0, sqlitePath: ":memory:", version: "0.0.0-test", localUserId: "reviewer", installSignalHandlers: false, logSink: { write: () => {} } });
  try {
    const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    for (const page of pages) {
      const served = await (await fetch(`${daemon.url}${page.route}`, { headers: { cookie } })).text();
      const { html, document } = builtPage(page);
      expect(extractDocRevision(served)).toBe(extractDocRevision(html));
      const revision = extractDocRevision(served)!;
      const anchor = parseDataSrc(document.querySelector("p[data-src]")!.getAttribute("data-src")!)!;
      const response = await fetch(`${daemon.url}/api/threads`, {
        method: "POST", headers: { cookie, origin: daemon.url, "content-type": "application/json" },
        body: JSON.stringify({ anchor: { ...anchor, revision }, selection: { kind: "block", version: 1, revision }, body: "Review this paragraph" }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
  } finally { await daemon.stop(); }
});
