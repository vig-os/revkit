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
import { mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import {
  type Author,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadFilter,
  type ThreadStatus,
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
  isSecFetchAcceptable,
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

/** A `Subscriber` backed by an SSE-shaped `ReadableStream`. Owns the
 * writer so it can push frames and keepalives. */
class SseSubscriber implements Subscriber {
  #closed = false;
  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly encoder: TextEncoder,
  ) {}
  deliver(event: ReviewEvent): void {
    if (this.#closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(sseFrame(event)));
    } catch {
      this.#closed = true;
      throw new Error("sse-enqueue-failed");
    }
  }
  writeKeepalive(): void {
    if (this.#closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(sseKeepalive()));
    } catch {
      this.#closed = true;
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.controller.close();
    } catch {
      // Already closed.
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
  const sqlitePath = options.sqlitePath ?? `${options.repoRoot}/.revkit/threads.sqlite`;
  if (sqlitePath !== ":memory:") {
    mkdirSync(dirname(sqlitePath), { recursive: true });
  }
  const store = SqliteThreadStore.open({ filename: sqlitePath });
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

  const state: ServeState = {
    pid: process.pid,
    port,
    url: boundUrl,
    agentToken,
    startedAt: new Date().toISOString(),
    version: options.version,
  };
  const writeResult = writeServeState(options.repoRoot, state);
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

  logger.info("serve.start", {
    pid: process.pid,
    port,
    dir: options.dir,
    version: options.version,
  });

  if (options.announce === true) {
    // Kept short and body-free: the launch URL and the fact that an
    // agent token file exists (mode 600) — not the token value.
    process.stdout.write(
      `revkit serve: listening on ${boundUrl}\n` +
        `  serve on: ${options.dir}\n` +
        `  launch:   ${launchUrl}   (single-use, expires in 60s)\n` +
        `  agent token in ${options.repoRoot}/.revkit/serve.json (mode 600)\n`,
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

    // Non-GET/HEAD requests: enforce Origin + Sec-Fetch-Site.
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (!isLoopbackOrigin(origin, port)) {
        logger.warn("request.rejected.origin", { requestId, origin: origin ?? "" });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
      const sfs = request.headers.get("sec-fetch-site");
      if (!isSecFetchAcceptable(sfs)) {
        logger.warn("request.rejected.sec-fetch", { requestId, reason: sfs ?? "" });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text/plain; charset=utf-8");
      }
    }

    // Launch-code exchange. GET only; the redirect strips the code.
    if (method === "GET" && url.pathname === "/-/auth") {
      return handleAuthExchange(url, requestId);
    }

    // `/events` — SSE by default, WebSocket on upgrade.
    if (url.pathname === "/events") {
      if (method !== "GET") return methodNotAllowed();
      return handleEvents(request, url, srv, requestId);
    }

    // JSON API. Everything under `/api/` requires either the session
    // cookie or the agent bearer token.
    if (url.pathname === "/api/threads" || url.pathname.startsWith("/api/threads/")) {
      return handleApi(request, url, method, requestId);
    }

    // Static files. GET / HEAD only.
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
    return handleStatic(request, url, requestId);
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
          .filter((s) => s.length > 0) as ThreadStatus[];
        if (parts.length === 1) filter.status = parts[0];
        else if (parts.length > 1) filter.status = parts;
      }
      const threads = await store.threads(filter);
      return jsonResponse({ threads, head: store.head() });
    }

    // POST /api/threads
    if (url.pathname === "/api/threads" && method === "POST") {
      const body = await parseJsonBody(request);
      const parsed = createThreadRequestSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues);
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
      const threadId = decodeURIComponent(match[1] ?? "");
      const kind = match[2];
      const body = await parseJsonBody(request);
      if (kind === "replies") {
        const parsed = replyRequestSchema.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.issues);
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
    const forParam = url.searchParams.get("for");
    if (forParam === "agent") {
      const bearer = bearerFromHeader(request.headers.get("authorization"));
      if (bearer === undefined || !auth.isAgent(bearer)) {
        logger.warn("events.rejected.agent-token", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text/plain; charset=utf-8");
      }
    } else {
      // `/events` accepts the session cookie or the agent token. A
      // channel client that attaches without `?for=agent` (agent side)
      // still authenticates via the bearer token.
      const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
      const bearer = bearerFromHeader(request.headers.get("authorization"));
      if (!auth.hasSession(cookieValue) && !auth.isAgent(bearer)) {
        logger.warn("events.rejected.no-session", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text/plain; charset=utf-8");
      }
    }

    // Compute the resume point. `Last-Event-ID` (SSE spec) wins; then
    // `?since=`; default is 0 (send everything).
    const lastEventId = request.headers.get("last-event-id");
    const sinceParam = url.searchParams.get("since");
    const rawSince = lastEventId ?? sinceParam ?? "0";
    const since = Number.parseInt(rawSince, 10);
    if (!Number.isFinite(since) || since < 0) {
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

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
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
