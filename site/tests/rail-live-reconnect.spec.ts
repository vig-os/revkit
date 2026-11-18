// Playwright e2e for issue #277 — the rail reconnects a dropped SSE
// stream, resyncs the missed events, and surfaces the "paused" state
// while reconnecting.
//
// What this pins:
//
//   1. On tab open, the rail has NO "live updates paused" indicator
//      (the stream is live).
//   2. When the browser goes offline, the EventSource fires `onerror`,
//      the live-channel controller flips to `reconnecting`, and the
//      indicator appears. From the application's point of view, this
//      is indistinguishable from a proxy idle-reaping the stream
//      server-side (the TCP teardown reaches the client either way,
//      and `EventSource.onerror` is the same).
//   3. While disconnected, a comment appended via the agent-bearer
//      API from the test side (Node fetch, not the offline page)
//      lands in the daemon's log but is NOT delivered to the rail.
//   4. When the browser comes back online, the `online` event fires,
//      the controller `wake()`s, a fresh EventSource opens at the
//      resume point, the daemon replays the missed event, and the
//      rail's thread list shows the new comment — without reload.
//
// Chromium-only. The test uses `context.setOffline()` (CDP under the
// hood) rather than `route.abort()` because we need the EXISTING
// stream to fail, not just the next request. `route.abort()` runs at
// request start, so a stream that is already open is unaffected.

import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provenanceFixture } from "./provenance-fixture.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

const FIXTURE_REL_PATH = "docs/adr/0003-content-model-mdx-typed-data.md";
const FIXTURE_START_LINE = 5;
const FIXTURE_PARAGRAPH_TEXT = "The rail selects text inside a stamped block and opens the composer.";

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly launchUrl: string;
  readonly agentToken: string;
  readonly port: number;
}

/** Spawn `bun packages/cli/bin/revkit.js serve --dir <dist>` in a
 * temp workspace root, poll `serve.json`, return state + launch URL.
 * Same shape as `rail-roundtrip.spec.ts`'s `bootDaemon`. */
async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-reco-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  // Seed the anchor's source file — the daemon computes
  // `anchor.revision = revisionOf(source)` server-side and refuses
  // an anchor whose file doesn't exist in the repo.
  mkdirSync(join(root, dirname(FIXTURE_REL_PATH)), { recursive: true });
  writeFileSync(
    join(root, FIXTURE_REL_PATH),
    `# Title\n\nline 2\n\n${FIXTURE_PARAGRAPH_TEXT}\n\nline 6\n`,
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
    throw new Error(`revkit serve did not write serve.json within 15s\nstderr: ${stderrChunks.join("")}`);
  }
  const deadline2 = Date.now() + 2000;
  while (Date.now() < deadline2) {
    if (stdoutChunks.join("").match(/launch:\s+(\S+)/)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const launchUrl = stdoutChunks.join("").match(/launch:\s+(\S+)/)?.[1];
  if (launchUrl === undefined) {
    child.kill("SIGTERM");
    throw new Error(`daemon started but never printed 'launch:' line`);
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

async function writeFixtureHtml(): Promise<{ relPath: string; cleanup: () => void }> {
  const relPath = "rail-reco-fixture.html";
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

test.describe("rail live reconnect @chromium-only (issue #277)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(60_000);

  test("REGRESSION: a dropped SSE stream + a POST in the gap + reconnect → the new comment appears without reload", async ({ page, context }) => {
    const daemon = await bootDaemon();
    const fixture = await writeFixtureHtml();
    try {
      // Step 1 — before navigation, instrument the page so the test
      // can later tear down the rail's EventSource at will. The rail
      // is bundled and shipped to the page; the wrapper here
      // intercepts every `new EventSource(url)` the page issues,
      // records the instance on `window.__revkit_sources`, and
      // exposes `window.__revkit_kill_sources()` which closes each
      // of them AND fires `onerror` so the live-channel controller
      // treats it as a transport failure (the exact code path a
      // proxy idle-reap would take). This simulates a server-side
      // kill at the CLIENT API — doing it over the network would
      // require a test-only daemon endpoint, which is more surface
      // than this case warrants.
      await page.addInitScript(() => {
        type ReadyState = EventSource["readyState"];
        interface Instrument extends EventSource {
          __instrumented?: true;
        }
        const sources: Instrument[] = [];
        (window as unknown as { __revkit_sources: Instrument[] }).__revkit_sources = sources;
        const Native = window.EventSource;
        class Wrapped extends Native {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            const self = this as Instrument;
            self.__instrumented = true;
            sources.push(self);
          }
        }
        window.EventSource = Wrapped as unknown as typeof window.EventSource;
        (window as unknown as { __revkit_kill_sources: () => void }).__revkit_kill_sources = () => {
          for (const source of sources.splice(0)) {
            try {
              source.close();
            } catch {
              /* already closed */
            }
            // `onerror` is the hook the rail's live-channel
            // controller listens to. Fire it directly so the
            // controller does not depend on the browser's own
            // notification of TCP teardown.
            try {
              source.onerror?.(new Event("error"));
            } catch {
              /* ignore */
            }
          }
        };
        (window as unknown as { __revkit_ready_states: () => ReadyState[] }).__revkit_ready_states = () => sources.map((s) => s.readyState);
      });

      // Step 2 — auth, open the page, confirm the rail is live.
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();
      // No "paused" indicator while the stream is up — the initial
      // `connecting` transition is suppressed so a cold page doesn't
      // flash the badge.
      await expect(page.getByTestId("revkit-rail-live-paused")).toBeHidden();

      // Mark the window so we can prove no reload happened across
      // the reconnect.
      await page.evaluate(() => {
        (window as unknown as { __revkit_reco_marker?: number }).__revkit_reco_marker = 42;
      });

      // Step 3 — tear down the rail's EventSource(s) at the client
      // API. The controller sees `onerror`, flips to `reconnecting`,
      // and the rail renders the paused indicator.
      await page.evaluate(() => (window as unknown as { __revkit_kill_sources: () => void }).__revkit_kill_sources());
      await expect(page.getByTestId("revkit-rail-live-paused")).toBeVisible({ timeout: 5_000 });

      // Step 4 — go offline so a subsequent reconnect attempt made
      // during backoff fails (the controller stays in
      // `reconnecting` even as its retry timer fires). From the
      // page's point of view, this is a dropped network AFTER the
      // stream was already dead — same end-state as a tab a laptop
      // left asleep for hours with the proxy having long since
      // forgotten the stream.
      await context.setOffline(true);

      // Step 5 — POST a comment into the daemon from the TEST side
      // (Node fetch, agent-bearer auth — the page is offline).
      // The daemon stores it; the rail misses the SSE frame.
      const seedAnchor = {
        path: FIXTURE_REL_PATH,
        startLine: 3,
        endLine: 3,
        quote: { exact: "line 2", prefix: "", suffix: "" },
        revision: "c".repeat(64),
      };
      const postResponse = await fetch(`${daemon.url}/api/threads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.agentToken}`,
          host: `127.0.0.1:${daemon.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ anchor: seedAnchor, body: "posted while the page was offline" }),
      });
      expect(postResponse.status).toBe(201);

      // Step 6 — bring the browser back online. The `online` event
      // fires on `window`, the controller `wake()`s, a fresh
      // EventSource opens at the resume point, the daemon replays
      // from there (including the comment posted in Step 5), the
      // rail refetches threads, and the new thread renders — all
      // WITHOUT a page reload.
      await context.setOffline(false);
      await expect(page.getByTestId("revkit-rail-live-paused")).toBeHidden({ timeout: 15_000 });
      await expect(page.locator(".revkit-rail__comment")).toHaveCount(1, { timeout: 15_000 });
      await expect(page.locator(".revkit-rail__body").first()).toContainText("posted while the page was offline");

      // Sanity: no reload happened — the marker set before the kill
      // is still on the window after the reconnect. A fresh page
      // load would have reset it.
      const afterMarker = await page.evaluate(() => (window as unknown as { __revkit_reco_marker?: number }).__revkit_reco_marker);
      expect(afterMarker).toBe(42);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});

// Suppress an unused-import warning on the strict tsconfig.
export type { Page };
