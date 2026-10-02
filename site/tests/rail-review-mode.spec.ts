// Rail review-mode Playwright spec — PR #59 round-2.
//
// Drives the review-mode rail against the STRICT fake GitHub
// (packages/cli/test/review/helpers/fake-github.ts). Runs on
// BUILT output — the daemon serves site/dist with the injected
// rail bundle, and Playwright drives the real DOM. Chromium-only
// (WebKit is #19). Axe gate at every phase.
//
// The daemon runs as a `bun` subprocess (needed for `bun:sqlite`)
// launched from `site/tests/fixtures/review-mode-daemon/boot.ts`,
// which wires a fake fetch into the review adapter and exposes a
// control HTTP surface for the spec to poke:
//   POST /control/inject       — arm the NEXT mutation to fail;
//   POST /control/clear-inject — clear the arm;
//   GET  /control/pending      — read the fake's state;
//   POST /control/set-head     — bump the PR head sha.
//
// Two tests, each covering one arc:
//   Test 1: comment → pending; failure → Retry; submit-gated;
//           discard two-step; axe clean.
//   Test 2: stale-head → re-anchor with orphan panel; axe clean.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const BOOT_SCRIPT = resolve(__dirname, "fixtures", "review-mode-daemon", "boot.ts");

const FIXTURE_REL_PATH = "docs/rail-review-mode.md";
const FIXTURE_PARAGRAPH_TEXT = "The rail submits pending drafts to the reviewer's PENDING GitHub review.";
const FIXTURE_SELECTED_QUOTE = "rail submits pending drafts";
const FIXTURE_HEAD_A = "1234567890abcdef1234567890abcdef12345678";
const FIXTURE_HEAD_B = "abcdef1234567890abcdef1234567890abcdef12";

interface BootInfo {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchUrl: string;
  readonly controlUrl: string;
}

interface DaemonCtx extends BootInfo {
  readonly child: ChildProcess;
  readonly root: string;
}

async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) {
    throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  }
  const root = mkdtempSync(join(tmpdir(), "revkit-rrm-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(FIXTURE_REL_PATH)), { recursive: true });
  writeFileSync(
    join(root, FIXTURE_REL_PATH),
    `# Rail review-mode fixture\n\n${FIXTURE_PARAGRAPH_TEXT}\ntail line\n`,
    "utf8",
  );
  const child = spawn(
    "bun",
    [
      BOOT_SCRIPT,
      "--dir", DIST,
      "--repo-root", root,
      "--fixture-path", FIXTURE_REL_PATH,
      "--head-a", FIXTURE_HEAD_A,
      "--control-port", "0",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    stderrChunks.push(s);
    if (process.env.REVKIT_E2E_LOG === "1") process.stderr.write(`[boot.stderr] ${s}`);
  });
  child.stdout?.on("data", (b: Buffer) => stdoutChunks.push(b.toString("utf8")));
  child.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(
        `[rail-rm] daemon exited ${code}/${sig}\nstderr:\n${stderrChunks.join("")}\nstdout:\n${stdoutChunks.join("")}\n`,
      );
    }
  });
  const deadline = Date.now() + 30_000;
  let info: BootInfo | undefined;
  while (Date.now() < deadline) {
    const joined = stdoutChunks.join("");
    const line = joined.split("\n").find((l) => l.trim().startsWith("{"));
    if (line !== undefined) {
      try {
        info = JSON.parse(line) as BootInfo;
        break;
      } catch { /* mid-write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (info === undefined) {
    try { child.kill("SIGTERM"); } catch { /* fine */ }
    throw new Error(
      `boot did not print a JSON info line within 30s\nstderr: ${stderrChunks.join("")}\nstdout: ${stdoutChunks.join("")}`,
    );
  }
  return { ...info, child, root };
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try { ctx.child.kill("SIGTERM"); } catch { /* fine */ }
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* fine */ }
}

function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-review-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail review fixture</title></head>
     <body>
       <main>
         <h1 data-src="${FIXTURE_REL_PATH}:1-1">Rail review-mode fixture</h1>
         <p id="target" data-src="${FIXTURE_REL_PATH}:3-3">${FIXTURE_PARAGRAPH_TEXT}</p>
         <p id="target2" data-src="${FIXTURE_REL_PATH}:4-4">tail line</p>
       </main>
     </body></html>`,
    "utf8",
  );
  return {
    relPath,
    cleanup: (): void => {
      try { rmSync(abs, { force: true }); } catch { /* fine */ }
    },
  };
}

async function selectSubstring(page: Page, targetId: string, substring: string): Promise<void> {
  await page.evaluate(
    ({ id, needle }: { id: string; needle: string }) => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`no #${id}`);
      const textNode = el.firstChild;
      if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
        throw new Error(`${id} has no text node`);
      }
      const full = textNode.textContent ?? "";
      const start = full.indexOf(needle);
      if (start < 0) throw new Error(`'${needle}' not in '${full}'`);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + needle.length);
      const sel = window.getSelection();
      if (sel === null) throw new Error("no selection API");
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    },
    { id: targetId, needle: substring },
  );
}

interface PendingSnapshot {
  reviewNodeId: string | null;
  commitOid: string | null;
  drafts: readonly unknown[];
  submits: readonly { reviewNodeId: string; event: string }[];
  deletes: readonly { reviewNodeId: string }[];
  replies: readonly unknown[];
  resolutions: readonly unknown[];
  submittedReviewIds: readonly string[];
}

async function readPending(controlUrl: string): Promise<PendingSnapshot> {
  const r = await fetch(`${controlUrl}/control/pending`);
  return (await r.json()) as PendingSnapshot;
}

async function armInjection(controlUrl: string, mutation: string): Promise<void> {
  await fetch(`${controlUrl}/control/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mutation }),
  });
}

async function clearInjection(controlUrl: string): Promise<void> {
  await fetch(`${controlUrl}/control/clear-inject`, { method: "POST" });
}

async function setHead(controlUrl: string, sha: string): Promise<void> {
  await fetch(`${controlUrl}/control/set-head`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha }),
  });
}

async function assertAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function cookieHeader(page: Page): Promise<string> {
  return (await page.context().cookies())
    .filter((c) => c.domain.includes("127.0.0.1") || c.domain.includes("localhost"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

test.describe("rail review-mode @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test("comment → pending; injected AddThread failure → Retry syncs; submit gated on unsynced; discard two-step; axe clean", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // ── Phase 1: comment → pending draft on the fake ─────
      await selectSubstring(page, "target", FIXTURE_SELECTED_QUOTE);
      await expect(page.getByTestId("revkit-rail-floating")).toBeVisible();
      await page.getByTestId("revkit-rail-floating").click();
      const composer = page.getByTestId("revkit-rail-composer");
      await expect(composer).toBeVisible();
      await page.getByTestId("revkit-rail-composer-input").fill("first review comment");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();
      await expect(composer).toBeHidden();

      await expect.poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 }).toBe(1);
      await expect(page.getByTestId("revkit-rail-review-count")).toContainText("1 pending comment");
      await expect(page.getByTestId("revkit-rail-review-unsynced")).toBeHidden();
      const submit = page.getByTestId("revkit-rail-review-submit-button");
      await expect(submit).toBeEnabled();

      // ── Phase 2: injected AddThread failure → Retry ──────
      await armInjection(daemon.controlUrl, "AddThread");
      await selectSubstring(page, "target2", "tail line");
      await expect(page.getByTestId("revkit-rail-floating")).toBeVisible();
      await page.getByTestId("revkit-rail-floating").click();
      await expect(composer).toBeVisible();
      await page.getByTestId("revkit-rail-composer-input").fill("second review comment (will fail on GitHub)");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();
      await expect(composer).toBeHidden();

      const unsynced = page.getByTestId("revkit-rail-review-unsynced");
      await expect(unsynced).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator("[data-testid=\"revkit-rail-review-unsynced-item\"][data-sync-kind=\"failed\"]"),
      ).toHaveCount(1);
      // Submit is disabled while unsynced.
      await expect(submit).toBeDisabled();

      // Retry — the reconciler READS GitHub first, then posts.
      await clearInjection(daemon.controlUrl);
      await page.getByTestId("revkit-rail-review-unsynced-retry").click();
      await expect(unsynced).toBeHidden({ timeout: 15_000 });
      await expect(submit).toBeEnabled();
      await expect.poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 }).toBe(2);
      await assertAxeClean(page);

      // ── Phase 3: discard two-step ─────────────────────────
      const discard = page.getByTestId("revkit-rail-review-discard");
      await discard.click();
      await expect(discard).toHaveAttribute("data-discard-armed", "true");
      // Second click fires.
      await discard.click();
      await expect
        .poll(async () => (await readPending(daemon.controlUrl)).reviewNodeId, { timeout: 15_000 })
        .toBeNull();
      await expect(page.getByTestId("revkit-rail-review-count")).toContainText("No pending review comments yet");

      await assertAxeClean(page);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("stale-head → re-anchor abandons old pending, moves survivors, orphans dead quotes; axe clean", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Post two comments — one that will survive re-anchor (its
      // quote is still in the file, moved to a new line), one that
      // will orphan (quoted text removed from the file).
      const composer = page.getByTestId("revkit-rail-composer");
      const composerInput = page.getByTestId("revkit-rail-composer-input");
      await selectSubstring(page, "target", FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      await composerInput.fill("survivor comment");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();
      await expect(composer).toBeHidden();

      await selectSubstring(page, "target2", "tail line");
      await page.getByTestId("revkit-rail-floating").click();
      await composerInput.fill("will-orphan comment");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();
      await expect(composer).toBeHidden();

      await expect.poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 }).toBe(2);

      // Rewrite the source so "tail line" is gone and the
      // paragraph moved down two lines. Bump the head sha.
      writeFileSync(
        join(daemon.root, FIXTURE_REL_PATH),
        `# Rail review-mode fixture\n\n\n\n${FIXTURE_PARAGRAPH_TEXT}\n`,
        "utf8",
      );
      await setHead(daemon.controlUrl, FIXTURE_HEAD_B);

      const cookieStr = await cookieHeader(page);
      const refresh = await fetch(`${daemon.url}/api/review/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: daemon.url,
          "sec-fetch-site": "same-origin",
          cookie: cookieStr,
        },
        body: "{}",
      });
      expect([200, 201]).toContain(refresh.status);
      await expect(page.getByTestId("revkit-rail-review-stale")).toBeVisible({ timeout: 15_000 });

      const reanchor = await fetch(`${daemon.url}/api/review/reanchor`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: daemon.url,
          "sec-fetch-site": "same-origin",
          cookie: cookieStr,
        },
        body: "{}",
      });
      expect(reanchor.status).toBe(201);
      const body = (await reanchor.json()) as {
        ok: boolean;
        newIntents: number;
        orphaned: number;
        repositions: Array<{ outcome: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.repositions.some((r) => r.outcome === "orphaned")).toBe(true);

      await expect(page.getByTestId("revkit-rail-orphans")).toBeVisible({ timeout: 15_000 });
      // At least one orphan item is visible.
      await expect(page.getByTestId("revkit-rail-orphan").first()).toBeVisible();

      await assertAxeClean(page);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});
