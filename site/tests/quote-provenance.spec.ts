import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderFixture } from "./provenance-fixture.ts";
import { revisionOf, type Anchor } from "@revkit/review-core";

const PATH = "docs/probe.md";
const CLI = resolve("../packages/cli/bin/revkit.js");
interface Env { root: string; child: ChildProcess; url: string; launch: string }

async function boot(source: string, path = PATH): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "revkit-browser-provenance-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}');
  writeFileSync(join(root, path), source);
  const document = await renderFixture(root, path, source);
  writeFileSync(join(root, "dist/index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Provenance</title></head><body><main>${document.body.innerHTML}</main></body></html>`);
  const child = spawn("bun", [CLI, "serve", "--dir", join(root, "dist")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  // Drain stderr without logging launch codes or local credentials.
  child.stderr!.on("data", () => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const file = join(root, ".revkit/serve.json");
    const launch = output.match(/launch:\s+(\S+)/)?.[1];
    if (existsSync(file) && launch) {
      const state = JSON.parse(readFileSync(file, "utf8")) as { url: string };
      return { root, child, url: state.url, launch };
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
  throw new Error("Provenance test daemon did not start");
}

async function stop(env: Env): Promise<void> {
  const done = new Promise<void>((resolveDone) => env.child.once("exit", () => resolveDone()));
  env.child.kill("SIGTERM");
  await Promise.race([done, new Promise((resolveDone) => setTimeout(resolveDone, 200))]);
  if (env.child.exitCode === null && env.child.signalCode === null) env.child.kill("SIGKILL");
  await done;
  rmSync(env.root, { recursive: true, force: true });
}

async function open(page: Page, env: Env): Promise<void> {
  await page.goto(env.launch);
  await page.goto(env.url);
  await expect(page.getByTestId("revkit-rail")).toBeVisible();
}

async function select(page: Page, needle?: string, occurrence = 0, paragraph = 0): Promise<void> {
  await page.evaluate(({ needle, occurrence, paragraph }) => {
    const block = document.querySelectorAll("main p")[paragraph]!;
    const range = document.createRange();
    if (needle === undefined) range.selectNodeContents(block);
    else {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
      const text = nodes.map((n) => n.data).join("");
      let at = -1;
      for (let i = 0; i <= occurrence; i++) at = text.indexOf(needle, at + 1);
      if (at < 0) throw new Error("Browser selection text absent");
      let length = 0;
      for (const node of nodes) {
        if (at >= length && at < length + node.length) range.setStart(node, at - length);
        if (at + needle.length > length && at + needle.length <= length + node.length) range.setEnd(node, at + needle.length - length);
        length += node.length;
      }
    }
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { needle, occurrence, paragraph });
}

let commentCounter = 0;
async function comment(page: Page): Promise<Anchor> {
  return test.step("submit and read the source anchor", async () => {
  const body = `Review source provenance ${commentCounter++}`;
  await page.getByTestId("revkit-rail-new").click();
  await page.getByTestId("revkit-rail-composer").locator("textarea").fill(body);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/threads") && r.request().method() === "POST");
  await page.getByTestId("revkit-rail-composer").locator('button[type="submit"]').click();
  const reply = await response;
  expect(reply.status()).toBe(201);
  const sent = reply.request().postDataJSON();
  expect(sent.anchor.quote).toBeUndefined();
  expect(sent.selection.kind).toMatch(/^(range|block)$/);
  return await page.evaluate(async (body) => {
    const response = await fetch("/api/threads");
    const result = await response.json();
    return result.threads.find((t: { comments: { body: string }[] }) => t.comments.some((c) => c.body === body)).anchor;
  }, body) as Anchor;
  });
}

for (const [source, needle, occurrence, exact, sourceAt] of [
  ["foo\\_bar and foo_bar", "foo_bar", 0, "foo\\_bar", 0],
  ["foo\\_bar and foo_bar", "foo_bar", 1, "foo_bar", 13],
  ["A &amp; B and A & B", "A & B", 0, "A &amp; B", 0],
  ["A &amp; B and A & B", "A & B", 1, "A & B", 14],
  ["🎉 &quot;hi&quot; -- now......", "“hi” — now…", 0, "&quot;hi&quot; -- now......", 3],
  ["Use `**kwargs` then release/* and _id", "**kwargs", 0, "**kwargs", 5],
  ["A ***both*** and **_mix_** end", "both and mix", 0, "both*** and **_mix", 5],
  ["first line\r\nsecond line 🎉", "line\nsecond", 0, "line\nsecond", 6],
  ["Use ` a\nb ` here", "a b", 0, "a\nb", 6],
  ["x &NotEqualTilde; y", "≂̸", 0, "&NotEqualTilde;", 2],
] as const) test(`real browser selection: ${JSON.stringify(source)} / occurrence ${occurrence}`, async ({ page }) => {
  const env = await boot(source);
  try {
    await open(page, env);
    await select(page, needle, occurrence);
    await expect(page.getByTestId("revkit-rail-new")).toHaveText("comment on selection");
    const anchor = await comment(page);
    const lf = source.replace(/\r\n?/g, "\n");
    expect(anchor.quote.exact).toBe(exact);
    expect(anchor.quote.prefix).toBe(lf.slice(Math.max(0, sourceAt - 32), sourceAt));
    expect(anchor.quote.suffix).toBe(lf.slice(sourceAt + exact.length, sourceAt + exact.length + 32));
    expect(anchor.startLine).toBe(lf.slice(0, sourceAt).split("\n").length);
    expect(anchor.endLine).toBe(lf.slice(0, sourceAt + exact.length - 1).split("\n").length);
    expect(anchor.revision).toBe(await revisionOf(lf));
    const request = await page.evaluate(() => document.querySelector("[data-revkit-leaf]")!.childNodes.length);
    expect(request).toBe(1);
  } finally { await stop(env); }
});

test("renderer/browser property: random typography and inline syntax retain exact source bounds", async ({ page }) => {
  let random = 113;
  const next = (): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const atoms = ['"hi"', "...", "......", "&amp;amp;", "&#46;&#46;&#46;", "\\*literal\\*", "**strong**", "***both***", "` **kwargs `", "`release/*`", "_id", "f(*args)", "🎉", "[a][ref]"];
  const paragraphs = Array.from({ length: 30 }, (_, i) => `case${i}: ${Array.from({ length: 3 + next() % 5 }, () => atoms[next() % atoms.length]!).join(" ")} done.`);
  const source = paragraphs.join("\n\n") + "\n\n[ref]: https://example.com";
  const env = await boot(source);
  try {
    await open(page, env);
    let at = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      await select(page, undefined, 0, i);
      await expect(page.getByTestId("revkit-rail-new")).toHaveText("comment on selection");
      const anchor = await comment(page);
      expect(anchor.quote.exact).toBe(paragraphs[i]);
      expect(anchor.quote.prefix).toBe(source.slice(Math.max(0, at - 32), at));
      expect(anchor.quote.suffix).toBe(source.slice(at + paragraphs[i]!.length, at + paragraphs[i]!.length + 32));
      expect(anchor.startLine).toBe(2 * i + 1);
      expect(anchor.endLine).toBe(2 * i + 1);
      at += paragraphs[i]!.length + 2;
    }
  } finally { await stop(env); }
});

test("math and MDX fallbacks visibly offer a whole-block comment", async ({ page }) => {
  for (const [source, path] of [["before $x^2$ after", PATH], ["authored {1 + 1} text", "docs/probe.mdx"]]) {
    const env = await boot(source!, path);
    try {
      await open(page, env);
      await select(page);
      await expect(page.getByTestId("revkit-rail-new")).toHaveText("comment on whole block");
      const anchor = await comment(page);
      expect(anchor.quote.exact).toBe(source);
    } finally { await stop(env); }
  }
});

test("stale revision refuses submission and preserves the draft", async ({ page }) => {
  const env = await boot("alpha beta gamma");
  try {
    await open(page, env);
    await select(page, "beta");
    await page.getByTestId("revkit-rail-new").click();
    const textarea = page.getByTestId("revkit-rail-composer").locator("textarea");
    await textarea.fill("Keep this draft");
    // Change the transmitted revision after composing, without triggering a
    // filesystem reload that would discard the page itself.
    await page.route("**/api/threads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      body.selection.revision = "0".repeat(64);
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByTestId("revkit-rail-composer").locator('button[type="submit"]').click();
    await expect(page.getByRole("alert")).toContainText("your draft is still here");
    await expect(textarea).toHaveValue("Keep this draft");
  } finally { await stop(env); }
});

test("a sub-line anchor focuses its containing source block", async ({ page }) => {
  const env = await boot("first line\nchosen phrase\nlast line");
  try {
    await open(page, env);
    const posted = page.waitForResponse((r) => r.url().endsWith("/api/threads") && r.request().method() === "POST");
    await page.evaluate((path) => { void fetch("/api/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: { path, startLine: 2, endLine: 2, revision: "a".repeat(64), quote: { exact: "chosen phrase", prefix: "", suffix: "" } }, body: "Focus this source line" }),
    }); }, PATH);
    expect((await posted).status()).toBe(201);
    await page.reload();
    await page.getByTestId("revkit-rail-thread").locator("button[data-anchor-kind=line]").click();
    await expect(page.locator("main p[data-src]")).toHaveAttribute("data-rail-focus", "true");
  } finally { await stop(env); }
});
