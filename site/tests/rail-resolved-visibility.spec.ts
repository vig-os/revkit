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

import { bootDaemon as startTestDaemon, stopDaemon } from "./helpers/daemon.ts";
import { provenanceFixture } from "./provenance-fixture.ts";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

const FIXTURE_REL_PATH = "docs/adr/0003-content-model-mdx-typed-data.md";
const FIXTURE_START_LINE = 5;
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

async function bootDaemon(opts: { root?: string; port?: number } = {}): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  // Round-3 test hook: an explicit `root` lets the restart spec
  // point a second daemon at the SAME repo so `.revkit/repo-id`
  // persists across the restart. `port` fixes the loopback port
  // so localStorage (keyed by origin) survives too.
  let root: string;
  if (opts.root !== undefined) {
    root = opts.root;
  } else {
    root = mkdtempSync(join(tmpdir(), "revkit-60-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
    const seedRelPath = FIXTURE_REL_PATH;
    mkdirSync(join(root, dirname(seedRelPath)), { recursive: true });
    writeFileSync(
      join(root, seedRelPath),
      `# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`,
      "utf8",
    );
  }
  const args = [REVKIT_BIN, "serve", "--dir", DIST];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  const ctx = await startTestDaemon({ root, args });
  return ctx;
}

async function shutdown(ctx: DaemonCtx, opts: { keepRoot?: boolean } = {}): Promise<void> {
  await stopDaemon(ctx.child);
  if (opts.keepRoot !== true) {
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

/** Write the same fixture the round-trip spec uses so we can drive
 * a real DOM selection against a predictable `data-src` block. A
 * unique suffix keeps the file per-test so `fullyParallel: true`
 * runs cannot race on the same dist path. */
let fixtureCounter = 0;
async function writeFixtureHtml(): Promise<{ relPath: string; cleanup: () => void }> {
  fixtureCounter += 1;
  const relPath = `rail-60-fixture-${process.pid}-${fixtureCounter}.html`;
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    await provenanceFixture(`# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`, FIXTURE_REL_PATH, FIXTURE_START_LINE),
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

/** A second fixture on a DIFFERENT source path so the multi-page
 * round-3 spec can navigate to a page whose thread set does NOT
 * include page A's threads (i.e. the daemon's page-scoped fetch
 * returns empty). Round-3 review — the prune must NOT wipe page
 * A's marks when the browser visits page B. */
function writeSecondFixtureHtml(): { relPath: string; cleanup: () => void } {
  fixtureCounter += 1;
  const relPath = `rail-60-fixture-b-${process.pid}-${fixtureCounter}.html`;
  const abs = join(DIST, relPath);
  // Anchor at a wholly unrelated source path so a thread here
  // could never collide with page A's data-src.
  const otherPath = "docs/adr/0007-daemon-mcp-transport.md";
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail 60 fixture B</title></head>
     <body>
       <main>
         <p data-src="${otherPath}:1-1">Page B has its own source anchors.</p>
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
    const textNode = paragraph.querySelector("[data-revkit-leaf]")?.firstChild ?? null;
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
    const fixture = await writeFixtureHtml();
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

      // Step 11 — reopen restores the actionable state. Two entry
      // points: the collapsed-row `revkit-rail-collapsed-reopen`
      // button (PR #62 review) or the in-body `revkit-rail-reopen`.
      // Verify the collapsed-row button first — it's one click from
      // the summary. Collapse again so the button is present.
      await toggle.click(); // collapse
      const collapsedReopen = page.getByTestId("revkit-rail-collapsed-reopen");
      await expect(collapsedReopen).toBeVisible();
      await collapsedReopen.click();
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

  /** Shared setup: boot daemon, write fixture, seed a thread and
   * post an agent reply through the API, then click to mark the
   * pill seen. Ends with a resolved-by-agent thread that the
   * viewer has acknowledged (no pill). Returns handles to drive
   * the follow-up steps. */
  async function setUpAckedThread(page: Page): Promise<{
    daemon: DaemonCtx;
    fixture: Awaited<ReturnType<typeof writeFixtureHtml>>;
    threadId: string;
    cleanup: () => Promise<void>;
  }> {
    const daemon = await bootDaemon();
    const fixture = await writeFixtureHtml();
    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      fixture.cleanup();
      await shutdown(daemon);
    };
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      await page.getByTestId("revkit-rail-composer-input").fill("what should this say?");
      await page.getByTestId("revkit-rail-submit").click();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      const list = (await listRes.json()) as {
        threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
      };
      const threadId = list.threads[0]!.id;
      const parentId = list.threads[0]!.comments[0]!.id;
      const replyRes = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadId)}/replies`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parentId, body: "ack — done" }),
      });
      expect(replyRes.status).toBe(201);
      // Wait for the reply to reach the DOM, then acknowledge it
      // by clicking the thread body. After this, the seen-mark is
      // set to the agent-reply createdAt.
      await expect(page.locator(".revkit-rail__thread")).toContainText("ack — done", { timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible();
      await page.getByTestId("revkit-rail-thread").click();
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      return { daemon, fixture, threadId, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  test("PR #62 blocker: human's own resolve does NOT retrigger the unread pill", async ({ page }) => {
    const { daemon, threadId, cleanup } = await setUpAckedThread(page);
    try {
      // Human resolves through the rail (browser-side). Even
      // though `updatedAt` bumps, this must not fire the pill.
      await page.getByTestId("revkit-rail-resolve").click();
      // Wait for the resolve to reach the daemon so the SSE has
      // fired at least once (proves `updatedAt` bumped).
      await expect.poll(async () => {
        const r = await fetch(`${daemon.url}/api/threads`, {
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            accept: "application/json",
          },
        });
        const l = (await r.json()) as { threads: Array<{ id: string; status: string }> };
        return l.threads.find((t) => t.id === threadId)?.status;
      }, { timeout: 5000 }).toBe("resolved");
      // The load-bearing assertion: no pill after the reviewer's
      // own resolve. The pre-fix `updatedAt` compare would fire
      // it because `updatedAt` was bumped by the resolve event.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      // Reload as well — the seen mark persists.
      await page.reload();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test("PR #62 blocker: human's own reopen does NOT retrigger the unread pill", async ({ page }) => {
    const { daemon, threadId, cleanup } = await setUpAckedThread(page);
    try {
      // Resolve then reopen — both by the human. Each bumps
      // `updatedAt`; neither is agent activity.
      await page.getByTestId("revkit-rail-resolve").click();
      await expect.poll(async () => {
        const r = await fetch(`${daemon.url}/api/threads`, {
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            accept: "application/json",
          },
        });
        const l = (await r.json()) as { threads: Array<{ id: string; status: string }> };
        return l.threads.find((t) => t.id === threadId)?.status;
      }, { timeout: 5000 }).toBe("resolved");
      // Reopen via the collapsed-row shortcut (one click).
      const collapsedReopen = page.getByTestId("revkit-rail-collapsed-reopen");
      await expect(collapsedReopen).toBeVisible();
      await collapsedReopen.click();
      await expect.poll(async () => {
        const r = await fetch(`${daemon.url}/api/threads`, {
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            accept: "application/json",
          },
        });
        const l = (await r.json()) as { threads: Array<{ id: string; status: string }> };
        return l.threads.find((t) => t.id === threadId)?.status;
      }, { timeout: 5000 }).toBe("open");
      // Load-bearing assertion: no pill after the reviewer's reopen.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      await page.reload();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test("PR #62 blocker: a re-anchor / orphan pipeline event does NOT retrigger the unread pill", async ({ page }) => {
    const { daemon, threadId, cleanup } = await setUpAckedThread(page);
    try {
      // Trigger the re-anchor pipeline by mutating the seeded
      // source file so the pipeline moves / orphans the thread.
      // GET /api/threads triggers the daemon's `refresh(path)` and
      // emits `thread.reanchored` or `thread.orphaned`, either of
      // which bumps `updatedAt`.
      const seedPath = join(daemon.root, FIXTURE_REL_PATH);
      writeFileSync(
        seedPath,
        // Replace with different content so the anchor cannot
        // resolve — the pipeline emits `thread.orphaned`.
        "# Title\n\ncompletely different content on every line\nmore\nmore still\nmore\nfinal\n",
        "utf8",
      );
      // Poke the daemon to force a refresh scan.
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      expect(listRes.status).toBe(200);
      // Wait for the SSE to propagate the orphan event — either
      // the thread is orphaned OR its updatedAt is newer than the
      // pre-existing agent reply's createdAt.
      await expect.poll(async () => {
        const r = await fetch(`${daemon.url}/api/threads`, {
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            accept: "application/json",
          },
        });
        const l = (await r.json()) as {
          threads: Array<{ id: string; status: string; updatedAt: string; comments: Array<{ createdAt: string; author: { kind: string } }> }>;
        };
        const t = l.threads.find((th) => th.id === threadId);
        if (t === undefined) return false;
        const lastAgentAt = t.comments
          .filter((c) => c.author.kind === "agent")
          .map((c) => c.createdAt)
          .sort()
          .pop();
        // A re-anchor bumped updatedAt strictly past the last
        // agent activity — that's the pre-fix trigger condition.
        return lastAgentAt !== undefined && t.updatedAt > lastAgentAt;
      }, { timeout: 5000 }).toBe(true);
      // Load-bearing assertion: no pill fired from the pipeline
      // event. Pre-fix, this was the "phantom unread" bug.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test("PR #62 review nit: 'Mark all seen' clears the pill on every unread thread at once", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = await writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      // Create three human threads (three different substrings
      // so we get three separate anchors), then post an
      // agent reply to each.
      const slices = [
        "rail selects text",
        "inside a stamped block",
        "opens the composer",
      ];
      for (const slice of slices) {
        await selectSubstring(page, slice);
        await page.getByTestId("revkit-rail-floating").click();
        await page.getByTestId("revkit-rail-composer-input").fill(`ask about "${slice}"`);
        await page.getByTestId("revkit-rail-submit").click();
        await expect(page.getByTestId("revkit-rail-composer")).toBeHidden();
      }
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(3);
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      const list = (await listRes.json()) as {
        threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
      };
      expect(list.threads.length).toBe(3);
      for (const thread of list.threads) {
        const r = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(thread.id)}/replies`, {
          method: "POST",
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ parentId: thread.comments[0]!.id, body: "ack" }),
        });
        expect(r.status).toBe(201);
      }
      // Wait for all three unread pills to render, then hit "Mark
      // all seen" and assert every pill is gone in one click.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toHaveCount(3, { timeout: 5000 });
      const bulk = page.getByTestId("revkit-rail-mark-all-seen");
      await expect(bulk).toBeVisible();
      await bulk.click();
      await expect(page.getByTestId("revkit-rail-unread-pill")).toHaveCount(0);
      // The bulk button hides itself when there is nothing left
      // to acknowledge.
      await expect(bulk).toBeHidden();
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("PR #62 round-3 blocker: seen mark on page A survives a visit to page B and back", async ({ page }) => {
    // The pre-round-3 prune ran against `threads()` — the
    // page-scoped list — so visiting page B (which has a
    // DIFFERENT set of threads) wiped page A's mark, and the pill
    // sprang back with no new agent activity. The round-3 fix
    // prunes against the UNSCOPED thread-id list (from
    // `/api/threads` with no `path` filter).
    const daemon = await bootDaemon();
    // Two fixtures on DIFFERENT source paths: the threads on each
    // page have distinct `data-src` anchors, and `fetchThreads`
    // asks the daemon for threads on the current page's paths.
    const pageA = await writeFixtureHtml();
    const pageB = writeSecondFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      // ── Page A: create thread + agent reply + acknowledge ──
      await page.goto(`${daemon.url}/${pageA.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      await page.getByTestId("revkit-rail-composer-input").fill("A: what should this say?");
      await page.getByTestId("revkit-rail-submit").click();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      const list = (await listRes.json()) as {
        threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
      };
      const threadA = list.threads[0]!;
      const replyRes = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadA.id)}/replies`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parentId: threadA.comments[0]!.id, body: "A: ack" }),
      });
      expect(replyRes.status).toBe(201);
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible({ timeout: 5000 });
      await page.getByTestId("revkit-rail-thread").click();
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      // ── Navigate to page B ──
      await page.goto(`${daemon.url}/${pageB.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      // Page B has no threads of its own; the daemon has threads
      // on other paths, but the page-scoped fetch here returns
      // an empty set.
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();
      // ── Back to page A ──
      await page.goto(`${daemon.url}/${pageA.relPath}`);
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      // Load-bearing: the seen mark for thread A must have
      // survived the round-trip to page B. Pre-round-3, the
      // page-B prune wiped it and the pill fired again.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
    } finally {
      pageA.cleanup();
      pageB.cleanup();
      await shutdown(daemon);
    }
  });

  test("PR #62 round-3 blocker: seen mark survives a daemon restart on the same --port", async ({ page }) => {
    // Round-3: the pre-fix key was the per-start `instanceId`, so
    // a restart minted a new key and every ack looked unread
    // again. The fix keys by the persistent `.revkit/repo-id`,
    // which survives the restart.
    let daemon = await bootDaemon();
    const fixture = await writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      await page.getByTestId("revkit-rail-composer-input").fill("restart: what should this say?");
      await page.getByTestId("revkit-rail-submit").click();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      // Agent replies + acknowledge.
      const listRes = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      const list = (await listRes.json()) as {
        threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
      };
      const parentId = list.threads[0]!.comments[0]!.id;
      const threadId = list.threads[0]!.id;
      const replyRes = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadId)}/replies`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parentId, body: "restart: ack" }),
      });
      expect(replyRes.status).toBe(201);
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible({ timeout: 5000 });
      await page.getByTestId("revkit-rail-thread").click();
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      // ── Restart the daemon on the same repo + same port ──
      const savedPort = daemon.port;
      const savedRoot = daemon.root;
      await shutdown(daemon, { keepRoot: true });
      daemon = await bootDaemon({ root: savedRoot, port: savedPort });
      // A restart mints a new launch code — walk the launch URL
      // again so the browser has a valid session cookie.
      const nav2 = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav2?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      // Load-bearing: the seen mark from before the restart must
      // still be in effect (keyed by `repoId`, which is
      // persistent). Pre-round-3, the pill was back.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #63: the seen-state bucket is keyed by the daemon's persistent
// `.revkit/repo-id`, and an ORIGIN is `127.0.0.1:<port>` — so two repos
// served one after the other on the same fixed `--port` share one
// `localStorage`. Pre-fix, `migrateSeenStorage` merged every
// `revkit.rail.seen.v1*` bucket into the current repo's and deleted the
// rest, so opening repo Y wiped repo X's acks.
//
// The unit tests in `packages/cli/test/rail/unread.test.ts` pin the
// storage contract against a Map stand-in. This block pins the WIRING
// through the real daemon and the browser's real `Storage`: three daemon
// boots on ONE port, two repo roots, two `.revkit/repo-id`s, one browser
// profile. It is also the only coverage that runs against an actual
// `Storage` implementation rather than a stand-in — `Object.keys` order,
// `key(i)` enumeration and the quota surface are all browser behaviour a
// Map cannot stand in for.
//
// Fast by construction: `--dir <built dist>` is passed, so `revkit serve`
// never reaches its auto-build branch (see `serve/cli.ts`); the fixture
// pages are written straight into the built dist; and the only cost is
// three daemon boots, each of which compiles the rail bundle once.
test.describe("rail seen-state across two repos on one origin (issue #63) @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  const SEEN_PREFIX = "revkit.rail.seen.v1";
  const SEEN_INDEX_KEY = "revkit.rail.seen.index.v1";

  /** A repo root with one source doc the daemon can resolve an
   * anchor against. Two of these = two different `.revkit/repo-id`s. */
  function seedRepoRoot(name: string, sourceRelPath: string): string {
    const root = mkdtempSync(join(tmpdir(), `revkit-63-${name}-`));
    mkdirSync(join(root, ".revkit"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
    mkdirSync(join(root, dirname(sourceRelPath)), { recursive: true });
    writeFileSync(
      join(root, sourceRelPath),
      `# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`,
      "utf8",
    );
    return root;
  }

  /** A served page whose stamped block anchors at `sourceRelPath`, so
   * repo X's page only ever lists repo X's threads. */
  async function writeRepoPage(sourceRelPath: string): Promise<{ relPath: string; cleanup: () => void }> {
    fixtureCounter += 1;
    const relPath = `rail-63-fixture-${process.pid}-${fixtureCounter}.html`;
    const abs = join(DIST, relPath);
    writeFileSync(
      abs,
      await provenanceFixture(`# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`, sourceRelPath, FIXTURE_START_LINE),
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

  /** Every `revkit.rail.seen*` entry in the page's real
   * `localStorage`, read through the DOM Storage API rather than a JS
   * object literal so enumeration order and the key list are the
   * browser's. */
  async function readSeenStorage(page: Page): Promise<Record<string, string>> {
    return page.evaluate(
      ({ prefix, indexKey }): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key === null) continue;
          if (key === prefix || key.startsWith(`${prefix}.`) || key === indexKey) {
            out[key] = localStorage.getItem(key) ?? "";
          }
        }
        return out;
      },
      { prefix: SEEN_PREFIX, indexKey: SEEN_INDEX_KEY },
    );
  }

  /** The origin's seen storage, read only once the rail's mount-time
   *  write for the CURRENT repo is durable (issue #78).
   *
   *  The rail resolves `repoId` from `/-/health` on an async mount
   *  path and only then calls `migrateSeenStorage`, which writes this
   *  repo's bucket, then the shared LRU index, then reclaims the keys
   *  the index does not vouch for (`unread.ts:364`, `:376`, `:383`).
   *  Both things this spec does after a navigation land before that
   *  write: `page.goto(..., { waitUntil: "commit" })` resolves on
   *  response headers by design, and a VISIBLE `revkit-rail` only
   *  means the component rendered. A bare read after either one
   *  observes the pre-write state — issue #78, where CI's
   *  `retries: 2` reported
   *  `expect(afterY[bucketY]).toBeDefined()` as passing on a retry
   *  while attempt 1 had failed. So each read below polls for the
   *  durable condition rather than sampling storage once: a poll is a
   *  WAIT, and every assertion after it still has to earn its pass.
   *
   *  What makes "the bucket is there" mean "the mount write landed" is
   *  that `migrateSeenStorage` is FULLY SYNCHRONOUS — no `await`
   *  anywhere in its body — so the bucket write, the index write and
   *  the reclaim pass all land in one uninterrupted task and no poll
   *  iteration can sample between them. The index is checked as a
   *  second, cheap witness, not because it is written last (it is
   *  not: the reclaim pass follows it). If `migrateSeenStorage` is
   *  ever made async, that synchronicity — not the key list below —
   *  is what has to be re-checked.
   *
   *  Only the current repo's OWN keys are waited on. Another repo's
   *  bucket is precisely the thing under assertion in all three legs,
   *  so waiting on it would turn a real cross-repo loss into a poll
   *  timeout and hide the assertion that names it.
   *
   *  Honest scope, per call site: on the two legs that MINT a bucket
   *  (repo X, then repo Y) the poll is the real barrier. On the third
   *  leg, back to repo X, both keys already exist from the first leg
   *  and were never removed, so the poll returns on its first
   *  iteration — there it is a no-op. That leg is safe anyway: the
   *  neighbouring `toBeHidden()` cannot pass before the mount write
   *  completes (the pill reads `seenMap()`, refreshed from storage
   *  only after `migrateSeenStorage` returns), and the LRU-order
   *  assertion on that snapshot requires the remount's index write. */
  async function readSeenStorageAfterMount(page: Page, bucket: string): Promise<Record<string, string>> {
    let snapshot: Record<string, string> = {};
    await expect
      .poll(
        async () => {
          snapshot = await readSeenStorage(page);
          return snapshot[bucket] !== undefined && snapshot[SEEN_INDEX_KEY] !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return snapshot;
  }

  function repoIdOf(root: string): string {
    return readFileSync(join(root, ".revkit", "repo-id"), "utf8").trim();
  }

  /** Post an agent reply so the thread carries agent activity and the
   * unread pill fires; the reviewer then acknowledges it. */
  async function agentReply(daemon: DaemonCtx, threadId: string, parentId: string, body: string): Promise<void> {
    const response = await fetch(
      `${daemon.url}/api/threads/${encodeURIComponent(threadId)}/replies`,
      {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parentId, body }),
      },
    );
    expect(response.status).toBe(201);
  }

  async function firstThread(daemon: DaemonCtx): Promise<{ id: string; parentId: string }> {
    const response = await fetch(`${daemon.url}/api/threads`, {
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
        accept: "application/json",
      },
    });
    const list = (await response.json()) as {
      threads: ReadonlyArray<{ id: string; comments: ReadonlyArray<{ id: string }> }>;
    };
    const thread = list.threads[0];
    const comment = thread?.comments[0];
    if (thread === undefined || comment === undefined) throw new Error("no thread on the daemon");
    return { id: thread.id, parentId: comment.id };
  }

  test("repo X's seen marks survive opening repo Y on the same fixed --port", async ({ page }) => {
    const sourceX = "docs/adr/9001-repo-x.md";
    const sourceY = "docs/adr/9002-repo-y.md";
    const rootX = seedRepoRoot("repo-x", sourceX);
    const rootY = seedRepoRoot("repo-y", sourceY);
    const pageX = await writeRepoPage(sourceX);
    const pageY = await writeRepoPage(sourceY);
    // Boot repo X on an ephemeral port, then reuse THAT number for the
    // other two boots — same origin, therefore same localStorage.
    let daemon = await bootDaemon({ root: rootX });
    const port = daemon.port;
    try {
      const bucketX = `${SEEN_PREFIX}.${repoIdOf(rootX)}`;

      // ── Repo X: raise a thread, let the agent answer, acknowledge ──
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${pageX.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      await page.getByTestId("revkit-rail-composer-input").fill("X: what should this say?");
      await page.getByTestId("revkit-rail-submit").click();
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      const x = await firstThread(daemon);
      await agentReply(daemon, x.id, x.parentId, "X: ack");
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("revkit-rail-thread").click();
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();

      const afterX = await readSeenStorageAfterMount(page, bucketX);
      expect(Object.keys(JSON.parse(afterX[bucketX]!) as Record<string, string>)).toEqual([x.id]);

      // ── Repo Y on the SAME port: a different repoId, same origin ──
      await shutdown(daemon, { keepRoot: true });
      daemon = await bootDaemon({ root: rootY, port });
      const navY = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(navY?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${pageY.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Y has now started, so it has minted its own repo id — the
      // whole premise: two ids, one origin.
      const bucketY = `${SEEN_PREFIX}.${repoIdOf(rootY)}`;
      expect(repoIdOf(rootY)).not.toBe(repoIdOf(rootX));

      const afterY = await readSeenStorageAfterMount(page, bucketY);
      // Load-bearing: repo X's bucket is still there, byte for byte.
      // Pre-fix this key was gone — `migrateSeenStorage` had merged it
      // into Y's bucket and deleted it.
      expect(afterY[bucketX]).toBe(afterX[bucketX]);
      expect(Object.keys(JSON.parse(afterY[bucketX]!) as Record<string, string>)).toEqual([x.id]);
      // Y's bucket exists in its own right…
      expect(afterY[bucketY]).toBeDefined();
      // …and X's mark was NOT folded across the repo boundary.
      expect(JSON.parse(afterY[bucketY]!)).toEqual({});

      // ── Back to repo X on the same port: the ack is still in force ──
      await shutdown(daemon, { keepRoot: true });
      daemon = await bootDaemon({ root: rootX, port });
      const navBack = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(navBack?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${pageX.relPath}`);
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      // The user-visible claim of this whole fix: no re-ack needed.
      await expect(page.getByTestId("revkit-rail-unread-pill")).toBeHidden();
      const afterBack = await readSeenStorageAfterMount(page, bucketX);
      expect(afterBack[bucketX]).toBe(afterX[bucketX]);
      // The index vouches for both repos, LRU order: this leg
      // touched X again (mounts went X → Y → X), so Y is now the
      // least-recently used and leads the oldest-first list.
      expect(JSON.parse(afterBack[SEEN_INDEX_KEY]!)).toEqual([bucketY, bucketX]);
    } finally {
      pageX.cleanup();
      pageY.cleanup();
      await shutdown(daemon);
      rmSync(rootX, { recursive: true, force: true });
      rmSync(rootY, { recursive: true, force: true });
    }
  });
});
