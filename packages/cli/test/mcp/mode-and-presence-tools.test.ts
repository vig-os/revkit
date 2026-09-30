// MCP contract tests for the `mode` and `presence` tools
// (M2 item 6, ADR-0007).
//
// Cover: `mode` without args reads the current mode; `mode set` flips
// it and drains the batch under handover → live; `presence` appends
// a presence event the rail can render.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { startChannelServer, type ChannelServerHandle } from "../../src/mcp/channel-server.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";

const anchor: Anchor = {
  path: "docs/a.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "hi", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

interface Ctx {
  daemon: DaemonHandle;
  channel: ChannelServerHandle;
  client: Client;
  root: string;
}

async function boot(deliveryMode: "handover" | "live" | "quiet" = "handover"): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-mode-tool-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<h1>ok</h1>");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "hi\n");
  const daemon = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    deliveryIdleFlushMs: 0,
    deliveryMode,
  });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const daemonClient = new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken });
  const channel = await startChannelServer({
    client: daemonClient,
    url: daemon.url,
    agentToken: daemon.agentToken,
    transport: serverTx,
    subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTx);
  return { daemon, channel, client, root };
}

async function tearDown(ctx: Ctx): Promise<void> {
  try { await ctx.channel.stop(); } catch { /* already stopped */ }
  await ctx.daemon.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

async function mintCookie(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("no set-cookie");
  const semi = raw.indexOf(";");
  return raw.slice(0, semi === -1 ? undefined : semi).trim();
}

/** Extract the { text } from an MCP tool call result. */
function textOf(result: { content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const chunk = result.content[0];
  if (chunk?.type !== "text" || chunk.text === undefined) {
    throw new Error("expected text content");
  }
  return chunk.text;
}

describe("`mode` MCP tool", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot("handover");
  });
  afterEach(async () => {
    await tearDown(ctx);
  });

  test("without args, returns the current mode (default handover)", async () => {
    const result = await ctx.client.callTool({ name: "mode" });
    const parsed = JSON.parse(textOf(result as { content: readonly { readonly type: string; readonly text?: string }[] })) as { mode: string };
    expect(parsed.mode).toBe("handover");
  });

  test("MCP `mode` tool refuses a `set` argument (round-2: read-only)", async () => {
    // Round-2: the mode tool is read-only from the agent surface.
    // A prompt-injected agent can never flip modes through the MCP.
    // The daemon's HTTP endpoint (used by `revkit mode <m>` on the
    // CLI) still accepts changes — see the HTTP tests for that
    // path. Here we assert the agent-facing contract.
    const result = (await ctx.client.callTool({
      name: "mode",
      arguments: { set: "live" },
    })) as { isError?: boolean; content: readonly { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toMatch(/invalid tool args/);
  });
});

describe("`presence` MCP tool", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot("live");
  });
  afterEach(async () => {
    await tearDown(ctx);
  });

  test("emits a presence FRAME (ephemeral, not durable) with location", async () => {
    const result = await ctx.client.callTool({
      name: "presence",
      arguments: { state: "editing", path: "docs/a.md", startLine: 1, endLine: 3 },
    });
    const parsed = JSON.parse(textOf(result as { content: readonly { readonly type: string; readonly text?: string }[] })) as { ok: boolean; frame: { kind: string; state: string; path?: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.frame.kind).toBe("presence");
    expect(parsed.frame.state).toBe("editing");
    expect(parsed.frame.path).toBe("docs/a.md");
  });

  test("refuses an invalid line range", async () => {
    const result = (await ctx.client.callTool({
      name: "presence",
      arguments: { state: "editing", path: "a.md", startLine: 5, endLine: 3 },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("emits `idle` state without a location", async () => {
    const result = await ctx.client.callTool({
      name: "presence",
      arguments: { state: "idle" },
    });
    const parsed = JSON.parse(textOf(result as { content: readonly { readonly type: string; readonly text?: string }[] })) as { ok: boolean; frame: { kind: string; state: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.frame.state).toBe("idle");
  });
});

describe("mode gating across the AGENT stream", () => {
  test("`quiet` suppresses ALL human-comment fan-out to /events?for=agent", async () => {
    const ctx = await boot("quiet");
    try {
      const cookie = await mintCookie(ctx.daemon);
      // Subscribe as agent BEFORE the comment.
      const received: unknown[] = [];
      const controller = new AbortController();
      const response = await fetch(`${ctx.daemon.url}/events?for=agent`, {
        headers: {
          authorization: `Bearer ${ctx.daemon.agentToken}`,
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readLoop = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (dataLine !== undefined) received.push(JSON.parse(dataLine.slice("data:".length).trim()));
            idx = buffer.indexOf("\n\n");
          }
        }
      })().catch(() => {});
      // Post a comment.
      await fetch(`${ctx.daemon.url}/api/threads`, {
        method: "POST",
        headers: {
          cookie,
          host: `127.0.0.1:${ctx.daemon.port}`,
          origin: ctx.daemon.url,
          "content-type": "application/json",
        },
        body: JSON.stringify({ anchor, body: "silence" }),
      });
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      await readLoop;
      // Nothing crossed the agent stream.
      expect(received.some((e) => (e as { kind?: string }).kind === "comment.created")).toBe(false);
    } finally {
      await tearDown(ctx);
    }
  });
});
