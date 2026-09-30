// Rail resolved-thread visibility spec (issue #60).
//
// The bug this spec pins:
//
//   The reviewer posts a comment. The agent's channel bundles
//   `reply` and `resolve` in the same turn, so
//   `comment.replied` + `thread.resolved` events land 300-400 ms
//   apart. The pre-fix rail filtered `resolved` threads out of
//   `fetchThreads`, so the reply was only visible in the DOM for
//   that narrow window before vanishing. A reviewer with only the
//   rail open never saw the ack — and a reload did not help,
//   because the daemon's status filter still excluded resolved.
//
// The fix (this repo's amendment): resolved threads stay visible
// in the rail, anchored to their block, in a collapsed row like
// GitHub does. When agent activity landed since the human last
// looked, the thread stays expanded with an "unread" pill until
// the human acknowledges it. Runs on BUILT output — the rail
// bundle is what the daemon serves.
//
// Chromium-only (WebKit is #19). axe gate at each of the three
// states: collapsed, expanded, unread.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

const FIXTURE_REL_PATH = "docs/adr/0003-content-model-mdx-typed-data.md";
const FIXTURE_START_LINE = 5;
const FIXTURE_END_LINE = 5;
const FIXTURE_PARAGRAPH_TEXT = "The rail selects text inside a stamped block and opens the composer.";
const FIXTURE_SELECTED_QUOTE = "rail selects text inside a stamped block";

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly launchUrl: string;
  readonly agentToken: string;
  readonly port: number;
}

async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-60-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  const seedRelPath = FIXTURE_REL_PATH;
  mkdirSync(join(root, dirname(seedRelPath)), { recursive: true });
  writeFileSync(
    join(root, seedRelPath),
    "# Title\n\nline 2\nline 3\nline 4\nline 5\nline 6\n",
    "utf8",
  );
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
      process.stderr.write(
        `[rail-60] daemon exited ${code}/${signal}\nstderr:\n${stderrChunks.join("")}\nstdout:\n${stdoutChunks.join("")}\n`,
      );
    }
  });
  const deadline = Date.now() + 15_000;
  let state: { readonly pid: number; readonly port: number; readonly url: string; readonly agentToken: string } | undefined;
  while (Date.now() < deadline) {
    const path = join(root, ".revkit", "serve.json");
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf8"));
        break;
      } catch {
        // Mid-write; retry.
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state === undefined) {
    child.kill("SIGTERM");
    throw new Error(
      `revkit serve did not write serve.json within 15s\nstderr: ${stderrChunks.join("")}\nstdout: ${stdoutChunks.join("")}`,
    );
  }
  const deadline2 = Date.now() + 2000;
  while (Date.now() < deadline2) {
    if (stdoutChunks.join("").match(/launch:\s+(\S+)/)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const launchUrl = stdoutChunks.join("").match(/launch:\s+(\S+)/)?.[1];
  if (launchUrl === undefined) {
    child.kill("SIGTERM");
    throw new Error(`daemon started but never printed 'launch:' — stdout: ${stdoutChunks.join("")}`);
  }
  return { child, root, url: state.url, port: state.port, agentToken: state.agentToken, launchUrl };
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try {
    ctx.child.kill("SIGTERM");
  } catch {
    // Already dead.
  }
  await new Promise((r) => setTimeout(r, 200));
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Write the same fixture the round-trip spec uses so we can drive
 * a real DOM selection against a predictable `data-src` block. */
function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-60-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail 60 fixture</title></head>
     <body>
       <main>
         <h1 data-src="${FIXTURE_REL_PATH}:1-1">Rail issue #60 fixture</h1>
         <p id="target" data-src="${FIXTURE_REL_PATH}:${FIXTURE_START_LINE}-${FIXTURE_END_LINE}">${FIXTURE_PARAGRAPH_TEXT}</p>
       </main>
     </body></html>`,
    "utf8",
  );
  return {
    relPath,
    cleanup: (): void => {
      try {
        rmSync(abs, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function selectSubstring(page: Page, substring: string): Promise<void> {
  await page.evaluate((needle: string): void => {
    const paragraph = document.getElementById("target");
    if (paragraph === null) throw new Error("no #target paragraph");
    const textNode = paragraph.firstChild;
    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error("target has no text node");
    }
    const full = textNode.textContent ?? "";
    const start = full.indexOf(needle);
    if (start < 0) throw new Error(`'${needle}' not found in '${full}'`);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    const sel = window.getSelection();
    if (sel === null) throw new Error("no selection API");
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  }, substring);
}

test.describe("rail resolved-thread visibility (issue #60) @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test("agent replies then resolves in a tight window; reply stays visible and is marked unread", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      // Step 1 — launch flow, then open the fixture.
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();

      // Step 2 — the reviewer selects text and posts a comment
      // through the rail's real DOM composer. This is the exact
      // path the round-trip spec exercises; the bug can only fire
      // when the thread was created by the human first.
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await expect(page.getByTestId("revkit-rail-floating")).toBeVisible();
      await page.getByTestId("revkit-rail-floating").click();
      await expect(page.getByTestId("revkit-rail-composer")).toBeVisible();
      await page.getByTestId("revkit-rail-composer-input").fill("what should this say?");
      await page.getByTestId("revkit-rail-submit").click();
      await expect(page.getByTestId("revkit-rail-composer")).toBeHidden();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

      // Step 3 — read the thread id back through the daemon so we
      // can drive the fake agent against it. The daemon requires
      // the agent bearer plus a loopback Host header.
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
      };
      expect(list.threads.length).toBe(1);
      const threadId = list.threads[0]!.id;
      const parentId = list.threads[0]!.comments[0]!.id;

      // Step 4 — a fake agent immediately replies and resolves
      // through the API with the agent bearer. This is the race
      // the harness caught (reply + resolve inside 300-400 ms).
      // The agent bearer makes the daemon resolve the actor as
      // `agent`, so `comment.replied.actor.kind === "agent"` and
      // `thread.resolved.actor.kind === "agent"` on the log —
      // exactly what the reducer needs to project `resolvedBy`.
      const replyRes = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadId)}/replies`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parentId, body: "ack — the fix is trivial" }),
      });
      expect(replyRes.status).toBe(201);
      const resolveRes = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadId)}/resolve`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(resolveRes.status).toBeLessThan(300);

      // Step 5 — after BOTH events, the reply is still visible in
      // the rail and the thread carries the unread pill. This is
      // the pre-fix regression point: `fetchThreads` filtered the
      // resolved thread out and the reply vanished from the DOM.
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1, { timeout: 5000 });
      await expect(page.locator(".revkit-rail__thread")).toContainText("ack — the fix is trivial", { timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible();

      // Step 6 — a full reload also shows the reply (unread
      // persists via localStorage until the reviewer acknowledges).
      // Pre-fix, a reload showed nothing.
      await page.reload();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      await expect(page.locator(".revkit-rail__thread")).toContainText("ack — the fix is trivial");
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible();

      // Step 7 — the header shows "Resolved (1)".
      await expect(page.getByTestId("revkit-rail-resolved-count")).toContainText("Resolved");
      await expect(page.getByTestId("revkit-rail-resolved-count")).toContainText("1");

      // Step 8 — axe on the unread + expanded state.
      {
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations,
          JSON.stringify(results.violations, null, 2),
        ).toEqual([]);
      }

      // Step 9 — clicking the disclosure marks it seen and
      // collapses the thread body (a resolved-seen thread is
      // collapsed by default, GitHub-style).
      const toggle = page.getByTestId("revkit-rail-resolved-toggle");
      await expect(toggle).toBeVisible();
      // First click marks-seen and toggles expansion off.
      await toggle.click();
      // After the click the pill is gone (per-viewer seen state).
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      // The thread body under the disclosure is now hidden.
      await expect(page.locator(".revkit-rail__thread-body")).toHaveAttribute("data-expanded", "false");
      // Clicking again re-expands (manual expand overrides collapsed).
      await toggle.click();
      await expect(page.locator(".revkit-rail__thread-body")).toHaveAttribute("data-expanded", "true");
      // The excerpt disappears because the thread is expanded (the
      // full comments render instead of the collapsed summary).
      await expect(page.getByTestId("revkit-rail-resolved-excerpt")).toBeHidden();

      // Step 10 — axe on the collapsed + expanded (manual) states.
      await toggle.click(); // collapse
      await expect(page.locator(".revkit-rail__thread-body")).toHaveAttribute("data-expanded", "false");
      {
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations,
          JSON.stringify(results.violations, null, 2),
        ).toEqual([]);
      }
      await toggle.click(); // expand
      {
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations,
          JSON.stringify(results.violations, null, 2),
        ).toEqual([]);
      }

      // Step 11 — reopen restores the actionable state.
      await page.getByTestId("revkit-rail-reopen").click();
      await expect(page.getByTestId("revkit-rail-resolve")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-reply")).toBeVisible();
      const afterReopen = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      const reopenedList = (await afterReopen.json()) as { threads: ReadonlyArray<{ id: string; status: string }> };
      expect(reopenedList.threads.find((t) => t.id === threadId)?.status).toBe("open");
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});
