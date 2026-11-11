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
// hand-written HTML fixture. The frozen Markdown fixture is seeded
// as `docs/adr/rail-reanchor.md` in a temp repo and built with Astro
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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Wait for a rail element count to be STABLE at `expected` across a
 * window, rather than to be `expected` at some instant.
 *
 * The re-anchor pipeline is debounced — a ~300 ms file debounce plus a
 * ~500 ms build debounce — so a source edit moves the thread through a
 * TRANSIENT state (re-anchoring, momentarily orphaned) on its way to
 * its settled one. An assertion of the form `toPass(() =>
 * toHaveCount(1))` is not merely tight, it is wrong: `toPass` returns
 * on the FIRST successful sample, so it can pass while the pipeline is
 * still mid-flight and fail on the very next transient sample. Both
 * outcomes are noise, and under parallel load — when the rest of the
 * suite is spawning Chromium instances — the transient lands often
 * enough to make this spec the suite's flake.
 *
 * What this asserts instead: the count reaches `expected` and STAYS
 * there for `stableForMs`. A transient is tolerated by construction;
 * a genuinely lost thread is not, because the count never settles.
 * The window is deliberately wider than the debounce sum so a slow
 * pipeline is not mistaken for an unstable one. */
async function expectStableCount(
  page: Page,
  testId: string,
  expected: number,
  options: { readonly stableForMs?: number; readonly timeoutMs?: number; readonly sampleMs?: number } = {},
): Promise<void> {
  const stableForMs = options.stableForMs ?? 1_500;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sampleMs = options.sampleMs ?? 150;
  const locator = page.getByTestId(testId);
  const deadline = Date.now() + timeoutMs;
  let stableSince: number | undefined;
  let last: number | undefined;
  while (Date.now() < deadline) {
    last = await locator.count();
    if (last === expected) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      // Any excursion restarts the stability window — that is the whole
      // point: one passing sample is not evidence of settling.
      stableSince = undefined;
    }
    await page.waitForTimeout(sampleMs);
  }
  const orphanCount = await page.getByTestId("revkit-rail-orphan").count().catch(() => -1);
  throw new Error(
    `expected "${testId}" to hold at ${expected} for ${stableForMs}ms within ${timeoutMs}ms; ` +
      `last seen ${String(last)} (orphan panel count: ${String(orphanCount)})`,
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const SITE = resolve(__dirname, "..");
const FIXTURE = resolve(__dirname, "fixtures", "rail-reanchor", "rail-reanchor.md");
const execFileAsync = promisify(execFile);

// Both the built page and the daemon's source come from the frozen
// fixture. The site's repo-docs loader renders docs/<slug>.md at /<slug>/.
const SOURCE_REL_PATH = "docs/adr/rail-reanchor.md";
const BUILT_PAGE_PATH = `/${SOURCE_REL_PATH.slice("docs/".length, -".md".length)}/`;
// fixtures/rail-reanchor/rail-reanchor.md retains ADR-0006's Context sentence
// verbatim. The rail selects a substring
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

interface FixtureBuild {
  readonly root: string;
  readonly dist: string;
}

/** Build the frozen fixture once, with caches owned by this build. */
async function buildFixture(): Promise<FixtureBuild> {
  const fixtureSource = readFileSync(FIXTURE, "utf8");
  // Keep the build beneath the trusted site so Astro's dependency resolver
  // can find the installed stack, as in the review build's staging layout.
  const scratch = join(SITE, ".revkit-review");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "rail-reanchor-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(SOURCE_REL_PATH)), { recursive: true });
  writeFileSync(join(root, SOURCE_REL_PATH), fixtureSource, "utf8");
  const dist = join(root, ".revkit", "dist");
  try {
    const site = join(root, "site");
    // Stage the real build tooling, with no live documentation. The repo-docs
    // loader needs its usual directories and matrix; the other collections
    // can be empty. Every file carrying the target quote is frozen input.
    cpSync(join(SITE, "src"), join(site, "src"), {
      recursive: true,
      filter: (path) => path !== join(SITE, "src", "content", "docs"),
    });
    for (const name of ["astro.config.mjs", "package.json", "tsconfig.json"]) {
      cpSync(join(SITE, name), join(site, name));
    }
    symlinkSync(resolve(SITE, "..", "packages"), join(root, "packages"), "dir");
    symlinkSync(join(SITE, "node_modules"), join(site, "node_modules"), "dir");
    mkdirSync(join(root, "docs", "designs"), { recursive: true });
    writeFileSync(join(root, "docs", "FEATURE-MATRIX.md"), "# Fixture matrix\n");
    mkdirSync(join(root, "vocab"), { recursive: true });
    writeFileSync(join(root, "vocab", "terms.yaml"), "schemaVersion: 1\nentries: []\n");
    mkdirSync(join(root, "plots"), { recursive: true });
    mkdirSync(join(root, ".revkit", "asks"), { recursive: true });
    mkdirSync(join(site, "src", "content", "docs"), { recursive: true });
    await execFileAsync(join(SITE, "node_modules", ".bin", "astro"), ["build", "--outDir", dist], {
      cwd: site,
      env: {
        ...process.env,
        REVKIT_ASTRO_CACHE_DIR: join(root, ".revkit", "cache", "astro"),
        REVKIT_VITE_CACHE_DIR: join(root, ".revkit", "cache", "vite"),
      },
    });
    await execFileAsync("bun", [REVKIT_BIN, "check-dist", dist], { cwd: root, env: process.env });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, dist };
}

let fixtureBuild: FixtureBuild | undefined;

/** Each daemon gets a fresh source repo; all serve the same frozen build.
 * Tests edit their own source copy while the built HTML stays as-is. */
async function bootDaemon(): Promise<DaemonCtx> {
  if (fixtureBuild === undefined) throw new Error("the frozen fixture must be built before booting a daemon");
  const root = mkdtempSync(join(tmpdir(), "revkit-rrt-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(SOURCE_REL_PATH)), { recursive: true });
  writeFileSync(join(root, SOURCE_REL_PATH), readFileSync(FIXTURE, "utf8"), "utf8");
  const child = spawn("bun", [REVKIT_BIN, "serve", "--dir", fixtureBuild.dist], {
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
    await shutdown({ child, root });
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
    await shutdown({ child, root });
    throw new Error(`daemon started but never printed 'launch:' line — stdout: ${stdoutChunks.join("")}`);
  }
  return { child, root, url: state.url, port: state.port, agentToken: state.agentToken, launchUrl };
}

async function shutdown(ctx: Pick<DaemonCtx, "child" | "root">): Promise<void> {
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
    if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Drive a real DOM text selection over a substring found in ANY
 * stamped block on the page. The selection anchors on whichever
 * `[data-src]` element contains the substring — for the fixture
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
    // Bring the block into view as a reviewer would before selecting it,
    // so the floating Comment button is placed inside the viewport.
    hit.scrollIntoView({ block: "center" });
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
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    fixtureBuild = await buildFixture();
  });

  test.afterAll(() => {
    if (fixtureBuild !== undefined) {
      rmSync(fixtureBuild.root, { recursive: true, force: true });
      fixtureBuild = undefined;
    }
  });

  test("edit source → thread moves in the rail without a reload; delete quote → orphan panel; axe clean", async ({ page }) => {
    const daemon = await bootDaemon();
    try {
      // Launch flow — sets the session cookie.
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      // Real built page — served from the file's shared frozen build.
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
      // line number, so this checks movement relative to the initial anchor.
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
      // Insert a paragraph ABOVE the anchored block. That shifts the
      // anchor's line while leaving ANCHOR_QUOTE intact, which is the
      // situation this test is named for: an atomic replace that MOVES
      // an anchor must re-anchor it.
      //
      // The previous edit REPLACED the anchored quote with different
      // text. That is a different scenario and the pipeline is right
      // to ORPHAN it — the quoted text no longer exists — so the
      // assertion "the thread must still be open" was asserting
      // something the edit itself invalidated. Worse, the old
      // `toPass` shape passed on a transient: it returned on the first
      // sample showing 1, which is what the rail still displayed in
      // the window BEFORE the debounced pipeline ran. Under parallel
      // load the pipeline finished before the first sample, the count
      // read 0, and the spec failed — the ~2-in-10 flake. Nothing was
      // ever "settled at 1"; the test was sampling a state that was
      // always about to change.
      const edited = original.replace(
        "## Context\n\n",
        "## Context\n\nInserted paragraph A.\n\nInserted paragraph B.\n\n",
      );
      expect(edited, "the rename-save fixture must still contain the anchor quote").toContain(ANCHOR_QUOTE);
      const tmpPath = sourcePath + ".rename.tmp";
      writeFileSync(tmpPath, edited, "utf8");
      // Rename over the target — this is what breaks file-bound
      // watchers.
      const { renameSync } = await import("node:fs");
      renameSync(tmpPath, sourcePath);
      await page.locator(".revkit-rail__refresh").click();
      // The claim is about the SETTLED state, not about any instant:
      // the thread must hold open once the debounced pipeline has run.
      // Sampling with `toPass` returned on the first success, which is
      // both too weak (it passes mid-pipeline) and load-flaky (it fails
      // once the pipeline wins the race). See `expectStableCount`.
      await expectStableCount(page, "revkit-rail-thread", 1);
      // And it really MOVED — a stable open thread at the old line
      // would mean the pipeline never read the new content.
      await expect(page.locator(".revkit-rail__thread-lines").first()).not.toHaveText(initialLabel ?? "");
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

      // Open the built fixture page through the localhost URL —
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
