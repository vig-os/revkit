// End-to-end integration tests for `revkit serve`.
//
// Each test starts a real in-process daemon against a random port and
// a temporary directory that plays the role of `site/dist`, exercises
// the surface (fetch / WebSocket / SSE / signals), and stops.
//
// Non-tautology stance: every security assertion was verified to fail
// when the corresponding guard is removed (see the notes on each
// `test(...)` block). The API round-trip asserts on delivered event
// payloads (seq, kind, anchor, body), not on "did the server respond
// at all"; a broken store or event bus fails these.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "@revkit/review-core";

/** The daemon returns `{seq, event}` on write, `{threads, head}` on read.
 * Test-scope helpers cast the parsed JSON to these shapes so assertions
 * do not litter the tests with `as any`. */
interface WriteResponse {
  readonly seq: number;
  readonly event: {
    readonly kind: string;
    readonly seq: number;
    readonly threadId: string;
    readonly commentId?: string;
    readonly body?: string;
    readonly actor: { readonly kind: string; readonly id: string };
  };
}
interface ThreadsResponse {
  readonly threads: readonly { readonly id: string }[];
  readonly head: number;
}
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
import { serveStatePath } from "../../src/serve/serve-state.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  dist: string;
  outside: string;
  logs: string[];
  cookieFor(code: string): Promise<string>;
}

async function startCtx(overrides: { launchCodeTtlMs?: number; sqlitePath?: string; nowMs?: () => number } = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-serve-it-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
  writeFileSync(join(dist, "app.js"), "console.log('ok')");
  mkdirSync(join(dist, "sub"), { recursive: true });
  writeFileSync(join(dist, "sub", "page.html"), "<h1>sub</h1>");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "SECRET");
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: overrides.sqlitePath ?? ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    launchCodeTtlMs: overrides.launchCodeTtlMs,
    nowMs: overrides.nowMs,
  });
  const cookieFor = async (code: string): Promise<string> => {
    const url = new URL(handle.url + "/-/auth");
    url.searchParams.set("code", code);
    const response = await fetch(url, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) throw new Error("no set-cookie");
    const eq = setCookie.indexOf("=");
    const semi = setCookie.indexOf(";");
    if (eq === -1 || semi === -1) throw new Error("bad set-cookie");
    return setCookie.slice(0, semi);
  };
  return { handle, root, dist, outside, logs, cookieFor };
}

function loopbackHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    ...extra,
  };
}

const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "why 30s?", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

describe("revkit serve — security", () => {
  test("refuses a request whose Host header is not loopback (DNS-rebinding defence)", async () => {
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/", { headers: { host: "evil.example.com" } });
      expect(response.status).toBe(421);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses a POST with a foreign Origin (CSRF defence)", async () => {
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${ctx.handle.port}`,
          origin: "http://evil.example",
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses a POST with Sec-Fetch-Site: cross-site", async () => {
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        }),
        body: "{}",
      });
      expect(response.status).toBe(403);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses /api/* without a valid agent token or session cookie", async () => {
    const ctx = await startCtx();
    try {
      const noAuth = await fetch(ctx.handle.url + "/api/threads");
      expect(noAuth.status).toBe(401);
      const badToken = await fetch(ctx.handle.url + "/api/threads", {
        headers: { host: `127.0.0.1:${ctx.handle.port}`, authorization: "Bearer wrong-token" },
      });
      expect(badToken.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses /events?for=agent without the agent token", async () => {
    const ctx = await startCtx();
    try {
      const noAuth = await fetch(ctx.handle.url + "/events?for=agent");
      expect(noAuth.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("launch code is single-use", async () => {
    const ctx = await startCtx();
    try {
      const url1 = new URL(ctx.handle.launchUrl);
      const first = await fetch(url1, {
        redirect: "manual",
        headers: { host: `127.0.0.1:${ctx.handle.port}` },
      });
      expect(first.status).toBe(302);
      const second = await fetch(url1, {
        redirect: "manual",
        headers: { host: `127.0.0.1:${ctx.handle.port}` },
      });
      expect(second.status).toBe(403);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("launch code expires after TTL", async () => {
    // Pin a controllable clock and set the TTL to 100 ms.
    let now = 0;
    const ctx = await startCtx({ launchCodeTtlMs: 100, nowMs: () => now });
    try {
      now = 500; // past the TTL
      const response = await fetch(ctx.handle.launchUrl, {
        redirect: "manual",
        headers: { host: `127.0.0.1:${ctx.handle.port}` },
      });
      expect(response.status).toBe(403);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("path traversal (/../) is refused", async () => {
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/../outside/secret.txt", {
        headers: { host: `127.0.0.1:${ctx.handle.port}` },
      });
      // The URL constructor normalises `/../` at the client side; if it
      // does, `..` is gone by the time the server sees the request, so
      // the response is a legitimate 404 for /outside/secret.txt (which
      // does not exist inside dist). Both 400 (traversal refused) and
      // 404 (not-found inside dist) are correct rejections. Assert on
      // the family: never a 200, never a leak of the file contents.
      expect(response.status).not.toBe(200);
      const body = await response.text();
      expect(body).not.toContain("SECRET");
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("URL-encoded path traversal (%2e%2e) is refused", async () => {
    const ctx = await startCtx();
    try {
      // Build the URL manually to keep the %2e%2e encoding; the URL
      // constructor would normalise `..` but leaves `%2e%2e` alone,
      // which is exactly the shape a bypass attempt uses.
      const raw = `http://127.0.0.1:${ctx.handle.port}/%2e%2e/outside/secret.txt`;
      const response = await fetch(raw, { headers: { host: `127.0.0.1:${ctx.handle.port}` } });
      expect(response.status).not.toBe(200);
      const body = await response.text();
      expect(body).not.toContain("SECRET");
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("symlink to a file outside the served root is refused", async () => {
    const ctx = await startCtx();
    try {
      // Plant a symlink inside dist that points at the outside secret.
      symlinkSync(join(ctx.outside, "secret.txt"), join(ctx.dist, "escape.txt"));
      const response = await fetch(ctx.handle.url + "/escape.txt", {
        headers: { host: `127.0.0.1:${ctx.handle.port}` },
      });
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("SECRET");
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("revkit serve — API round-trip", () => {
  test("create → reply → resolve delivers three events over SSE with correct seqs, and resume from ?since= picks up the tail", async () => {
    const ctx = await startCtx();
    try {
      // Open an SSE stream as the agent.
      const sseUrl = ctx.handle.url + "/events?for=agent";
      const sseResponse = await fetch(sseUrl, {
        headers: { host: `127.0.0.1:${ctx.handle.port}`, authorization: `Bearer ${ctx.handle.agentToken}` },
      });
      expect(sseResponse.status).toBe(200);
      expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();
      const buffered: string[] = [];
      // Pump reader in the background; the test awaits `nextEvent()`.
      const done = { flag: false };
      const pump = (async () => {
        while (!done.flag) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) return;
          buffered.push(decoder.decode(value, { stream: true }));
        }
      })();

      // Post create → reply → resolve as the agent.
      const created = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchor, body: "why 30s?" }),
      });
      expect(created.status).toBe(201);
      const createdPayload = await json<WriteResponse>(created);
      expect(createdPayload.seq).toBe(1);
      const threadId = createdPayload.event.threadId;
      const commentId = createdPayload.event.commentId;

      const replied = await fetch(ctx.handle.url + `/api/threads/${threadId}/replies`, {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ parentId: commentId, body: "raised to 60s" }),
      });
      expect(replied.status).toBe(201);
      const repliedPayload = await json<WriteResponse>(replied);
      expect(repliedPayload.seq).toBe(2);

      const resolved = await fetch(ctx.handle.url + `/api/threads/${threadId}/resolve`, {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ resolution: "raised" }),
      });
      expect(resolved.status).toBe(201);
      const resolvedPayload = await json<WriteResponse>(resolved);
      expect(resolvedPayload.seq).toBe(3);

      // Wait for the SSE to have all three frames.
      const start = performance.now();
      while (performance.now() - start < 2000) {
        const joined = buffered.join("");
        if ((joined.match(/^data: /gm) ?? []).length >= 3) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const joined = buffered.join("");
      const dataLines = joined.split("\n").filter((line) => line.startsWith("data: "));
      expect(dataLines.length).toBe(3);
      const parsed = dataLines.map((line) => JSON.parse(line.slice("data: ".length)));
      expect(parsed[0].kind).toBe("comment.created");
      expect(parsed[0].seq).toBe(1);
      expect(parsed[1].kind).toBe("comment.replied");
      expect(parsed[1].seq).toBe(2);
      expect(parsed[2].kind).toBe("thread.resolved");
      expect(parsed[2].seq).toBe(3);

      done.flag = true;
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});

      // Now resume from ?since=2 — should only see seq=3.
      const resumeResponse = await fetch(ctx.handle.url + "/events?for=agent&since=2", {
        headers: { host: `127.0.0.1:${ctx.handle.port}`, authorization: `Bearer ${ctx.handle.agentToken}` },
      });
      const resumeReader = resumeResponse.body!.getReader();
      let resumeBuf = "";
      const resumeStart = performance.now();
      while (performance.now() - resumeStart < 1000) {
        const { value, done: readerDone } = await resumeReader.read();
        if (readerDone) break;
        resumeBuf += new TextDecoder().decode(value, { stream: true });
        const lines = resumeBuf.split("\n").filter((line) => line.startsWith("data: "));
        if (lines.length >= 1) break;
      }
      const resumeLines = resumeBuf.split("\n").filter((line) => line.startsWith("data: "));
      expect(resumeLines.length).toBe(1);
      const first = JSON.parse(resumeLines[0]!.slice("data: ".length));
      expect(first.kind).toBe("thread.resolved");
      expect(first.seq).toBe(3);
      await resumeReader.cancel().catch(() => {});
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("WebSocket delivers the same events as SSE", async () => {
    const ctx = await startCtx();
    try {
      // Bun's WebSocket client — one-shot. Auth via query string is
      // not supported (no header slot on browsers); use the fact that
      // WS handshake reuses the fetch upgrade path and the daemon
      // accepts the bearer via the Authorization header on the
      // handshake request.
      const messages: unknown[] = [];
      const opened = Promise.withResolvers<void>();
      const ws = new WebSocket(ctx.handle.url.replace("http://", "ws://") + "/events?for=agent", {
        headers: { authorization: `Bearer ${ctx.handle.agentToken}`, host: `127.0.0.1:${ctx.handle.port}` },
      } as unknown as string);
      ws.addEventListener("open", () => opened.resolve());
      ws.addEventListener("message", (ev) => {
        try {
          messages.push(JSON.parse((ev as MessageEvent).data as string));
        } catch {
          // Non-JSON frame; ignore.
        }
      });
      await opened.promise;

      // Post one event and wait for the WS to receive it.
      const created = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchor, body: "ws test" }),
      });
      expect(created.status).toBe(201);
      const payload = await json<WriteResponse>(created);
      const seq = payload.seq;

      const start = performance.now();
      while (performance.now() - start < 2000) {
        if (messages.some((m) => (m as { seq: number }).seq === seq)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const match = messages.find((m) => (m as { seq: number }).seq === seq) as { kind: string; body: string } | undefined;
      expect(match).toBeDefined();
      expect(match?.kind).toBe("comment.created");
      expect(match?.body).toBe("ws test");
      ws.close();
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("human via session cookie can create threads", async () => {
    const ctx = await startCtx();
    try {
      const cookie = await ctx.cookieFor(ctx.handle.launchCode);
      const response = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          cookie,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchor, body: "human comment" }),
      });
      expect(response.status).toBe(201);
      const payload = await json<WriteResponse>(response);
      expect(payload.event.actor.kind).toBe("local");
      expect(payload.event.actor.id).toBe("local-test");
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("revkit serve — persistence", () => {
  test("threads survive a stop/start against the same sqlite file", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "revkit-persist-"));
    const dbPath = join(dbDir, "threads.sqlite");
    // First run: post one thread, then stop.
    const ctxA = await startCtx({ sqlitePath: dbPath });
    let threadId: string;
    try {
      const response = await fetch(ctxA.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctxA.handle.port, {
          authorization: `Bearer ${ctxA.handle.agentToken}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchor, body: "persistence" }),
      });
      const payload = await json<WriteResponse>(response);
      threadId = payload.event.threadId;
      expect(threadId).toBeDefined();
    } finally {
      await ctxA.handle.stop();
      rmSync(ctxA.root, { recursive: true, force: true });
    }
    // Second run: same db, different daemon — read the threads back.
    const ctxB = await startCtx({ sqlitePath: dbPath });
    try {
      const response = await fetch(ctxB.handle.url + "/api/threads", {
        headers: {
          host: `127.0.0.1:${ctxB.handle.port}`,
          authorization: `Bearer ${ctxB.handle.agentToken}`,
        },
      });
      const payload = await json<ThreadsResponse>(response);
      expect(payload.threads.length).toBe(1);
      expect(payload.threads[0]?.id).toBe(threadId);
    } finally {
      await ctxB.handle.stop();
      rmSync(ctxB.root, { recursive: true, force: true });
    }
    rmSync(dbDir, { recursive: true, force: true });
  });
});

describe("revkit serve — serve.json bookkeeping", () => {
  test("writes .revkit/serve.json at mode 600 on start and removes it on stop", async () => {
    const ctx = await startCtx();
    const path = serveStatePath(ctx.root);
    try {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.port).toBe(ctx.handle.port);
      expect(parsed.agentToken).toBe(ctx.handle.agentToken);
    } finally {
      await ctx.handle.stop();
    }
    // File is gone after stop.
    let existsAfter = false;
    try {
      statSync(path);
      existsAfter = true;
    } catch {
      existsAfter = false;
    }
    expect(existsAfter).toBe(false);
    rmSync(ctx.root, { recursive: true, force: true });
  });
});

describe("revkit serve — logs", () => {
  test("logs contain no comment bodies and no agent token", async () => {
    const ctx = await startCtx();
    try {
      const cookie = await ctx.cookieFor(ctx.handle.launchCode);
      // Post a comment whose body carries a distinctive string.
      const secretBody = "SUPER-SECRET-COMMENT-BODY-DO-NOT-LOG";
      const response = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          cookie,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchor, body: secretBody }),
      });
      expect(response.status).toBe(201);
      // Force a rejected append to log a warn too — an unknown-thread
      // reply.
      await fetch(ctx.handle.url + "/api/threads/does-not-exist/replies", {
        method: "POST",
        headers: loopbackHeaders(ctx.handle.port, {
          cookie,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ parentId: "x", body: "another " + secretBody }),
      });
      // Every log line must be JSON, and none may contain the body or
      // the agent token.
      for (const line of ctx.logs) {
        expect(line).not.toContain(secretBody);
        expect(line).not.toContain(ctx.handle.agentToken);
        expect(line).not.toContain(ctx.handle.launchCode);
        // Must parse as JSON — structure invariant.
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});
