// Rail re-anchor Playwright spec (M2 item 5b, story A8).
//
// The full "human comments through the rail → source file is edited
// → thread moves in the rail without a reload → same source deletes
// the quoted line → thread appears in the orphan panel" loop, driven
// through the real DOM. Chromium-only (WebKit is #19). axe gate at
// the end.
//
// This spec exercises the LAZY trigger path (the rail's SSE
// re-fetch fires when the daemon emits `thread.reanchored` /
// `thread.orphaned` events, which the daemon emits from its
// `refresh(path)` call inside `/api/threads` GET). Watchers exist
// separately; they are covered in the unit / integration tests
// under `packages/cli/test/serve/reanchor-daemon.test.ts` where a
// short debounce keeps the run fast. Here we rely on the request
// path so the spec runs deterministically.
//
// The spec also covers the #44 localhost round-trip: an ORPHAN
// panel test opens the daemon on `http://localhost:<port>/`
// deliberately and asserts the redirect + rail flow.

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

const FIXTURE_REL_PATH = "docs/reanchor-fixture.md";
// Line 5 is the anchor target — the source has 4 header/blank
// lines above it.
const FIXTURE_START_LINE = 5;
const FIXTURE_QUOTE = "the target phrase lives on this line";
const FIXTURE_PARAGRAPH_TEXT = "Here " + FIXTURE_QUOTE + " and reviewers pick it up.";
const SEEDED_SOURCE =
  "# Fixture\n" +
  "\n" +
  "First paragraph, unchanged across edits.\n" +
  "\n" +
  FIXTURE_PARAGRAPH_TEXT + "\n" +
  "\n" +
  "Third paragraph, also unchanged.\n";

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
  const root = mkdtempSync(join(tmpdir(), "revkit-rrt-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(FIXTURE_REL_PATH)), { recursive: true });
  writeFileSync(join(root, FIXTURE_REL_PATH), SEEDED_SOURCE, "utf8");
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
        `[rail-rt] daemon exited ${code}/${signal}\nstderr:\n${stderrChunks.join("")}\nstdout:\n${stdoutChunks.join("")}\n`,
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
    throw new Error(`daemon started but never printed 'launch:' line — stdout: ${stdoutChunks.join("")}`);
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

/** Emit a fixture HTML into `dist/` with one paragraph anchored to
 * `FIXTURE_REL_PATH`. The rail discovers the block via `data-src`
 * on load. */
function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-reanchor-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail reanchor</title></head>
     <body>
       <main>
         <h1 data-src="${FIXTURE_REL_PATH}:1-1">Rail re-anchor fixture</h1>
         <p id="target" data-src="${FIXTURE_REL_PATH}:${FIXTURE_START_LINE}-${FIXTURE_START_LINE}">${FIXTURE_PARAGRAPH_TEXT}</p>
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

/** Drive a real DOM text selection over the fixture's target
 * paragraph, then post a comment through the rail's normal flow. */
async function selectAndComment(page: Page, quote: string, body: string): Promise<void> {
  await page.evaluate((needle: string) => {
    const p = document.getElementById("target");
    if (p === null) throw new Error("no #target");
    const textNode = p.firstChild;
    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) throw new Error("no text node");
    const full = textNode.textContent ?? "";
    const start = full.indexOf(needle);
    if (start < 0) throw new Error(`'${needle}' not in target`);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    const sel = window.getSelection();
    if (sel === null) throw new Error("no selection");
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  }, quote);
  await expect(page.getByTestId("revkit-rail-floating")).toBeVisible();
  await page.getByTestId("revkit-rail-floating").click();
  const composer = page.getByTestId("revkit-rail-composer");
  await expect(composer).toBeVisible();
  await page.getByTestId("revkit-rail-composer-input").fill(body);
  await page.getByTestId("revkit-rail-submit").click();
  await expect(composer).toBeHidden();
}

test.describe("rail re-anchor round-trip @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test("edit the source → thread moves in the rail without a reload; delete the quote → orphan panel; axe clean", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      // Launch flow — sets the session cookie.
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();

      // Post a comment.
      await selectAndComment(page, FIXTURE_QUOTE, "why does this happen?");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      const initialLineLabel = await page
        .locator(".revkit-rail__thread-lines")
        .first()
        .textContent();
      expect(initialLineLabel?.replace(/[–—]/g, "-").trim()).toContain(`L${FIXTURE_START_LINE}-${FIXTURE_START_LINE}`);

      // Edit the source: shift the anchored line down by inserting
      // an extra paragraph BEFORE the target. The pipeline classifies
      // this as unchanged (the target survives verbatim), maps its
      // offset through the diff, and re-anchors to the new line
      // number. The rail's SSE re-fetches and moves the thread.
      const shifted =
        "# Fixture\n" +
        "\n" +
        "First paragraph, unchanged across edits.\n" +
        "\n" +
        "A newly-inserted paragraph that shifts everything down.\n" +
        "\n" +
        FIXTURE_PARAGRAPH_TEXT + "\n" +
        "\n" +
        "Third paragraph, also unchanged.\n";
      writeFileSync(join(daemon.root, FIXTURE_REL_PATH), shifted, "utf8");
      // Force the lazy trigger: refetch through the DOM (the rail
      // does this on its own after an SSE event, but the file
      // watchers may not have fired yet under Playwright timing).
      // The refresh button on the rail runs `refetch()`.
      await page.locator(".revkit-rail__refresh").click();
      // The thread now points to line 7 (2 lines down). Reading the
      // rail's line label proves the anchor moved live.
      await expect(async () => {
        const labelNow = await page
          .locator(".revkit-rail__thread-lines")
          .first()
          .textContent();
        const label = labelNow?.replace(/[–—]/g, "-").trim() ?? "";
        expect(label).toContain("L7-7");
      }).toPass({ timeout: 5000 });
      // Sanity: the thread count did NOT drop — the thread is still
      // open, just at a new line.
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

      // Now delete the quoted text entirely — the anchor should
      // orphan and appear in the orphan panel.
      const withoutTarget =
        "# Fixture\n" +
        "\n" +
        "First paragraph, unchanged across edits.\n" +
        "\n" +
        "A newly-inserted paragraph that shifts everything down.\n" +
        "\n" +
        "Third paragraph, also unchanged.\n";
      writeFileSync(join(daemon.root, FIXTURE_REL_PATH), withoutTarget, "utf8");
      await page.locator(".revkit-rail__refresh").click();
      await expect(page.getByTestId("revkit-rail-orphans")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-orphan")).toHaveCount(1);
      // The orphan carries the original quote and a "was at L…" note.
      await expect(page.getByTestId("revkit-rail-orphan")).toContainText(FIXTURE_QUOTE);
      await expect(page.getByTestId("revkit-rail-orphan-reason")).toBeVisible();
      // The main open-threads list is empty (or shows the empty
      // state) because the only thread orphaned.
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();

      // axe scan — the orphan panel must be labelled and
      // keyboard-accessible.
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations,
        JSON.stringify(results.violations, null, 2),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("issue #44: open the page on http://localhost:<port>/ — 307 to 127.0.0.1, rail round-trip works", async ({ page }) => {
    // Story A8 sibling: the rail must ROUND-TRIP a comment when the
    // user pastes a localhost URL. The daemon canonicalises to
    // 127.0.0.1 with a 307 and Chromium follows; the cookie lands
    // on 127.0.0.1 and every subsequent fetch is same-origin
    // authenticated.
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      // Launch on the LOCALHOST alias — the redirect chain: 307 to
      // 127.0.0.1's /-/auth?code=…, then 302 to /. Chromium
      // follows both; the session cookie ends up on 127.0.0.1.
      const localhostLaunchUrl = daemon.launchUrl.replace(
        `http://127.0.0.1:${daemon.port}`,
        `http://localhost:${daemon.port}`,
      );
      await page.goto(localhostLaunchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // After the redirects, the page lands on the canonical origin.
      expect(page.url()).toContain(`127.0.0.1:${daemon.port}`);

      // Open the fixture through the localhost URL — same 307,
      // same canonicalisation.
      await page.goto(`http://localhost:${daemon.port}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Post a comment. If the cookie is missing or the origin gate
      // rejects, the POST returns 401 and the composer stays open.
      await selectAndComment(page, FIXTURE_QUOTE, "on localhost");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      await expect(page.getByTestId("revkit-rail-thread")).toContainText("on localhost");
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});
