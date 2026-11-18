// `revkit host` — Linux-host target server entry (ADR-0026
// §"Plain Linux host / VM"), sub-issue 2 of #195.
//
// One `Bun.serve` process with one handler, bound to a unix socket
// (default) or a single-tenant loopback TCP port, wired to the
// `trusted-proxy` provider from sub-issue 1 and to the existing
// SQLite store behind the review-core store contract. The loopback
// daemon in `packages/cli/src/serve/` is unchanged.
//
// What this file owns:
//   - startup bind (unix socket at mode 0660 + proxy group, or TCP
//     loopback with a single-tenant banner)//   - base-path strip (`/review/api/threads` → `/api/threads`) and
//     the symmetric rewrite of absolute paths in rendered HTML /
//     the rail bundle (AC 5)//   - request-shape checks (Host allowlist, Origin check on writes,
//     `Sec-Fetch-Site: cross-site` refused, CSP, hygiene headers)//   - identity via `createTrustedProxyAuthProvider` (@revkit/review-core)
//     and the allowed-groups gate (`authorize.ts`)//   - routing: GET static, GET/POST `/api/threads` (comments),
//     GET `/events` (SSE), explicit 404 for agent-shaped routes
//     (`/events?for=agent`, `/-/launch-code`, `/-/health`, bearer
//     `Authorization` on `/api/*`).
//
// What this file deliberately does NOT own: the publish pipeline
// (an agent-only route), ask pages and ask scripts (same), the
// reanchor daemon, the launch-code flow. Those stay on `revkit
// serve` and are agent-surfaces the ADR explicitly keeps
// loopback-only.

import type { Server } from "bun";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  createTrustedProxyAuthProvider,
  type AuthProvider,
  type AuthRequest,
  type AuthRequestPeer,
  type ReviewEvent,
  type ReviewEventInput,
} from "@revkit/review-core";
import { SqliteThreadStore } from "../serve/sqlite-store.ts";
import { EventBus, sseFrame, sseKeepalive, type Subscriber } from "../serve/event-bus.ts";
import { openStaticServer, type StaticServer } from "../serve/static-server.ts";
import { contentTypeForExtension } from "../serve/mime.ts";
import { createThreadRequestSchema } from "../serve/api-schemas.ts";
import ALLOWLIST_JSON from "../dist-check-allowlist.json" with { type: "json" };
import type { HostConfig } from "./config.ts";
import { authorize } from "./authorize.ts";
import { applyHostResponseHeaders, type HostHeaderContext, type ResponseKind } from "./headers.ts";

/** Runtime handle for a running host server — returned by `startHostServer`. */
export interface HostHandle {
  /** The listen descriptor: `unix:<path>` or `http://host:port`. */
  readonly listenDescriptor: string;
  /** Resolved TCP port (for `listen.kind=tcp`), else undefined. */
  readonly port: number | undefined;
  /** Idempotent shutdown; closes the store and removes the socket. */
  stop(): Promise<void>;
}

/** Writer accessed through an interface so a test can capture lines
 * without colouring process stderr. */
export interface LineWriter {
  (line: string): void;
}

export interface StartHostOptions {
  readonly config: HostConfig;
  /** Injected for tests; defaults to `process.stderr.write` and
   * the real wall-clock. */
  readonly log?: LineWriter;
  readonly nowMs?: () => number;
  /** Passed through to the SQLite store when a test wants `:memory:`. */
  readonly sqliteFilename?: string;
}

/** Start the host-target server. Resolves after bind. */
export async function startHostServer(options: StartHostOptions): Promise<HostHandle> {
  const config = options.config;
  const log = options.log ?? ((line) => { process.stderr.write(line); });

  // Groups: `getgrnam` is not in `node:os`. Resolve with a one-shot
  // POSIX helper that reads `/etc/group`; a group not present at
  // startup is a startup refusal.
  let groupGid: number | undefined;
  if (config.listen.kind === "unix") {
    groupGid = resolveGroupGid(config.listen.proxyGroup);
    if (groupGid === undefined) {
      throw new Error(
        `revkit host: proxy group ${JSON.stringify(config.listen.proxyGroup)} not found on this system`,
      );
    }
    // The socket's parent directory must not be world-writable — a
    // world-writable parent lets an unprivileged local account swap
    // the socket with its own listener and impersonate the backend.
    const parent = dirname(config.listen.socketPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o750 });
    }
    const parentStat = statSync(parent);
    if ((parentStat.mode & 0o002) !== 0) {
      throw new Error(
        `revkit host: socket parent directory ${JSON.stringify(parent)} is world-writable; refuse to bind`,
      );
    }
    // Clean up a stale socket from a previous crashed process.
    if (existsSync(config.listen.socketPath)) {
      unlinkSync(config.listen.socketPath);
    }
  }

  // Static site.
  const staticServer = openStaticServer(config.staticDir);
  void realpathSync(config.staticDir);

  // SQLite store at the configured path (ADR-0026 §State). Tests
  // may override with `:memory:`.
  const sqliteFilename = options.sqliteFilename ?? config.sqlitePath;
  const store = SqliteThreadStore.open({ filename: sqliteFilename });

  // Event bus for SSE fan-out.
  const bus = new EventBus();

  // Auth provider (per-request re-derive, ADR-0026 §Identity open
  // question "re-derive per request" — the safer default).
  const auth: AuthProvider = createTrustedProxyAuthProvider({
    headers: {
      subject: config.identity.subjectHeader,
      ...(config.identity.displayNameHeader !== undefined
        ? { displayName: config.identity.displayNameHeader }
        : {}),
      ...(config.identity.groupsHeader !== undefined
        ? { groups: config.identity.groupsHeader }
        : {}),
    },
    trust: config.listen.kind === "unix" ? { kind: "unix-socket" } : config.trust,
  });

  const headerCtx: HostHeaderContext = {
    publicOrigin: config.publicOrigin,
    basePath: config.basePath,
    inlineScriptHashes: Array.from(
      new Set(Object.keys((ALLOWLIST_JSON as { sha256: Record<string, unknown> }).sha256)),
    ).sort(),
  };

  // Precompute lowercase allowlist for case-insensitive `Host`
  // comparison.
  const hostAllowlist = new Set(config.hostAllowlist.map((v) => v.toLowerCase()));

  const fetchHandler = async (
    request: Request,
    srv: Server<unknown>,
  ): Promise<Response | undefined> => {
    const requestId = randomUUID();
    const url = new URL(request.url);
    try {
      return await handleRequest(request, url, srv, requestId);
    } catch (error) {
      log(JSON.stringify({ kind: "request.error", requestId, errorKind: (error as Error).name }) + "\n");
      return respondText(500, "Internal Server Error");
    }
  };
  // Bun.serve's typed overload set is a strict XOR of
  // {unix} vs {hostname,port}; cast to the common shape here (the
  // narrowed branches each pass only one at a time). The alternative
  // is two literal-only call sites whose fetch bodies are
  // copy-pasted, which the no-duplication gate would refuse.
  const server: Server<unknown> =
    config.listen.kind === "unix"
      ? Bun.serve({ unix: config.listen.socketPath, idleTimeout: 0, fetch: fetchHandler } as never)
      : Bun.serve({
          hostname: config.listen.host,
          port: config.listen.port,
          idleTimeout: 0,
          fetch: fetchHandler,
        } as never);

  if (config.listen.kind === "unix") {
    // chgrp+chmod at open; Bun.serve's default is 0755 under the
    // process umask.
    chownSync(config.listen.socketPath, -1, groupGid!);
    chmodSync(config.listen.socketPath, 0o660);
    log(
      JSON.stringify({ kind: "listen.unix", socket: config.listen.socketPath, group: config.listen.proxyGroup }) +
        "\n",
    );
  } else {
    // AC 3: single-tenant banner on TCP mode. Logged once at bind .    // the resolved port is logged once too.
    log(
      JSON.stringify({ kind: "listen.tcp.single-tenant", port: server.port, host: config.listen.host }) + "\n",
    );
  }

  return {
    listenDescriptor:
      config.listen.kind === "unix"
        ? `unix:${config.listen.socketPath}`
        : `http://${config.listen.host}:${server.port ?? config.listen.port}`,
    port: config.listen.kind === "tcp" ? server.port ?? undefined : undefined,
    async stop(): Promise<void> {
      // Shut down the HTTP server and cleanup side state. Each step
      // guarded so a double-stop does not throw.
      try { server.stop(true); } catch { /* already stopped */ }
      try { store.close(); } catch { /* already closed */ }
      if (config.listen.kind === "unix") {
        try { unlinkSync(config.listen.socketPath); } catch { /* already removed */ }
      }
    },
  };

  // ── request pipeline ─────────────────────────────────────────────

  async function handleRequest(
    request: Request,
    url: URL,
    srv: Server<unknown>,
    requestId: string,
  ): Promise<Response> {
    // AC 4a: Host allowlist (DNS-rebinding defence). `Host` is
    // required.
    const hostHeader = (request.headers.get("host") ?? "").toLowerCase();
    if (!hostAllowlist.has(hostHeader)) {
      return respondText(421, "Misdirected Request");
    }

    // AC 4b/4c: write-side guards. Browsers set `Origin` on writes .    // a `Sec-Fetch-Site: cross-site` is refused outright even when
    // `Origin` was stripped. Missing `Origin` on a write is also
    // refused — the ADR-0012 guidance says CSRF on writes.
    const method = request.method.toUpperCase();
    const isWrite = method !== "GET" && method !== "HEAD";
    if (isWrite) {
      const origin = request.headers.get("origin");
      if (origin !== config.publicOrigin) {
        return respondText(403, "Forbidden (origin)");
      }
      const secFetch = request.headers.get("sec-fetch-site");
      if (secFetch !== null && secFetch !== "same-origin" && secFetch !== "none") {
        return respondText(403, "Forbidden (sec-fetch-site)");
      }
    }

    // Strip the configured base-path prefix once, so every route
    // below is written against the un-prefixed path. A request
    // outside the base path (and outside the empty-prefix case)
    // is a 404.
    const path = stripBasePath(url.pathname, config.basePath);
    if (path === undefined) {
      return respondText(404, "Not Found");
    }

    // AC 8: every agent-shaped request is an explicit 404. An
    // `Authorization: Bearer <...>` is the `trusted-proxy` target's
    // signal that the caller thinks this is the agent-token
    // surface; the host target has no such surface.
    if (isAgentShaped(path, request.headers, url)) {
      return respondText(404, "Not Found");
    }

    // Route table.
    if (path === "/events") return handleEvents(request, srv, requestId);
    if (path === "/api/threads") return handleThreadsApi(request, srv, method, isWrite);
    if (method !== "GET" && method !== "HEAD") return respondText(405, "Method Not Allowed");
    return handleStatic(path, method);
  }

  function isAgentShaped(path: string, headers: Headers, url: URL): boolean {
    // `Authorization: Bearer ...` is the agent-token spelling on
    // `revkit serve`. The host target does not implement that
    // surface; any such request is a 404.
    const auth = headers.get("authorization");
    if (auth !== null && /^\s*bearer\s/i.test(auth)) return true;
    // Agent routes from the daemon that have no meaning here.
    if (path === "/-/launch-code") return true;
    if (path === "/-/health") return true;
    if (path === "/-/auth") return true;
    if (path === "/api/publish") return true;
    if (path.startsWith("/api/asks")) return true;
    if (path === "/events" && url.searchParams.get("for") === "agent") return true;
    return false;
  }

  async function handleEvents(request: Request, srv: Server<unknown>, requestId: string): Promise<Response> {
    // Identity + gate (view is enough for SSE; the gate's `view`
    // capability is the right answer here).
    const identityResult = await authenticateRequest(request, srv);
    if (identityResult.kind === "refused") return identityResult.response;
    const gate = authorize(config.authorization.rules, {
      identity: identityResult.identity,
      groupsHeader: config.identity.groupsHeader
        ? request.headers.get(config.identity.groupsHeader)
        : null,
      path: "/events",
      isWrite: false,
    });
    if (gate.kind === "deny") return respondText(403, `Forbidden (${gate.reason})`);

    // Minimal SSE stream: fan events out from the bus. The daemon's
    // `/events` has resume + keepalive + presence; the host target
    // ships resume + keepalive here (presence lives on the daemon).
    const since = (() => {
      const raw = new URL(request.url).searchParams.get("since");
      if (raw === null) return 0;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    })();

    const encoder = new TextEncoder();
    let detach: (() => void) | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        const subscriber: Subscriber = {
          audience: "rail",
          deliver(event: ReviewEvent): void {
            try {
              controller.enqueue(encoder.encode(sseFrame(event)));
            } catch { /* client gone — bus will detach on next publish */ }
          },
          close(): void {
            try { controller.close(); } catch { /* already closed */ }
          },
        };
        void (async () => {
          for (const event of await store.since(since)) {
            try { controller.enqueue(encoder.encode(sseFrame(event))); } catch { return; }
          }
          detach = bus.subscribe(subscriber);
          keepaliveTimer = setInterval(() => {
            try { controller.enqueue(encoder.encode(sseKeepalive())); }
            catch { if (keepaliveTimer) clearInterval(keepaliveTimer); }
          }, 15_000);
        })();
        void requestId;
      },
      cancel(): void {
        if (detach !== undefined) detach();
        if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      },
    });
    const response = new Response(body, { status: 200 });
    return applyHeaders(response, "sse", "text/event-stream; charset=utf-8");
  }

  async function handleThreadsApi(
    request: Request,
    srv: Server<unknown>,
    method: string,
    isWrite: boolean,
  ): Promise<Response> {
    if (method !== "GET" && method !== "POST") return respondText(405, "Method Not Allowed");
    const identityResult = await authenticateRequest(request, srv);
    if (identityResult.kind === "refused") return identityResult.response;
    const gate = authorize(config.authorization.rules, {
      identity: identityResult.identity,
      groupsHeader: config.identity.groupsHeader
        ? request.headers.get(config.identity.groupsHeader)
        : null,
      path: "/api/threads",
      isWrite,
    });
    if (gate.kind === "deny") return respondText(403, `Forbidden (${gate.reason})`);

    if (method === "GET") {
      const head = store.head();
      const threads = await store.threads();
      return applyHeaders(
        new Response(JSON.stringify({ threads, head }), { status: 200 }),
        "json",
        "application/json; charset=utf-8",
      );
    }

    // POST — create a thread. Minimal path through review-core: a
    // reviewer's identity becomes the event's `actor.kind="local"`
    // with id = provider:subject. The daemon's local-user shape is
    // unchanged by this issue.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respondText(400, "Bad Request");
    }
    const parsed = createThreadRequestSchema.safeParse(body);
    if (!parsed.success) return respondText(400, "Bad Request");
    // The schema types `quote` as optional (the browser may omit it
    // when the anchor is line-only), but `ReviewEventInput.anchor`
    // requires a `TextQuote` on a line anchor. Mint an empty quote
    // when the caller supplied none — the review-core validator
    // accepts an empty `exact` so this is schema-compatible, and the
    // daemon's own anchor shape fills in the quote server-side.
    const rawAnchor = parsed.data.anchor;
    const anchor = {
      path: rawAnchor.path,
      startLine: rawAnchor.startLine,
      endLine: rawAnchor.endLine,
      revision: rawAnchor.revision,
      quote: rawAnchor.quote ?? { exact: "", prefix: "", suffix: "" },
      ...(rawAnchor.commit !== undefined ? { commit: rawAnchor.commit } : {}),
    };
    const input: ReviewEventInput = {
      kind: "comment.created",
      threadId: parsed.data.threadId ?? randomUUID(),
      commentId: parsed.data.commentId ?? randomUUID(),
      actor: {
        kind: "local",
        id: `${identityResult.identity.provider}:${identityResult.identity.subject}`,
        displayName: identityResult.identity.displayName,
      },
      anchor,
      body: parsed.data.body,
    };
    try {
      const seq = await store.append(input);
      const event = (await store.since(seq - 1))[0];
      if (event !== undefined) bus.publish(event);
      return applyHeaders(
        new Response(JSON.stringify({ seq, event }), { status: 200 }),
        "json",
        "application/json; charset=utf-8",
      );
    } catch (error) {
      return respondText(400, `Bad Request: ${(error as Error).message}`);
    }
  }

  async function handleStatic(path: string, method: string): Promise<Response> {
    const resolved = staticServer.resolve(path === "" ? "/" : path);
    if (!resolved.ok) return respondText(404, "Not Found");
    const absolutePath = resolved.absolutePath;
    const ext = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
    const contentType = contentTypeForExtension(ext) ?? "application/octet-stream";
    // HTML + the rail bundle get absolute-path rewriting (AC 5).
    const needsRewrite =
      config.basePath.length > 0 &&
      (contentType.startsWith("text/html") || path === "/-/rail.js");
    const file = Bun.file(absolutePath);
    const kind: ResponseKind = contentType.startsWith("text/html")
      ? "html"
      : contentType.startsWith("application/json")
        ? "json"
        : "asset";
    if (method === "HEAD") {
      return applyHeaders(new Response(null, { status: 200 }), kind, contentType);
    }
    if (needsRewrite) {
      return await rewriteAndRespond(file, kind, contentType);
    }
    return applyHeaders(new Response(file, { status: 200 }), kind, contentType);
  }

  async function rewriteAndRespond(
    file: ReturnType<typeof Bun.file>,
    kind: ResponseKind,
    contentType: string,
  ): Promise<Response> {
    const text = await file.text();
    const rewritten = rewriteAbsolutePaths(text, config.basePath);
    return applyHeaders(new Response(rewritten, { status: 200 }), kind, contentType);
  }

  async function authenticateRequest(
    request: Request,
    srv: Server<unknown>,
  ): Promise<
    | { kind: "identity"; identity: AuthenticatedIdentity }
    | { kind: "refused"; response: Response }
  > {
    const authRequest: AuthRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      peer: peerFor(srv, request),
    };
    const result = await auth.authenticate(authRequest);
    if (result.kind === "refused") {
      return { kind: "refused", response: respondText(result.reason.status, authRefusalMessage(result.reason.reason)) };
    }
    return { kind: "identity", identity: result.identity };
  }

  function peerFor(srv: Server<unknown>, request: Request): AuthRequestPeer {
    if (config.listen.kind === "unix") return { transport: "unix" };
    try {
      const ip = srv.requestIP(request);
      if (ip !== null && typeof ip === "object" && "address" in ip) {
        return { transport: "tcp", address: ip.address };
      }
    } catch { /* fall through */ }
    return { transport: "tcp", address: "0.0.0.0" };
  }

  function applyHeaders(response: Response, kind: ResponseKind, contentType: string | undefined): Response {
    return applyHostResponseHeaders(response, kind, contentType, headerCtx);
  }

  function respondText(status: number, body: string): Response {
    return applyHeaders(
      new Response(body + "\n", { status }),
      "text",
      "text/plain; charset=utf-8",
    );
  }
}

type AuthenticatedIdentity = import("@revkit/review-core").Identity;

function authRefusalMessage(reason: string): string {
  if (reason === "untrusted-peer") return "Forbidden (untrusted peer)";
  if (reason === "missing-subject") return "Unauthorized (missing subject)";
  return "Unauthorized";
}

/** Strip the configured base-path. Returns:
 *   - the un-prefixed path (always starts with `/`) on a match;
 *   - `undefined` when `basePath` is non-empty and the request is
 *     outside it (so every non-prefixed request outside the base
 *     path 404s, which is the semantics of a sub-path deployment).
 *
 * Exported for the test suite. */
export function stripBasePath(pathname: string, basePath: string): string | undefined {
  if (basePath.length === 0) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) {
    return pathname.slice(basePath.length);
  }
  return undefined;
}

/** Rewrite `href="/..."`, `src="/..."`, `action="/..."` and
 * quoted `"/..."` string paths used by the rail bundle to prefix
 * the configured base path. Protocol-relative `//host/...` is
 * untouched (the `(?!/)` guard). An already-prefixed path
 * (`"/review/..."` with `basePath="/review"`) is passed through
 * unchanged — the rewriter is idempotent so a built artifact that
 * already names the prefix is not double-prefixed.
 *
 * Exported for the test suite. */
export function rewriteAbsolutePaths(input: string, basePath: string): string {
  if (basePath.length === 0) return input;
  const prefixForSlash = basePath + "/";
  // Groups: $1 = attribute/opener/leading quote; $2 = optional
  // quote char; $3 = the leading slash of the absolute path we are
  // about to rewrite. `(?!/)` guards against `//` (protocol-rel).
  // For `href=/path` without quotes we still rewrite. The pattern
  // covers HTML attributes (href/src/action) and quoted path
  // literals in JS/JSON (`"/api/..."`).
  const pattern = /(href=|src=|action=|["'])(["'])?(\/)(?!\/)/g;
  return input.replace(pattern, (match, prefix: string, quote: string | undefined, _slash: string, offset: number) => {
    // The slash's absolute offset in `input`: the matched span ends
    // at `offset + match.length`, and the slash is the last
    // character of that span.
    const slashOffset = offset + match.length - 1;
    const tail = input.slice(slashOffset);
    if (tail.startsWith(prefixForSlash) || tail === basePath) {
      return match;
    }
    return prefix + (quote ?? "") + basePath + "/";
  });
}

/** Resolve a POSIX group name to its gid. Reads `/etc/group` because
 * `node:os` has no `getgrnam`. A numeric-id shortcut
 * (`proxyGroup: "1000"`) pins a gid without touching the file.
 * Returns `undefined` when the group is not found. */
function resolveGroupGid(name: string): number | undefined {
  if (/^[0-9]+$/.test(name)) {
    const parsed = Number.parseInt(name, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  let raw: string;
  try {
    raw = readFileSync("/etc/group", "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const parts = line.split(":");
    if (parts.length >= 3 && parts[0] === name) {
      const gid = Number.parseInt(parts[2] ?? "", 10);
      if (Number.isFinite(gid)) return gid;
    }
  }
  return undefined;
}
