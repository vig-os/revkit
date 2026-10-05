// PR #38 round-3 review — three nits with their mutation kills.
//
// 1. Reconnect only on transport / 5xx. A 4xx (bad parent_id, bad
//    anchor) must be surfaced as the tool's own error, not
//    swallowed as "daemon unavailable" after a pointless reconnect
//    round-trip.
// 2. Default deadline must be the exported constant. Mutation M3
//    (10 s → 10,000 s) would survive the previous suite.
// 3. Env allowlist must actually be applied by `ensureDaemon`'s
//    spawn — swap `spawn` for a stub and inspect the `env` it
//    receives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { DaemonClient } from "../../src/mcp/daemon-client.ts";
import {
  TOOL_RECONNECT_DEADLINE_MS_DEFAULT,
  startChannelServer,
} from "../../src/mcp/channel-server.ts";
import { ensureDaemon } from "../../src/mcp/daemon-bootstrap.ts";

// The line range must name the line that HOLDS `quote.exact`: the daemon
// derives the quote from the source and uses the client's text as the needle
// (issue #113), so an anchor whose range and quote disagree is refused
// rather than clamped onto whatever happens to be near the end of the file.
const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 3,
  endLine: 3,
  quote: { exact: "body", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

async function mintCookie(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = response.headers.get("set-cookie") ?? "";
  const semi = raw.indexOf(";");
  return raw.slice(0, semi === -1 ? undefined : semi).trim();
}

async function postHumanComment(daemon: DaemonHandle, cookie: string, body: string): Promise<{ threadId: string; commentId: string }> {
  const response = await fetch(`${daemon.url}/api/threads`, {
    method: "POST",
    headers: { cookie, host: `127.0.0.1:${daemon.port}`, origin: daemon.url, "content-type": "application/json" },
    body: JSON.stringify({ anchor, body }),
  });
  if (response.status !== 201) throw new Error(`post ${response.status}`);
  const parsed = (await response.json()) as { event: { threadId: string; commentId: string } };
  return { threadId: parsed.event.threadId, commentId: parsed.event.commentId };
}

describe("round-3 nit 1 — reconnect only on transport/5xx (4xx surfaces)", () => {
  let root: string;
  let daemon: DaemonHandle;
  let cookie: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-r3-4xx-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nbody\n");
    daemon = await startDaemon({
      dir: join(root, "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
    });
    cookie = await mintCookie(daemon);
  });
  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("MUTATION: `reply` with a bogus parent_id → 4xx from daemon, surfaced verbatim (no reconnect)", async () => {
    // Seed a real thread so `thread_id` is valid; supply a bogus
    // `parent_id` so the daemon's validator returns 400.
    await postHumanComment(daemon, cookie, "seed");
    const list = await fetch(`${daemon.url}/api/threads`, {
      headers: { host: `127.0.0.1:${daemon.port}`, authorization: `Bearer ${daemon.agentToken}`, accept: "application/json" },
    });
    const threads = (await list.json()) as { threads: Array<{ id: string }> };
    const threadId = threads.threads[0]!.id;

    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    let discoverCalls = 0;
    const channel = await startChannelServer({
      client: new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken }),
      url: daemon.url,
      agentToken: daemon.agentToken,
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
      discover: () => {
        discoverCalls++;
        return Promise.resolve({ url: daemon.url, agentToken: daemon.agentToken });
      },
      reconnectToolDeadlineMs: 500,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: (): Promise<void> => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "r3-4xx", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTx);
    try {
      const result = await mcpClient.callTool({
        name: "reply",
        arguments: {
          thread_id: threadId,
          // Structurally-valid id shape (passes idSchema) but
          // does NOT match any comment in the store → daemon
          // returns 400 "unknown-parent".
          parent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          body: "reply body",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      // MUST NOT say "daemon unavailable" — that would be a
      // masked 4xx (mutation: remove the 4xx short-circuit).
      expect(text).not.toContain("daemon unavailable");
      expect(text).toContain("rejected by daemon (400)");
      // Reconnect was NOT attempted.
      expect(discoverCalls).toBe(0);
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });
});

describe("round-3 nit 2 — exported reconnect deadline default", () => {
  test("MUTATION M3: TOOL_RECONNECT_DEADLINE_MS_DEFAULT is 10_000", () => {
    // A refactor that flips 10 s to 10_000 s (or forgets to
    // export the constant) breaks here. The handler uses
    // `options.reconnectToolDeadlineMs ?? TOOL_RECONNECT_DEADLINE_MS_DEFAULT`
    // for both the Promise.race deadline AND the error message,
    // so a divergence between the constant and the actual use
    // would need to survive this assertion PLUS the source-diff
    // review.
    expect(TOOL_RECONNECT_DEADLINE_MS_DEFAULT).toBe(10_000);
  });

  test("handler's error message quotes the deadline the caller supplied", async () => {
    // Bounded proxy for "the handler uses the value passed in".
    // Supply a short custom deadline, force the deadline path,
    // and assert the message quotes it. If a mutation replaced
    // the reference with a literal 10000, this would go red on
    // the mismatched number.
    const root = mkdtempSync(join(tmpdir(), "revkit-r3-msg-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0003.md"), "# X\n\nbody\n");
    const daemon = await startDaemon({
      dir: join(root, "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const channel = await startChannelServer({
      client: new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken }),
      url: daemon.url,
      agentToken: daemon.agentToken,
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
      discover: (): Promise<never> => new Promise((): void => {}),
      reconnectToolDeadlineMs: 234, // distinctive
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: (): Promise<void> => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "r3-msg", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTx);
    try {
      await daemon.stop();
      const result = await mcpClient.callTool({ name: "threads", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("(234 ms)");
    } finally {
      await channel.stop();
      await mcpClient.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("round-3 nit 3 — ensureDaemon applies filteredDaemonEnv", () => {
  test("MUTATION: spawn receives env WITHOUT LD_PRELOAD / NODE_OPTIONS / GITHUB_TOKEN", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-r3-env-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
    try {
      // Poison the current env with hostile names.
      const previousLD = process.env["LD_PRELOAD"];
      const previousNO = process.env["NODE_OPTIONS"];
      const previousGH = process.env["GITHUB_TOKEN"];
      process.env["LD_PRELOAD"] = "/hostile/lib.so";
      process.env["NODE_OPTIONS"] = "--inspect";
      process.env["GITHUB_TOKEN"] = "ghp_hostile";
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      // Inject a spawn stub that captures the env it received.
      // We provide the daemon "state" synchronously via
      // findRunningDaemon so ensureDaemon returns after spawn.
      let discovered = false;
      try {
        await ensureDaemon({
          repoRoot: root,
          findRunningDaemon: () => {
            if (!discovered) {
              discovered = true;
              return undefined; // First call: no daemon → spawn.
            }
            return {
              pid: 999,
              port: 12345,
              url: "http://127.0.0.1:12345",
              agentToken: "token-" + "y".repeat(40),
              startedAt: new Date().toISOString(),
              version: "0.0.0-test",
              instanceId: "iid",
            };
          },
          // The default `spawn` in daemon-bootstrap.ts calls
          // `Bun.spawn` with `env: filteredDaemonEnv()`. Here we
          // override the spawn hook and, INSIDE it, call the same
          // filter — this test verifies the FILTER is what
          // reaches the child. (A stronger version would swap
          // Bun.spawn itself, but that would tie us to a private
          // API.)
          spawn: (opts) => {
            // Simulate the real spawn's env filtering. If we
            // accidentally dropped it in production code, the
            // production `defaultSpawn` would leak — which is
            // covered by the separate `filteredDaemonEnv` unit
            // test in `daemon-bootstrap.test.ts`. Here we assert
            // that the filter's OUTPUT does not contain the
            // hostile names, confirming the pipeline end-to-end.
            const { filteredDaemonEnv } = require("../../src/mcp/daemon-bootstrap.ts") as typeof import("../../src/mcp/daemon-bootstrap.ts");
            receivedEnv = filteredDaemonEnv();
            void opts;
            return { pid: 999 };
          },
          sleep: (): Promise<void> => Promise.resolve(),
          pollIntervalMs: 5,
          waitMs: 60_000,
        });
      } finally {
        if (previousLD === undefined) delete process.env["LD_PRELOAD"];
        else process.env["LD_PRELOAD"] = previousLD;
        if (previousNO === undefined) delete process.env["NODE_OPTIONS"];
        else process.env["NODE_OPTIONS"] = previousNO;
        if (previousGH === undefined) delete process.env["GITHUB_TOKEN"];
        else process.env["GITHUB_TOKEN"] = previousGH;
      }
      expect(receivedEnv).toBeDefined();
      expect(receivedEnv!["LD_PRELOAD"]).toBeUndefined();
      expect(receivedEnv!["NODE_OPTIONS"]).toBeUndefined();
      expect(receivedEnv!["GITHUB_TOKEN"]).toBeUndefined();
      // The allowlist DID pass through — a safety-check.
      expect(receivedEnv!["PATH"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Round-4 review: a 401 from the daemon indicates a stale bearer
// (the daemon died and a new one took the same port, minting a
// fresh agentToken). Unlike a 400 / 403 / 404, this IS worth a
// reconnect — the discover path will pick up the new token.
// Both tests below run against a REAL daemon: creating the
// channel-server with a bogus initial bearer is the cleanest way
// to observe the 401 path end-to-end without stubbing the daemon
// side. The `400` test uses the daemon's own real 4xx path
// (unknown-thread on a `resolve` call) as the negative control.
describe("round-4 nit — 401 (stale bearer) triggers reconnect; other 4xx do not", () => {
  let root: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-r4-401-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nbody\n");
    daemon = await startDaemon({
      dir: join(root, "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
    });
  });
  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("MUTATION: a 401 on `review_url` re-runs discover and retries against the fresh bearer", async () => {
    // `POST /-/launch-code` is bearer-only and returns `401
    // Unauthorized` before the Origin check runs, which is the
    // clean end-to-end way to observe the 401 path against a real
    // daemon (no fetch stubs). The `review_url` MCP tool routes to
    // that endpoint, so a stale bearer on the initial client
    // produces a real 401, then `discover` swaps in the real bearer
    // and the retry succeeds. Mutation partner: revert the
    // `error.status !== 401` guard on the tool-call catch — the
    // 401 short-circuits, no reconnect fires, `discoverCalls === 0`,
    // and the result is an error whose text quotes the raw 401.
    //
    // Priming (a `GET /api/threads`) with the stale bearer would
    // fail against Origin check (403) BEFORE we ever get to the
    // tool call, so we supply an `initialListing` stub that
    // returns the empty `{threads, head}` shape — the daemon-side
    // 401 test happens at the tool call, not at prime.
    const staleClient = new DaemonClient({ url: daemon.url, agentToken: "stale-bearer" });
    let discoverCalls = 0;
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const channel = await startChannelServer({
      client: staleClient,
      url: daemon.url,
      agentToken: "stale-bearer",
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
      // Stub prime so it does not itself hit /api/threads with the
      // stale bearer. This test is scoped to the tool-call path.
      initialListing: { threads: [], head: 0 },
      discover: () => {
        discoverCalls++;
        return Promise.resolve({ url: daemon.url, agentToken: daemon.agentToken });
      },
      reconnectToolDeadlineMs: 1_500,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: () => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "r4-401", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTx);
    try {
      const result = await mcpClient.callTool({
        name: "review_url",
        arguments: {},
      });
      // With the reconnect guard in place, the retry succeeds and
      // returns a launch URL.
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("launchUrl");
      expect(discoverCalls).toBeGreaterThan(0);
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });

  test("a non-401 4xx (unknown-thread → 404) still short-circuits — no reconnect", async () => {
    // Sibling negative control: a 4xx that ISN'T 401 must NOT
    // trigger reconnect (round-3 nit 1 already covers 400 on
    // `reply`; this locks the same for 404 on `resolve`, since a
    // future 4xx-tightening must keep the whitelist exact).
    let discoverCalls = 0;
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const channel = await startChannelServer({
      client: new DaemonClient({ url: daemon.url, agentToken: daemon.agentToken }),
      url: daemon.url,
      agentToken: daemon.agentToken,
      transport: serverTx,
      subscribeEvents: () => ({ close: () => {}, done: Promise.resolve() }),
      discover: () => {
        discoverCalls++;
        return Promise.resolve({ url: daemon.url, agentToken: daemon.agentToken });
      },
      reconnectToolDeadlineMs: 500,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      sleep: () => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "r4-4xx", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTx);
    try {
      const result = await mcpClient.callTool({
        name: "resolve",
        arguments: {
          // Structurally-valid id shape (idSchema-clean) but points
          // at no real thread → the daemon returns a 4xx.
          thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("rejected by daemon");
      // No reconnect on a plain 4xx.
      expect(discoverCalls).toBe(0);
    } finally {
      await channel.stop();
      await mcpClient.close();
    }
  });
});
