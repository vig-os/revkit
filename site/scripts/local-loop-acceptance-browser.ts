// Playwright leg of `scripts/local-loop-acceptance.py` (issue #202, step 6).
//
// Runs from the revkit repo's `site/` workspace so `@playwright/test` and
// `playwright-driver.browsers` resolve from the dev shell — this
// deliberately keeps bun/playwright OFF the server environment: the Python
// harness launches `revkit mcp` with a scrubbed PATH, never inherits bun,
// and only pokes THIS process for the rail-UI leg.
//
// Protocol with the Python harness (one line = one event):
//
//   out  COMMENT_OK thread_id=<tid> comment_id=<cid>
//        — the composer landed and the daemon returned 201.
//   in   EXPECT thread_id=<tid>
//        — Python has issued `reply` + `resolve` via the MCP tools; the
//          browser must now observe both landing on the page without
//          reloading.
//   out  REPLY_RESOLVE_OK thread_id=<tid>
//        — the page saw the agent-authored reply body AND `status=resolved`
//          via SSE, no reload.
//   in   BYE
//        — clean up and exit 0.
//
// Any other stdout line is treated as a free-form log and forwarded to the
// Python harness as `[browser stdout] …`. Stderr is forwarded as
// `[browser stderr] …`.

import { chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_URL = process.env["REVKIT_ACCEPT_URL"];
const TOKEN = process.env["REVKIT_ACCEPT_TOKEN"];
const ROUTE = process.env["REVKIT_ACCEPT_ROUTE"];
const SCRATCH = process.env["REVKIT_ACCEPT_SCRATCH"];
if (!STATE_URL || !TOKEN || !ROUTE || !SCRATCH) {
  console.error("REVKIT_ACCEPT_{URL,TOKEN,ROUTE,SCRATCH} must all be set");
  process.exit(2);
}

function emit(line: string): void {
  process.stdout.write(line + "\n");
}

async function mintLaunchUrl(): Promise<string> {
  // Issue the launch-code mint from the harness side so the URL never
  // touches argv or the environment.
  const response = await fetch(`${STATE_URL}/-/launch-code`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`launch-code mint failed: ${response.status}`);
  const parsed = (await response.json()) as { launchUrl: string };
  return parsed.launchUrl;
}

async function selectFirstParagraphAnchor(page: Page): Promise<void> {
  // Pick the `data-src`'d block carrying the first-paragraph marker,
  // then build a Range on its first descendant text node. ADR-0006 keeps
  // the data-src attribute on the block element but wraps the body in a
  // `data-revkit-leaf` span (see `site/src/lib/markdown-processor.ts`),
  // so the block's `firstChild` is normally the leaf span, not a text
  // node. We walk to the first non-empty text node to make the Range.
  await page.evaluate(() => {
    const marker = "This paragraph is published by the acceptance test";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-src]"));
    let chosen: HTMLElement | undefined;
    for (const el of candidates) {
      if (el.closest('[data-testid="revkit-rail"]') !== null) continue;
      const text = (el.textContent ?? "").trim();
      if (text.includes(marker)) {
        chosen = el;
        break;
      }
    }
    if (chosen === undefined) throw new Error("no data-src'd block with the acceptance marker on the page");
    const walker = document.createTreeWalker(chosen, NodeFilter.SHOW_TEXT);
    let textNode: Text | undefined;
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if ((n.nodeValue ?? "").trim().length > 0) {
        textNode = n as Text;
        break;
      }
    }
    if (textNode === undefined) throw new Error("data-src'd block has no text descendant");
    const raw = textNode.nodeValue ?? "";
    const trimmed = raw.replace(/^\s+/, "");
    const leading = raw.length - trimmed.length;
    const needle = trimmed.slice(0, Math.min(40, trimmed.length));
    const range = document.createRange();
    range.setStart(textNode, leading);
    range.setEnd(textNode, leading + needle.length);
    const sel = window.getSelection();
    if (sel === null) throw new Error("no selection API");
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  });
}

async function readStdinLine(): Promise<string | undefined> {
  // Line-at-a-time read from stdin. `process.stdin` is a Readable in
  // object mode under bun, so we assemble chunks and split on \n.
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        resolve(buf.slice(0, idx));
      }
    };
    const onEnd = (): void => {
      process.stdin.off("data", onData);
      resolve(undefined);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

async function main(): Promise<number> {
  const launchUrl = await mintLaunchUrl();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics: string[] = [];
  page.on("console", (msg) => {
    diagnostics.push(`[page ${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    diagnostics.push(`[page error] ${err.message}`);
  });

  const trace = (label: string): void => {
    console.error(`[browser trace] ${label}`);
  };

  page.on("request", (req) => {
    if (req.url().includes("/api/")) {
      console.error(`[browser net>] ${req.method()} ${req.url()}`);
    }
  });
  page.on("response", (resp) => {
    if (resp.url().includes("/api/")) {
      console.error(`[browser net<] ${resp.status()} ${resp.url()}`);
    }
  });

  try {
    // Launch URL → session cookie, then the fixture page → rail bundle.
    trace("goto launchUrl");
    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    trace(`goto ${ROUTE}`);
    await page.goto(`${STATE_URL}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    trace("wait for rail");
    await page.waitForSelector('[data-testid="revkit-rail"]', { timeout: 15_000 });

    trace("select anchor");
    await selectFirstParagraphAnchor(page);
    trace("wait for floating comment button");
    await page.waitForSelector('[data-testid="revkit-rail-floating"]', { timeout: 10_000 });
    trace("click floating");
    await page.click('[data-testid="revkit-rail-floating"]');
    trace("wait for composer");
    await page.waitForSelector('[data-testid="revkit-rail-composer"]', { timeout: 10_000 });

    // `@agent now` is the mention shape that flushes a batched hand-over
    // immediately — the daemon's channel frame arrives without the
    // harness poking `/api/handover` from outside. This matches the
    // user-visible path (the audience is "a reviewer typed @agent now").
    const commentMarker = `rev-acceptance-${Date.now()}`;
    const commentBody = `Acceptance step 6 ${commentMarker} — @agent now please ack this thread.`;
    trace("fill + submit composer");
    await page.fill('[data-testid="revkit-rail-composer-input"]', commentBody);
    await page.click('[data-testid="revkit-rail-submit"]');

    // Wait for composer close — the rail hides it on submit success
    // (setComposerAnchor(undefined)) — and then read the fresh thread
    // id out of the rail's own DOM. Reading from the user-visible
    // state instead of the network response avoids the race where
    // Playwright's wrapper for the POST body raced the rail's own
    // consumer (observed: `[browser] POST /api/threads body capture
    // failed: text: Target page, context or browser has been closed`).
    trace("await composer hidden");
    const closed = await page
      .waitForSelector('[data-testid="revkit-rail-composer"]', { state: "hidden", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      const err = await page.locator(".revkit-rail__error").first().textContent().catch(() => null);
      throw new Error(`composer did not close after submit; rail error='${err ?? "<none>"}'`);
    }
    trace("composer closed, reading ids from rail");
    // The rail refetches threads on submit success, so our new row
    // lands in the DOM moments after the composer hides. Poll until
    // the row carrying our comment marker appears. A fresh thread
    // with a stamped id is the only way the rail can render it —
    // the rail's reducer refuses an unidentified row.
    const ids = await page.waitForFunction(
      (marker: string) => {
        const nodes = document.querySelectorAll<HTMLElement>('[data-testid="revkit-rail-thread"]');
        for (const node of Array.from(nodes)) {
          const bodyEl = node.querySelector('[data-testid="revkit-rail-comment"]');
          if (bodyEl === null) continue;
          const text = bodyEl.textContent ?? "";
          if (!text.includes(marker)) continue;
          const threadId = node.getAttribute("data-thread-id");
          const commentId = bodyEl.getAttribute("data-comment-id");
          if (threadId !== null && threadId.length > 0) {
            return { threadId, commentId };
          }
        }
        return null;
      },
      commentMarker,
      { timeout: 15_000, polling: 100 },
    ).then((handle) => handle.jsonValue() as Promise<{ threadId: string; commentId: string | null }>);
    const threadId = ids.threadId;
    // Fallback for `commentId`: the rail's `<li data-testid=
    // "revkit-rail-comment">` doesn't always carry `data-comment-id`
    // on the container. Read the first comment on the known thread
    // id through the daemon's own GET /api/threads list filtered to
    // the fixture path — same origin, same cookie as the rail, no
    // extra plumbing. This is a public read path the rail itself
    // uses on every refetch.
    let commentId = ids.commentId;
    if (commentId === null || commentId.length === 0) {
      commentId = await page.evaluate(async (tid: string) => {
        const url = `/api/threads?path=${encodeURIComponent("docs/adr/0202-local-loop-acceptance-fixture.md")}&status=${encodeURIComponent("open,orphaned,resolved")}`;
        const resp = await fetch(url, { credentials: "same-origin" });
        if (!resp.ok) throw new Error(`GET ${url} failed: ${resp.status}`);
        const data = (await resp.json()) as { threads?: Array<{ id: string; comments?: Array<{ id: string }> }> };
        const row = data.threads?.find((t) => t.id === tid);
        return row?.comments?.[0]?.id ?? "";
      }, threadId);
    }
    if (commentId === null || commentId === "") {
      throw new Error(`could not resolve commentId for thread ${threadId}`);
    }
    trace(`got threadId=${threadId} commentId=${commentId}`);

    // Arm the MutationObserver watcher BEFORE calling into Python.
    // Round-2 lesson from the dogfood script: the resolve + reply
    // events may arrive in the same flush; attach first, wait after.
    await page.evaluate((tid: string) => {
      (window as unknown as { __revkitSeen?: { reply: boolean; resolved: boolean } }).__revkitSeen = {
        reply: false,
        resolved: false,
      };
      const check = (): void => {
        const nodes = document.querySelectorAll(
          `[data-testid="revkit-rail-thread"][data-thread-id="${tid}"]`,
        );
        for (const node of Array.from(nodes)) {
          // The rail marks resolved state with a class suffix
          // (revkit-rail__thread--resolved), not a data attribute —
          // see packages/cli/src/rail/rail.tsx:2287.
          const resolved = (node as HTMLElement).classList.contains("revkit-rail__thread--resolved");
          const agentReply = node.querySelector(
            '[data-testid="revkit-rail-comment"][data-author-kind="agent"]',
          );
          const body = agentReply?.textContent ?? "";
          const haveReply = body.includes("acceptance-ack from the MCP reply tool");
          const seen = (window as unknown as { __revkitSeen: { reply: boolean; resolved: boolean } }).__revkitSeen;
          if (haveReply) seen.reply = true;
          if (resolved) seen.resolved = true;
        }
      };
      check();
      new MutationObserver(() => check()).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, threadId);

    emit(`COMMENT_OK thread_id=${threadId} comment_id=${commentId}`);

    // Wait for Python to call `reply` + `resolve` via the MCP tools,
    // then signal us to start watching for the SSE update.
    const line = await readStdinLine();
    if (line === undefined || !line.startsWith("EXPECT")) {
      throw new Error(`unexpected harness line before EXPECT: ${line ?? "<eof>"}`);
    }

    // Poll the observer state. 90 s is generous; typical observed
    // latency is a few hundred milliseconds.
    const started = Date.now();
    await page.waitForFunction(
      () => {
        const seen = (window as unknown as { __revkitSeen?: { reply: boolean; resolved: boolean } }).__revkitSeen;
        return seen !== undefined && seen.reply && seen.resolved;
      },
      undefined,
      { timeout: 90_000, polling: 100 },
    );
    const latencyMs = Date.now() - started;
    emit(`REPLY_RESOLVE_OK thread_id=${threadId} latencyMs=${latencyMs}`);

    // Wait for BYE or EOF before shutting the browser — a premature
    // close can race the Python harness.
    const bye = await readStdinLine();
    if (bye !== undefined && !bye.startsWith("BYE")) {
      // Not fatal; the harness may have hit its own deadline. Log so
      // a future bug has evidence.
      diagnostics.push(`[harness stdin unexpected] ${bye}`);
    }
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`[browser] ${err.message}`);
    if (diagnostics.length > 0) {
      console.error(diagnostics.join("\n"));
    }
    try {
      // Save a screenshot and the page HTML for a post-mortem — writes
      // land in the scratch dir so a CI artifact-collect can grab them.
      await page.screenshot({ path: join(SCRATCH!, "accept-rail.png"), fullPage: true });
      const html = await page.content();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(SCRATCH!, "accept-rail.html"), html);
    } catch {
      // ignore
    }
    return 1;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// Silence an unused import under strict settings — `readFileSync` is kept
// imported so a future diagnostic can snapshot files from SCRATCH without
// another round-trip through the tool list.
void readFileSync;

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
