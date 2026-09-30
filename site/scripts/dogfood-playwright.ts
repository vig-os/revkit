// Playwright leg of the revkit dogfood loop.
//
// Called by packages/cli/src/dogfood/playwright.ts. Reads the daemon state from the
// **isolated** state dir the shell created for this run, mints a fresh
// launch URL through `POST /-/launch-code` (so the URL is single-use),
// opens the built site in a real chromium page, selects text on a real
// block, posts a comment through the rail's own UI (no API shortcuts),
// then polls the daemon until the test agent's reply arrives and the
// thread is resolved. On success it prints `DOGFOOD_OK`.
//
// Environment inputs:
//   REVKIT_DOGFOOD_STATE_DIR       — isolated `.revkit/serve.json` root
//                                     for this run. Round-2 blocker fix:
//                                     the daemon no longer runs at the
//                                     repo root, so this path is required.
//   REVKIT_DOGFOOD_NONCE            — random per-run token embedded in the
//                                     comment body; the agent echoes it in
//                                     the reply ("ack <nonce>") so we can
//                                     tell OUR reply apart. The nonce echo
//                                     is a LIVENESS marker only, not a
//                                     lockdown proof — see
//                                     packages/cli/src/dogfood/verify.ts:verifyRunning
//                                     for the real lockdown assertion.
//   REVKIT_DOGFOOD_ARTIFACTS_DIR    — writable temp dir for screenshots.
//   PLAYWRIGHT_BROWSERS_PATH        — chromium binary root (dev shell).
//
// Timing: the reply-visible wait uses a 240 s bound. The lockdown-proof
// step (attempting Bash first) adds a turn on top of the observed 15-20 s
// baseline, so the ceiling stays generous. If we're near it we've either
// found a real bug or the machine is under load; either way, the poll
// loop stops with a diagnostic dump.
//
// Redaction rule: this script MUST NOT print launch URLs, agent tokens
// or any `?code=...` value. The shell caller pipes stdout through
// `redact` before appending to `last.log`, but we keep the payload clean
// at the source too — never log the launch URL, only the fact that a
// URL was minted.

// `@playwright/test` (not the bare `playwright` package) is what ships in
// the site workspace, so this script runs from `site/` — see how
// packages/cli/src/dogfood/playwright.ts invokes it. The `chromium` and `Page` exports
// are re-exported through `@playwright/test`, no test-runner state is used.
import { chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env["REVKIT_DOGFOOD_STATE_DIR"];
const ARTIFACTS_DIR = process.env["REVKIT_DOGFOOD_ARTIFACTS_DIR"];
const NONCE = process.env["REVKIT_DOGFOOD_NONCE"];
if (STATE_DIR === undefined || STATE_DIR.length === 0) {
  console.error("REVKIT_DOGFOOD_STATE_DIR unset");
  process.exit(2);
}
if (ARTIFACTS_DIR === undefined || ARTIFACTS_DIR.length === 0) {
  console.error("REVKIT_DOGFOOD_ARTIFACTS_DIR unset");
  process.exit(2);
}
if (NONCE === undefined || NONCE.length === 0) {
  console.error("REVKIT_DOGFOOD_NONCE unset");
  process.exit(2);
}
const STATE_PATH = join(STATE_DIR, ".revkit", "serve.json");

interface ServeState {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly pid: number;
}

const state: ServeState = JSON.parse(readFileSync(STATE_PATH, "utf8"));

/** Mint a fresh single-use launch URL. Never logs the URL or the token — a
 * leaked transcript with either is a security incident. */
async function mintLaunchUrl(): Promise<string> {
  const response = await fetch(`${state.url}/-/launch-code`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`launch-code mint failed: ${response.status}`);
  }
  const parsed = (await response.json()) as { launchUrl: string };
  return parsed.launchUrl;
}

/** Read the (single) open thread that carries our nonce. Returns undefined
 * until it appears; used by both the create-side and the reply-wait loop. */
async function findThreadByNonce(): Promise<
  | undefined
  | {
      readonly id: string;
      readonly status: string;
      readonly comments: ReadonlyArray<{
        readonly id: string;
        readonly body: string;
        readonly author?: { readonly kind?: string };
      }>;
    }
> {
  const response = await fetch(`${state.url}/api/threads`, {
    headers: {
      host: `127.0.0.1:${state.port}`,
      authorization: `Bearer ${state.agentToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`list threads failed: ${response.status}`);
  const body = (await response.json()) as {
    threads: Array<{
      id: string;
      status: string;
      comments: Array<{ id: string; body: string; author?: { kind?: string } }>;
    }>;
  };
  return body.threads.find((thread) => thread.comments.some((comment) => comment.body.includes(NONCE!)));
}

/** Bounded poll. Returns the matching value or throws on timeout. Predicate
 * receives the current polled value and returns true when done. Sleeps
 * between calls so we don't hammer the daemon. */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `dogfood: timeout waiting for '${label}' after ${timeoutMs}ms — last=${JSON.stringify(last)}`,
  );
}

/** Drive a real DOM text selection on the ADR page. We pick a `<p>` that
 * itself carries `data-src` (that's the shape the ADR loader emits — a
 * top-level paragraph is a data-src'd block, not a paragraph inside a
 * data-src'd container) and use the DOM Selection API. Mouse coordinates
 * would depend on font metrics, so a Range is more robust. */
async function selectSomeAnchoredText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    // Walk every element carrying `data-src`; pick the first one whose
    // text is long enough to make a useful selection AND whose first
    // child is a text node (so `range.setStart(textNode, 0)` is valid).
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-src]"));
    let chosen: HTMLElement | undefined;
    for (const el of candidates) {
      if (el.closest('[data-testid="revkit-rail"]') !== null) continue;
      const textNode = el.firstChild;
      if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) continue;
      const raw = (textNode.textContent ?? "").trim();
      if (raw.length >= 20) {
        chosen = el;
        break;
      }
    }
    if (chosen === undefined) throw new Error("no data-src'd block with a usable text node on the page");
    const textNode = chosen.firstChild as Text;
    const raw = textNode.textContent ?? "";
    // Grab a middle slice so leading/trailing whitespace doesn't confuse
    // the Range. Length 40 keeps the composer quote readable.
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
    // Fire mouseup so the rail's selection listener picks it up.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    return needle;
  });
}

async function main(): Promise<void> {
  const launchUrl = await mintLaunchUrl();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  // PR-#58 review round-2 diagnostic: capture browser console + SSE
  // frames so a rail live-update timeout is diagnosable from the log.
  // Gated on the env var REVKIT_DOGFOOD_TRACE_SSE equal to one, so
  // the default run stays quiet; the coordinator's investigation flow
  // (root-cause the rail live failure) enables it.
  const trace = process.env["REVKIT_DOGFOOD_TRACE_SSE"] === "1";
  if (trace) {
    page.on("console", (msg) => {
      console.log(`[browser ${msg.type()}] ${msg.text()}`); // guardrails-ok(no-debug-leftovers): diagnostic gated on REVKIT_DOGFOOD_TRACE_SSE
    });
    page.on("pageerror", (err) => {
      console.log(`[browser pageerror] ${err.message}`); // guardrails-ok(no-debug-leftovers): diagnostic gated on REVKIT_DOGFOOD_TRACE_SSE
    });
    page.on("response", async (resp) => {
      const u = resp.url();
      if (u.includes("/events") || u.includes("/api/threads") || u.includes("/api/handover")) {
        console.log(`[net] ${resp.status()} ${u}`); // guardrails-ok(no-debug-leftovers): diagnostic gated on REVKIT_DOGFOOD_TRACE_SSE
      }
    });
    // Hook the EventSource so every incoming frame is logged.
    // The `console.log` calls INSIDE the init script run in the
    // browser; Playwright's page.on("console") forwards them to our
    // stdout as `[browser log] ...`. Each one is guardrails-ok because
    // the whole trace path is behind `REVKIT_DOGFOOD_TRACE_SSE=1`.
    await page.addInitScript(() => {
      const OriginalES = window.EventSource;
      class TracedES extends OriginalES {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          const label = String(url);
          this.addEventListener("open", () => console.log(`[sse open] ${label}`)); // guardrails-ok(no-debug-leftovers): trace gated on REVKIT_DOGFOOD_TRACE_SSE
          this.addEventListener("error", () => console.log(`[sse error] ${label}`)); // guardrails-ok(no-debug-leftovers): trace gated on REVKIT_DOGFOOD_TRACE_SSE
          this.addEventListener("message", (e: MessageEvent) => {
            const body = typeof e.data === "string" ? e.data.slice(0, 300) : "<non-string>";
            console.log(`[sse msg default] ${label} ${body}`); // guardrails-ok(no-debug-leftovers): trace gated on REVKIT_DOGFOOD_TRACE_SSE
          });
          // Common revkit-daemon event names — see packages/cli/src/serve
          // Log every named event we know about; the SSE spec dispatches
          // by `event:` name, not the default `message` listener.
          for (const name of ["comment.appended", "comment.replied", "thread.status", "handover", "presence", "ping"]) {
            this.addEventListener(name, (e: MessageEvent) => {
              const body = typeof e.data === "string" ? e.data.slice(0, 300) : "<non-string>";
              console.log(`[sse msg ${name}] ${label} ${body}`); // guardrails-ok(no-debug-leftovers): trace gated on REVKIT_DOGFOOD_TRACE_SSE
            });
          }
        }
      }
      window.EventSource = TracedES as unknown as typeof EventSource;
    });
  }
  try {
    // 1. Log in via the single-use launch URL. The daemon set-cookies our
    //    session; we redirect to `/`.
    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });

    // 2. Navigate to a real ADR page (built site). ADR-0007 is the channel
    //    architecture — a natural place to leave a review comment. The
    //    data-src anchors let the rail compute a stable path:lines pair.
    await page.goto(`${state.url}/adr/0007-agent-bridge-mcp-channel/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    // The rail bundle is injected by the daemon's HTMLRewriter; the empty
    // marker appears once its DOM is mounted.
    await page.waitForSelector('[data-testid="revkit-rail"]', { timeout: 10_000 });

    // 3. Select text, open the composer, submit through the DOM.
    await selectSomeAnchoredText(page);
    await page.waitForSelector('[data-testid="revkit-rail-floating"]', { timeout: 5_000 });
    await page.click('[data-testid="revkit-rail-floating"]');
    await page.waitForSelector('[data-testid="revkit-rail-composer"]', { timeout: 5_000 });
    // Round-4 change: the dogfood comment reads like a real reviewer's
    // note. No embedded imperative chain, no coerced tool call. The
    // lockdown is proven by the shell's pre-launch /proc inspection of
    // the claude process (see packages/cli/src/dogfood/verify.ts:verifyRunning),
    // NOT by anything the model does with this comment. The comment
    // just carries a nonce so the harness can tell OUR test thread
    // apart from any other. If the agent declines the note (a good
    // model may refuse instructions that arrive over a channel — see
    // ADR-0007's "channel content is untrusted" section), the harness
    // fails cleanly on the reply-wait timeout; that IS correct
    // behaviour and no bug.
    const commentBody =
      `Small typo here — ${NONCE}. Please ack this thread with the ` +
      `token \`${NONCE}\` using the revkit reply tool, then resolve. ` +
      `No file changes needed.`;
    await page.fill('[data-testid="revkit-rail-composer-input"]', commentBody);
    await page.click('[data-testid="revkit-rail-submit"]');
    // On success the composer is unmounted (setComposerAnchor(undefined)
    // in rail.ts). On daemon error the composer STAYS visible with an
    // .revkit-rail__error banner — capture that message before giving
    // up, so the harness's failure line is useful.
    const composerHidden = await page
      .waitForSelector('[data-testid="revkit-rail-composer"]', {
        state: "hidden",
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    if (!composerHidden) {
      const errorMsg = await page
        .locator(".revkit-rail__error")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      throw new Error(
        `composer did not close after submit — daemon may have rejected the comment. rail error='${errorMsg ?? "<none>"}'`,
      );
    }

    // 4. Confirm the thread was created and carries our nonce.
    const created = await waitFor(
      "thread creation",
      findThreadByNonce,
      (thread) => thread !== undefined,
      15_000,
      250,
    );
    if (created === undefined) throw new Error("unreachable — waitFor guarantees a match");
    // 4b. M2 item 6 dogfood — the daemon boots in `handover` mode
    // (the default), so the human comment above is BATCHED and did
    // not reach the agent's channel stream yet. Flush the batch
    // through the daemon's own /api/handover endpoint; the agent
    // should now receive a `handover` channel notification, look
    // up the thread via `threads`, and reply. This proves the
    // handover pipeline end-to-end.
    const flush = await fetch(`${state.url}/api/handover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        "content-type": "application/json",
        host: `127.0.0.1:${state.port}`,
      },
      body: "{}",
    });
    if (!flush.ok) throw new Error(`handover flush failed: ${flush.status}`);
    console.log("handover flushed via POST /api/handover"); // guardrails-ok(no-debug-leftovers): CLI progress line
    // stdout is this script's contract — the caller shell
    // (packages/cli/src/dogfood/main.ts) tees each line into the dogfood
    // transcript, so `console.log` IS the tracing facade here.
    console.log(`created thread ${created.id} (${created.comments.length} comment(s))`); // guardrails-ok(no-debug-leftovers): CLI progress line

    // 5. Wait for the agent's reply. This is a LIVENESS check —
    //    success = there is a comment authored by an agent whose
    //    body contains `ack <nonce>`. The nonce echo proves the
    //    agent reached a reply turn against OUR thread. It does NOT
    //    prove the lockdown fired; the shell script's pre-launch
    //    cmdline + environ verification of the real claude process
    //    is the load-bearing lockdown proof (round 4 dropped the
    //    forgeable post-run "did the agent write the denial text"
    //    check). A well-aligned model may correctly decline to
    //    follow instructions embedded in a channel comment — that
    //    behaviour is correct per ADR-0007, and this timeout is
    //    the right way for the harness to notice it.
    //    Timeout: 180 s baseline for a normal reply turn.
    const started = Date.now();
    const withReply = await waitFor(
      "agent reply visible on daemon",
      findThreadByNonce,
      (thread) =>
        thread !== undefined &&
        thread.comments.some(
          (c) => c.author?.kind === "agent" && c.body.includes(`ack ${NONCE}`),
        ),
      180_000,
      750,
    );
    if (withReply === undefined) throw new Error("unreachable — waitFor guarantees a match");
    const commentLatencyMs = Date.now() - started;
    console.log(`agent replied in ~${commentLatencyMs}ms`); // guardrails-ok(no-debug-leftovers): CLI progress line

    // 6. Also confirm the reply is visible in the PAGE without a reload —
    //    that's the SSE path (comment.replied → rail refetch). We look for
    //    a thread with more than one comment.
    // Playwright's `waitForFunction` overload with `arg` requires the
    // function to declare its `arg` type as its FIRST parameter — we pass
    // `nonce` in explicitly to keep the browser side self-contained. Cast
    // to `unknown` first to satisfy the overload picker across playwright
    // versions.
    await page
      .waitForFunction(
        (nonce: string) => {
          const threads = document.querySelectorAll('[data-testid="revkit-rail-thread"]');
          for (const el of Array.from(threads)) {
            const text = el.textContent ?? "";
            if (text.includes(`ack ${nonce}`)) return true;
          }
          return false;
        },
        NONCE as string,
        { timeout: 30_000 },
      )
      .catch(async () => {
        // PR-#58 review round-2 diagnostic: dump the rail state on
        // timeout so a regression like "SSE arrived but rail didn't
        // re-render" is visible in the log.
        try {
          const snapshot = await page.evaluate(() => {
            const threads = document.querySelectorAll('[data-testid="revkit-rail-thread"]');
            const list: Array<{ id: string | null; text: string }> = [];
            threads.forEach((el) => {
              list.push({
                id: el.getAttribute("data-thread-id"),
                text: (el.textContent ?? "").slice(0, 500),
              });
            });
            return { count: list.length, threads: list };
          });
          console.log(`[rail-snapshot] threads=${snapshot.count} contents=${JSON.stringify(snapshot.threads)}`); // guardrails-ok(no-debug-leftovers): diagnostic on failure path
        } catch (err) {
          console.log(`[rail-snapshot] failed: ${(err as Error).message}`); // guardrails-ok(no-debug-leftovers): diagnostic on failure path
        }
        throw new Error("reply text did not appear in the rail without reload");
      });

    // 7. Capture the "reply visible in rail" screenshot as evidence.
    const shot = join(ARTIFACTS_DIR!, "reply-visible.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`screenshot saved to ${shot}`); // guardrails-ok(no-debug-leftovers): CLI progress line

    // 8. Wait for the resolve. The agent instructions include a resolve
    //    after the reply. Give it 60s.
    await waitFor(
      "thread resolved",
      findThreadByNonce,
      (thread) => thread !== undefined && thread.status === "resolved",
      60_000,
      500,
    );
    console.log("thread resolved by agent"); // guardrails-ok(no-debug-leftovers): CLI progress line
    // The next line is the SUCCESS SENTINEL the caller shell greps for.
    console.log(`DOGFOOD_OK reply_latency_ms=${commentLatencyMs}`); // guardrails-ok(no-debug-leftovers): success sentinel
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`dogfood-playwright: ${(error as Error).message}`);
  process.exit(1);
});
