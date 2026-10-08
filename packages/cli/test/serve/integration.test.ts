// End-to-end integration tests for `revkit serve`.
//
// Each test starts a real in-process daemon against a random port and
// a temporary directory that plays the role of `site/dist`, exercises
// the surface (fetch / WebSocket / SSE / signals / raw TCP for
// traversal cases the URL parser would normalise), and stops.
//
// The API round-trip asserts on delivered event payloads (seq, kind,
// anchor, body), not on "did the server respond at all" — a broken
// store or event bus fails these. The security cases each have a
// mutation partner (a paired test that goes red when the guard is
// removed); see the top-of-suite table in the PR body.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
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

/** Send an HTTP/1.1 GET over a raw TCP socket, exactly as a hostile
 * client would, without letting any URL parser normalise the target.
 * Returns the parsed status and the response body. Used by the
 * traversal tests, where `fetch()` collapses `/../` before it hits
 * the wire and would make the guard look untested.
 *
 * **Rejects rather than resolving a sentinel.** A response that is
 * not parseable as HTTP — no header terminator, or a first line that
 * is not an HTTP status line — throws. It used to resolve
 * `{ status: 0, body: "" }`, which satisfied every caller assertion
 * at once (`0 !== 200` and `"".includes("SECRET") === false`), so a
 * daemon that answered with garbage, or answered nothing parseable,
 * was indistinguishable from one that correctly refused a traversal.
 * Every caller of this helper therefore sees a real status or an
 * exception. */
async function rawHttpGet(port: number, rawTarget: string): Promise<{ status: number; body: string }> {
  const request =
    `GET ${rawTarget} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Connection: close\r\n\r\n`;
  return new Promise((resolveOuter, rejectOuter) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const headerEnd = raw.indexOf("\r\n\r\n");
      const firstLine = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).split("\r\n")[0] ?? "";
      const match = firstLine.match(/^HTTP\/1\.\d (\d{3})(?:\s|$)/);
      // No header terminator means the body cannot be delimited, so
      // `body` would be a lie — the bytes after the status line
      // cannot be told apart from headers. Refuse the whole response.
      if (headerEnd === -1 || match === null) {
        rejectOuter(
          new Error(
            `rawHttpGet: response to '${rawTarget}' is not parseable HTTP ` +
              `(header terminator ${headerEnd === -1 ? "absent" : "present"}, ` +
              `first line ${JSON.stringify(firstLine)})`,
          ),
        );
        return;
      }
      resolveOuter({ status: Number.parseInt(match[1] ?? "0", 10), body: raw.slice(headerEnd + 4) });
    });
    socket.on("error", (error) => rejectOuter(error));
    setTimeout(() => {
      socket.destroy();
      rejectOuter(new Error("rawHttpGet timeout"));
    }, 2000);
  });
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
  // Seed a source file at the path every test anchor points at, so
  // the daemon's server-side revision computation (PR #38 review)
  // can `readFileSync` it and produce a real revision.
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nquestion body\nwhy 30s?\nsecond line\n");
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
  startLine: 4,
  endLine: 4,
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

  test("cookie + matching Origin + Sec-Fetch-Site: same-site is refused (Origin-present branch)", async () => {
    // Round-3 survivor, corrected in round 4: this exercises the
    // **cookie** path of `checkOrigin` — a browser page on the
    // same site but a different port sends Origin=<daemon-origin>
    // (matches, because ports are not part of same-site) and
    // `Sec-Fetch-Site: same-site`. The "Origin present" branch
    // must refuse a `sfs != same-origin`. Sending a bearer would
    // instead exercise the bearer branch of the same check, so we
    // authenticate via the session cookie.
    // Mutation: drop the `sfs !== "same-origin"` check in the
    // Origin-present cookie branch → this test flips 403 → 200
    // (verified in the round-4 falsification report).
    const ctx = await startCtx();
    try {
      const cookie = await ctx.cookieFor(ctx.handle.launchCode);
      const response = await fetch(ctx.handle.url + "/api/threads", {
        headers: loopbackHeaders(ctx.handle.port, {
          cookie,
          "sec-fetch-site": "same-site",
        }),
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
      // Origin check runs first: a request that carries neither a
      // valid bearer nor a legitimate loopback Origin is 403 (the
      // request could be a cross-origin browser attack). The 401
      // arm is exercised in the "same-origin no-auth" test below.
      const noAuthNoOrigin = await fetch(ctx.handle.url + "/api/threads");
      expect(noAuthNoOrigin.status).toBe(403);
      const badToken = await fetch(ctx.handle.url + "/api/threads", {
        headers: {
          host: `127.0.0.1:${ctx.handle.port}`,
          origin: `http://127.0.0.1:${ctx.handle.port}`,
          authorization: "Bearer wrong-token",
        },
      });
      expect(badToken.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses /api/* with a matching Origin but no credential (401, not 403)", async () => {
    // This is the mutation partner to the previous test: with a
    // legitimate loopback Origin the auth check is the one that runs
    // — flipping `identifyActor`'s branch back to always-authenticated
    // would turn this test red.
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/api/threads", {
        headers: loopbackHeaders(ctx.handle.port),
      });
      expect(response.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses /events?for=agent without the agent token (foreign Origin → 403)", async () => {
    const ctx = await startCtx();
    try {
      // No Origin, no bearer → 403 at the Origin gate. Reproduces
      // the cross-site WebSocket attack shape below via curl (a
      // browser page could send this with cookies riding along).
      const noAuth = await fetch(ctx.handle.url + "/events?for=agent");
      expect(noAuth.status).toBe(403);
      // With a matching Origin but no bearer, the agent-token check
      // is what refuses (401) — a distinct mutation target.
      const sameOriginNoBearer = await fetch(ctx.handle.url + "/events?for=agent", {
        headers: loopbackHeaders(ctx.handle.port),
      });
      expect(sameOriginNoBearer.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses /events with a foreign Origin, even with a session cookie (cross-site WebSocket hijack)", async () => {
    // Reproduces the round-1 blocker: a page on `127.0.0.1:<other-port>`
    // that runs `new WebSocket("ws://127.0.0.1:<daemon>/events")`
    // would share the browser's cookie jar and receive `comment.created`
    // frames (body included). The Origin check must refuse the
    // upgrade AND the SSE version.
    const ctx = await startCtx();
    try {
      const cookie = await ctx.cookieFor(ctx.handle.launchCode);
      // SSE with a foreign Origin: browser would set Sec-Fetch-Site:
      // cross-site; the check catches even absent that header.
      const sse = await fetch(ctx.handle.url + "/events", {
        headers: {
          host: `127.0.0.1:${ctx.handle.port}`,
          origin: `http://127.0.0.1:${ctx.handle.port + 1}`,
          cookie,
        },
      });
      expect(sse.status).toBe(403);
      // WebSocket upgrade with a foreign Origin and the cookie:
      // must NOT get 101. curl's `--http1.1 --upgrade` handshake is
      // driven here through fetch with `upgrade: websocket` and a
      // fake Sec-WebSocket-Key.
      const ws = await fetch(ctx.handle.url + "/events", {
        headers: {
          host: `127.0.0.1:${ctx.handle.port}`,
          origin: `http://127.0.0.1:${ctx.handle.port + 1}`,
          cookie,
          upgrade: "websocket",
          connection: "Upgrade",
          // RFC 6455 requires a 16-byte random nonce; we generate it
          // per run so gitleaks does not flag a static string.
          "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
          "sec-websocket-version": "13",
        },
      });
      // 403 (Origin refused) rather than 101 (switching protocols).
      expect(ws.status).toBe(403);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("refuses default /events (no ?for=agent) without a session cookie or bearer", async () => {
    // Mutation partner for the cookie check on the default `/events`
    // branch: with a matching same-origin Origin (past the Origin
    // gate) and no cookie / bearer, the request must be 401. Disabling
    // the `hasSession && !hasValidBearer` guard makes this test go
    // red.
    const ctx = await startCtx();
    try {
      const noAuth = await fetch(ctx.handle.url + "/events", {
        headers: loopbackHeaders(ctx.handle.port),
      });
      expect(noAuth.status).toBe(401);
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("accepts default /events with a valid session cookie (mutation partner)", async () => {
    // Mutation partner for the cookie *acceptance*: exchanging the
    // launch code for a session cookie and using it on default
    // `/events` (SSE) must succeed. Removing `auth.hasSession` from
    // `identifyActor` / the events check would turn this test red.
    const ctx = await startCtx();
    try {
      const cookie = await ctx.cookieFor(ctx.handle.launchCode);
      const response = await fetch(ctx.handle.url + "/events", {
        headers: loopbackHeaders(ctx.handle.port, { cookie }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body?.cancel();
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("accepts /events?for=agent from an MCP-style caller with a valid bearer and no Origin", async () => {
    // Non-browser MCP clients do not set Origin. The Origin gate
    // must allow that case as long as the bearer is valid. This is
    // the mutation partner to "no Origin → 403": flipping the
    // bearer allowance would turn this test red.
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/events?for=agent", {
        headers: {
          host: `127.0.0.1:${ctx.handle.port}`,
          authorization: `Bearer ${ctx.handle.agentToken}`,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body?.cancel();
    } finally {
      await ctx.handle.stop();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  test("accepts a bearer-authenticated POST with NO Origin header (browser-less caller)", async () => {
    // `revkit mcp` is a subprocess with no browser envelope. Its
    // credential is the bearer token; missing Origin should not
    // reject it — the Origin check exists to catch browsers, and a
    // browser always attaches Origin. A malformed body still 400s,
    // proving the request reached the API branch (i.e. passed the
    // Origin/Sec-Fetch guards).
    const ctx = await startCtx();
    try {
      const response = await fetch(ctx.handle.url + "/api/threads", {
        method: "POST",
        headers: {
          // NOTE: no `origin` header.
          host: `127.0.0.1:${ctx.handle.port}`,
          authorization: `Bearer ${ctx.handle.agentToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      // Reached the API branch: 400 (invalid body), not 403 (Origin
      // rejected).
      expect(response.status).toBe(400);
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

  test("path traversal shapes are refused when sent over a raw TCP socket", async () => {
    // A `fetch()` client normalises `/foo/../bar` to `/bar` on the
    // client side, which means the daemon never sees `..` — the guard
    // is not exercised. To test the guard, we open a raw TCP socket
    // to the daemon and write the HTTP request line ourselves,
    // preserving `%2e%2e`, `..%2f`, backslashes and double-encoded
    // forms.
    //
    // Each payload asserts its EXACT expected status, measured
    // against this daemon rather than guessed — they genuinely
    // differ, because two different layers refuse two different
    // shapes (see the table):
    //
    //   * 400 — the daemon's `resolveWithinRoot` sees a decoded `..`
    //     SEGMENT and refuses it as `traversal`
    //     (`static.rejected` `errorKind: "traversal"` → 400). This
    //     needs the traversal marker to survive URL normalisation,
    //     which it does when the marker is glued to an encoded
    //     slash: `..%2f` decodes to `../` only at the daemon's own
    //     `decodeURIComponent`, after the URL parser is done.
    //   * 404 — the URL parser (or a single decode) collapses the
    //     `..` before the guard sees it, so the request is a
    //     well-formed path to a file that does not exist in dist
    //     (`errorKind: "not-found"` → 404). Still a refusal, and
    //     still no `SECRET` — but it is the *404* half of
    //     "refused", not the 400 half.
    //
    // The statuses were captured from the daemon's own structured
    // `static.rejected` log line for each payload; an `expect(status)
    // .not.toBe(200)` here was previously satisfied by the parse
    // sentinel `0` as well as by a real refusal, so a non-HTTP
    // answer passed as a refusal.
    const ctx = await startCtx();
    try {
      const attacks: ReadonlyArray<readonly [target: string, expectedStatus: number]> = [
        // `/../` and `%2e%2e` are dot-segments to the URL parser, so
        // it normalises them away before the request line reaches the
        // daemon: `/outside/secret.txt`, which is simply not in dist.
        ["/../outside/secret.txt", 404],
        ["/%2e%2e/outside/secret.txt", 404],
        // Encoded slash: the dot-segment is only decoded at the
        // daemon boundary, so the guard itself refuses these.
        ["/..%2foutside/secret.txt", 400],
        ["/..%2Foutside/secret.txt", 400],
        ["/%2e%2e%2foutside/secret.txt", 400],
        ["/%2E%2E%2Foutside/secret.txt", 400],
        ["/sub/..%2f..%2foutside/secret.txt", 400],
        // Double-encoded — the daemon decodes once, so `%2e%2e`
        // remains a literal (non-dot) segment name and 404s.
        ["/%252e%252e/outside/secret.txt", 404],
      ];
      for (const [attack, expectedStatus] of attacks) {
        const { status, body } = await rawHttpGet(ctx.handle.port, attack);
        expect(status, `attack '${attack}' must be refused with ${expectedStatus}`).toBe(expectedStatus);
        expect(body, `attack '${attack}' body must not carry SECRET`).not.toContain("SECRET");
      }
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
