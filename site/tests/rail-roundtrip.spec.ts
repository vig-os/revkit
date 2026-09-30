// Playwright round-trip for the M2 comment rail + MCP channel.
//
// The rail is injected by the daemon at serve time (HTMLRewriter,
// no Starlight override). This spec drives the whole loop:
//
//   1. Boot a real `revkit serve` subprocess against the site's
//      built `dist/` on a random port (Playwright runs on Node, so
//      the daemon must run out of process — it uses `bun:sqlite`).
//   2. Read `.revkit/serve.json` for the URL, launch code and agent
//      token.
//   3. Open a page via the launch URL (exchanges the code for the
//      HttpOnly session cookie the rail uses on `/api/*`).
//   4. Verify the injected `<script>` / `<link>` land on the page and
//      the rail mounts (announces "No open threads yet.").
//   5. Post a comment via the daemon's API — the rail re-renders.
//   6. In-test, start an MCP client wired to the same daemon (in-
//      memory transport, real channel formatter). Feed the daemon's
//      appended event to the channel server's fake SSE subscriber;
//      assert a `notifications/claude/channel` arrives with the
//      expected `meta` (`thread_id`, `path`, `lines`).
//   7. Call the `reply` tool via MCP. The rail sees the new comment
//      without a page reload.
//
// This is one test, not five — the whole "human comments, MCP
// receives, MCP replies, page updates" loop is what the M2
// acceptance asks for. Isolated units live in
// `packages/cli/test/mcp/*`.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ES module scope has no `__dirname`; derive it from `import.meta.url`.
const __dirname = dirname(fileURLToPath(import.meta.url));
import type { Anchor } from "@revkit/review-core";
import { startChannelServer } from "../../packages/cli/src/mcp/channel-server.ts";
import { DaemonClient } from "../../packages/cli/src/mcp/daemon-client.ts";
import type { WireEvent } from "../../packages/cli/src/mcp/event-subscriber.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

/** Path to the site's built dist. Playwright's outer `webServer` runs
 * `just build` first, so `site/dist` exists when this spec runs. */
const DIST = resolve(__dirname, "..", "dist");
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly launchUrl: string;
  readonly agentToken: string;
  readonly port: number;
}

/** Spawn `bun packages/cli/bin/revkit.js serve --dir <dist>` in a
 * temp `--repoRoot`-equivalent (the daemon uses `findRepoRoot...` on
 * its cwd), poll until `serve.json` appears, return the state. */
async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-rt-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  // The daemon locates the repo root by walking up for package.json.
  // Seed a minimal one so the temp dir is a valid workspace.
  // `findRepoRootByPackageJson` walks up looking for a package.json
  // with `"name": "revkit"` — the workspace-root marker.
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  // Spawn via `bun` (the daemon uses `bun:sqlite` + `Bun.serve`).
  // The daemon runs under Bun (bun:sqlite, Bun.serve, HTMLRewriter).
  // The nix dev shell puts bun on PATH; if it's not, the test fails
  // fast with a clear error rather than a 15s timeout.
  const child = spawn(
    "bun",
    [REVKIT_BIN, "serve", "--dir", DIST],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: process.env,
    },
  );
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    process.stderr.write(`[rail-roundtrip] spawn error: ${(error as Error).message}\n`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(
        `[rail-roundtrip] daemon exited ${code}/${signal}\nstderr:\n${stderrChunks.join("")}\nstdout:\n${stdoutChunks.join("")}\n`,
      );
    }
  });
  // Poll serve.json for up to 15s.
  const deadline = Date.now() + 15_000;
  let state: {
    readonly pid: number;
    readonly port: number;
    readonly url: string;
    readonly agentToken: string;
  } | undefined;
  while (Date.now() < deadline) {
    const path = join(root, ".revkit", "serve.json");
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf8"));
        break;
      } catch {
        // File appeared but is mid-write. Try again.
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
  // The daemon printed its launch line on stdout before writing
  // serve.json in most runs; give the reader one more beat to pick
  // it up. If the line is still missing we fall back to re-minting a
  // launch code — the launch URL is only needed for the first
  // navigation.
  const deadline2 = Date.now() + 2000;
  while (Date.now() < deadline2) {
    if (stdoutChunks.join("").match(/launch:\s+(\S+)/)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const launchMatch = stdoutChunks.join("").match(/launch:\s+(\S+)/);
  const launchUrl = launchMatch?.[1];
  if (launchUrl === undefined) {
    child.kill("SIGTERM");
    throw new Error(
      `daemon started but never printed 'launch:' line — stdout: ${stdoutChunks.join("")}`,
    );
  }
  return {
    child,
    root,
    url: state.url,
    port: state.port,
    agentToken: state.agentToken,
    launchUrl,
  };
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try {
    ctx.child.kill("SIGTERM");
  } catch {
    // Already dead.
  }
  // Give the daemon a beat to remove serve.json cleanly.
  await new Promise((r) => setTimeout(r, 200));
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Write a stable HTML fixture into `dist/` so the test exercises the
 * injector on a page it fully controls (not one whose DOM shape Astro
 * chose). Cleans up when the returned function runs. */
function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail fixture</title></head>
     <body>
       <main>
         <h1 data-src="docs/adr/0003-content-model-mdx-typed-data.md:1-1">Rail fixture heading</h1>
         <p data-src="docs/adr/0003-content-model-mdx-typed-data.md:3-3">Some prose block to comment on.</p>
       </main>
     </body></html>`,
    "utf8",
  );
  return {
    relPath,
    cleanup: () => {
      try {
        rmSync(abs, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

test.describe("rail round-trip @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  // The daemon boot + rail bundle build + MCP handshake pushes the
  // default 30s Playwright timeout; give it 120s so a slow CI runner
  // has room.
  test.setTimeout(120_000);

  test("daemon injects rail; human posts, MCP receives + replies, page updates", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      // Wire the MCP side against the same daemon. `subscribeEvents`
      // is a captured hook that lets THIS test synchronously feed
      // the exact event the daemon just appended — Playwright's
      // test isolation makes racing the real SSE loop brittle.
      const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
      let sseOnEvent: ((event: WireEvent) => Promise<void> | void) | undefined;
      const channel = await startChannelServer({
        client: new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken }),
        url: daemon.url,
        agentToken: daemon.agentToken,
        transport: serverTx,
        subscribeEvents: (opts) => {
          sseOnEvent = opts.onEvent;
          return { close: () => {}, done: Promise.resolve() };
        },
      });

      const mcpClient = new Client(
        { name: "revkit-rt-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const channelEvents: Array<{ params: { content: string; meta?: Record<string, string> } }> = [];
      mcpClient.setNotificationHandler(
        z.object({
          method: z.literal("notifications/claude/channel"),
          params: z.object({
            content: z.string(),
            meta: z.record(z.string(), z.string()).optional(),
          }),
        }),
        async (m) => {
          channelEvents.push(m);
        },
      );
      await mcpClient.connect(clientTx);

      try {
        // Step 1: navigate through the launch URL → cookie is set,
        // the browser is now authenticated for `/api/*` calls. The
        // launch code is single-use, so we drive the exchange
        // through Playwright's page navigation (Chromium is the
        // consumer). `waitUntil: "commit"` skips the wait for the
        // full `/` page to load — Astro's index is large and pulls
        // /_katex fonts we don't need.
        const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
        expect(nav?.status()).toBeLessThan(400);

        // Step 2: open the fixture page (same-origin — cookie flows).
        // The rail bundle mounts on load.
        await page.goto(`${daemon.url}/${fixture.relPath}`);

        // The daemon's HTMLRewriter appended the rail's <link> and
        // <script> tags. Grab the raw HTML and assert on them.
        const html = await page.content();
        expect(html).toContain(`/-/rail.js`);
        expect(html).toContain(`/-/rail.css`);

        // The rail's own mount marker + empty state are attached
        // and visible. The mount div itself has no dimensions (its
        // child `<aside>` is `position:fixed`), so we assert
        // `toBeAttached` on the mount and `toBeVisible` on the
        // fixed-position rail proper.
        await expect(page.locator("[data-revkit-rail-mount]")).toBeAttached();
        await expect(page.getByTestId("revkit-rail")).toBeVisible();
        await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();

        // Step 3: create a comment through the API (equivalent to
        // the rail's `POST /api/threads` under the hood). Driving
        // the DOM selection API from Playwright is brittle across
        // browsers — the API path exercises the same daemon
        // endpoints the rail uses.
        const anchor: Anchor = {
          path: "docs/adr/0003-content-model-mdx-typed-data.md",
          startLine: 3,
          endLine: 3,
          quote: { exact: "Some prose block", prefix: "", suffix: "" },
          revision: "c".repeat(64),
        };
        const created = await page.evaluate(
          async ({ anchorArg }): Promise<{ seq: number; event: { threadId: string; commentId: string } }> => {
            const response = await fetch("/api/threads", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ anchor: anchorArg, body: "why does this happen?" }),
            });
            if (!response.ok) throw new Error(`create-thread failed ${response.status}`);
            return await response.json();
          },
          { anchorArg: anchor },
        );
        expect(created.seq).toBeGreaterThan(0);

        // Rail refetches on `/events` push; the empty-state clears
        // and the thread appears.
        await expect(page.getByTestId("revkit-rail-empty")).toBeHidden({ timeout: 5000 });
        await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

        // Step 4: pump the same event into the MCP channel server
        // so the fake SSE subscriber emits the channel notification.
        expect(sseOnEvent).toBeDefined();
        await sseOnEvent!({
          seq: created.seq,
          kind: "comment.created",
          ts: new Date().toISOString(),
          actor: { kind: "local", id: "local-e2e" },
          threadId: created.event.threadId,
          commentId: created.event.commentId,
          anchor,
          body: "why does this happen?",
        } as unknown as WireEvent);

        // Give the notification a beat to traverse the transport.
        await new Promise((r) => setTimeout(r, 50));
        expect(channelEvents.length).toBe(1);
        expect(channelEvents[0]!.params.meta).toEqual({
          thread_id: created.event.threadId,
          path: anchor.path,
          lines: "3-3",
        });

        // Step 5: MCP client calls the `reply` tool. The rail sees
        // the new comment.
        const replyResult = await mcpClient.callTool({
          name: "reply",
          arguments: {
            thread_id: created.event.threadId,
            parent_id: created.event.commentId,
            body: "because L42 says so",
          },
        });
        expect(replyResult.isError).toBeFalsy();

        // Rail re-renders — two comments in the same thread.
        await expect(page.locator(".revkit-rail__comment")).toHaveCount(2, { timeout: 5000 });
        await expect(page.locator(".revkit-rail__comment").last()).toContainText("because L42");
        // The agent's actor kind is present on the second comment.
        await expect(page.locator(".revkit-rail__author-kind--agent").first()).toBeVisible();
      } finally {
        await channel.stop();
        await mcpClient.close();
      }
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});
