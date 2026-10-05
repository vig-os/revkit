// PR #38 blockers 2 + 3 — replay-on-start + daemon restart.
//
// Blocker 2 (replay): every `revkit mcp` boot used to subscribe to
// `/events?for=agent` from seq=0, flooding the agent with every
// historical comment. Fix: read the daemon's head, subscribe from
// there, and — if open threads are waiting on the agent — emit ONE
// summary notification. This spec posts N comments, then starts the
// channel server; the assertion: 0 per-comment notifications, exactly
// 1 summary. It goes red under the old whole-history replay.
//
// Blocker 3 (reconnect): killing the daemon and starting a new one
// (different port, different token, different `instanceId`) used to
// leave `revkit mcp` deaf forever. Fix: on subscriber error, re-run
// `discover` (auto-starts a new daemon), rebuild the client with the
// new URL + token, `verifyDaemonInstance` the swap, and resubscribe
// from `min(lastSeenSeq, head)` so a fresh sqlite (head=0) doesn't
// hang on a stale resume point.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";
import { startChannelServer, type DiscoverFn } from "../../src/mcp/channel-server.ts";
import type { WireEvent } from "../../src/mcp/event-subscriber.ts";

// The line range must name the line that HOLDS `quote.exact`: the daemon
// derives the quote from the source and uses the client's text as the needle
// (issue #113), so an anchor whose range and quote disagree is refused
// rather than clamped onto whatever happens to be near the end of the file.
const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 4,
  endLine: 4,
  quote: { exact: "why 30s?", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

async function mintCookie(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`auth exchange: ${response.status}`);
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("no set-cookie");
  const semi = raw.indexOf(";");
  return raw.slice(0, semi === -1 ? undefined : semi).trim();
}

/** Post a human comment via the cookie-authenticated API. */
async function postHumanComment(daemon: DaemonHandle, cookie: string, body: string): Promise<{ seq: number; threadId: string; commentId: string }> {
  const response = await fetch(`${daemon.url}/api/threads`, {
    method: "POST",
    headers: {
      cookie,
      host: `127.0.0.1:${daemon.port}`,
      origin: daemon.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ anchor, body }),
  });
  if (response.status !== 201) throw new Error(`post comment: ${response.status}`);
  const parsed = (await response.json()) as { seq: number; event: { threadId: string; commentId: string } };
  return { seq: parsed.seq, threadId: parsed.event.threadId, commentId: parsed.event.commentId };
}

interface Ctx {
  daemon: DaemonHandle;
  root: string;
  cookie: string;
}
async function bootDaemon(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-mcp-replay-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nquestion body\nwhy 30s?\n");
  const daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },

    deliveryMode: "live",
  });
  const cookie = await mintCookie(daemon);
  return { daemon, root, cookie };
}

const channelSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
});

describe("blocker 2 — replay-on-start", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await bootDaemon();
  });
  afterEach(async () => {
    await ctx.daemon.stop();
    rmSync(ctx.root, { recursive: true, force: true });
  });

  test("MUTATION C: 2 human comments before start → 0 per-comment notifications, 1 summary (real SSE)", async () => {
    // Seed two human comments BEFORE the channel server starts.
    const first = await postHumanComment(ctx.daemon, ctx.cookie, "first comment");
    const second = await postHumanComment(ctx.daemon, ctx.cookie, "second comment");
    expect(second.seq).toBeGreaterThan(first.seq);

    const notifications: Array<{ params: { content: string; meta?: Record<string, string> } }> = [];

    // Start the channel server WITHOUT stubbing `subscribeEvents`.
    // The REAL `startEventSubscriber` opens `/events?for=agent`
    // against the real daemon; if `since` were 0 (the old replay
    // bug), the two historical events would fan out. The correct
    // path passes `since = head` and no per-comment event fires.
    // This test kills mutation C directly.
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "replay-test", version: "0.0.0" }, { capabilities: {} });
    mcpClient.setNotificationHandler(channelSchema, async (msg) => {
      notifications.push(msg);
    });
    const channel = await startChannelServer({
      client: new DaemonClient({ url: ctx.daemon.url, agentToken: ctx.daemon.agentToken }),
      url: ctx.daemon.url,
      agentToken: ctx.daemon.agentToken,
      transport: serverTx,
      // NO subscribeEvents override — the real SSE loop runs.
    });
    await mcpClient.connect(clientTx);
    try {
      // Give the prime notification + a full SSE handshake a beat
      // to complete.
      await new Promise((r) => setTimeout(r, 200));
      // Exactly one summary. No per-comment notifications.
      expect(notifications.length).toBe(1);
      const only = notifications[0]!;
      expect(only.params.meta?.["kind"]).toBe("catchup_summary");
      expect(only.params.meta?.["waiting"]).toBe("2");
      expect(only.params.content).toContain(first.threadId);
      expect(only.params.content).toContain(second.threadId);
      // MUTATION C's fingerprint: raw per-comment content strings
      // would show up here if the SSE loop replayed from seq=0.
      expect(only.params.content).not.toContain("first comment");
      expect(only.params.content).not.toContain("second comment");
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });

  test("no open thread waiting on agent → 0 notifications on start", async () => {
    // Seed a thread, then resolve it. No summary should fire because
    // no thread is "waiting on the agent".
    const created = await postHumanComment(ctx.daemon, ctx.cookie, "please resolve me");
    const resolveResp = await fetch(`${ctx.daemon.url}/api/threads/${encodeURIComponent(created.threadId)}/resolve`, {
      method: "POST",
      headers: {
        cookie: ctx.cookie,
        host: `127.0.0.1:${ctx.daemon.port}`,
        origin: ctx.daemon.url,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(resolveResp.status).toBe(201);

    const notifications: Array<{ params: { content: string } }> = [];
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "no-summary", version: "0.0.0" }, { capabilities: {} });
    mcpClient.setNotificationHandler(channelSchema, async (msg) => {
      notifications.push(msg);
    });
    const channel = await startChannelServer({
      client: new DaemonClient({ url: ctx.daemon.url, agentToken: ctx.daemon.agentToken }),
      url: ctx.daemon.url,
      agentToken: ctx.daemon.agentToken,
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
    });
    await mcpClient.connect(clientTx);
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(notifications.length).toBe(0);
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });
});

describe("blocker 2b — tool call reconnect is bounded", () => {
  let root: string;
  let daemon: DaemonHandle;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-mcp-toolbound-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    // Four lines, with the shared anchor's quoted text on line 4 — the
    // daemon derives the quote from this file and refuses a range whose
    // text the client's needle cannot be found in.
    writeFileSync(join(root, "docs", "adr", "0003.md"), "# X\n\nbody\nwhy 30s?\n");
    daemon = await startDaemon({
      dir: join(root, "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },

      deliveryMode: "live",
    });
  });
  afterEach(async () => {
    try { await daemon.stop(); } catch { /* dead */ }
    rmSync(root, { recursive: true, force: true });
  });

  test("MUTATION: an impossible reconnect returns isError with a clear message inside the deadline", async () => {
    // Kill the daemon and provide a discover that never returns.
    // With the previous unbounded loop, `threads` would hang
    // forever. With the deadline, it returns `isError` well before
    // the test's Bun timeout.
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "toolbound-test", version: "0.0.0" }, { capabilities: {} });
    let discoverCalls = 0;
    const channel = await startChannelServer({
      client: new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken }),
      url: daemon.url,
      agentToken: daemon.agentToken,
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
      // Never resolves — mimics "no daemon reachable".
      discover: (): Promise<never> => {
        discoverCalls++;
        return new Promise((): void => {
          /* pending forever */
        });
      },
      // Short deadline so the test finishes in bounded time.
      reconnectToolDeadlineMs: 300,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: (): Promise<void> => Promise.resolve(),
    });
    await mcpClient.connect(clientTx);
    try {
      // Kill the daemon so the tool call fails on first attempt.
      await daemon.stop();
      const start = Date.now();
      const result = await mcpClient.callTool({ name: "threads", arguments: {} });
      const elapsed = Date.now() - start;
      // Under the OLD unbounded reconnect this callTool never
      // resolves; here it MUST return within a reasonable margin
      // of the deadline.
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("daemon unavailable");
      expect(elapsed).toBeLessThan(5000); // deadline + reasonable slack
      expect(discoverCalls).toBeGreaterThan(0);
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });
});

describe("blocker 3 — reconnect on daemon restart", () => {
  let root: string;
  let daemonA: DaemonHandle;
  let cookieA: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-mcp-reconnect-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    // As above: the shared anchor names line 4, so line 4 holds its text.
    writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR\n\nsecond line\nwhy 30s?\nfourth\n");
    // Use ONE sqlite path shared across daemon boots — that's the
    // "sqlite persists across restarts" property.
    const sqlitePath = join(root, "threads.sqlite");
    daemonA = await startDaemon({
      dir: join(root, "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath,
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },

      deliveryMode: "live",
    });
    // Store sqlitePath for the discover to boot the second daemon
    // on the SAME file (so seqs continue).
    (root as unknown as { sqlitePath: string }); // placeholder — see below
    (globalThis as unknown as { __sqlitePath: string }).__sqlitePath = sqlitePath;
    cookieA = await mintCookie(daemonA);
  });
  afterEach(async () => {
    try { await daemonA.stop(); } catch { /* already dead */ }
    rmSync(root, { recursive: true, force: true });
  });

  test("MUTATION: kill daemon, start new one; next human comment reaches the agent via reconnect", async () => {
    // 1. Start the channel server against daemonA. It primes; no
    //    open threads, no summary.
    const notifications: Array<{ params: { content: string; meta?: Record<string, string> } }> = [];
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "reconnect-test", version: "0.0.0" }, { capabilities: {} });
    mcpClient.setNotificationHandler(channelSchema, async (msg) => {
      notifications.push(msg);
    });

    // A test-only subscriber that lets us drive events synchronously
    // AND lets us simulate a subscriber failure that triggers the
    // reconnect path.
    let subscriberOnEvent: ((event: WireEvent) => Promise<void> | void) | undefined;
    let subscriberOnError: ((error: Error) => void) | undefined;
    let subscribeCallCount = 0;
    const injectSubscribe: typeof import("../../src/mcp/event-subscriber.ts").startEventSubscriber = (opts) => {
      subscribeCallCount++;
      subscriberOnEvent = opts.onEvent;
      subscriberOnError = opts.onError;
      return { close: () => {}, done: Promise.resolve() };
    };

    // A discover function that boots a fresh daemon on the same
    // sqlite (so seqs continue). Called by the channel server when
    // the subscriber errors.
    let daemonB: DaemonHandle | undefined;
    const discover: DiscoverFn = async () => {
      // Real behaviour: `revkit serve` is spawned. Here we boot the
      // second daemon directly.
      daemonB = await startDaemon({
        dir: join(root, "dist"),
        repoRoot: root,
        port: 0,
        sqlitePath: (globalThis as unknown as { __sqlitePath: string }).__sqlitePath,
        version: "0.0.0-test",
        localUserId: "local-test",
        installSignalHandlers: false,
        logSink: { write: () => {} },

        deliveryMode: "live",
      });
      return {
        url: daemonB.url,
        agentToken: daemonB.agentToken,
        instanceId: "fresh-instance",
      };
    };

    const channel = await startChannelServer({
      client: new DaemonClient({ url: daemonA.url, agentToken: daemonA.agentToken }),
      url: daemonA.url,
      agentToken: daemonA.agentToken,
      instanceId: "initial-instance",
      transport: serverTx,
      subscribeEvents: injectSubscribe,
      discover,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: (): Promise<void> => Promise.resolve(),
    });
    await mcpClient.connect(clientTx);
    try {
      // Prime happened: no summary (no open thread).
      await new Promise((r) => setTimeout(r, 20));
      expect(notifications.length).toBe(0);
      expect(subscribeCallCount).toBe(1);

      // 2. Kill daemonA. This releases the flock.
      await daemonA.stop();

      // 3. Trigger the subscriber's onError, which invokes reconnect.
      //    reconnect() calls discover (which boots daemonB), then
      //    calls injectSubscribe again with the new url + token.
      subscriberOnError?.(new Error("simulated: connection reset"));
      // Wait for reconnect to complete.
      const deadline = Date.now() + 5000;
      while (subscribeCallCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(subscribeCallCount).toBe(2);
      expect(daemonB).toBeDefined();

      // 4. Post a NEW human comment on daemonB, then pump the wire
      //    event through the second subscriber's onEvent — the same
      //    path the real SSE loop would take.
      const cookieB = await mintCookie(daemonB!);
      const posted = await postHumanComment(daemonB!, cookieB, "post-restart comment");
      await subscriberOnEvent!({
        seq: posted.seq,
        kind: "comment.created",
        ts: new Date().toISOString(),
        actor: { kind: "local", id: "local-test" },
        threadId: posted.threadId,
        commentId: posted.commentId,
        anchor,
        body: "post-restart comment",
      } as unknown as WireEvent);
      await new Promise((r) => setTimeout(r, 20));
      expect(notifications.length).toBe(1);
      expect(notifications[0]!.params.content).toContain("post-restart comment");

      // 5. Tool call also works against the reconnected client.
      const threads = await mcpClient.callTool({ name: "threads", arguments: {} });
      expect(threads.isError).toBeFalsy();
    } finally {
      await channel.stop();
      await mcpClient.close();
      if (daemonB !== undefined) await daemonB.stop();
    }
  });
});
