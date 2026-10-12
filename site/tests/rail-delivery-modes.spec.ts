// Playwright rail mode-switch + mention chip test (M2 item 6,
// ADR-0007 delivery modes + ADR-0011 typed mentions).
//
// Boots a real daemon, opens the rail against a stable HTML fixture,
// and drives the mode picker + posts a comment carrying `@agent now`
// so:
//   - the mode-switch fieldset renders with all three options;
//   - the `handover` batched-count badge appears after posting a
//     comment under handover;
//   - the "Hand over" button flushes the batch (count returns to 0);
//   - the `@agent now` mention renders as a chip with the marker
//     class (`revkit-rail__mention--agent-now`);
//   - axe reports no violations with the rail open.
//
// The daemon is started in a temp workspace outside the repo so the
// site's dist stays untouched. Chromium-only (WebKit is #19).

import { bootDaemon as startTestDaemon, stopDaemon } from "./helpers/daemon.ts";
import { provenanceFixture } from "./provenance-fixture.ts";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mintLaunchUrl } from "./fixtures/launch-code";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");
const FIXTURE_REL_PATH = "docs/adr/0003-content-model-mdx-typed-data.md";
const FIXTURE_START_LINE = 5;
const FIXTURE_PARAGRAPH_TEXT = "Rail delivery-mode fixture paragraph anchored to a stamped block.";
const FIXTURE_SELECTED = "delivery-mode fixture paragraph";

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly agentToken: string;
  readonly port: number;
}

async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist missing at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-rt-mode-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(FIXTURE_REL_PATH)), { recursive: true });
  writeFileSync(
    join(root, FIXTURE_REL_PATH),
    `# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`,
    "utf8",
  );
  const ctx = await startTestDaemon({ root, args: [REVKIT_BIN, "serve", "--dir", DIST] });
  return ctx;
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  await stopDaemon(ctx.child);
  rmSync(ctx.root, { recursive: true, force: true });
}

async function writeFixture(): Promise<{ path: string; cleanup: () => void }> {
  // Round-3: per-process unique fixture path so a parallel spec run
  // (were fullyParallel to reach us) can't collide with a shared
  // `site/dist/rail-mode-fixture.html` write.
  const unique = process.pid.toString(36) + "-" + Date.now().toString(36);
  const rel = `rail-mode-fixture-${unique}.html`;
  const abs = join(DIST, rel);
  // A minimal accessible fixture: <h1> for axe's page-has-heading-one
  // rule, one data-src'd paragraph so the rail's selection listener
  // has something to anchor a comment to.
  writeFileSync(
    abs,
    await provenanceFixture(`# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`, FIXTURE_REL_PATH, FIXTURE_START_LINE),
    "utf8",
  );
  return {
    path: rel,
    cleanup: () => { try { rmSync(abs, { force: true }); } catch { /* ignore */ } },
  };
}

async function selectSubstring(page: Page, needle: string): Promise<void> {
  await page.evaluate((n: string) => {
    const target = document.getElementById("target");
    if (target === null) throw new Error("no target");
    const textNode = target.querySelector("[data-revkit-leaf]")?.firstChild ?? null;
    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) throw new Error("no text node");
    const raw = textNode.textContent ?? "";
    const start = raw.indexOf(n);
    if (start < 0) throw new Error("needle not in text");
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + n.length);
    const sel = window.getSelection();
    if (sel === null) throw new Error("no selection API");
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, needle);
}

// Round-3: force serial mode. `fullyParallel: true` at the config
// level was splitting these tests across workers; each worker's
// `beforeAll` boots a daemon AND writes to a SHARED fixture path
// under `site/dist/`. Two workers colliding on that write (or one
// worker's afterAll deleting the fixture while another is still
// reading it) caused the axe test to intermittently time out
// waiting for the rail to load a fixture that no longer existed.
// Serial mode means one worker runs the whole file — the daemon
// and fixture are boot-once, tear-down-once.
test.describe.configure({ mode: "serial" });

test.describe("rail delivery modes + mention chips (M2 item 6)", () => {
  let ctx: DaemonCtx;
  let fixture: { path: string; cleanup: () => void };
  test.beforeAll(async () => {
    ctx = await bootDaemon();
    fixture = await writeFixture();
  });
  test.afterAll(async () => {
    fixture?.cleanup();
    if (ctx !== undefined) await shutdown(ctx);
  });

  // Each test opens the daemon with a FRESHLY MINTED launch URL (round-3:
  // the code is single-use and Playwright gives every test a fresh browser
  // context, so no cookie carries over). See `fixtures/launch-code.ts`.
  test("mode switch renders and flipping to `live` reaches the daemon", async ({ page }) => {
    await page.goto(await mintLaunchUrl(ctx), { waitUntil: "domcontentloaded" });
    await page.goto(`${ctx.url}/${fixture.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="revkit-rail"]');
    // Mode fieldset is present with all three options.
    await page.waitForSelector('[data-testid="revkit-rail-mode-handover"]');
    await page.waitForSelector('[data-testid="revkit-rail-mode-live"]');
    await page.waitForSelector('[data-testid="revkit-rail-mode-quiet"]');
    // Default: handover selected.
    const handoverSelected = await page
      .locator('[data-testid="revkit-rail-mode-handover"]')
      .getAttribute("data-selected");
    expect(handoverSelected).toBe("true");
    // Flip to live.
    await page.locator('[data-testid="revkit-rail-mode-live"] input[type=radio]').check();
    // Wait for the state to reflect the change (SSE handover fanout OR direct refetch).
    await page.waitForFunction(
      () => document.querySelector('[data-testid="revkit-rail-mode-live"]')?.getAttribute("data-selected") === "true",
      { timeout: 5000 },
    );
    // Verify server-side via GET /api/delivery-mode (same-origin fetch).
    const daemonSaidLive = await page.evaluate(async () => {
      const response = await fetch("/api/delivery-mode", { credentials: "same-origin" });
      const parsed = await response.json();
      return parsed.mode === "live";
    });
    expect(daemonSaidLive).toBe(true);
  });

  test("`@agent now` in a comment renders as an agent-now chip", async ({ page }) => {
    await page.goto(await mintLaunchUrl(ctx), { waitUntil: "domcontentloaded" });
    // Force mode to live so posting a comment does not stay batched (the
    // rail's mention rendering is independent of mode, but the flow
    // through-the-daemon assertion is simpler when the comment shows up).
    await page.evaluate(async () => {
      await fetch("/api/delivery-mode", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "live" }),
      });
    });
    await page.goto(`${ctx.url}/${fixture.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="revkit-rail"]');
    await selectSubstring(page, FIXTURE_SELECTED);
    await page.waitForSelector('[data-testid="revkit-rail-floating"]', { timeout: 5000 });
    await page.click('[data-testid="revkit-rail-floating"]');
    await page.waitForSelector('[data-testid="revkit-rail-composer"]');
    const body = "Hey @agent now please review this batch";
    await page.fill('[data-testid="revkit-rail-composer-input"]', body);
    await page.click('[data-testid="revkit-rail-submit"]');
    // The comment now appears in the rail with a chip.
    await page.waitForSelector(
      '[data-testid="revkit-rail-mention"][data-mention-kind="agent-now"]',
      { timeout: 5000 },
    );
    const chip = page.locator('[data-testid="revkit-rail-mention"][data-mention-kind="agent-now"]').first();
    await expect(chip).toContainText("@agent now");
  });

  test("handover flushes on 'Hand over' click (batched → 0)", async ({ page }) => {
    // Ensure mode is handover for this test — the previous test left it
    // in `live`, so reset explicitly.
    await page.goto(await mintLaunchUrl(ctx), { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      await fetch("/api/delivery-mode", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "handover" }),
      });
    });
    await page.goto(`${ctx.url}/${fixture.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="revkit-rail"]');
    // Post a comment via the DOM.
    await selectSubstring(page, FIXTURE_SELECTED);
    await page.waitForSelector('[data-testid="revkit-rail-floating"]');
    await page.click('[data-testid="revkit-rail-floating"]');
    await page.waitForSelector('[data-testid="revkit-rail-composer"]');
    await page.fill('[data-testid="revkit-rail-composer-input"]', "quiet feedback, no rush");
    await page.click('[data-testid="revkit-rail-submit"]');
    // The batched badge should appear.
    await page.waitForSelector('[data-testid="revkit-rail-batched"]', { timeout: 5000 });
    // Click hand over.
    await page.click('[data-testid="revkit-rail-handover"]');
    // The batched section disappears — the batch went to zero.
    await page.waitForSelector('[data-testid="revkit-rail-batched"]', {
      state: "hidden",
      timeout: 5000,
    });
  });

  test("axe reports no violations with the mode UI + a mention chip on the page", async ({ page }) => {
    await page.goto(await mintLaunchUrl(ctx), { waitUntil: "domcontentloaded" });
    await page.goto(`${ctx.url}/${fixture.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="revkit-rail"]');
    // Round-2 fix: wait for the delivery-mode UI to be READY before
    // running axe. The rail loads asynchronously (mode is fetched
    // from /api/delivery-mode after the page's SSE subscription
    // settles). Waiting for a stable selector, not a fixed timeout,
    // stops the intermittent race the reviewer observed in the full
    // suite where axe fired before the fieldset rendered.
    await page.waitForSelector('[data-testid="revkit-rail-mode"] fieldset');
    // Also wait until at least one mode radio is `data-selected="true"`
    // — that only happens once `fetchDeliveryMode` has resolved.
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-testid^="revkit-rail-mode-"][data-selected="true"]',
        ).length > 0,
      { timeout: 10_000 },
    );
    const results = await new AxeBuilder({ page }).analyze();
    // ADR-0017 gate: zero violations at any severity.
    expect(results.violations).toEqual([]);
  });
});
