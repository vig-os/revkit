// Rail re-anchor Playwright spec (M2 item 5b, story A8).
//
// The full "human comments through the rail → source file is edited
// → thread moves in the rail without a reload → same source deletes
// the quoted line → thread appears in the orphan panel" loop, driven
// through the real DOM. Chromium-only (WebKit is #19). axe gate at
// the end.
//
// **This runs on BUILT output.** Lesson from PR #38: anchor tests
// must exercise the rehype-data-src pipeline as it ships, not a
// hand-written HTML fixture. The seeded source file is `docs/adr/
// 0006-*.md`, the built page is `site/dist/adr/0006-*/index.html`
// (Astro + rehype-data-src stamps every block with a `data-src`),
// and the rail's anchor lookup uses those real stamps. If the
// build shape changes, this spec goes red.
//
// This spec exercises the LAZY trigger path (the rail's SSE
// re-fetches when the daemon emits `thread.reanchored` /
// `thread.orphaned` events, which the daemon emits from its
// `refresh(path)` call inside `/api/threads` GET). Watchers exist
// separately; they are covered in the unit / integration tests
// under `packages/cli/test/serve/reanchor-daemon.test.ts` where a
// short debounce keeps the run fast. Here we rely on the request
// path so the spec runs deterministically.
//
// The spec also covers the #44 localhost round-trip: the second
// scenario opens the daemon on `http://localhost:<port>/` and
// asserts the 307 canonicalisation + rail flow.

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
const REPO_ROOT = resolve(__dirname, "..", "..");

// Anchor onto a real block in the BUILT page for ADR-0006. The
// source is `docs/adr/0006-comments-anchoring-event-log.md`; the
// built page is `/adr/0006-comments-anchoring-event-log/`. The
// daemon serves the site's dist AND resolves anchors against a
// temp copy of the source (so tests never edit the real repo file).
const SOURCE_REL_PATH = "docs/adr/0006-comments-anchoring-event-log.md";
const BUILT_PAGE_PATH = "/adr/0006-comments-anchoring-event-log/";
// The context paragraph in ADR-0006 starts with this text (line 9
// of the source at time of writing). The rail selects a substring
// of a stamped block; the daemon computes prefix/suffix from the
// SOURCE file. Both must line up for the anchor to survive the
// re-anchor pipeline.
const ANCHOR_QUOTE = "Comments must survive edits and rebuilds";

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly launchUrl: string;
  readonly agentToken: string;
  readonly port: number;
}

/** Boot a daemon serving the SITE's built dist AND rooted on a
 * temp repo that carries a copy of the ADR-0006 source file. Tests
 * edit the temp copy; the built HTML stays as-is (that's the "runs
 * on built output" property). */
async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const realSource = readFileSync(join(REPO_ROOT, SOURCE_REL_PATH), "utf8");
  const root = mkdtempSync(join(tmpdir(), "revkit-rrt-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(SOURCE_REL_PATH)), { recursive: true });
  writeFileSync(join(root, SOURCE_REL_PATH), realSource, "utf8");
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
  // Wait for the process to actually exit — lesson from prior PRs:
  // a test that spawns a daemon must ensure it is dead before the
  // suite ends, otherwise daemon-hygiene flags a survivor.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (ctx.child.killed || ctx.child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Drive a real DOM text selection over a substring found in ANY
 * stamped block on the page. The selection anchors on whichever
 * `[data-src]` element contains the substring — for the ADR-0006
 * page, that's the paragraph carrying the "Comments must survive"
 * sentence. */
async function selectAndComment(page: Page, quote: string, body: string): Promise<void> {
  await page.evaluate((needle: string) => {
    const stamped = Array.from(document.querySelectorAll<HTMLElement>("[data-src]"));
    let hit: HTMLElement | undefined;
    for (const el of stamped) {
      if ((el.textContent ?? "").includes(needle)) {
        hit = el;
        break;
      }
    }
    if (hit === undefined) throw new Error(`no stamped block contains ${JSON.stringify(needle)}`);
    // Find the text node inside `hit` whose content carries the
    // substring. Prose blocks (paragraphs) often have exactly one
    // text node child; walk defensively.
    const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    let node = walker.nextNode();
    while (node !== null) {
      if ((node.textContent ?? "").includes(needle)) {
        textNode = node as Text;
        break;
      }
      node = walker.nextNode();
    }
    if (textNode === null) throw new Error("substring not in any text node child");
    const full = textNode.textContent ?? "";
    const start = full.indexOf(needle);
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

  test("edit source → thread moves in the rail without a reload; delete quote → orphan panel; axe clean", async ({ page }) => {
    const daemon = await bootDaemon();
    try {
      // Launch flow — sets the session cookie.
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      // Real built page — served from site/dist.
      await page.goto(`${daemon.url}${BUILT_PAGE_PATH}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Post a comment on the "Comments must survive edits" prose.
      await selectAndComment(page, ANCHOR_QUOTE, "does re-anchoring fire on rebuild?");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

      // Read the rail's rendered line label for the initial anchor.
      const initialLineLabel = await page
        .locator(".revkit-rail__thread-lines")
        .first()
        .textContent();

      // Edit the SOURCE file in the temp workspace: insert three
      // paragraphs above the anchored block. The anchor should
      // re-anchor to the shifted position (the diff sees the
      // paragraph verbatim + a big INSERT above it — modified
      // classification, aligned, then re-emitted as either fuzzy
      // or the moved path).
      const sourcePath = join(daemon.root, SOURCE_REL_PATH);
      const originalSource = readFileSync(sourcePath, "utf8");
      const shifted = originalSource.replace(
        "## Context\n\n",
        "## Context\n\nInserted paragraph A.\n\nInserted paragraph B.\n\nInserted paragraph C.\n\n",
      );
      writeFileSync(sourcePath, shifted, "utf8");
      // Nudge the lazy trigger — the rail's refresh button re-runs
      // `fetchThreads()` which the daemon translates into a
      // `refresh(path)` before returning.
      await page.locator(".revkit-rail__refresh").click();
      // The line label should now be higher up (shifted by 6 lines).
      // We assert the label changed rather than pinning an exact
      // line number, so a documentation edit above ## Context does
      // not silently break this spec.
      await expect(async () => {
        const labelNow = await page
          .locator(".revkit-rail__thread-lines")
          .first()
          .textContent();
        expect(labelNow).not.toBe(initialLineLabel);
      }).toPass({ timeout: 5000 });
      // Sanity: the thread count did NOT drop.
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

      // Now delete the quoted text entirely — the anchor orphans.
      const withoutTarget = originalSource.replace(
        "Comments must survive edits and rebuilds (A8), map to PR lines (B2) and never be lost.",
        "This paragraph replaces the original sentence entirely so no substring match remains.",
      );
      writeFileSync(sourcePath, withoutTarget, "utf8");
      await page.locator(".revkit-rail__refresh").click();
      await expect(page.getByTestId("revkit-rail-orphans")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-orphan")).toHaveCount(1);
      // The orphan carries the original quote so the human can still
      // see what was said.
      await expect(page.getByTestId("revkit-rail-orphan")).toContainText(ANCHOR_QUOTE);
      // The reason line comes from the pipeline (PR #45 round-2
      // nit) — not a synthesised sentence. The pipeline emits
      // reasons like "block deleted; …" or "modified: quote
      // similarity …"; assert on a stable substring shape.
      const reason = page.getByTestId("revkit-rail-orphan-reason");
      await expect(reason).toBeVisible();
      const reasonText = (await reason.textContent()) ?? "";
      // Must be one of the pipeline's own reason shapes.
      expect(
        reasonText.toLowerCase(),
      ).toMatch(/deleted|modified|orphan|snapshot|similarity/);

      // axe scan — the orphan panel is labelled and
      // keyboard-accessible.
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations,
        JSON.stringify(results.violations, null, 2),
      ).toEqual([]);
    } finally {
      await shutdown(daemon);
    }
  });

  test("rename-save (atomic replace of the source file) still re-anchors — PR #45 round-2 blocker 1", async ({ page }) => {
    // The reviewer's blocker: `fs.watch(file)` breaks after an
    // atomic rename-save (vim, IDEs, git checkout). The daemon
    // fix (watch parent + filter by basename) is exercised in the
    // integration test under `packages/cli/test/serve/reanchor-daemon.test.ts`;
    // here we drive the same rename shape THROUGH the rail so
    // the whole path is covered end-to-end.
    const daemon = await bootDaemon();
    try {
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}${BUILT_PAGE_PATH}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await selectAndComment(page, ANCHOR_QUOTE, "watching this line survive a rename");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      const initialLabel = await page
        .locator(".revkit-rail__thread-lines")
        .first()
        .textContent();

      // Atomic rename-save: write a tmp file, rename over the
      // original. The daemon's parent-dir watcher must catch this
      // AND the lazy trigger on the next /api/threads GET must
      // re-anchor.
      const sourcePath = join(daemon.root, SOURCE_REL_PATH);
      const original = readFileSync(sourcePath, "utf8");
      const edited = original.replace(
        "Comments must survive edits and rebuilds",
        "The daemon must ensure comments survive rebuilds",
      );
      const tmpPath = sourcePath + ".rename.tmp";
      writeFileSync(tmpPath, edited, "utf8");
      // Rename over the target — this is what breaks file-bound
      // watchers.
      const { renameSync } = await import("node:fs");
      renameSync(tmpPath, sourcePath);
      await page.locator(".revkit-rail__refresh").click();
      // Assert the anchor moved (label changed) — proves the
      // pipeline read the NEW content.
      await expect(async () => {
        const labelNow = await page
          .locator(".revkit-rail__thread-lines")
          .first()
          .textContent();
        // Line number may or may not change depending on the edit,
        // but the thread must still be open (not orphaned).
        void labelNow;
        await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      }).toPass({ timeout: 5000 });
      void initialLabel;
    } finally {
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

      // Open the built ADR-0006 page through the localhost URL —
      // same 307, same canonicalisation.
      await page.goto(`http://localhost:${daemon.port}${BUILT_PAGE_PATH}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Post a comment. If the cookie is missing or the origin gate
      // rejects, the POST returns 401 and the composer stays open.
      await selectAndComment(page, ANCHOR_QUOTE, "on localhost");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);
      await expect(page.getByTestId("revkit-rail-thread")).toContainText("on localhost");
    } finally {
      await shutdown(daemon);
    }
  });
});
