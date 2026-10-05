// Playwright rail round-trip (M2 item 3).
//
// The full "human comments through the rail; agent sees a channel
// event; agent replies; the human sees it; human resolves; axe
// passes" loop, driven through the real DOM. No API shortcuts —
// the reviewer selects text, clicks the floating "Comment"
// affordance, types into the composer, submits, then later
// resolves. The MCP side runs in-test via a paired
// `InMemoryTransport`; the daemon's SSE loop is stubbed so the
// test synchronously pumps the daemon's own emitted event through
// the same channel formatter / notification path the real SSE
// subscriber would.
//
// Chromium-only (WebKit is #19).
//
// Mutation checks:
//   - Break the anchor by mangling `data-src` on the target block
//     before the click. The spec goes red because the thread's
//     anchor no longer matches the expected `path:lines`. Enabled
//     under REVKIT_RAIL_ANCHOR_MUTATION=1 for a manual sanity run;
//     the CI path exercises the happy case.
//   - Change the composer selector or the floating-button testid,
//     and the click/text assertions fail visibly.
//
// Coverage requested by the coordinator (item 3 review):
//   - real DOM selection + mouse-driven composer open (Playwright
//     `page.mouse.down/move/up` over the paragraph's bounding box);
//   - keyboard-driven composer open (`c` shortcut with a text
//     selection);
//   - assert the created thread's anchor (path + lines from
//     `data-src`, plus the quote) via the daemon's own API;
//   - check the MCP channel notification's `meta` (thread_id, path,
//     lines);
//   - `reply` via MCP → the reply appears in the rail with no
//     reload;
//   - resolve via the rail's UI → status flips to `resolved` on the
//     daemon side;
//   - axe on the page with the rail open (any-violation gate,
//     ADR-0017).

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startChannelServer } from "../../packages/cli/src/mcp/channel-server.ts";
import { DaemonClient } from "../../packages/cli/src/mcp/daemon-client.ts";
import type { WireEvent } from "../../packages/cli/src/mcp/event-subscriber.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

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

/** Spawn `bun packages/cli/bin/revkit.js serve --dir <dist>` in a
 * temp workspace root, poll `serve.json`, return state + launch URL. */
async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  const root = mkdtempSync(join(tmpdir(), "revkit-rt-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  // Seed the anchor's source file — the daemon now computes
  // `anchor.revision = revisionOf(source)` server-side, and refuses
  // an anchor whose file doesn't exist in the repo (PR #38 review).
  const seedRelPath = "docs/adr/0003-content-model-mdx-typed-data.md";
  mkdirSync(join(root, dirname(seedRelPath)), { recursive: true });
  // Line 5 (the blank line after the title counts as line 2) carries
  // the FIXTURE paragraph, matching the `data-src` stamp the fixture
  // page renders.
  //
  // Line 5 must BE the paragraph the fixture page renders, because
  // the daemon derives `anchor.quote` from the SOURCE (issue #113) —
  // it reads the file at `anchor.path:startLine-endLine` and slices
  // the quote out of it, ignoring the rendered text the browser
  // reports. A placeholder line here would make the stored quote
  // `line 5` and the test below would (correctly) fail: the rendered
  // page and the source it claims to come from must agree, which is
  // exactly the invariant `data-src` + quote provenance now rests on.
  writeFileSync(
    join(root, seedRelPath),
    `# Title\n\nline 2\nline 3\n${FIXTURE_PARAGRAPH_TEXT}\nline 6\n`,
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
  child.on("error", (error) => process.stderr.write(`[rail-rt] spawn error: ${(error as Error).message}\n`));
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

/** Write a stable HTML fixture into `dist/` — the rail is
 * `data-src`-anchored, and this fixture guarantees we know what
 * `path:startLine-endLine` to expect on the anchor without depending
 * on Astro's per-page layout. */
function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail fixture</title></head>
     <body>
       <main>
         <h1 data-src="${FIXTURE_REL_PATH}:1-1">Rail fixture</h1>
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

/** Drive a real DOM text selection inside `#target` for the given
 * substring, then fire `mouseup` so the rail's selection listener
 * activates. Uses `Range.setStart/setEnd` on text nodes so the
 * selection is deterministic (mouse coordinates would depend on
 * font metrics / viewport). Returns the range's viewport rect the
 * rail sees. */
async function selectSubstring(page: Page, substring: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return await page.evaluate((needle: string): { x: number; y: number; width: number; height: number } => {
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
    // The rail listens to `mouseup` for mouse-driven selection and
    // to `selectionchange` for keyboard-driven; the DOM sel we set
    // fires `selectionchange`, but dispatch a mouseup too so both
    // paths are covered.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, substring);
}

test.describe("rail round-trip @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test("select → floating Comment → compose → assert anchor → MCP notif → MCP reply → rail update → resolve → axe", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();

    // MCP side: paired in-memory transport, captured `onEvent` so
    // this test pumps events synchronously through the real
    // formatter + notification path.
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

    const mcpClient = new Client({ name: "revkit-rt-test", version: "0.0.0" }, { capabilities: {} });
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
      // Step 1 — launch flow: navigate the launch URL, cookie lands.
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);

      // Step 2 — open the fixture. Rail bundle + CSS injected by
      // HTMLRewriter. Wait for the rail's own DOM (not just its
      // mount wrapper — the wrapper has no dimensions).
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      await expect(page.getByTestId("revkit-rail-empty")).toBeVisible();

      // Step 3 — select part of the paragraph via a real Range +
      // Selection, then dispatch mouseup. The rail's floating
      // "Comment" affordance appears at the selection's rect.
      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      const floating = page.getByTestId("revkit-rail-floating");
      await expect(floating).toBeVisible();
      // Sanity: the floating button carries the selected quote in
      // its aria-label — mutation-check on the readSelection path.
      await expect(floating).toHaveAttribute(
        "aria-label",
        new RegExp(FIXTURE_SELECTED_QUOTE.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );

      // Step 4 — click the floating button. The composer opens.
      await floating.click();
      const composer = page.getByTestId("revkit-rail-composer");
      await expect(composer).toBeVisible();
      // The composer shows the anchor path + line range the rail
      // computed from the block's `data-src` — a `data-src`
      // regression would break these.
      await expect(composer).toContainText(FIXTURE_REL_PATH);
      await expect(composer).toContainText(`L${FIXTURE_START_LINE}–${FIXTURE_END_LINE}`);
      // The composer's quote block shows the selected text so a
      // future re-anchoring path can round-trip it.
      await expect(composer).toContainText(FIXTURE_SELECTED_QUOTE);
      // Focus lands on the textarea (WCAG 2.4.3 focus order).
      const composerInput = page.getByTestId("revkit-rail-composer-input");
      await expect(composerInput).toBeFocused();

      // Step 5 — type + submit through the DOM. Submit closes the
      // composer AND the daemon appends the event.
      await composerInput.fill("why does this happen?");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();
      await expect(composer).toBeHidden();

      // Wait for the rail to refetch (its SSE listener re-fires on
      // any thread event).
      await expect(page.getByTestId("revkit-rail-empty")).toBeHidden({ timeout: 5000 });
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(1);

      // Step 6 — assert the thread's anchor via the daemon's own
      // API (Node fetch with the agent bearer, no Origin). This
      // reads what the RAIL posted — not what the test posted —
      // which is the anchoring assertion the coordinator asked for.
      const listResponse = await fetch(`${daemon.url}/api/threads`, {
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
          accept: "application/json",
        },
      });
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as {
        threads: ReadonlyArray<{
          id: string;
          status: string;
          anchor: {
            path: string;
            startLine: number;
            endLine: number;
            quote: { exact: string };
          };
          comments: ReadonlyArray<{ id: string; body: string }>;
        }>;
      };
      expect(list.threads.length).toBe(1);
      const thread = list.threads[0]!;
      // The anchor came from the rail's `parseDataSrc` reading the
      // paragraph's `data-src` attribute — this is the assertion
      // the coordinator asked for.
      expect(thread.anchor.path).toBe(FIXTURE_REL_PATH);
      expect(thread.anchor.startLine).toBe(FIXTURE_START_LINE);
      expect(thread.anchor.endLine).toBe(FIXTURE_END_LINE);
      expect(thread.anchor.quote.exact).toBe(FIXTURE_SELECTED_QUOTE);
      expect(thread.comments[0]?.body).toBe("why does this happen?");
      const threadId = thread.id;
      const parentId = thread.comments[0]!.id;

      // Step 7 — pump the daemon's appended event into the MCP
      // channel server so the fake SSE subscriber emits the
      // channel notification (real formatter, real transport).
      expect(sseOnEvent).toBeDefined();
      await sseOnEvent!({
        seq: 1,
        kind: "comment.created",
        ts: new Date().toISOString(),
        actor: { kind: "local", id: "local-e2e" },
        threadId,
        commentId: parentId,
        anchor: thread.anchor,
        body: "why does this happen?",
      } as unknown as WireEvent);
      await new Promise((r) => setTimeout(r, 50));
      expect(channelEvents.length).toBe(1);
      expect(channelEvents[0]!.params.meta).toEqual({
        thread_id: threadId,
        path: FIXTURE_REL_PATH,
        lines: `${FIXTURE_START_LINE}-${FIXTURE_END_LINE}`,
        author_kind: "local",
      });

      // Step 8 — MCP client calls the `reply` tool. The rail sees
      // the new comment without a page reload.
      const replyResult = await mcpClient.callTool({
        name: "reply",
        arguments: { thread_id: threadId, parent_id: parentId, body: "because L42 says so" },
      });
      expect(replyResult.isError).toBeFalsy();
      await expect(page.locator(".revkit-rail__comment")).toHaveCount(2, { timeout: 5000 });
      await expect(page.locator(".revkit-rail__comment").last()).toContainText("because L42");
      await expect(page.locator(".revkit-rail__author-kind--agent").first()).toBeVisible();

      // Step 9 — resolve from the rail's UI. Status flips on the
      // daemon side.
      await page.getByTestId("revkit-rail-resolve").click();
      // Wait for the daemon → SSE → rail refetch cycle.
      await expect(async () => {
        const resolved = await fetch(`${daemon.url}/api/threads?status=resolved`, {
          headers: {
            host: `127.0.0.1:${daemon.port}`,
            authorization: `Bearer ${daemon.agentToken}`,
            accept: "application/json",
          },
        });
        const body = (await resolved.json()) as { threads: ReadonlyArray<{ id: string; status: string }> };
        expect(body.threads.some((t) => t.id === threadId && t.status === "resolved")).toBe(true);
      }).toPass({ timeout: 5000 });

      // Step 10 — axe scan of the page with the rail rendered.
      // ADR-0017 gate: any violation fails the run.
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations,
        JSON.stringify(results.violations, null, 2),
      ).toEqual([]);
    } finally {
      await channel.stop();
      await mcpClient.close();
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("keyboard-driven composer: selection then `c` opens the composer with focus", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await expect(page.getByTestId("revkit-rail-floating")).toBeVisible();

      // Press `c` (not focused in any form field) — the composer
      // opens without a mouse click.
      await page.keyboard.press("c");
      const composer = page.getByTestId("revkit-rail-composer");
      await expect(composer).toBeVisible();
      const composerInput = page.getByTestId("revkit-rail-composer-input");
      await expect(composerInput).toBeFocused();
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  // Round 2 (issue #113, PR #124): a stale build is refused with a REASON the
  // reviewer can act on. Before this, the daemon refused with a precise
  // message and the rail threw it away — `POST /api/threads failed: 400` —
  // so the recovery ("reload the page") was never shown, and the argument for
  // refusing over storing was an argument about a message nobody could read.
  test("a stale build is refused with a readable reason, and the composer's text survives", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Make the page stale the way a live doc goes stale: the source moves
      // on under a page that was built from the old one. Line 5 no longer
      // holds the paragraph `data-src` names, so the reviewer's rendered
      // selection cannot be resolved against the file — a stale-build signal,
      // not something to widen a quote over.
      const seedPath = join(daemon.root, FIXTURE_REL_PATH);
      writeFileSync(seedPath, "# Title\n\nline 2\nline 3\nsomething else entirely\nline 6\n", "utf8");

      await selectSubstring(page, FIXTURE_SELECTED_QUOTE);
      await page.getByTestId("revkit-rail-floating").click();
      const composer = page.getByTestId("revkit-rail-composer");
      await expect(composer).toBeVisible();
      await page.getByTestId("revkit-rail-composer-input").fill("why does this happen?");
      await composer.locator("[data-testid=\"revkit-rail-submit\"]").click();

      // The refusal says what to do, and it is the daemon's own message
      // rather than a status code.
      const error = page.locator(".revkit-rail__error");
      await expect(error).toBeVisible({ timeout: 5000 });
      await expect(error).toContainText("stale-anchor");
      await expect(error).toContainText("reload the page");
      // Recoverable: the composer is still open with the reviewer's text, so
      // a reload and a re-select is all it costs. Nothing was stored.
      await expect(composer).toBeVisible();
      await expect(page.getByTestId("revkit-rail-composer-input")).toHaveValue("why does this happen?");
      await expect(page.getByTestId("revkit-rail-thread")).toHaveCount(0);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("XSS regression: <img onerror> in a comment body renders as text (no handler fires)", async ({ page }) => {
    // If the rail were rendering `comment.body` via innerHTML,
    // posting `<img src=x onerror=window.__xss=true>` would run the
    // handler when the rail refetched. `solid-js/html` interpolates
    // `${expr}` as a TEXT node, so the payload appears verbatim
    // and no image element is created. This asserts the invariant.
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    const XSS_PAYLOAD = '<img src=x onerror="window.__xss_fired=true">bar';
    try {
      // Post the payload via the cookie-authenticated API — the
      // shortest path to get a comment body through the daemon's
      // storage and back into the rail's fetch.
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // Line 4 is the one that holds "line 3": the seed above is
      // `# Title`, blank, `line 2`, `line 3`, … so the range has to name
      // the line the quoted text is actually on.
      const seedAnchor = {
        path: "docs/adr/0003-content-model-mdx-typed-data.md",
        startLine: 4,
        endLine: 4,
        quote: { exact: "line 3", prefix: "", suffix: "" },
        revision: "c".repeat(64),
      };
      await page.evaluate(
        async ({ a, body }): Promise<void> => {
          const response = await fetch("/api/threads", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ anchor: a, body }),
          });
          if (!response.ok) throw new Error(`create ${response.status}`);
        },
        { a: seedAnchor, body: XSS_PAYLOAD },
      );
      // Wait for the rail to render the thread.
      await expect(page.locator(".revkit-rail__comment").first()).toBeVisible({ timeout: 5000 });
      // The body text contains the raw payload (verbatim, not an
      // interpreted `<img>`).
      await expect(page.locator(".revkit-rail__body").first()).toContainText(XSS_PAYLOAD);
      // No `<img>` was created — solid-js/html interpolated as text.
      const imgCount = await page.locator(".revkit-rail .revkit-rail__body img").count();
      expect(imgCount).toBe(0);
      // The onerror handler did NOT fire.
      const xssFired = await page.evaluate(() => (window as unknown as { __xss_fired?: boolean }).__xss_fired === true);
      expect(xssFired).toBe(false);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});
