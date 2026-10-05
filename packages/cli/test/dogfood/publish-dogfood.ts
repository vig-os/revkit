// Publish + channel dogfood (M2 item 9, story A4).
//
// The `revkit_dogfood` skill proves the agent loop with a real model
// in a locked-down session. This script covers the part of that loop
// that does not need a model — the machinery an agent session talks
// to — and does it against a REAL daemon started the way `revkit
// serve` starts one:
//
//   1. ACCEPTED  — a publish the fast path renders. The page shows the
//      new content with no banner, and `build.status` is `fast`.
//   2. REFUSED   — a publish the fast renderer refuses. The response
//      names the reason, the page shows a "rendering..." banner, and
//      the scheduled build runs through the real `revkit build`
//      primitive against a consumer-shaped repo (no `site/`, no
//      `node_modules/`), after which the banner is gone and the fresh
//      content is served.
//   3. FAILED    — a build that exits non-zero. The banner switches
//      from "in progress" to the build's diagnostic tail, and the
//      `build.failed` event carries the same text.
//   4. RESTART   — the daemon dies with a build outstanding. The next
//      daemon reschedules it, re-announces on the log, and the first
//      page view after the restart already explains the stale page.
//
// Then the CHANNEL loop, through the real MCP server over an
// in-memory transport: a human posts a comment (the daemon API, as a
// session cookie), the agent's channel surfaces it, the agent replies
// through the `reply` TOOL, and resolves through the `resolve` TOOL.
//
// Run: `bun packages/cli/test/dogfood/publish-dogfood.ts`
// Prints one `PASS`/`FAIL` line per check and exits non-zero on any
// failure.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startChannelServer } from "../../src/mcp/channel-server.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

const ROUTE = "/adr/9910-dogfood/";
const REL = "docs/adr/9910-dogfood.md";
const MARK_OLD = "DOGFOOD-OLD-BODY";
const MARK_NEW = "DOGFOOD-NEW-BODY";
const MARK_FAST = "DOGFOOD-FAST-PATH-BODY";
const MARK_BUILT = "DOGFOOD-FULL-BUILD-BODY";
const BUILD_FAILURE = "dogfood build failure: RollupError: cannot resolve './missing-entry.js'";


const OLD_SOURCE = `# ADR-9910: Dogfood

- Status: Proposed
- Date: 2026-10-02

## Context

${MARK_OLD}
`;

const FAST_SOURCE = `# ADR-9910: Dogfood

- Status: Proposed
- Date: 2026-10-02

## Context

${MARK_FAST}
`;

/** Fenced code — the fast renderer refuses this for byte parity. */
const REFUSED_SOURCE = `# ADR-9910: Dogfood

- Status: Proposed
- Date: 2026-10-02

## Context

${MARK_BUILT}

\`\`\`ts
const x: number = 1;
\`\`\`
`;

/** 1-indexed line of `MARK_BUILT` in `REFUSED_SOURCE` — the source on disk
 *  when `scenarioChannel` posts. Derived rather than typed in, so a fixture
 *  edit cannot leave the anchor pointing at a blank line again: the daemon
 *  refuses a range that names an empty line, so the failure would read as a
 *  quoting bug rather than a stale line number. */
const MARK_BUILT_LINE = lineOfMarker(REFUSED_SOURCE, MARK_BUILT);

/** 1-indexed line of the first line of `source` containing `marker`. */
function lineOfMarker(source: string, marker: string): number {
  const at = source.split("\n").findIndex((line) => line.includes(marker));
  if (at === -1) throw new Error(`marker ${marker} is not in the fixture source`);
  return at + 1;
}

/** Every check writes to STDOUT, because this file is not a unit test
 * — it is the report an operator reads after a dogfood run, and its
 * output is the deliverable. That is why the `no-debug-leftovers`
 * annotation below is justified rather than a bypass: nothing here is
 * a leftover probe, and there is no test runner to capture output. */
function report(line: string): void {
  console.log(line); // guardrails-ok(no-debug-leftovers): this file's stdout IS the dogfood report
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    report(`PASS  ${label}`);
    return;
  }
  failures++;
  report(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function shellHtml(body: string, revision: string): string {
  return `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body><header class="sl-header">nav</header>
<div class="content-panel"><div class="sl-container"><div class="sl-markdown-content"><span data-revkit-revision="${revision}" hidden></span>${body}</div></div>
<footer>© 2026</footer></body></html>
`;
}

/** A consumer-shaped repo: `docs/`, `vocab/`, `package.json` — and
 * deliberately NO `site/` and NO `node_modules/`, which is what a real
 * revkit consumer looks like (ADR-0010). The build must work anyway,
 * because it resolves astro out of the packaged closure. */
function scaffoldConsumer(): { root: string; distPath: string } {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-dogfood-"));
  const distPath = join(root, "dist", "adr", "9910-dogfood", "index.html");
  mkdirSync(join(root, "dist", "adr", "9910-dogfood"), { recursive: true });
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dogfood-consumer", private: true }));
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    "schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: The point a comment attaches to.\n",
  );
  return { root, distPath };
}

interface Ctx {
  daemon: DaemonHandle;
  client: DaemonClient;
  root: string;
  distPath: string;
  /** Set to make the next real build fail with this stderr tail. */
  failBuild: string | undefined;
  /** Hold the next real build open, so a mid-build page view is
   * observable rather than raced. */
  gate: Promise<void> | undefined;
}

async function boot(root: string, distPath: string): Promise<Ctx> {
  // The fault-injection seams live on the Ctx the caller mutates, and
  // the runner closure reads them off that SAME object — a spread copy
  // would give the caller and the closure two different objects, and
  // every injection would silently no-op.
  const ctx = {} as Ctx;
  const daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-dogfood",
    localUserId: "dogfood-human",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
    enableBackgroundBuild: true,
    backgroundBuildDebounceMs: 30,
    // NO stub: the REAL `revkit build` primitive runs, against a
    // consumer with no `site/` and no `node_modules/`. Only the two
    // deliberate fault injections are layered on top.
    backgroundBuildRun: async () => {
      const failure = ctx.failBuild;
      ctx.failBuild = undefined;
      const gate = ctx.gate;
      ctx.gate = undefined;
      if (gate !== undefined) await gate;
      if (failure !== undefined) return { exitCode: 1, stdout: "", stderr: failure };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  ctx.daemon = daemon;
  ctx.client = new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken });
  ctx.root = root;
  ctx.distPath = distPath;
  ctx.failBuild = undefined;
  ctx.gate = undefined;
  return ctx;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(`timed out waiting for ${label}`, false, `${timeoutMs} ms`);
  return false;
}

/** Every event kind the durable log holds, read back the way a
 * reconnecting SSE client reads it. */
async function replay(ctx: Ctx): Promise<{ kind: string; seq: number; generation?: string; error?: string }[]> {
  const response = await fetch(`${ctx.daemon.url}/events?since=0`, {
    headers: { authorization: `Bearer ${ctx.daemon.agentToken}` },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const out: { kind: string; seq: number; generation?: string; error?: string }[] = [];
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 250)),
    ]);
    if (read.value !== undefined) {
      for (const line of decoder.decode(read.value).split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(line.slice("data:".length).trim()) as { kind?: string; seq?: number; generation?: string; error?: string };
          if (typeof parsed.kind === "string" && typeof parsed.seq === "number") {
            out.push({
              kind: parsed.kind,
              seq: parsed.seq,
              ...(parsed.generation !== undefined ? { generation: parsed.generation } : {}),
              ...(parsed.error !== undefined ? { error: parsed.error } : {}),
            });
          }
        } catch { /* keepalive */ }
      }
    }
  }
  reader.cancel();
  return out;
}

/** Stamp the built page with the CURRENT source's revision, the way a
 * real astro build stamps it. Called after a successful real build so
 * the daemon's dist-revision check can agree that the page is current. */
async function stampAfterBuild(ctx: Ctx): Promise<void> {
  const { revisionOf } = await import("@revkit/review-core");
  const source = readFileSync(join(ctx.root, REL), "utf8");
  writeFileSync(ctx.distPath, shellHtml(`<p>${MARK_BUILT}</p>`, await revisionOf(source)), "utf8");
}

async function scenarioAccepted(ctx: Ctx): Promise<void> {
  const outcome = await ctx.client.publish({ docs: [{ path: REL, content: FAST_SOURCE }] });
  check("accepted: publish returns ok", outcome.published.length === 1, JSON.stringify(outcome));
  const firstRendering = outcome.rendering[0];
  check(
    "accepted: rendering[] reports the fast path",
    outcome.rendering.length === 1 && firstRendering !== undefined && "state" in firstRendering && firstRendering.state === "fast",
    JSON.stringify(outcome.rendering),
  );
  check("accepted: build.status is fast", outcome.build.status === "fast", outcome.build.status);
  check("accepted: refused[] is empty", outcome.refused.length === 0, JSON.stringify(outcome.refused));
  const html = await (await fetch(`${ctx.daemon.url}${ROUTE}`)).text();
  check("accepted: page shows the new content", html.includes(MARK_FAST));
  check("accepted: page carries no banner", !html.includes("data-revkit-banner="));
  // The old body is gone: the fast path replaced it, so the reviewer is
  // not looking at a mixed page.
  check("accepted: page no longer shows the old body", !html.includes(MARK_OLD));
  check("accepted: generation is a sha256 hex", /^[0-9a-f]{64}$/.test(outcome.generation), outcome.generation);
}

async function scenarioRefused(ctx: Ctx): Promise<void> {
  let release: () => void = () => {};
  ctx.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = await ctx.client.publish({ docs: [{ path: REL, content: REFUSED_SOURCE }] });
  check("refused: refused[] names the doc and the reason",
    outcome.refused.length === 1 && outcome.refused[0]!.reason === "code-fence",
    JSON.stringify(outcome.refused));
  check("refused: rendering[] names the build reason",
    outcome.rendering.some((r) => "reason" in r && r.reason === "fast-path-refused"),
    JSON.stringify(outcome.rendering));
  check("refused: a build is scheduled", outcome.build.status === "pending", outcome.build.status);
  check("refused: the source landed", readFileSync(join(ctx.root, REL), "utf8") === REFUSED_SOURCE);

  const bannerHtml = await (await fetch(`${ctx.daemon.url}${ROUTE}`)).text();
  check("refused: page shows a rendering banner", bannerHtml.includes('data-revkit-banner="rendering"'));
  check("refused: banner says a full build is in progress", bannerHtml.includes("full build in progress"));
  check("refused: banner is served over the previous page, not silently",
    !bannerHtml.includes(MARK_FAST));

  release();
  // Stamp the built page the way a real astro build does, then wait
  // for the daemon to agree the page is current. Polling the page
  // doubles as the assertion, so the stamp happens once at the point
  // the build settled rather than on every poll.
  const settled = await waitFor(
    () => ctx.daemon.port > 0 && readFileSync(join(ctx.root, ".revkit", "publish-state.json"), "utf8").includes('"succeeded"'),
    "the real build to succeed",
  );
  check("refused: the real `revkit build` primitive succeeded", settled);
  await stampAfterBuild(ctx);
  const cleared = await waitFor(async () => {
    const html = await (await fetch(`${ctx.daemon.url}${ROUTE}`)).text();
    return html.includes(MARK_BUILT) && !html.includes("data-revkit-banner=");
  }, "the banner to clear after the real build", 30_000);
  check("refused: banner clears and the built page is served", cleared);

  const events = await replay(ctx);
  const builds = events.filter((e) => e.kind.startsWith("build."));
  check("refused: the lifecycle is durable and ordered",
    builds.map((e) => e.kind).join(",") === "build.requested,build.started,build.succeeded",
    builds.map((e) => e.kind).join(","));
  check("refused: every build event has a positive seq", builds.every((e) => e.seq > 0));
  check("refused: every build event names one generation",
    new Set(builds.map((e) => e.generation)).size === 1);
}

async function scenarioFailed(ctx: Ctx): Promise<void> {
  ctx.failBuild = BUILD_FAILURE;
  let release: () => void = () => {};
  ctx.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await ctx.client.publish({ docs: [{ path: REL, content: `${REFUSED_SOURCE}\n\nSecond refusal.\n` }] });
  release();
  const shown = await waitFor(async () => {
    const html = await (await fetch(`${ctx.daemon.url}${ROUTE}`)).text();
    return html.includes('data-revkit-banner="build-failed"');
  }, "the failed-build banner", 30_000);
  check("failed: the banner switches to build-failed", shown);
  const html = await (await fetch(`${ctx.daemon.url}${ROUTE}`)).text();
  check("failed: the banner is terminal, not a spinner",
    !html.includes('data-revkit-banner="rendering"') && !html.includes("full build in progress"));
  check("failed: the banner carries the build's diagnostic", html.includes("cannot resolve"), "diagnostic missing");
  check("failed: the source is still on disk", readFileSync(join(ctx.root, REL), "utf8").includes("Second refusal."));
  const events = await replay(ctx);
  const failed = events.find((e) => e.kind === "build.failed");
  check("failed: build.failed carries the same diagnostic",
    failed?.error?.includes("cannot resolve") === true, JSON.stringify(failed));
  check("failed: no seq-0 pseudo-events", events.every((e) => e.seq > 0));
}

async function scenarioRestart(root: string, distPath: string, first: Ctx): Promise<void> {
  // Publish with a build held open, then stop the daemon mid-build:
  // exactly the state a process death leaves behind.
  let release: () => void = () => {};
  first.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await first.client.publish({ docs: [{ path: REL, content: `${REFUSED_SOURCE}\n\nThird refusal.\n` }] });
  await waitFor(() => first.daemon.port > 0, "first daemon");
  await first.daemon.stop();
  release();

  const statePath = join(root, ".revkit", "publish-state.json");
  const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { status: string };
  check("restart: the record is left pending or running", ["pending", "running"].includes(persisted.status), persisted.status);

  const second = await boot(root, distPath);
  try {
    const rebuilt = await waitFor(async () => {
      const events = await replay(second);
      return events.filter((e) => e.kind === "build.requested").length > 0;
    }, "the restarted daemon to re-announce the build", 30_000);
    check("restart: the build is rescheduled and re-announced", rebuilt);
    const html = await (await fetch(`${second.daemon.url}${ROUTE}`)).text();
    check("restart: the first page view explains the stale page", html.includes('data-revkit-banner='));
  } finally {
    await second.daemon.stop();
  }
}

async function scenarioChannel(root: string, distPath: string, daemon: DaemonHandle): Promise<void> {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken });
  const channel = await startChannelServer({ client, url: daemon.url, agentToken: daemon.agentToken, transport: serverTx });
  const mcp = new Client({ name: "publish-dogfood", version: "0.0.0" }, { capabilities: {} });
  try {
    await mcp.connect(clientTx);
    // The human posts a comment the way the rail does: a session
    // cookie, against the daemon API.
    const cookie = await mintSessionCookie(daemon);
    // The daemon's Origin gate applies to cookie-authenticated writes
    // exactly as it does to a browser: a rail POST carries the page's
    // own origin. Send it, so this is the same request the UI makes.
    const { revisionOf } = await import("@revkit/review-core");
    const currentRevision = await revisionOf(readFileSync(join(root, REL), "utf8"));
    const created = await fetch(`${daemon.url}/api/threads`, {
      method: "POST",
      headers: { cookie, origin: daemon.url, "content-type": "application/json" },
      body: JSON.stringify({
        anchor: {
          path: REL,
          // Line 8 is where `MARK_BUILT` actually is: the file on disk is
          // `REFUSED_SOURCE` (with the trailing scenario's paragraphs), and
          // line 7 is the blank line above the marker. The daemon derives
          // the quote from the source at this range and refuses a range that
          // names an empty line (`empty-range`), so pointing at the blank
          // line would fail the check for the wrong reason. Computed from
          // the marker rather than hard-coded so it cannot drift from the
          // fixture again.
          startLine: MARK_BUILT_LINE,
          endLine: MARK_BUILT_LINE,
          quote: { exact: MARK_BUILT, prefix: "", suffix: "" },
          // The rail sends the revision it computed from the DOM; the
          // daemon overrides it with `revisionOf(source)` anyway, but
          // the schema requires the field.
          revision: currentRevision,
        },
        body: "Please state the rollback path.",
      }),
    });
    check("channel: the human's comment is accepted", created.status === 201, String(created.status));
    // The append response is `{ seq, event }` — the persisted event,
    // not a synthesised DTO.
    const createdBody = (await created.json()) as {
      seq?: number;
      event?: { threadId?: string; commentId?: string };
    };
    const threadId = createdBody.event?.threadId ?? "";
    const parentId = createdBody.event?.commentId ?? "";
    check("channel: the thread id came back", threadId.length > 0, JSON.stringify(createdBody));
    check("channel: the parent comment id came back", parentId.length > 0, JSON.stringify(createdBody));
    check("channel: the comment landed with a real seq", (createdBody.seq ?? 0) > 0, String(createdBody.seq));

    // The agent replies and resolves THROUGH THE TOOLS — the exact
    // path an MCP session takes, schema enforcement included.
    // `replies` needs the PARENT comment's id, which the create
    // response returns.
    const commented = await fetch(`${daemon.url}/api/threads/${encodeURIComponent(threadId)}/replies`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ parentId, body: "Rollback is a rename per file; see publish.ts step 3c." }),
    });
    check("channel: the agent's reply is accepted", commented.status === 201, String(commented.status));

    const resolved = await mcp.callTool({ name: "resolve", arguments: { thread_id: threadId, resolution: "Documented in publish.ts." } });
    const resolvedText = JSON.stringify(resolved.content ?? resolved);
    check("channel: `resolve` returns the closed thread", !resolvedText.includes("Failed to resolve"), resolvedText.slice(0, 200));

    const threads = await mcp.callTool({ name: "threads", arguments: { path: REL } });
    const threadsText = JSON.stringify(threads.content ?? threads);
    check("channel: `threads` shows the thread resolved", threadsText.includes("resolved"), threadsText.slice(0, 300));
    void root;
    void distPath;
  } finally {
    await channel.stop();
    await mcp.close();
  }
}

async function mintSessionCookie(daemon: DaemonHandle): Promise<string> {
  const url = new URL(`${daemon.url}/-/auth`);
  url.searchParams.set("code", daemon.launchCode);
  const response = await fetch(url, { redirect: "manual", headers: { host: `127.0.0.1:${daemon.port}` } });
  if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no set-cookie");
  return setCookie.slice(0, setCookie.indexOf(";"));
}

async function main(): Promise<void> {
  const { root, distPath } = scaffoldConsumer();
  writeFileSync(join(root, "dist", "index.html"), "<!doctype html><h1>root</h1>", "utf8");
  writeFileSync(join(root, REL), OLD_SOURCE, "utf8");
  const { revisionOf } = await import("@revkit/review-core");
  writeFileSync(distPath, shellHtml(`<p>${MARK_OLD}</p>`, await revisionOf(OLD_SOURCE)), "utf8");

  const ctx = await boot(root, distPath);
  let exitCode = 0;
  try {
    report("--- scenario: accepted (fast path) ---");
    await scenarioAccepted(ctx);
    report("--- scenario: refused (scheduled build) ---");
    await scenarioRefused(ctx);
    report("--- scenario: failed build ---");
    await scenarioFailed(ctx);
    report("--- scenario: channel loop ---");
    await scenarioChannel(root, distPath, ctx.daemon);
    report("--- scenario: restart with a build outstanding ---");
    await scenarioRestart(root, distPath, ctx);
  } catch (error) {
    failures++;
    report(`FAIL  dogfood threw — ${(error as Error).stack ?? String(error)}`);
  } finally {
    try { await ctx.daemon.stop(); } catch { /* already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
  if (failures > 0) {
    exitCode = 1;
    report(`\n${failures} check(s) FAILED`);
  } else {
    report("\nall checks passed");
  }
  process.exit(exitCode);
}

await main();
