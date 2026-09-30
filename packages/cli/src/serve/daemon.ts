// The `revkit serve` daemon — one Bun.serve process bound to 127.0.0.1
// only, serving `site/dist` and the JSON API from one origin
// (ADR-0013, ADR-0006, ADR-0007).
//
// Everything is composed here; the individual concerns live in files
// that stay small enough to test in isolation:
//   - static files → `static-server.ts` (path confinement in `confined-path.ts`)
//   - Content-Type → `mime.ts`
//   - launch code, session cookie, agent token, Host/Origin guards
//                → `auth.ts`
//   - `.revkit/serve.json` at mode 600, atomic write, stale detection
//                → `serve-state.ts`
//   - event fanout → `event-bus.ts`
//   - JSON API bodies → `api-schemas.ts`
//   - structured logs → `logger.ts`
//   - store (append-only event log) → `sqlite-store.ts` (implements
//                review-core's `ThreadStore`, ADR-0006)
//
// `startDaemon(options)` returns a `DaemonHandle` — `{url, port,
// agentToken, launchUrl, stop()}`. The handle's `stop()` is
// idempotent and always cleans up `.revkit/serve.json`. The CLI wraps
// `startDaemon` in a top-level `serve` subcommand; tests spawn the
// same function against `port: 0` and a temporary directory.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, extname, relative as relativePath } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import {
  threadStatusSchema,
  type Author,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadFilter,
  ThreadStoreAppendError,
} from "@revkit/review-core";
import { openStaticServer } from "./static-server.ts";
import { contentTypeForExtension } from "./mime.ts";
import {
  AuthState,
  bearerFromHeader,
  cookieName,
  isLoopbackHost,
  isLoopbackOrigin,
  mintToken,
  readCookie,
  setCookieHeader,
} from "./auth.ts";
import { EventBus, sseFrame, sseKeepalive, type Subscriber } from "./event-bus.ts";
import { defaultSink, makeLogger, type LineSink } from "./logger.ts";
import { removeServeState, writeServeState, type ServeState } from "./serve-state.ts";
import { SqliteThreadStore } from "./sqlite-store.ts";
import {
  createThreadRequestSchema,
  reopenRequestSchema,
  replyRequestSchema,
  resolveRequestSchema,
} from "./api-schemas.ts";

/** Public options accepted by the daemon. */
export interface StartDaemonOptions {
  /** Directory the static server serves from. Absolute. */
  readonly dir: string;
  /** Absolute repo-root path; `.revkit/` lives under it. */
  readonly repoRoot: string;
  /** Requested port (0 = random). Defaults to 0. */
  readonly port?: number;
  /** Path to the sqlite file. Defaults to `<repoRoot>/.revkit/threads.sqlite`.
   * Tests pass `:memory:` or a temporary path. */
  readonly sqlitePath?: string;
  /** Version string written to `serve.json`. */
  readonly version: string;
  /** Author id assigned to comments made through the session cookie
   * (the human on this machine). The CLI generates and reuses a
   * per-install id; tests can pin one. */
  readonly localUserId: string;
  /** Optional display name for the local human. */
  readonly localUserDisplayName?: string;
  /** The agent's registered id (mention target). Defaults to
   * `"agent"`; the M2 channel client rebinds it to a per-session
   * name. */
  readonly agentActorId?: string;
  /** Sink for structured logs. Defaults to stderr. */
  readonly logSink?: LineSink;
  /** Whether the daemon prints the launch link + agent token file
   * path to stdout after bind. Off by default in tests to keep the
   * harness quiet; the CLI turns it on. */
  readonly announce?: boolean;
  /** Injected clock for tests (`Date.now`-style ms epoch). */
  readonly nowMs?: () => number;
  /** How long a launch code stays valid. Defaults to 60 s. */
  readonly launchCodeTtlMs?: number;
  /** Whether to install SIGINT / SIGTERM handlers. On by default in
   * the CLI; off in tests (they call `stop()` directly). */
  readonly installSignalHandlers?: boolean;
}

/** A handle on a running daemon. `stop()` is idempotent and removes
 * `.revkit/serve.json`. */
export interface DaemonHandle {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchCode: string;
  readonly launchUrl: string;
  stop(): Promise<void>;
}

/** Data attached to each WebSocket connection: which subscriber the
 * bus knows this connection as, so `close` detaches it. */
interface WebSocketData {
  since: number;
  requestId: string;
  subscriber?: Subscriber;
  detach?: () => void;
}

/** A `Subscriber` backed by a WebSocket. */
class WebSocketSubscriber implements Subscriber {
  #closed = false;
  constructor(private readonly ws: ServerWebSocket<WebSocketData>) {}
  deliver(event: ReviewEvent): void {
    if (this.#closed) return;
    this.ws.send(JSON.stringify(event));
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.ws.close(1000, "server shutting down");
    } catch {
      // Already closed on the wire.
    }
  }
}

/** How often to send an SSE keepalive comment. Kept short so a paused
 * tab wakes quickly; long enough not to spam the log. */
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Start the daemon. Returns a handle whose `stop()` is idempotent. */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const logger = makeLogger({ sink: options.logSink ?? defaultSink() });
  const requestedPort = options.port ?? 0;

  // Make sure `.revkit/` exists before opening the sqlite file —
  // `bun:sqlite` creates the file but not the parent directory, and
  // `writeServeState` (below) also assumes the directory is there.
  // Directory mode is 0700 so a curious peer user cannot list the
  // sqlite / cookie files; the sqlite file itself is chmodded to
  // 0600 alongside its WAL sidecars.
  const sqlitePath = options.sqlitePath ?? `${options.repoRoot}/.revkit/threads.sqlite`;
  if (sqlitePath !== ":memory:") {
    mkdirSync(dirname(sqlitePath), { recursive: true, mode: 0o700 });
    // Re-chmod: on an existing `.revkit/` mkdir won't downgrade the
    // mode, and umask-clamped creation may have missed the setuid-off
    // bits on odd filesystems. Force 0700.
    try {
      chmodSync(dirname(sqlitePath), 0o700);
    } catch {
      // A caller-supplied dir may be a symlink chain we cannot
      // chmod; not fatal.
    }
  }
  const store = SqliteThreadStore.open({
    filename: sqlitePath,
    displayName: sqlitePath === ":memory:" ? sqlitePath : repoRelativeDisplay(options.repoRoot, sqlitePath),
  });
  if (sqlitePath !== ":memory:") {
    // Chmod the sqlite file and its WAL sidecars to 0600. Sidecars
    // may not exist yet — chmod is best-effort per path.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(sqlitePath + suffix, 0o600);
      } catch {
        // File does not exist yet (WAL/SHM created on first write) —
        // fine.
      }
    }
  }
  const staticServer = openStaticServer(options.dir);
  const bus = new EventBus();

  const agentToken = mintToken();
  const launchCode = mintToken();
  const auth = new AuthState({
    agentToken,
    launchCode,
    clock: options.nowMs,
    launchCodeTtlMs: options.launchCodeTtlMs,
  });

  const localActor: Author = {
    kind: "local",
    id: options.localUserId,
    ...(options.localUserDisplayName !== undefined ? { displayName: options.localUserDisplayName } : {}),
  };
  const agentActor: Author = { kind: "agent", id: options.agentActorId ?? "agent" };

  const keepaliveTimers = new Set<ReturnType<typeof setInterval>>();

  const server: Server<WebSocketData> = Bun.serve<WebSocketData>({
    port: requestedPort,
    hostname: "127.0.0.1",
    // `/events` is a long-lived SSE / WebSocket stream — a
    // per-request idle timeout of 10 s (Bun's default) would close
    // the connection before the next event arrives on a quiet
    // channel. Zero disables the per-request timer; keepalive
    // frames (SSE `sseKeepalive`) still give the client a heartbeat.
    idleTimeout: 0,
    async fetch(request, srv): Promise<Response | undefined> {
      const requestId = randomUUID();
      const url = new URL(request.url);
      const started = performance.now();
      try {
        const response = await handleRequest(request, url, srv, requestId);
        if (response === undefined) {
          // WebSocket upgrade — Bun handles the response.
          return undefined;
        }
        const duration = Math.round(performance.now() - started);
        logger.info("request", {
          requestId,
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs: duration,
        });
        return response;
      } catch (error) {
        const duration = Math.round(performance.now() - started);
        logger.error("request.error", {
          requestId,
          method: request.method,
          path: url.pathname,
          status: 500,
          durationMs: duration,
          errorKind: (error as Error).name,
        });
        return withHygiene(new Response("Internal Server Error", { status: 500 }), "text/plain; charset=utf-8");
      }
    },
    websocket: {
      async open(ws) {
        const data = ws.data;
        try {
          const primer = await store.since(data.since);
          for (const event of primer) ws.send(JSON.stringify(event));
          const subscriber = new WebSocketSubscriber(ws);
          const detach = bus.subscribe(subscriber);
          data.subscriber = subscriber;
          data.detach = detach;
        } catch (error) {
          logger.error("events.ws.prime-failed", {
            requestId: data.requestId,
            errorKind: (error as Error).name,
          });
          try {
            ws.close(1011, "prime failed");
          } catch {
            // Already closed.
          }
        }
      },
      message(ws, message) {
        // Clients do not send messages on the event stream; ignore.
        void ws;
        void message;
      },
      close(ws) {
        const data = ws.data;
        if (data.detach !== undefined) {
          try {
            data.detach();
          } catch {
            // Already detached.
          }
        }
      },
    },
  });

  // `Server.port` is `number | undefined` in Bun's types (a unix-
  // socket server has no port) — we bound to a hostname above, so it
  // is defined; the type-narrow is a defensive assert.
  if (server.port === undefined) {
    server.stop(true);
    store.close();
    staticServer.close();
    throw new Error("revkit serve: Bun.serve returned no port — refusing to write serve.json without one.");
  }
  const port: number = server.port;
  const boundUrl = `http://127.0.0.1:${port}`;
  const launchUrl = `${boundUrl}/-/auth?code=${launchCode}`;

  // Per-start instance id, echoed by `GET /-/health` so a probe can
  // tell whether the port answers as THIS daemon (or a foreign
  // process that reclaimed the pid + port pair).
  const instanceId = mintToken();
  const state: ServeState & { readonly instanceId: string } = {
    pid: process.pid,
    port,
    url: boundUrl,
    agentToken,
    startedAt: new Date().toISOString(),
    version: options.version,
    instanceId,
  };
  const writeResult = await writeServeState(options.repoRoot, state, {
    probeDaemon: async (existing) => {
      // Fetch `/-/health` on the existing daemon's URL. If the
      // response's instanceId matches the file's, we treat it as
      // ours (should not happen — we would still be running); if it
      // does not answer, or answers something else, treat as "other"
      // so the state file is replaced.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 500);
        try {
          const r = await fetch(existing.url + "/-/health", {
            headers: { host: `127.0.0.1:${existing.port}` },
            signal: controller.signal,
          });
          if (!r.ok) return "other";
          const body = (await r.json()) as { instanceId?: unknown };
          if (typeof body.instanceId === "string" && body.instanceId.length > 0) return "revkit";
          return "other";
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return "other";
      }
    },
  });
  if (!writeResult.ok) {
    // Another daemon owns the file — release our own port and refuse.
    server.stop(true);
    store.close();
    staticServer.close();
    const existing = writeResult.refused.state;
    throw new Error(
      `revkit serve: another daemon is running (pid ${existing.pid}, ${existing.url}). ` +
        `Stop it, or wait for it to release '.revkit/serve.json'.`,
    );
  }

  // Emit repo-relative paths in structured logs and on stdout so the
  // caller's absolute filesystem layout does not leak into
  // scrollback or a shipped log — defence in depth for ADR-0020,
  // since a home directory path can carry the operator's username.
  const dirDisplay = repoRelativeDisplay(options.repoRoot, options.dir);
  logger.info("serve.start", {
    pid: process.pid,
    port,
    dir: dirDisplay,
    version: options.version,
  });

  if (options.announce === true) {
    // Kept short and body-free: the launch URL and the fact that an
    // agent token file exists (mode 600) — not the token value.
    process.stdout.write(
      `revkit serve: listening on ${boundUrl}\n` +
        `  serve on: ${dirDisplay}\n` +
        `  launch:   ${launchUrl}   (single-use, expires in 60s)\n` +
        `  agent token in .revkit/serve.json (mode 600)\n`,
    );
  }

  const signalHandlersInstalled: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  if (options.installSignalHandlers !== false) {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info("serve.signal", { reason: signal });
      // Fire-and-forget; stop() removes the handlers so a second
      // signal is not swallowed.
      void handle.stop();
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => onSignal(sig);
      signalHandlersInstalled.push({ signal: sig, handler });
      process.on(sig, handler);
    }
  }

  let stopped = false;
  const handle: DaemonHandle = {
    url: boundUrl,
    port,
    agentToken,
    launchCode,
    launchUrl,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of keepaliveTimers) clearInterval(timer);
      keepaliveTimers.clear();
      bus.closeAll();
      try {
        server.stop(true);
      } catch {
        // Server already stopping.
      }
      store.close();
      staticServer.close();
      removeServeState(options.repoRoot);
      for (const { signal, handler } of signalHandlersInstalled) {
        process.off(signal, handler);
      }
      logger.info("serve.stop", { port });
    },
  };
  return handle;

  // ── request dispatcher ────────────────────────────────────────────

  async function handleRequest(request: Request, url: URL, srv: Server<WebSocketData>, requestId: string): Promise<Response | undefined> {
    // Host check (DNS-rebinding defence) on every request, GET or not.
    // A public DNS record that points at 127.0.0.1 cannot present a
    // matching Host header.
    const hostHeader = request.headers.get("host");
    if (!isLoopbackHost(hostHeader, port)) {
      logger.warn("request.rejected.host", { requestId, host: hostHeader ?? "" });
      return withHygiene(new Response("Misdirected Request", { status: 421 }), "text/plain; charset=utf-8");
    }

    const method = request.method.toUpperCase();

    // Launch-code exchange. GET only; the redirect strips the code.
    // The launch code is a one-shot secret so there is no CSRF-shape
    // attack against this endpoint — anyone with the code has, by
    // definition, been handed access.
    if (method === "GET" && url.pathname === "/-/auth") {
      return handleAuthExchange(url, requestId);
    }

    // Liveness / identity probe used by the next `revkit serve`
    // start to distinguish a real running daemon from a reused pid.
    // Returns the daemon's per-start instance id — a bearer-shaped
    // secret is not needed here because the response identifies
    // the daemon only (no tokens, no data).
    if (method === "GET" && url.pathname === "/-/health") {
      const body = JSON.stringify({ instanceId, pid: process.pid });
      const response = new Response(body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      response.headers.set("x-content-type-options", "nosniff");
      return response;
    }

    // `/events` — SSE by default, WebSocket on upgrade. Origin check
    // runs inside the handler after we know which credential the
    // caller presented (a bearer-authenticated non-browser client may
    // omit Origin; a cookie-authenticated browser must not).
    if (url.pathname === "/events") {
      if (method !== "GET") return methodNotAllowed();
      return handleEvents(request, url, srv, requestId);
    }

    // JSON API. Same Origin discipline as `/events`, enforced inside
    // the handler.
    if (url.pathname === "/api/threads" || url.pathname.startsWith("/api/threads/")) {
      return handleApi(request, url, method, requestId);
    }

    // Static files. GET / HEAD only. Static output is public — no
    // cookie, no user data returned in the body — so no Origin check
    // is needed and the daemon serves them to whoever asks over the
    // loopback interface.
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
    return handleStatic(request, url, requestId);
  }

  /** Enforce the Origin discipline for a cookie-or-bearer authenticated
   * endpoint (ADR-0013). Rules, in order:
   *
   * 1. **Bearer callers** (a valid agent token) — accept. If they also
   *    send an Origin, it must match the daemon's own (a bearer
   *    caller sending a foreign Origin is suspicious). Non-browser
   *    MCP clients typically send neither header, so absent is fine.
   * 2. **Origin present** — must match the daemon's own loopback
   *    origin. If it does, `Sec-Fetch-Site` (when set) must be
   *    `same-origin`; `cross-site` and `same-site` are refused (a
   *    page on `127.0.0.1:<other-port>` counts as `same-site`).
   * 3. **Origin absent** — the browser omits Origin on a same-origin
   *    GET and on `EventSource` (Fetch §3.3.3 keeps Origin off
   *    `no-cors` same-origin GETs). Accept only when `Sec-Fetch-Site`
   *    is `same-origin`. Neither header present is a shell caller
   *    with a stolen cookie — the daemon's own tab always sends
   *    Sec-Fetch-Site, so this refuses safely. `Sec-Fetch-Site: none`
   *    (top-level navigation) is refused too: a data endpoint
   *    typed in the URL bar returns raw JSON, but so would a phish
   *    disguising the URL — refusing keeps to same-origin discipline.
   *
   * Returns a Response on rejection or undefined on pass. */
  function checkOrigin(request: Request, requestId: string, hasValidBearer: boolean): Response | undefined {
    const origin = request.headers.get("origin");
    const sfs = request.headers.get("sec-fetch-site");

    if (hasValidBearer) {
      // Even a bearer caller cannot claim to be a cross-site or
      // same-site fetch — that shape only comes from a browser that
      // stole the bearer, which is worth refusing.
      if (origin !== null && !isLoopbackOrigin(origin, port)) {
        logger.warn("request.rejected.origin", { requestId, origin });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
      if (sfs !== null && sfs !== "same-origin" && sfs !== "none") {
        logger.warn("request.rejected.sec-fetch", { requestId, reason: sfs });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
      return undefined;
    }

    if (origin !== null) {
      if (!isLoopbackOrigin(origin, port)) {
        logger.warn("request.rejected.origin", { requestId, origin });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
      if (sfs !== null && sfs !== "same-origin") {
        logger.warn("request.rejected.sec-fetch", { requestId, reason: sfs });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
      return undefined;
    }

    // Origin absent — the same-origin browser fetch / EventSource
    // path. Requires the browser to have set Sec-Fetch-Site
    // explicitly. Every modern browser (Chromium, Firefox, WebKit)
    // sets it on `fetch` and `EventSource`; a caller that sends
    // neither Origin nor Sec-Fetch-Site cannot be a same-origin
    // browser request.
    if (sfs === "same-origin") return undefined;
    logger.warn("request.rejected.origin", { requestId, reason: sfs === null ? "missing" : `sfs=${sfs}` });
    return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
  }

  function methodNotAllowed(): Response {
    return withHygiene(new Response("Method Not Allowed", { status: 405 }), "text/plain; charset=utf-8");
  }

  function handleAuthExchange(url: URL, requestId: string): Response {
    const code = url.searchParams.get("code") ?? "";
    if (code.length === 0) {
      logger.warn("auth.exchange.missing-code", { requestId });
      return withHygiene(new Response("Bad Request", { status: 400 }), "text/plain; charset=utf-8");
    }
    const outcome = auth.exchangeLaunchCode(code);
    if (!outcome.ok) {
      logger.warn("auth.exchange.rejected", { requestId, reason: outcome.reason });
      return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
    }
    logger.info("auth.exchange.ok", { requestId });
    const response = new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": setCookieHeader(cookieName(port), outcome.cookie),
      },
    });
    return withHygiene(response, undefined);
  }

  // ── API branch ────────────────────────────────────────────────────

  async function handleApi(request: Request, url: URL, method: string, requestId: string): Promise<Response> {
    // Origin gate runs BEFORE authentication so a page from another
    // loopback port cannot smuggle the browser's session cookie into
    // a same-site API call (browsers do not partition cookies by port).
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    const hasValidBearer = bearer !== undefined && auth.isAgent(bearer);
    const originRejection = checkOrigin(request, requestId, hasValidBearer);
    if (originRejection !== undefined) return originRejection;

    const actor = identifyActor(request);
    if (actor === undefined) {
      logger.warn("api.rejected.auth", { requestId, path: url.pathname });
      return withHygiene(new Response("Unauthorized", { status: 401 }), "text/plain; charset=utf-8");
    }

    // GET /api/threads?path=&status=
    if (url.pathname === "/api/threads" && method === "GET") {
      const filter: ThreadFilter = {};
      const pathParam = url.searchParams.get("path");
      if (pathParam !== null) filter.path = pathParam;
      const statusParam = url.searchParams.get("status");
      if (statusParam !== null) {
        const parts = statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        // Validate each part against review-core's `ThreadStatus`
        // enum instead of casting — an unknown status silently
        // matches nothing today and would confuse a caller.
        const parsedStatus = z.array(threadStatusSchema).min(1).safeParse(parts);
        if (!parsedStatus.success) {
          return badRequest([{ code: "custom", path: ["status"], message: "invalid status value(s)" }]);
        }
        if (parsedStatus.data.length === 1) filter.status = parsedStatus.data[0];
        else filter.status = parsedStatus.data;
      }
      const threads = await store.threads(filter);
      return jsonResponse({ threads, head: store.head() });
    }

    // POST /api/threads
    if (url.pathname === "/api/threads" && method === "POST") {
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) return bodyRead.kind === "too-large" ? payloadTooLarge() : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      const parsed = createThreadRequestSchema.safeParse(bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      if (!enforceCommentBodyLimit(parsed.data.body)) return payloadTooLarge();
      const threadId = parsed.data.threadId ?? randomUUID();
      const commentId = parsed.data.commentId ?? randomUUID();
      const input: ReviewEventInput = {
        kind: "comment.created",
        actor,
        threadId,
        commentId,
        anchor: parsed.data.anchor,
        body: parsed.data.body,
      };
      return await appendAndReturn(input, requestId, { threadId, commentId });
    }

    // Paths of shape /api/threads/:id/(replies|resolve|reopen)
    const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/(replies|resolve|reopen)$/);
    if (match !== null && method === "POST") {
      // `decodeURIComponent` throws `URIError` on a malformed percent
      // escape ("%zz"); catch it and turn it into a 400 rather than
      // letting it surface as a 500.
      let threadId: string;
      try {
        threadId = decodeURIComponent(match[1] ?? "");
      } catch {
        return badRequest([{ code: "custom", path: ["threadId"], message: "invalid percent-encoding" }]);
      }
      const kind = match[2];
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) return bodyRead.kind === "too-large" ? payloadTooLarge() : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      const body = bodyRead.value;
      if (kind === "replies") {
        const parsed = replyRequestSchema.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.issues);
        if (!enforceCommentBodyLimit(parsed.data.body)) return payloadTooLarge();
        const commentId = parsed.data.commentId ?? randomUUID();
        const input: ReviewEventInput = {
          kind: "comment.replied",
          actor,
          threadId,
          commentId,
          parentId: parsed.data.parentId,
          body: parsed.data.body,
        };
        return await appendAndReturn(input, requestId, { threadId, commentId });
      }
      if (kind === "resolve") {
        const parsed = resolveRequestSchema.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.issues);
        const input: ReviewEventInput = {
          kind: "thread.resolved",
          actor,
          threadId,
          ...(parsed.data.resolution !== undefined ? { resolution: parsed.data.resolution } : {}),
        };
        return await appendAndReturn(input, requestId, { threadId });
      }
      if (kind === "reopen") {
        const parsed = reopenRequestSchema.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.issues);
        const input: ReviewEventInput = {
          kind: "thread.reopened",
          actor,
          threadId,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        };
        return await appendAndReturn(input, requestId, { threadId });
      }
    }

    return withHygiene(new Response("Not Found", { status: 404 }), "text/plain; charset=utf-8");
  }

  async function appendAndReturn(
    input: ReviewEventInput,
    requestId: string,
    fields: { readonly threadId?: string; readonly commentId?: string },
  ): Promise<Response> {
    let seq: number;
    try {
      seq = await store.append(input);
    } catch (error) {
      if (error instanceof ThreadStoreAppendError) {
        logger.warn("api.append.rejected", {
          requestId,
          ...(fields.threadId !== undefined ? { threadId: fields.threadId } : {}),
          ...(fields.commentId !== undefined ? { commentId: fields.commentId } : {}),
          errorKind: error.rejection.kind,
        });
        return badRequest([{ code: "custom", path: [], message: error.rejection.kind }]);
      }
      throw error;
    }
    // Rehydrate the persisted event and fan it out. `since(seq - 1)`
    // returns exactly the row just written.
    const events = await store.since(seq - 1);
    const event = events.find((e) => e.seq === seq);
    if (event !== undefined) {
      // Fire-and-forget: subscribers should not block the API
      // response, and the bus already isolates delivery failures per
      // subscriber.
      void bus.publish(event);
    }
    logger.info("api.append.ok", {
      requestId,
      seq,
      ...(fields.threadId !== undefined ? { threadId: fields.threadId } : {}),
      ...(fields.commentId !== undefined ? { commentId: fields.commentId } : {}),
    });
    return jsonResponse({ seq, event }, 201);
  }

  /** Resolve the caller to an `Author`, or undefined if neither the
   * session cookie nor the agent bearer token authenticates. */
  function identifyActor(request: Request): Author | undefined {
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    if (bearer !== undefined && auth.isAgent(bearer)) return agentActor;
    const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
    if (auth.hasSession(cookieValue)) return localActor;
    return undefined;
  }

  // ── /events branch ────────────────────────────────────────────────

  async function handleEvents(request: Request, url: URL, srv: Server<WebSocketData>, requestId: string): Promise<Response | undefined> {
    // Origin gate first, for the same reason as `/api/*`: a browser
    // page on another loopback port could otherwise open a WebSocket
    // and receive live event frames on the daemon's cookie jar
    // (WebSocket does not enforce same-origin at the socket layer).
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    const hasValidBearer = bearer !== undefined && auth.isAgent(bearer);
    const originRejection = checkOrigin(request, requestId, hasValidBearer);
    if (originRejection !== undefined) return originRejection;

    const forParam = url.searchParams.get("for");
    if (forParam === "agent") {
      if (!hasValidBearer) {
        logger.warn("events.rejected.agent-token", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text/plain; charset=utf-8");
      }
    } else {
      // `/events` accepts the session cookie or the agent token. A
      // channel client that attaches without `?for=agent` (agent side)
      // still authenticates via the bearer token.
      const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
      if (!auth.hasSession(cookieValue) && !hasValidBearer) {
        logger.warn("events.rejected.no-session", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text/plain; charset=utf-8");
      }
    }

    // Compute the resume point. `Last-Event-ID` (SSE spec) wins; then
    // `?since=`; default is 0 (send everything). Strict decimal —
    // `Number.parseInt("10abc")` returns 10 which would silently
    // accept a garbage query; a regex refuses that.
    const lastEventId = request.headers.get("last-event-id");
    const sinceParam = url.searchParams.get("since");
    const rawSince = lastEventId ?? sinceParam ?? "0";
    if (!/^[0-9]+$/.test(rawSince)) {
      return badRequest([{ code: "custom", path: ["since"], message: "invalid since" }]);
    }
    const since = Number.parseInt(rawSince, 10);
    if (!Number.isFinite(since) || since < 0 || since > Number.MAX_SAFE_INTEGER) {
      return badRequest([{ code: "custom", path: ["since"], message: "invalid since" }]);
    }

    // WebSocket upgrade branch.
    const upgrade = request.headers.get("upgrade");
    if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
      const data: WebSocketData = { since, requestId };
      const upgraded = srv.upgrade(request, { data });
      if (!upgraded) {
        return withHygiene(new Response("Upgrade Failed", { status: 426 }), "text/plain; charset=utf-8");
      }
      // Successful upgrade: Bun ignores any response we return.
      return undefined;
    }

    // SSE branch. Subscribe synchronously BEFORE returning the
    // Response so the client cannot POST an event between `fetch()`
    // resolving on their side and the subscription registering on
    // ours. Events that fire before the ReadableStream's `start`
    // callback runs are queued and flushed as the first frames.
    const encoder = new TextEncoder();
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const pending: ReviewEvent[] = [];
    let closed = false;
    const subscriber: Subscriber = {
      deliver(event: ReviewEvent): void {
        if (closed) return;
        if (sseController === undefined) {
          pending.push(event);
          return;
        }
        try {
          sseController.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          closed = true;
          throw new Error("sse-enqueue-failed");
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          sseController?.close();
        } catch {
          // Already closed.
        }
      },
    };
    const detach = bus.subscribe(subscriber);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        sseController = controller;
        // Emit a keepalive comment right away so the client's fetch()
        // resolves with the response headers before we do the (async)
        // prime; without this, some HTTP clients wait until a data
        // byte arrives before returning from `fetch()` and the test
        // race window opens between "fetch resolved" and "we
        // subscribed".
        controller.enqueue(encoder.encode(sseKeepalive()));
        // Prime with the resume slice — the client should see the
        // past before the future.
        try {
          const primer = await store.since(since);
          for (const event of primer) controller.enqueue(encoder.encode(sseFrame(event)));
        } catch (error) {
          logger.error("events.sse.prime-failed", { requestId, errorKind: (error as Error).name });
          controller.close();
          closed = true;
          detach();
          return;
        }
        // Flush anything that arrived between `bus.subscribe` and
        // `start` firing.
        for (const event of pending) controller.enqueue(encoder.encode(sseFrame(event)));
        pending.length = 0;
        keepalive = setInterval(() => {
          if (closed || sseController === undefined) return;
          try {
            sseController.enqueue(encoder.encode(sseKeepalive()));
          } catch {
            closed = true;
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        keepaliveTimers.add(keepalive);
      },
      cancel(): void {
        if (keepalive !== undefined) {
          clearInterval(keepalive);
          keepaliveTimers.delete(keepalive);
        }
        detach();
        closed = true;
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
    return withHygiene(response, undefined);
  }

  // ── static branch ─────────────────────────────────────────────────

  async function handleStatic(request: Request, url: URL, requestId: string): Promise<Response> {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      logger.warn("static.rejected.invalid-encoding", { requestId, path: url.pathname });
      return withHygiene(new Response("Bad Request", { status: 400 }), "text/plain; charset=utf-8");
    }
    const result = staticServer.resolve(decodedPath);
    if (!result.ok) {
      // Refused paths log the kind (traversal / symlink / outside /
      // invalid / not-found) so a probe shows up structured. 400 for
      // a malformed path, 404 for everything else — the response never
      // reveals whether a "symlink" or "outside" file exists.
      logger.warn("static.rejected", { requestId, path: decodedPath, errorKind: result.kind });
      const status = result.kind === "invalid" || result.kind === "traversal" ? 400 : 404;
      return withHygiene(new Response(status === 400 ? "Bad Request" : "Not Found", { status }), "text/plain; charset=utf-8");
    }
    const contentType = contentTypeForExtension(extname(result.absolutePath).toLowerCase());
    if (contentType === null) {
      // Unknown extension: refuse rather than sniff.
      logger.warn("static.rejected.mime", { requestId, path: decodedPath });
      return withHygiene(new Response("Not Found", { status: 404 }), "text/plain; charset=utf-8");
    }
    if (request.method === "HEAD") {
      const size = staticServer.size(result.absolutePath);
      return withHygiene(new Response(null, { status: 200, headers: { "content-length": String(size) } }), contentType);
    }
    const body = Bun.file(result.absolutePath);
    return withHygiene(new Response(body, { status: 200 }), contentType);
  }

  /** Attach the response-hygiene headers every response carries:
   * `X-Content-Type-Options: nosniff`, and (when the caller passed
   * one) the explicit Content-Type. The full CSP is M2 item 8 (issue
   * #22); this baseline ships now. */
  function withHygiene(response: Response, contentType: string | undefined): Response {
    response.headers.set("x-content-type-options", "nosniff");
    if (contentType !== undefined) {
      response.headers.set("content-type", contentType);
    }
    return response;
  }
}

// ── local helpers ──────────────────────────────────────────────────

/** Render `absolute` relative to `repoRoot` for logs and stdout. Falls
 * back to the absolute path when `absolute` lies outside `repoRoot`
 * (a `--dir` pointing at some other directory on disk); the caller has
 * asked us to serve that path, so hiding it in a log would be
 * worse than an absolute leak. */
function repoRelativeDisplay(repoRoot: string, absolute: string): string {
  const rel = relativePath(repoRoot, absolute);
  if (rel === "" || rel.startsWith("..")) return absolute;
  return rel.split(/[\\/]/).join("/");
}

/** Hard caps for `/api/*` request bodies. A malformed or malicious
 * caller cannot use a huge body to eat memory or fill the sqlite
 * `payload` column. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB whole request
export const MAX_COMMENT_BODY_BYTES = 65_536; // 64 KiB per comment body

/** Read the request body with a cap. Returns `{ ok: true, value }` on
 * success, `{ ok: false, kind: "too-large" | "invalid" }` on rejection.
 * `too-large` becomes a 413; `invalid` a 400. */
async function readCappedJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "too-large" | "invalid" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredLen = Number.parseInt(declared, 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      return { ok: false, kind: "too-large" };
    }
  }
  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch {
    return { ok: false, kind: "invalid" };
  }
  // Content-Length is client-controlled — belt-and-braces on the
  // actual number of bytes read.
  if (raw.byteLength > MAX_BODY_BYTES) return { ok: false, kind: "too-large" };
  const text = new TextDecoder().decode(raw);
  if (text.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "invalid" };
  }
}

/** Enforce a per-body character cap on a request that carries a
 * `body` string field (a comment body or a reply). Returns undefined
 * when clear, or a 413 Response when the body exceeds
 * MAX_COMMENT_BODY_BYTES. */
function enforceCommentBodyLimit(body: string): boolean {
  return Buffer.byteLength(body, "utf8") <= MAX_COMMENT_BODY_BYTES;
}

function jsonResponse(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function badRequest(issues: unknown): Response {
  const response = new Response(JSON.stringify({ error: "invalid-body", issues }), {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function payloadTooLarge(): Response {
  const response = new Response(JSON.stringify({ error: "payload-too-large" }), {
    status: 413,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
