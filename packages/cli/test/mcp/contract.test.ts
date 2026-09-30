// MCP contract tests (ADR-0016).
//
// Spin up a real daemon + a real MCP channel server connected via
// `InMemoryTransport`, then drive an MCP client through the wire:
//
//   1. `client.listTools()` returns the three tools with the right
//      names + schemas.
//   2. `client.callTool({name:"threads"})` proxies to the daemon and
//      returns whatever the daemon reports.
//   3. `client.callTool({name:"reply"})` writes a reply via the
//      daemon's HTTP API.
//   4. `client.callTool({name:"resolve"})` closes a thread.
//   5. When the daemon fans out a human-authored `comment.created`,
//      a `notifications/claude/channel` notification arrives on the
//      client with the EXACT shape the Claude Code docs describe
//      (`content` string + `meta` identifier-keyed).
//
// Non-tautology: each assertion is written so a real regression
// (bad tool schema, dropped notification, unauthenticated call)
// fails visibly. The two "mutation" tests at the end break the
// auth and the notification wiring and confirm the corresponding
// assertions turn red.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { startChannelServer, type ChannelServerHandle } from "../../src/mcp/channel-server.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";
import { formatChannelPayload } from "../../src/mcp/channel-server.ts";
import type { WireEvent } from "../../src/mcp/event-subscriber.ts";

interface Ctx {
  daemon: DaemonHandle;
  root: string;
  dist: string;
  channel: ChannelServerHandle;
  client: Client;
  channelMessages: unknown[];
  cookie: string;
}

const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "why 30s?", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

/** Boot a daemon + a channel server bound in-memory to a fresh MCP
 * client. Returns the whole `Ctx` for the test to drive. */
async function boot(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-mcp-contract-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
  // Seed the anchor's source file so the daemon can compute its
  // revision server-side (PR #38 review).
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nquestion body\nwhy 30s?\n");
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
  // Pair transports: `serverTx` is what the channel server uses,
  // `clientTx` is what the MCP `Client` uses. Anything the client
  // sends on `clientTx` reaches the server; the server's
  // notifications reach the client.
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const daemonClient = new DaemonClient({
    url: daemon.url,
    agentToken: daemon.agentToken,
  });
  const channel = await startChannelServer({
    client: daemonClient,
    url: daemon.url,
    agentToken: daemon.agentToken,
    transport: serverTx,
    // Also test-only: return a subscriber that lets THIS test drive
    // events directly, so the assertion isn't racing the real SSE
    // loop. The channel server still calls `onEvent(...)` for each
    // event we feed, which flows through the real formatter and the
    // real `server.notification(...)` call.
    subscribeEvents: (options) => {
      const sub = {
        onEvent: options.onEvent,
        close: () => {},
        done: Promise.resolve(),
      };
      // Attach the harness handle to a global for the test to reach.
      testSubscriberOnEvent = options.onEvent;
      return sub;
    },
  });
  // The MCP `Client` needs a capabilities declaration and a
  // clientInfo — bare-bones values pass the initialize handshake.
  const client = new Client(
    { name: "revkit-mcp-contract-test", version: "0.0.0-test" },
    { capabilities: {} },
  );
  const channelMessages: unknown[] = [];
  // A notification handler that captures every
  // `notifications/claude/channel` for later assertion.
  const channelNotificationSchema = z.object({
    method: z.literal("notifications/claude/channel"),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string(), z.string()).optional(),
    }),
  });
  client.setNotificationHandler(channelNotificationSchema, async (msg) => {
    channelMessages.push(msg);
  });
  await client.connect(clientTx);
  return { daemon, root, dist, channel, client, channelMessages, cookie };
}

async function tearDown(ctx: Ctx): Promise<void> {
  try {
    await ctx.channel.stop();
  } catch {
    // Already stopped.
  }
  await ctx.daemon.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Test-scoped handle: `boot()` sets this so a test can pump synthetic
 * events through the same formatter + notification path that the real
 * SSE loop would use. Reset per-test in `beforeEach`. */
let testSubscriberOnEvent: ((event: WireEvent) => Promise<void> | void) | undefined;
beforeEach(() => {
  testSubscriberOnEvent = undefined;
});

/** Exchange the launch code for a session cookie so the test can post
 * as the "human" on the daemon. */
async function mintSessionCookie(daemon: DaemonHandle): Promise<string> {
  const url = new URL(daemon.launchUrl);
  const response = await fetch(url, {
    redirect: "manual",
    headers: { host: `127.0.0.1:${daemon.port}` },
  });
  if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no set-cookie");
  const eq = setCookie.indexOf("=");
  const semi = setCookie.indexOf(";");
  return setCookie.slice(0, semi === -1 ? undefined : semi).trim();
}

describe("revkit mcp — channel + tools contract", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await tearDown(ctx);
  });

  test("tools/list advertises threads, reply, resolve with expected shape", async () => {
    const listing = await ctx.client.listTools();
    const names = listing.tools.map((t) => t.name).sort();
    // M2 item 6 (delivery modes + presence): the `mode` and
    // `presence` tools joined the listing.
    expect(names).toEqual(["mode", "presence", "reply", "resolve", "review_url", "threads"]);
    const reply = listing.tools.find((t) => t.name === "reply");
    expect(reply?.inputSchema.required).toEqual(["thread_id", "parent_id", "body"]);
    const threads = listing.tools.find((t) => t.name === "threads");
    // `additionalProperties: false` is what stops the model from
    // sneaking undocumented args past the schema. Load-bearing for
    // ADR-0007 safety.
    expect(threads?.inputSchema.additionalProperties).toBe(false);
    // The daemon's channel capability lands in the client's view of
    // the server capabilities.
    const caps = ctx.client.getServerCapabilities();
    expect(caps?.experimental).toBeDefined();
    expect(caps?.experimental?.["claude/channel"]).toBeDefined();
  });

  test("threads → daemon: empty state returns head=0", async () => {
    const result = await ctx.client.callTool({ name: "threads", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    const parsed = JSON.parse(content.text) as { threads: unknown[]; head: number };
    expect(parsed.threads).toEqual([]);
    expect(parsed.head).toBe(0);
  });

  test("reply → daemon: adds a comment through the HTTP API", async () => {
    // First seed a thread via the daemon's cookie-authenticated API
    // (as the "human"): POST /api/threads with an anchor + body.
    const created = await fetch(`${ctx.daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie: ctx.cookie,
        host: `127.0.0.1:${ctx.daemon.port}`,
        origin: ctx.daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "why 30s?" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      readonly seq: number;
      readonly event: { readonly threadId: string; readonly commentId: string };
    };
    const threadId = createdBody.event.threadId;
    const parentId = createdBody.event.commentId;

    // Now the MCP client (as the agent) replies via the reply tool.
    const result = await ctx.client.callTool({
      name: "reply",
      arguments: { thread_id: threadId, parent_id: parentId, body: "raised to 60s, see L42" },
    });
    expect(result.isError).toBeFalsy();
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    const parsed = JSON.parse(content.text) as { seq: number; event: { kind: string; body: string; actor: { kind: string } } };
    // Reply landed as an agent event, seq strictly after the create.
    expect(parsed.seq).toBeGreaterThan(createdBody.seq);
    expect(parsed.event.kind).toBe("comment.replied");
    expect(parsed.event.actor.kind).toBe("agent");
    expect(parsed.event.body).toBe("raised to 60s, see L42");
  });

  test("resolve → daemon: closes an open thread", async () => {
    const created = await fetch(`${ctx.daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie: ctx.cookie,
        host: `127.0.0.1:${ctx.daemon.port}`,
        origin: ctx.daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "look here" }),
    });
    const threadId = ((await created.json()) as { event: { threadId: string } }).event.threadId;
    const resolved = await ctx.client.callTool({
      name: "resolve",
      arguments: { thread_id: threadId, resolution: "fixed" },
    });
    expect(resolved.isError).toBeFalsy();
    // The list now reports the thread as resolved (filter status).
    const listing = await ctx.client.callTool({ name: "threads", arguments: { status: "resolved" } });
    const list = JSON.parse(
      (listing.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { threads: Array<{ id: string; status: string }> };
    expect(list.threads.some((t) => t.id === threadId && t.status === "resolved")).toBe(true);
  });

  test("channel notification arrives with content + meta {thread_id, path, lines} — exact shape", async () => {
    // Post a human comment via the cookie API and pretend the SSE
    // loop delivered it: pump the same shape into
    // `testSubscriberOnEvent`, which the channel server uses to
    // format and emit the notification.
    const created = await fetch(`${ctx.daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie: ctx.cookie,
        host: `127.0.0.1:${ctx.daemon.port}`,
        origin: ctx.daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "why 30s?" }),
    });
    const createdBody = (await created.json()) as {
      readonly seq: number;
      readonly event: {
        readonly kind: string;
        readonly seq: number;
        readonly threadId: string;
        readonly commentId: string;
        readonly anchor: typeof anchor;
        readonly body: string;
        readonly actor: { readonly kind: string; readonly id: string };
        readonly ts: string;
      };
    };
    // Pump the exact event the daemon appended.
    await testSubscriberOnEvent?.(createdBody.event as unknown as WireEvent);
    // Give the notification a tick to flow through the transport
    // and hit our handler.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(ctx.channelMessages.length).toBe(1);
    const message = ctx.channelMessages[0] as {
      method: string;
      params: { content: string; meta?: Record<string, string> };
    };
    expect(message.method).toBe("notifications/claude/channel");
    expect(typeof message.params.content).toBe("string");
    expect(message.params.content.length).toBeGreaterThan(0);
    // Meta MUST carry the four documented keys for M2 item 3
    // (thread_id, path, lines, author_kind). Our contract fixes the
    // key set; hyphens would be silently dropped by Claude Code per
    // the docs, so we insist on underscore identifiers.
    expect(message.params.meta).toEqual({
      thread_id: createdBody.event.threadId,
      path: anchor.path,
      lines: `${anchor.startLine}-${anchor.endLine}`,
      author_kind: "local",
    });
    // Belt-and-braces: assert every key is an identifier (letters,
    // digits, underscores) — this is what Claude Code accepts.
    for (const key of Object.keys(message.params.meta!)) {
      expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  test("agent-authored events are NOT forwarded as channel notifications", async () => {
    // If the agent's own reply loops back on `/events`, the channel
    // must not forward it — otherwise Claude sees its own outbound
    // reply as a new inbound event.
    await testSubscriberOnEvent?.({
      seq: 42,
      kind: "comment.replied",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "agent", id: "agent" },
      threadId: "t1",
      commentId: "c2",
      parentId: "c1",
      body: "my own reply",
    } as unknown as WireEvent);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(ctx.channelMessages.length).toBe(0);
  });
});

// ── mutation / negative-control tests ─────────────────────────────

describe("revkit mcp — mutation checks", () => {
  test("MUTATION: an invalid bearer token makes reply fail (auth guard is load-bearing)", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-mcp-mut-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<h1>x</h1>");
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
    try {
      // Use the WRONG token. The reply must fail.
      const client = new DaemonClient({
        url: daemon.url,
        agentToken: "wrong-token-" + "x".repeat(40),
      });
      let threw = false;
      try {
        await client.reply("t1", "c1", "body");
      } catch (error) {
        threw = true;
        // Any 4xx is fine — the daemon may 401 (auth) OR 403 (the
        // Origin check catches a browser-less request that failed
        // bearer auth). The point is: an unauthenticated write is
        // refused, not accepted silently.
        expect((error as Error).message).toMatch(/40\d/);
      }
      expect(threw).toBe(true);
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MUTATION: formatChannelPayload returns undefined for irrelevant kinds", () => {
    // Truly-irrelevant kinds (e.g. `ask.created` which is routed via
    // the `/ask/<id>` page, not through the channel) must drop.
    // Presence + handover ARE forwarded as of M2 item 6 — that's the
    // channel-notification promotion path for those events.
    const result = formatChannelPayload({
      seq: 1,
      kind: "ask.created",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "local", id: "u1" },
      askId: "ask-1",
    } as unknown as WireEvent);
    expect(result).toBeUndefined();
  });

  test("M2 item 6: formatChannelPayload emits a handover frame with count + ids", () => {
    const payload = formatChannelPayload({
      seq: 1,
      kind: "handover",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "local", id: "u1", displayName: "Alex" },
      commentIds: ["c-1", "c-2"],
      revision: "e".repeat(64),
      note: "Reviewer handed the batch to the agent.",
    } as unknown as WireEvent);
    expect(payload).toBeDefined();
    expect(payload!.content).toContain("2 comments");
    expect(payload!.content).toContain("c-1, c-2");
    expect(payload!.meta.kind).toBe("handover");
    expect(payload!.meta.count).toBe("2");
  });

  test("M2 item 6: formatChannelPayload emits a presence frame from another local session", () => {
    const payload = formatChannelPayload({
      seq: 1,
      kind: "presence",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "local", id: "u1", displayName: "Alex" },
      state: "editing",
      path: "docs/a.md",
      startLine: 1,
      endLine: 3,
    } as unknown as WireEvent);
    expect(payload).toBeDefined();
    expect(payload!.meta.kind).toBe("presence");
    expect(payload!.meta.state).toBe("editing");
    expect(payload!.content).toContain("docs/a.md:1-3");
  });

  test("M2 item 6: an agent's OWN presence beacon is skipped (echo suppression)", () => {
    const payload = formatChannelPayload({
      seq: 1,
      kind: "presence",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "agent", id: "agent" },
      state: "editing",
    } as unknown as WireEvent);
    expect(payload).toBeUndefined();
  });

  test("MUTATION: formatChannelPayload picks identifier meta keys (no hyphens)", () => {
    const payload = formatChannelPayload({
      seq: 1,
      kind: "comment.created",
      ts: "2026-09-30T00:00:00Z",
      actor: { kind: "local", id: "u1", displayName: "Alex" },
      threadId: "t1",
      commentId: "c1",
      body: "hello",
      anchor: {
        path: "docs/x.md",
        startLine: 1,
        endLine: 2,
        quote: { exact: "hi", prefix: "", suffix: "" },
        revision: "0".repeat(64),
      },
    } as unknown as WireEvent);
    expect(payload).toBeDefined();
    // Assert keys individually so a rename of one key is visible.
    expect(Object.keys(payload!.meta).sort()).toEqual(["author_kind", "lines", "path", "thread_id"]);
    expect(payload!.meta["path"]).toBe("docs/x.md");
    expect(payload!.meta["lines"]).toBe("1-2");
    expect(payload!.meta["thread_id"]).toBe("t1");
    expect(payload!.meta["author_kind"]).toBe("local");
    expect(payload!.content).toContain("Alex");
  });
});
