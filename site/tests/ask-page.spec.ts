// Playwright: the `/ask/<id>` route renders every ask kind, accepts
// a real answer through the DOM, and is axe-clean under
// ADR-0017's strict "any violation" gate.
//
// Six specs, one per kind (choice, rank, scale, text, region,
// review). Each boots an isolated `revkit serve` in a temp
// workspace, POSTs the ask as the agent, opens the browser at the
// launch URL with next set to the ask path, interacts with the
// widget to submit an answer, verifies the record went `answered`
// via the JSON API, and runs axe against the page. A separate
// spec asserts the pages CSP is present, has default-src none,
// names the ask bundle path, does not allow unsafe-eval, and that
// an agent-supplied script-tag title lands as text, not HTML.
//
// Chromium only (WebKit is #19). Loads the daemon on 127.0.0.1 to
// avoid the localhost redirect for the events stream.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchUrl: string;
}

async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-ask-page-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  const child = spawn("bun", [REVKIT_BIN, "serve", "--dir", DIST], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: process.env,
  });
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[ask-page] daemon exited ${code}/${signal}\nstderr:\n${stderrChunks.join("")}\n`);
    }
  });
  const deadline = Date.now() + 15_000;
  let state: { readonly port: number; readonly url: string; readonly agentToken: string } | undefined;
  while (Date.now() < deadline) {
    const path = join(root, ".revkit", "serve.json");
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf8"));
        break;
      } catch { /* mid-write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state === undefined) {
    child.kill("SIGTERM");
    throw new Error(`daemon did not write serve.json within 15s`);
  }
  const deadline2 = Date.now() + 3000;
  let launchUrl: string | undefined;
  while (Date.now() < deadline2) {
    const match = stdoutChunks.join("").match(/launch:\s+(\S+)/);
    if (match !== null) { launchUrl = match[1]; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  if (launchUrl === undefined) {
    child.kill("SIGTERM");
    throw new Error(`daemon printed no launch: line`);
  }
  return { child, root, url: state.url, port: state.port, agentToken: state.agentToken, launchUrl };
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try { ctx.child.kill("SIGTERM"); } catch { /* dead */ }
  await new Promise((r) => setTimeout(r, 200));
  rmSync(ctx.root, { recursive: true, force: true });
}

async function createAsk(ctx: DaemonCtx, spec: Record<string, unknown>): Promise<{ id: string; url: string }> {
  const response = await fetch(`${ctx.url}/api/asks`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${ctx.port}`,
      origin: `http://127.0.0.1:${ctx.port}`,
      authorization: `Bearer ${ctx.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ spec }),
  });
  if (!response.ok) throw new Error(`createAsk failed: ${response.status} ${await response.text()}`);
  const parsed = (await response.json()) as { ask: { id: string }; url: string };
  return { id: parsed.ask.id, url: parsed.url };
}

async function openAskPage(ctx: DaemonCtx, page: Page, id: string): Promise<void> {
  // Land through the launch URL so the browser gets the session cookie.
  const url = new URL(ctx.launchUrl);
  url.searchParams.set("next", `/ask/${id}`);
  const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  if (response === null) throw new Error("goto returned null");
  expect(response.status()).toBeLessThan(400);
  await page.waitForSelector('[data-testid="revkit-ask-root"]', { timeout: 5000 });
}

async function readAsk(ctx: DaemonCtx, id: string): Promise<{ status: string; answer?: unknown }> {
  const response = await fetch(`${ctx.url}/api/asks/${id}`, {
    headers: {
      host: `127.0.0.1:${ctx.port}`,
      origin: `http://127.0.0.1:${ctx.port}`,
      authorization: `Bearer ${ctx.agentToken}`,
    },
  });
  const parsed = (await response.json()) as { ask: { status: string; answer?: unknown } };
  return parsed.ask;
}

async function scanAxeOnRoot(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).include('[data-testid="revkit-ask-root"]').analyze();
  expect(results.violations, `axe violations: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

let ctx: DaemonCtx;

test.beforeAll(async () => { ctx = await bootDaemon(); });
test.afterAll(async () => { if (ctx !== undefined) await shutdown(ctx); });

test.describe("/ask/<id> — CSP + shell", () => {
  test("CSP names /-/ask.js and refuses eval; agent-supplied title lands as text", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "text",
      // A hostile title: raw HTML must NOT execute or land as tags.
      title: "<script>window.__revkit_xss=true</script>Trust me?",
      multiline: false,
    });
    const url = new URL(ctx.launchUrl);
    url.searchParams.set("next", `/ask/${id}`);
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    expect(response!.status()).toBe(200);
    const csp = response!.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("/-/ask.js");
    expect(csp).not.toContain("'unsafe-eval'");
    await page.waitForSelector('[data-testid="revkit-ask-root"]');
    // The whole title (script tag AND label) lands as text.
    const titleText = await page.locator(".revkit-ask__title").innerText();
    expect(titleText).toContain("<script>");
    expect(titleText).toContain("Trust me?");
    // The injected script did not execute.
    const xss = await page.evaluate(() => (window as unknown as { __revkit_xss?: boolean }).__revkit_xss);
    expect(xss).toBeUndefined();
  });
});

test.describe("/ask/<id> — six kinds render, answer, and pass axe", () => {
  test("choice: pick one option and submit", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "choice",
      title: "Which storage?",
      options: [
        { id: "d1", label: "Cloudflare D1" },
        { id: "kv", label: "Workers KV" },
      ],
      allowOther: false,
      multi: false,
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    await page.locator("#revkit-ask-choice-d1").check();
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.status).toBe("answered");
    expect(record.answer).toEqual({ kind: "choice", value: "d1" });
  });

  test("rank: reorder options and submit", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "rank",
      title: "Prefer which order?",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
        { id: "c", label: "Charlie" },
      ],
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    // Move alpha down by one — new order should be b, a, c.
    await page.getByLabel("Move Alpha down").click();
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.status).toBe("answered");
    expect(record.answer).toEqual({ kind: "rank", ranking: ["b", "a", "c"] });
  });

  test("scale: submit disabled until the slider is touched; keyboard picks a value on 0..10", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "scale",
      title: "Confidence?",
      min: 0,
      max: 10,
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    // PR #52 round-2 review — no preselected default. Submit is
    // disabled until the slider is touched, and the visible
    // output reads "(pick a value)" until then.
    const submit = page.locator('[data-testid="revkit-ask-submit"]');
    await expect(submit).toBeDisabled();
    await expect(page.locator('[data-testid="revkit-ask-scale-value"]')).toContainText("pick a value");
    // Drive the slider from the keyboard — from step 0, arrow-right
    // three times lands on step 3 (value 3 on `min=0, step=1`).
    const range = page.locator('[data-testid="revkit-ask-scale-input"]');
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.status).toBe("answered");
    expect((record.answer as { value: number }).value).toBe(3);
  });

  test("PR #52 round-2 review — scale on 1..4 (odd span, off-step midpoint would be 2.5): default is not preselected, and a submitted value is a valid step", async ({ page }) => {
    // Repro of the round-2 blocker: `(min+max)/2 = 2.5` is off
    // the step lattice on `1..4 step 1`, so the old code refused
    // its own default. With the fix, the default is not
    // preselected — submit is disabled until touch — and the
    // integer-step-index representation makes it impossible to
    // land off the lattice.
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "scale",
      title: "1..4",
      min: 1,
      max: 4,
      step: 1,
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    await expect(page.locator('[data-testid="revkit-ask-submit"]')).toBeDisabled();
    // From step 0 (value 1), arrow-right once reaches step 1 (value 2).
    const range = page.locator('[data-testid="revkit-ask-scale-input"]');
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-testid="revkit-ask-submit"]')).toBeEnabled();
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect((record.answer as { value: number }).value).toBe(2);
  });

  test("PR #52 round-2 review — scale on 0..9 step 3: only 0, 3, 6, 9 are reachable, and submit lands on a valid step", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "scale",
      title: "0..9, step 3",
      min: 0,
      max: 9,
      step: 3,
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    // From step 0 (value 0), two arrow-rights land on step 2 (value 6).
    const range = page.locator('[data-testid="revkit-ask-scale-input"]');
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect((record.answer as { value: number }).value).toBe(6);
  });

  test("text: type an answer and submit", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "text",
      title: "What did we miss?",
      multiline: false,
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    await page.locator("#revkit-ask-text").fill("nothing important");
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.answer).toEqual({ kind: "text", text: "nothing important" });
  });

  test("region: keyboard fallback picks the centre and submits", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "region",
      title: "Highlight the anomaly",
      target: "plots/example/spec.vl.json",
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    // Focus the canvas and press Enter — the keyboard fallback
    // places the marker at the centre.
    const canvas = page.locator(".revkit-ask__region-canvas");
    await canvas.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.status).toBe("answered");
    expect((record.answer as { coordinates: number[] }).coordinates).toEqual([0.5, 0.5]);
  });

  test("review: approve and submit", async ({ page }) => {
    const { id } = await createAsk(ctx, {
      schemaVersion: 1,
      kind: "review",
      title: "Merge?",
      target: "docs/adr/0007-agent-bridge-mcp-channel.md",
    });
    await openAskPage(ctx, page, id);
    await scanAxeOnRoot(page);
    await page.locator("#revkit-ask-review-approve").check();
    await page.locator('[data-testid="revkit-ask-submit"]').click();
    await expect(page.locator('[data-testid="revkit-ask-root"]')).toHaveAttribute("data-status", "answered", { timeout: 5000 });
    const record = await readAsk(ctx, id);
    expect(record.answer).toEqual({ kind: "review", decision: "approve" });
  });
});
