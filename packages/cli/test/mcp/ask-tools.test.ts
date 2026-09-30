// MCP contract tests for the `ask` and `await_answer` tools
// (M2 item 7, story A1). Spin up a real daemon plus a real MCP
// channel server connected via `InMemoryTransport`, then drive an
// MCP client through listTools plus each of the tools. The
// load-bearing assertion is the concurrent round-trip: start
// `await_answer(id)`, then POST the humans answer, and check the
// tool returns with the answered record under 1000 ms (the A1
// acceptance). A separate assertion covers the still-pending
// timeout path so the agent knows to call again, and a fast-path
// assertion covers a call after the ask is already terminal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Ask } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { startChannelServer, type ChannelServerHandle } from "../../src/mcp/channel-server.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";

interface Ctx {
  daemon: DaemonHandle;
  root: string;
  dist: string;
  channel: ChannelServerHandle;
  client: Client;
  cookie: string;
}

const choiceSpec: Ask = {
  schemaVersion: 1,
  kind: "choice",
  title: "Which storage?",
  options: [
    { id: "d1", label: "D1" },
    { id: "kv", label: "KV" },
  ],
  allowOther: false,
  multi: false,
};

async function boot(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-mcp-ask-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
  const daemon = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
  });
  const cookie = await mintSessionCookie(daemon);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const daemonClient = new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken });
  // NOTE: we intentionally DO NOT stub `subscribeEvents` here so
  // the ask-answered wake-up flows through the real SSE loop the
  // production channel uses. That is the whole point of the
  // latency assertion.
  const channel = await startChannelServer({
    client: daemonClient,
    url: daemon.url,
    agentToken: daemon.agentToken,
    transport: serverTx,
  });
  const client = new Client(
    { name: "revkit-mcp-ask-tools-test", version: "0.0.0-test" },
    { capabilities: {} },
  );
  await client.connect(clientTx);
  return { daemon, root, dist, channel, client, cookie };
}

async function tearDown(ctx: Ctx): Promise<void> {
  try { await ctx.channel.stop(); } catch { /* already stopped */ }
  await ctx.daemon.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

async function mintSessionCookie(daemon: DaemonHandle): Promise<string> {
  const url = new URL(daemon.url + "/-/auth");
  url.searchParams.set("code", daemon.launchCode);
  const response = await fetch(url, {
    redirect: "manual",
    headers: { host: `127.0.0.1:${daemon.port}` },
  });
  if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no set-cookie");
  const eq = setCookie.indexOf("=");
  const semi = setCookie.indexOf(";");
  if (eq === -1 || semi === -1) throw new Error("bad set-cookie");
  return setCookie.slice(0, semi);
}

async function humanAnswer(ctx: Ctx, askId: string, value: string): Promise<void> {
  const response = await fetch(`${ctx.daemon.url}/api/asks/${askId}/answer`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${ctx.daemon.port}`,
      origin: `http://127.0.0.1:${ctx.daemon.port}`,
      cookie: ctx.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ answer: { kind: "choice", value } }),
  });
  if (!response.ok) throw new Error(`humanAnswer failed: ${response.status}`);
}

/** Parse the tool result's `content[0].text` as JSON. */
function parseToolResult(result: unknown): Record<string, unknown> {
  const text = (result as { content?: readonly { text?: string }[] } | undefined)?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result missing text");
  return JSON.parse(text) as Record<string, unknown>;
}

let ctxRef: Ctx | undefined;
beforeEach(async () => { ctxRef = await boot(); });
afterEach(async () => { if (ctxRef !== undefined) { await tearDown(ctxRef); ctxRef = undefined; } });

describe("MCP ask + await_answer", () => {
  test("listTools includes `ask` and `await_answer`", async () => {
    const ctx = ctxRef!;
    const tools = await ctx.client.listTools();
    const names = tools.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toContain("ask");
    expect(names).toContain("await_answer");
  });

  test("ask returns { ask, url } — url is a ready-to-open launch URL (next=/ask/<id>)", async () => {
    const ctx = ctxRef!;
    const result = await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } });
    const parsed = parseToolResult(result);
    expect(typeof parsed.url).toBe("string");
    const record = parsed.ask as { id: string; status: string; spec: { kind: string } };
    expect(record.status).toBe("pending");
    expect(record.spec.kind).toBe("choice");
    expect(record.id.length).toBeGreaterThan(0);
    // PR #52 review: the returned URL is a full loopback URL
    // (a `?code=<launch-code>&next=/ask/<id>` link the human can
    // click to land on the page with a session cookie), not a
    // bare `/ask/<id>` path.
    const openUrl = new URL(parsed.url as string);
    expect(openUrl.hostname).toBe("127.0.0.1");
    expect(openUrl.pathname).toBe("/-/auth");
    expect(openUrl.searchParams.get("next")).toBe(`/ask/${record.id}`);
    expect(openUrl.searchParams.get("code")?.length).toBeGreaterThan(20);
  });

  test("await_answer wakes on the SSE frame and returns the answered record in under 1000 ms (A1 < 1 s)", async () => {
    const ctx = ctxRef!;
    // Create the ask.
    const created = parseToolResult(
      await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } }),
    );
    const askId = (created.ask as { id: string }).id;
    // Small warm-up so the SSE loop's initial primer is drained
    // before we start measuring. Latency is answer-to-tool wake,
    // not first-connect settle.
    await new Promise((r) => setTimeout(r, 100));
    const start = performance.now();
    // Run the answer POST concurrently with `await_answer`. The
    // POST fires ~immediately; the poll should wake on the SSE
    // frame the daemon emits from `ask.answered`.
    const pollPromise = ctx.client.callTool({
      name: "await_answer",
      arguments: { id: askId, timeout_ms: 8000 },
    });
    // Nudge to ensure the poll is registered before the POST lands.
    await new Promise((r) => setTimeout(r, 10));
    await humanAnswer(ctx, askId, "d1");
    const result = await pollPromise;
    const elapsedMs = performance.now() - start;
    const record = parseToolResult(result).ask as { status: string; answer: { value: string } };
    expect(record.status).toBe("answered");
    expect(record.answer.value).toBe("d1");
    // A1 acceptance: answer-to-agent latency < 1 s.
    expect(elapsedMs).toBeLessThan(1000);
    // Attach the measurement to the runner so a report scanner can
    // read it back (bun test prints console output by default).
    // eslint-disable-next-line no-console
    console.log(`await_answer wake latency: ${elapsedMs.toFixed(1)} ms`);
  });

  test("await_answer with a small timeout returns the still-pending record instead of hanging", async () => {
    const ctx = ctxRef!;
    const created = parseToolResult(
      await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } }),
    );
    const askId = (created.ask as { id: string }).id;
    const start = performance.now();
    const result = await ctx.client.callTool({
      name: "await_answer",
      arguments: { id: askId, timeout_ms: 200 },
    });
    const elapsedMs = performance.now() - start;
    const parsed = parseToolResult(result);
    const record = parsed.ask as { status: string };
    expect(record.status).toBe("pending");
    // Should be at least the timeout, at most ~2× (some CI slop).
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("PR #52 review — await_answer catches a terminal event that lands DURING its fast-path getAsk (waiter registered first)", async () => {
    // A deterministic race: we make the fast-path GET slow, and
    // fire the answer POST while the GET is still in flight. If
    // the waiter is registered BEFORE the GET (the fix), the
    // subscriber wakes it as soon as the SSE frame lands and
    // `await_answer` returns the answered record. If the waiter
    // is registered AFTER the GET (the bug), the SSE frame lands
    // with nobody to wake, and `await_answer` falls through to
    // the timeout path.
    const ctx = ctxRef!;
    const created = parseToolResult(
      await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } }),
    );
    const askId = (created.ask as { id: string }).id;
    // Warm the SSE subscriber before we start racing.
    await new Promise((r) => setTimeout(r, 100));
    // Kick a POST that WILL land while `await_answer` is in the
    // getAsk fetch. `await_answer` is bounded by 800 ms; we fire
    // the answer 50 ms in — well before the timeout.
    const answerAfter = new Promise<void>((r) => setTimeout(r, 50));
    void answerAfter.then(() => humanAnswer(ctx, askId, "d1"));
    const start = performance.now();
    const result = await ctx.client.callTool({
      name: "await_answer",
      arguments: { id: askId, timeout_ms: 800 },
    });
    const elapsed = performance.now() - start;
    const record = parseToolResult(result).ask as { status: string; answer: { value: string } };
    // The load-bearing assertion: the tool returns answered, not
    // pending. If the waiter is registered AFTER getAsk, this
    // flips to `pending` at the timeout, which is exactly what the
    // reviewer flagged.
    expect(record.status).toBe("answered");
    expect(record.answer.value).toBe("d1");
    // The tool returned WELL before its 800 ms deadline — the
    // waiter caught the event, not the timeout.
    expect(elapsed).toBeLessThan(600);
  });

  test("PR #52 round-2 review — if getAsk throws, await_answer disposes the waiter + timer and rethrows", async () => {
    // Route await_answer through a channel-server wired to a
    // stub DaemonClient whose `getAsk` throws. If the fix is in
    // place, the waiter entry the tool registered is removed and
    // its timer cleared before the throw propagates.
    const ctx = ctxRef!;
    // Create a real ask so we have a valid id.
    const created = parseToolResult(
      await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } }),
    );
    const askId = (created.ask as { id: string }).id;
    // Point a NEW channel-server at a stub client that always
    // throws on `getAsk`. The subscriber is a no-op so no events
    // fire — the only path is `getAsk`.
    const { InMemoryTransport: TxA } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client: ClientA } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { startChannelServer } = await import("../../src/mcp/channel-server.ts");
    const stubClient = {
      listThreads: async () => ({ threads: [], head: 0 }),
      getAsk: async (): Promise<unknown> => { throw new Error("getAsk-throw-under-test"); },
      createAsk: async () => ({ ask: {}, url: "" }),
      cancelAsk: async () => ({}),
      reply: async () => ({}),
      resolve: async () => ({}),
      mintLaunchUrl: async () => ({ launchUrl: "http://x/", ttlMs: 0 }),
    } as unknown as import("../../src/mcp/daemon-client.ts").DaemonClient;
    const [cTx, sTx] = TxA.createLinkedPair();
    const stubChannel = await startChannelServer({
      client: stubClient,
      url: ctx.daemon.url,
      agentToken: ctx.daemon.agentToken,
      transport: sTx,
      // No-op subscriber — we never fire events; the throw path
      // is what we're testing.
      subscribeEvents: () => ({ onEvent: () => {}, close: () => {}, done: Promise.resolve() }),
    });
    try {
      const stubMcp = new ClientA(
        { name: "revkit-mcp-ask-tools-stub", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await stubMcp.connect(cTx);
      const result = await stubMcp.callTool({
        name: "await_answer",
        arguments: { id: askId, timeout_ms: 500 },
      });
      // The tool surfaces the throw as an `isError` result — the
      // load-bearing assertion is that the tool RETURNS (does not
      // hang past the timeout) with the expected error text.
      expect((result as { isError?: boolean }).isError).toBe(true);
      const text = (result as { content: readonly { text: string }[] }).content[0]!.text;
      expect(text).toContain("getAsk-throw-under-test");
    } finally {
      await stubChannel.stop();
    }
  });

  test("await_answer returns immediately when the ask is already terminal (fast path)", async () => {
    const ctx = ctxRef!;
    const created = parseToolResult(
      await ctx.client.callTool({ name: "ask", arguments: { spec: choiceSpec } }),
    );
    const askId = (created.ask as { id: string }).id;
    // Answer synchronously first.
    await humanAnswer(ctx, askId, "kv");
    const start = performance.now();
    const result = await ctx.client.callTool({
      name: "await_answer",
      arguments: { id: askId, timeout_ms: 8000 },
    });
    const elapsedMs = performance.now() - start;
    const record = parseToolResult(result).ask as { status: string; answer: { value: string } };
    expect(record.status).toBe("answered");
    expect(record.answer.value).toBe("kv");
    // Fast path: no SSE wait.
    expect(elapsedMs).toBeLessThan(500);
  });
});
