// Daemon HTTP tests for the asks API (M2 item 7, story A1).
//
// Every test starts a real in-process daemon against a random port
// and a temporary repo root, exercises the surface, and cleans up.
// The suite exercises the ask-create endpoint's agent-bearer gate,
// the answer endpoint's session-cookie gate (bearer alone is
// refused because roles are the point), the cross-site POST
// refusal from the daemons origin check, the 413 for answer
// bodies larger than the 256 KiB cap, the duplicate-answer race
// resolution, the lazy expiry sweep on the read path (a slow
// answer after expiry lands as ask-not-pending), the mode 0600 on
// the on-disk ask file plus schema round-trip, and the
// Cache-Control no-store hygiene on the JSON reads.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFileSchema, type Ask } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";

const choiceSpec: Ask = {
  schemaVersion: 1,
  kind: "choice",
  title: "Which storage backend?",
  prompt: "Pick one, note optional.",
  options: [
    { id: "d1", label: "Cloudflare D1" },
    { id: "kv", label: "Workers KV" },
  ],
  allowOther: true,
  multi: false,
};

interface Ctx {
  handle: DaemonHandle;
  root: string;
  dist: string;
  logs: string[];
  cookieFor(code: string): Promise<string>;
}

async function startCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-asks-http-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
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
  return { handle, root, dist, logs, cookieFor };
}

async function stopCtx(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

let ctxRef: Ctx | undefined;
beforeEach(async () => { ctxRef = await startCtx(); });
afterEach(async () => { if (ctxRef !== undefined) { await stopCtx(ctxRef); ctxRef = undefined; } });

function loopbackHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    ...extra,
  };
}

async function createAsk(ctx: Ctx, spec: Ask = choiceSpec, opts: { id?: string; ttlMs?: number } = {}): Promise<{ id: string; url: string }> {
  const body: Record<string, unknown> = { spec };
  if (opts.id !== undefined) body.id = opts.id;
  if (opts.ttlMs !== undefined) body.ttlMs = opts.ttlMs;
  const response = await fetch(ctx.handle.url + "/api/asks", {
    method: "POST",
    headers: loopbackHeaders(ctx.handle.port, {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.handle.agentToken}`,
    }),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const parsed = (await response.json()) as { ask: { id: string }; url: string };
  return { id: parsed.ask.id, url: parsed.url };
}

describe("POST /api/asks — create", () => {
  test("agent bearer creates an ask, returns id + /ask/<id> url", async () => {
    const ctx = ctxRef!;
    const { id, url } = await createAsk(ctx);
    expect(id.length).toBeGreaterThan(0);
    expect(url).toBe(`/ask/${id}`);
  });

  test("without an agent bearer the write is refused (401 or 403 — the two the auth wall raises)", async () => {
    const ctx = ctxRef!;
    // No auth at all.
    const noAuth = await fetch(ctx.handle.url + "/api/asks", {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json" }),
      body: JSON.stringify({ spec: choiceSpec }),
    });
    expect([401, 403]).toContain(noAuth.status);
    // Session cookie only (i.e. the human): 403, roles enforced.
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const withCookie = await fetch(ctx.handle.url + "/api/asks", {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ spec: choiceSpec }),
    });
    expect(withCookie.status).toBe(403);
  });

  test("a cross-site Origin is refused (CSRF defence, same rule as /api/threads)", async () => {
    const ctx = ctxRef!;
    const response = await fetch(ctx.handle.url + "/api/asks", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${ctx.handle.port}`,
        origin: "http://evil.example",
        authorization: `Bearer ${ctx.handle.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ spec: choiceSpec }),
    });
    expect(response.status).toBe(403);
  });

  test(".revkit/asks/<id>.json lands mode 0600 and validates against askFileSchema", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const path = join(ctx.root, ".revkit", "asks", `${id}.json`);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = askFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(parsed.kind).toBe("choice");
  });

  test("a duplicate id round-trips as a 400 with duplicate-ask", async () => {
    const ctx = ctxRef!;
    await createAsk(ctx, choiceSpec, { id: "ask-dup" });
    const response = await fetch(ctx.handle.url + "/api/asks", {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.handle.agentToken}`,
      }),
      body: JSON.stringify({ id: "ask-dup", spec: choiceSpec }),
    });
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string; issues: readonly { message: string }[] };
    expect(parsed.issues[0]?.message).toBe("duplicate-ask");
  });
});

describe("POST /api/asks/:id/answer — answer", () => {
  test("session cookie answers a pending ask; the answer lands on the record", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1" } }),
    });
    expect(response.status).toBe(201);
    // Read it back.
    const get = await fetch(`${ctx.handle.url}/api/asks/${id}`, {
      headers: loopbackHeaders(ctx.handle.port, { cookie }),
    });
    const parsed = (await get.json()) as { ask: { status: string; answer: unknown } };
    expect(parsed.ask.status).toBe("answered");
    expect(parsed.ask.answer).toEqual({ kind: "choice", value: "d1" });
  });

  test("bearer-only cannot answer (roles enforced)", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.handle.agentToken}`,
      }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1" } }),
    });
    expect(response.status).toBe(403);
  });

  test("an oversize answer body is refused with 413 (defence-in-depth on top of the 1 MiB request cap)", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    // A huge note field pushes the serialised body past MAX_ANSWER_BODY_BYTES
    // (256 KiB) while staying under the 1 MiB request cap.
    const bigNote = "x".repeat(300_000);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1", note: bigNote } }),
    });
    expect(response.status).toBe(413);
  });

  test("a second answer POST is rejected with duplicate-answer (double-answer race)", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const first = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1" } }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "kv" } }),
    });
    expect(second.status).toBe(400);
    const parsed = (await second.json()) as { error: string; issues: readonly { message: string }[] };
    expect(parsed.issues[0]?.message).toBe("duplicate-answer");
  });

  test("an answer with a kind that mismatches the spec is refused with answer-kind-mismatch", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "text", text: "no" } }),
    });
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { issues: readonly { message: string }[] };
    expect(parsed.issues[0]?.message).toBe("answer-kind-mismatch");
  });
});

describe("expiry (lazy)", () => {
  test("a pending ask past its ttlMs expires on the next read; a later answer fails ask-not-pending", async () => {
    const ctx = ctxRef!;
    // ttlMs is 1 — after we await a microtask, the deadline has passed.
    const { id } = await createAsk(ctx, choiceSpec, { ttlMs: 1 });
    // Sleep a beat so the wall clock crosses the deadline.
    await new Promise((r) => setTimeout(r, 20));
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    // Reading /api/asks/:id sweeps the ask.
    const read = await fetch(`${ctx.handle.url}/api/asks/${id}`, {
      headers: loopbackHeaders(ctx.handle.port, { cookie }),
    });
    expect(read.status).toBe(200);
    const parsed = (await read.json()) as { ask: { status: string } };
    expect(parsed.ask.status).toBe("expired");
    // A subsequent answer is refused.
    const late = await fetch(`${ctx.handle.url}/api/asks/${id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1" } }),
    });
    expect(late.status).toBe(400);
    const lateBody = (await late.json()) as { issues: readonly { message: string }[] };
    expect(lateBody.issues[0]?.message).toBe("ask-not-pending");
  });
});

describe("POST /api/asks/:id/cancel — cancel", () => {
  test("agent bearer cancels a pending ask", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/cancel`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.handle.agentToken}`,
      }),
      body: JSON.stringify({ reason: "superseded" }),
    });
    expect(response.status).toBe(201);
    const read = await fetch(`${ctx.handle.url}/api/asks/${id}`, {
      headers: loopbackHeaders(ctx.handle.port, { authorization: `Bearer ${ctx.handle.agentToken}` }),
    });
    const parsed = (await read.json()) as { ask: { status: string; cancelReason?: string } };
    expect(parsed.ask.status).toBe("cancelled");
    expect(parsed.ask.cancelReason).toBe("superseded");
  });

  test("session cookie alone cannot cancel (agent-only role)", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const response = await fetch(`${ctx.handle.url}/api/asks/${id}/cancel`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /api/asks — list + hygiene", () => {
  test("list carries Cache-Control: no-store (hygiene applies to JSON reads)", async () => {
    const ctx = ctxRef!;
    await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const response = await fetch(`${ctx.handle.url}/api/asks`, {
      headers: loopbackHeaders(ctx.handle.port, { cookie }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("status=answered,expired filter narrows the response", async () => {
    const ctx = ctxRef!;
    const a = await createAsk(ctx);
    const b = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    // Answer one.
    await fetch(`${ctx.handle.url}/api/asks/${a.id}/answer`, {
      method: "POST",
      headers: loopbackHeaders(ctx.handle.port, { "content-type": "application/json", cookie }),
      body: JSON.stringify({ answer: { kind: "choice", value: "d1" } }),
    });
    const answered = await fetch(`${ctx.handle.url}/api/asks?status=answered`, {
      headers: loopbackHeaders(ctx.handle.port, { cookie }),
    });
    const parsed = (await answered.json()) as { asks: readonly { id: string }[] };
    expect(parsed.asks.map((x) => x.id)).toEqual([a.id]);
    void b;
  });
});

describe("GET /ask/<id> — page shell", () => {
  test("session cookie renders the HTML shell with CSP + inline boot JSON", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const response = await fetch(`${ctx.handle.url}/ask/${id}`, {
      headers: loopbackHeaders(ctx.handle.port, { cookie }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // CSP is present and does NOT allow eval.
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    // The bundle script lands under /-/ask.js.
    expect(html).toContain('src="/-/ask.js"');
    // The boot JSON contains the ask id.
    expect(html).toContain(`"id":"${id}"`);
  });

  test("no cookie → 401 (the launch-code flow is what mints one)", async () => {
    const ctx = ctxRef!;
    const { id } = await createAsk(ctx);
    const response = await fetch(`${ctx.handle.url}/ask/${id}`, {
      headers: { host: `127.0.0.1:${ctx.handle.port}`, "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(401);
  });
});
