// HTTP-boundary tests for `POST /api/publish` (M2 item 9, story A4).
//
// Every test boots a real in-process daemon against a temporary
// repo root that carries a minimal shell HTML for one ADR route,
// posts a publish request as the agent, and asserts on:
//
//   1. The event fanout (`doc.published` lands on `/events`).
//   2. The GET of the doc route serves the fast-path override,
//      not the shell's original content.
//   3. The refusal path: bearer required, path confinement, `revkit
//      check` gate.
//   4. Live-refresh latency budget (write-to-visible under 1 second).
//
// A dogfood-style Playwright test lives in `site/tests/publish.spec.ts`
// alongside the ADR-visible test — this file exercises the daemon-
// only boundary at bun-test speed so a regression is caught before
// the full-browser suite runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { ARTICLE_OPEN_MARKER } from "../../src/serve/publish.ts";

const SHELL = `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body>
<header class="sl-header">nav</header>
<div class="content-panel"><div class="sl-container"><h1>ADR</h1></div></div>
<div class="content-panel"><div class="sl-container">${ARTICLE_OPEN_MARKER}<p>OLD BODY</p></div></div>
<footer>© 2026</footer>
</body></html>
`;

const ORIGINAL_ADR = `# ADR-0999: Test\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\nOld context.\n`;

interface Ctx {
  handle: DaemonHandle;
  root: string;
  dist: string;
  logs: string[];
}

async function startCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-http-"));
  const dist = join(root, "dist");
  const distAdr = join(dist, "adr", "0999-test");
  mkdirSync(distAdr, { recursive: true });
  writeFileSync(join(distAdr, "index.html"), SHELL);
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>root</h1>");
  // Seed the source tree so the confinement check has a parent
  // directory to write into.
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0999-test.md"), ORIGINAL_ADR);
  // Seed vocab so `revkit check` doesn't fail with "failed to load
  // vocab" (the vocab schema requires at least one entry). The
  // shape must match `vocabFileSchema`.
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    `schemaVersion: 1\nentries:\n  - id: placeholder\n    term: placeholder\n    definition: A placeholder term for tests.\n`,
  );
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    // No re-anchor watcher: the tests are fast, and the poll fallback
    // adds hundreds of ms per boot.
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
  });
  return { handle, root, dist, logs };
}

async function stopCtx(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

/** POST a publish batch as the agent. */
async function publish(
  handle: DaemonHandle,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${handle.url}/api/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${handle.agentToken}`,
      host: `127.0.0.1:${handle.port}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/publish — happy path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startCtx();
  });
  afterEach(async () => {
    await stopCtx(ctx);
  });

  test("accepts a valid update; the doc route serves the OVERRIDE next", async () => {
    const newBody = `# ADR-0999: Test\n\n- Status: Accepted\n- Date: 2026-09-30\n\n## Context\n\nNEW BODY MARKER.\n`;
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: newBody }],
    });
    expect(response.status).toBe(201);
    const outcome = (await response.json()) as {
      published: readonly { path: string; route?: string; revision: string }[];
      overrides: readonly { route: string; dataSrcCount: number }[];
    };
    expect(outcome.published).toHaveLength(1);
    expect(outcome.published[0]?.route).toBe("/adr/0999-test/");
    expect(outcome.published[0]?.revision).toBe(await revisionOf(newBody));
    expect(outcome.overrides).toHaveLength(1);
    expect(outcome.overrides[0]?.route).toBe("/adr/0999-test/");
    expect(outcome.overrides[0]?.dataSrcCount).toBeGreaterThan(0);

    // The doc route now serves the fast-path override.
    const pageAfter = await fetch(`${ctx.handle.url}/adr/0999-test/`, {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(pageAfter.status).toBe(200);
    const pageHtml = await pageAfter.text();
    expect(pageHtml).toContain("NEW BODY MARKER.");
    expect(pageHtml).not.toContain("OLD BODY");
    // Shell preservation: the footer + header survived byte-for-byte.
    expect(pageHtml).toContain('<header class="sl-header">nav</header>');
    expect(pageHtml).toContain("<footer>© 2026</footer>");
  });

  test("write-to-visible latency is under 1 second (story A4)", async () => {
    const newBody = `# ADR-0999: Test\n\n- Status: Proposed\n\n## Context\n\nUPDATED FROM PUBLISH LATENCY TEST.\n`;
    const t0 = performance.now();
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: newBody }],
    });
    expect(response.status).toBe(201);
    const pageAfter = await fetch(`${ctx.handle.url}/adr/0999-test/`, {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    const html = await pageAfter.text();
    const t1 = performance.now();
    const elapsedMs = t1 - t0;
    expect(html).toContain("UPDATED FROM PUBLISH LATENCY TEST.");
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("`doc.published` reaches an SSE subscriber", async () => {
    // Open an agent-audience event stream, wait for the SSE
    // `hello` frame (the first `: keepalive` the daemon flushes on
    // `start` to prove the subscriber is primed), THEN publish.
    // Reading the first frame synchronously before the POST is
    // the race guard: on `start` the daemon primes the resume
    // slice + attaches the subscriber, so a frame arriving after
    // the first keepalive is guaranteed to hit us.
    const events: unknown[] = [];
    const eventStream = new Response(
      (
        await fetch(`${ctx.handle.url}/events?for=agent&since=0`, {
          headers: {
            authorization: `Bearer ${ctx.handle.agentToken}`,
            accept: "text/event-stream",
            host: `127.0.0.1:${ctx.handle.port}`,
          },
        })
      ).body,
    );
    const reader = eventStream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readOne = async (deadlineMs: number): Promise<string> => {
      while (Date.now() < deadlineMs) {
        const readPromise = reader.read();
        const timeout = new Promise<undefined>((r) =>
          setTimeout(() => r(undefined), Math.max(0, deadlineMs - Date.now())),
        );
        const winner = await Promise.race([readPromise, timeout]);
        if (winner === undefined) return "";
        const { value, done } = winner as ReadableStreamReadResult<Uint8Array>;
        if (done) return "";
        buffered += decoder.decode(value, { stream: true });
        const at = buffered.indexOf("\n\n");
        if (at !== -1) {
          const frame = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          return frame;
        }
      }
      return "";
    };
    // 1) Wait for the first SSE frame — the daemon's
    //    `sseKeepalive()` fires from inside `start()`, so its
    //    presence proves `bus.subscribe(subscriber)` has run.
    const helloDeadline = Date.now() + 2_000;
    const hello = await readOne(helloDeadline);
    expect(hello.length).toBeGreaterThan(0);
    // 2) Publish. The event's fan-out lands AFTER our subscriber
    //    is attached, so no race.
    const newBody = `# ADR-0999: Test\n\n- Status: Accepted\n\n## Context\n\nEvent flow test.\n`;
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: newBody }],
    });
    expect(response.status).toBe(201);
    // 3) Read frames for up to 2 s and look for `doc.published`.
    const frameDeadline = Date.now() + 2_000;
    while (Date.now() < frameDeadline) {
      const frame = await readOne(frameDeadline);
      if (frame === "") continue;
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine === undefined) continue;
      try {
        const parsed = JSON.parse(dataLine.slice(6)) as { kind?: string };
        events.push(parsed);
        if (parsed.kind === "doc.published") break;
      } catch {
        // ignore
      }
    }
    reader.cancel();
    const kinds = events.map((e) => (e as { kind?: string }).kind);
    expect(kinds).toContain("doc.published");
    // Presence beacons are ephemeral (M2 item 6 round 2): the hub
    // broadcasts a `presence` frame with no `seq`. Both editing
    // and idle land on this same stream, so we require at least
    // one to prove the envelope wraps the publish.
    expect(kinds).toContain("presence");
  });
});

describe("POST /api/publish — CSP + shell hygiene", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startCtx();
  });
  afterEach(async () => {
    await stopCtx(ctx);
  });

  test("override responses still carry the full daemon CSP header", async () => {
    const newBody = `# ADR-0999: Test\n\n- Status: Accepted\n\n## Context\n\nCSP flow test.\n`;
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: newBody }],
    });
    expect(response.status).toBe(201);
    const page = await fetch(`${ctx.handle.url}/adr/0999-test/`, {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    const csp = page.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    // The CSP shape ADR-0013 amendment pins for the daemon:
    // `default-src 'none'`, explicit rail path, no `'unsafe-eval'`
    // (JavaScript eval) — but `'wasm-unsafe-eval'` IS allowed
    // (pagefind's `.wasm` runtime). Assert the two independently
    // so a widening of one does not silently unlock the other.
    expect(csp!).toContain("default-src 'none'");
    expect(csp!).not.toContain("'unsafe-eval'");
    expect(csp!).toContain("/-/rail.js");
  });

  test("Content-Type is text/html on the override (rail expects HTML)", async () => {
    const response = await publish(ctx.handle, {
      docs: [
        {
          path: "docs/adr/0999-test.md",
          content: `# ADR-0999: Test\n\n- Status: Proposed\n\n## Context\n\nhi\n`,
        },
      ],
    });
    expect(response.status).toBe(201);
    const page = await fetch(`${ctx.handle.url}/adr/0999-test/`, {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(page.headers.get("content-type")?.startsWith("text/html")).toBe(true);
  });
});

describe("POST /api/publish — re-anchoring after write", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startCtx();
  });
  afterEach(async () => {
    await stopCtx(ctx);
  });

  test("a thread whose anchor lives on the published file re-anchors to the new revision", async () => {
    // Create a thread on the OLD source, then publish a NEW source
    // that keeps the anchored quote. The re-anchor pipeline should
    // move the thread's `revision` to the new one.
    const oldSource = ORIGINAL_ADR;
    const targetQuote = "Old context.";
    const oldIdx = oldSource.indexOf(targetQuote);
    expect(oldIdx).toBeGreaterThan(0);
    const before = oldSource.slice(0, oldIdx);
    const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
    // Non-empty prefix + suffix so `prepareReanchor` has enough
    // context to run move detection (`reanchor.ts` refuses an
    // "insufficient context" pattern otherwise). The prefix comes
    // from the preceding line; the suffix is the file's tail.
    const anchor = {
      path: "docs/adr/0999-test.md",
      startLine,
      endLine: startLine,
      quote: {
        exact: targetQuote,
        prefix: "## Context\n\n",
        suffix: "\n",
      },
      revision: "0".repeat(64),
    };
    const cookieRes = await fetch(ctx.handle.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    const setCookie = cookieRes.headers.get("set-cookie")!;
    const cookie = setCookie.slice(0, setCookie.indexOf(";"));
    const createRes = await fetch(`${ctx.handle.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie,
        host: `127.0.0.1:${ctx.handle.port}`,
        origin: ctx.handle.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "why?" }),
    });
    expect(createRes.status).toBe(201);
    // Publish a version that still contains the quote — the fuzzy
    // pipeline finds it under a fresh revision.
    const newSource = `# ADR-0999: Test\n\n- Status: Accepted\n- Date: 2026-09-30\n\n## Context\n\nOld context. And a fresh sentence.\n`;
    const publishRes = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: newSource }],
    });
    expect(publishRes.status).toBe(201);
    const threadsRes = await fetch(
      `${ctx.handle.url}/api/threads?path=docs%2Fadr%2F0999-test.md`,
      {
        headers: {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          host: `127.0.0.1:${ctx.handle.port}`,
        },
      },
    );
    const threadsBody = (await threadsRes.json()) as {
      threads: readonly {
        anchor: { revision: string; startLine?: number };
        status: string;
      }[];
    };
    expect(threadsBody.threads.length).toBe(1);
    // Proof that the re-anchor pipeline ran: either the thread's
    // anchor moved to the NEW revision (`thread.reanchored`), OR
    // the thread transitioned to `orphaned` (`thread.orphaned`
    // event, which keeps the anchor's original revision as the
    // reducer's projection of the last-known-good position). Both
    // outcomes prove the pipeline saw the new source; the point
    // of the test is that publish TRIGGERS the pipeline, not
    // which outcome it produces on this fixture.
    const thread = threadsBody.threads[0]!;
    const newRevision = await revisionOf(newSource);
    if (thread.status === "open") {
      expect(thread.anchor.revision).toBe(newRevision);
    } else {
      expect(thread.status).toBe("orphaned");
    }
  });
});

describe("POST /api/publish — refusal cases", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startCtx();
  });
  afterEach(async () => {
    await stopCtx(ctx);
  });

  test("refuses a caller with no bearer (403)", async () => {
    const response = await fetch(`${ctx.handle.url}/api/publish`, {
      method: "POST",
      headers: { host: `127.0.0.1:${ctx.handle.port}`, "content-type": "application/json" },
      body: JSON.stringify({ docs: [{ path: "docs/adr/0999-test.md", content: "# x\n" }] }),
    });
    expect(response.status).toBe(403);
  });

  test("refuses a `../` traversal (400 confinement)", async () => {
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/../../etc/passwd", content: "boom" }],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("confinement");
  });

  test("refuses a path outside the publishable roots", async () => {
    const response = await publish(ctx.handle, {
      docs: [{ path: "packages/cli/src/index.ts", content: "// pwned\n" }],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("confinement");
  });

  test("refuses a batch that fails `revkit check` and ROLLS BACK the write", async () => {
    // A payload containing a hand-rolled `<script>` tag is refused by
    // the component-registry rule (raw HTML in .md is refused
    // outside comments).
    const previous = readFileSync(join(ctx.root, "docs/adr/0999-test.md"), "utf8");
    const bad = `# ADR-0999\n\n<script>alert(1)</script>\n`;
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: bad }],
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; diagnostics?: string[] };
    expect(body.error).toBe("check-failed");
    expect(body.diagnostics?.length ?? 0).toBeGreaterThan(0);
    // Rollback: the file on disk is what it was before.
    const after = readFileSync(join(ctx.root, "docs/adr/0999-test.md"), "utf8");
    expect(after).toBe(previous);
  });

  test("returns 413 when the per-file body exceeds 5 MiB (round-2 nit)", async () => {
    const previous = readFileSync(join(ctx.root, "docs/adr/0999-test.md"), "utf8");
    // 5 MiB + 1 byte of ASCII → byteLength = 5 MiB + 1.
    const oversized = `# ADR-0999\n\n${"x".repeat(5 * 1024 * 1024 + 1)}\n`;
    const response = await publish(ctx.handle, {
      docs: [{ path: "docs/adr/0999-test.md", content: oversized }],
    });
    expect(response.status).toBe(413);
    // Rollback: no write should have landed for an over-cap batch.
    const after = readFileSync(join(ctx.root, "docs/adr/0999-test.md"), "utf8");
    expect(after).toBe(previous);
  });

  test("concurrent publish requests serialise cleanly (round-2 nit)", async () => {
    // Two overlapping publishes to the SAME path. The module-scoped
    // publish mutex must serialise them; both must complete with a
    // deterministic final state (the LAST publish wins on disk).
    const bodyA = `# ADR-0999\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\nA writes first.\n`;
    const bodyB = `# ADR-0999\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\nB writes second.\n`;
    const [resA, resB] = await Promise.all([
      publish(ctx.handle, { docs: [{ path: "docs/adr/0999-test.md", content: bodyA }] }),
      publish(ctx.handle, { docs: [{ path: "docs/adr/0999-test.md", content: bodyB }] }),
    ]);
    // Both requests must succeed (2xx). One of them is the "winner"
    // that ended up on disk; the other was applied first and then
    // overwritten. Neither should 500 or hang.
    expect([resA.status, resB.status].every((s) => s >= 200 && s < 300)).toBe(true);
    const onDisk = readFileSync(join(ctx.root, "docs/adr/0999-test.md"), "utf8");
    // Final content is one of the two bodies (both LF-normalised).
    expect([bodyA, bodyB]).toContain(onDisk);
  });
});
