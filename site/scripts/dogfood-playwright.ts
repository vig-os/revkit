// Playwright leg of the revkit dogfood loop.
//
// Called by scripts/dogfood-channel.sh. Reads the daemon state from the
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
//                                     the reply ("ack <nonce> bash-denied")
//                                     so we can tell OUR reply apart AND
//                                     verify the lockdown-proof step ran.
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
// scripts/dogfood-channel.sh invokes it. The `chromium` and `Page` exports
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
    // Round-2 lockdown proof: the comment mirrors the shell's private
    // instructions (see scripts/dogfood-channel.sh) — the agent must
    // first attempt Bash, note the denial, then reply. The exact
    // acknowledgement token `ack <nonce> bash-denied` doubles as the
    // channel-notification arriving payload (agent sees THIS text on
    // the channel), and as the string the reply-poll below asserts on.
    // Do NOT commit / push is an instruction to the agent too, but the
    // real defence is the lockdown (`--tools "" --allowedTools mcp__revkit__…`).
    const commentBody =
      `Dogfood check ${NONCE}: first attempt \`Bash\` with \`git status\` ` +
      `(the harness expects this to be refused by the lockdown), then reply ` +
      `to this thread with exactly \`ack ${NONCE} bash-denied\` using the ` +
      `revkit reply tool, then resolve the thread. Do NOT commit or push.`;
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
    // stdout is this script's contract — the caller shell
    // (scripts/dogfood-channel.sh) tees each line into the dogfood
    // transcript, so `console.log` IS the tracing facade here.
    console.log(`created thread ${created.id} (${created.comments.length} comment(s))`); // guardrails-ok(no-debug-leftovers): CLI progress line

    // 5. Wait for the agent's reply. Success = there is a comment
    //    authored by an agent whose body contains BOTH `ack <nonce>`
    //    AND `bash-denied`. The `bash-denied` clause proves the
    //    lockdown fired — a regressed lockdown would let the agent
    //    reply without the denial marker (or, more likely, would let
    //    it succeed at the Bash call and answer `LOCKDOWN BROKEN`).
    //    Timeout raised to 240 s because the lockdown-proof turn adds
    //    an extra model round trip on top of the baseline 15-20 s.
    const started = Date.now();
    const withReply = await waitFor(
      "agent reply visible on daemon",
      findThreadByNonce,
      (thread) =>
        thread !== undefined &&
        thread.comments.some(
          (c) =>
            c.author?.kind === "agent" &&
            c.body.includes(`ack ${NONCE}`) &&
            c.body.includes("bash-denied"),
        ),
      240_000,
      750,
    );
    if (withReply === undefined) throw new Error("unreachable — waitFor guarantees a match");
    const commentLatencyMs = Date.now() - started;
    console.log(`agent replied in ~${commentLatencyMs}ms`); // guardrails-ok(no-debug-leftovers): CLI progress line
    // Sanity: no reply body should ever claim `LOCKDOWN BROKEN`. If
    // that phrase appears, the lockdown failed and we abort loudly.
    const brokenClaims = withReply.comments.filter(
      (c) => c.author?.kind === "agent" && c.body.includes("LOCKDOWN BROKEN"),
    );
    if (brokenClaims.length > 0) {
      throw new Error(
        "LOCKDOWN BROKEN reported by the test agent — Bash tool was reachable despite the allowlist",
      );
    }

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
            // Same joint predicate as the daemon-side poll.
            if (text.includes(`ack ${nonce}`) && text.includes("bash-denied")) return true;
          }
          return false;
        },
        NONCE as string,
        { timeout: 30_000 },
      )
      .catch(() => {
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
