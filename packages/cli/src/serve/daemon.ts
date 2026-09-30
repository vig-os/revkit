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
  askSchema,
  askStatusSchema,
  isValidId,
  revisionOf,
  threadStatusSchema,
  type Anchor,
  type AskFilter,
  type AskRecord,
  type Author,
  type HandoverTrigger,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadFilter,
  ThreadStoreAppendError,
} from "@revkit/review-core";
import { openDeliveryAdapter, parseMode, type DeliveryAdapter } from "./delivery-modes.ts";
import { extractMentions } from "./mentions.ts";
import { openPresenceHub, type PresenceHub, type PresenceFrame } from "./presence-hub.ts";
import { openStaticServer } from "./static-server.ts";
import { resolveAnchorSource } from "./anchor-source.ts";
import { startReanchorDaemon, type ReanchorDaemonOptions } from "./reanchor-daemon.ts";
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
import { buildRailBundle } from "../rail/bundle.ts";
import { injectRail, RAIL_CSS_PATH, RAIL_JS_PATH } from "../rail/injector.ts";
import {
  ASK_CSS_PATH,
  ASK_JS_PATH,
  renderAskPage,
} from "../ask-page/render.ts";
import { buildAskPageBundle } from "../ask-page/bundle.ts";
import { writeAskFile } from "./asks-file.ts";
import { defaultSink, makeLogger, type LineSink } from "./logger.ts";
import { acquireAndPublish, ensureRevkitDir, type ServeState } from "./serve-state.ts";
import { SqliteThreadStore } from "./sqlite-store.ts";
import {
  answerAskRequestSchema,
  cancelAskRequestSchema,
  createAskRequestSchema,
  createThreadRequestSchema,
  reopenRequestSchema,
  replyRequestSchema,
  resolveRequestSchema,
} from "./api-schemas.ts";
import { applyResponseHeaders, type HeaderContext, type ResponseKind } from "./headers.ts";
// The inline-script hash allowlist is the SAME committed set that
// `revkit check-dist` enforces: `dist-check-allowlist.json`'s
// `sha256` keys, shipped with the running revkit version. This
// follows ADR-0012's "the Worker applies the allowlist of the
// revkit version it runs, never hashes found in an artifact"
// exactly — and, on the daemon, closes the M3 hazard where a PR-
// controlled build could plant its own hashes into an artefact
// under `dist/`.
import ALLOWLIST_JSON from "../dist-check-allowlist.json" with { type: "json" };

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
  /** Test-only overrides for the re-anchoring daemon (M2 item 5b).
   * Production callers omit — the defaults (fs.watch, 300 ms file
   * debounce, 500 ms build debounce) match the ADR-0006 M2 design.
   * A test injects a shorter debounce or forces polling so the spec
   * runs in ms. */
  readonly reanchor?: Partial<
    Omit<ReanchorDaemonOptions, "store" | "bus" | "repoRoot" | "distDir" | "logger">
  >;
  /** Test-only override for the delivery-mode idle-flush window
   * (`handover` mode, M2 item 6). 0 disables the idle timer; the
   * production default (90 s) lives in `delivery-modes.ts`. */
  readonly deliveryIdleFlushMs?: number;
  /** Initial delivery mode. If set AND the log carries no
   * `delivery.mode_changed` event yet, the daemon writes one at
   * startup so the log records the reviewer's boot-time choice.
   * Production callers omit; tests pass `"live"` to exercise the
   * fan-out path without going through handover. */
  readonly deliveryMode?: "handover" | "live" | "quiet";
  /** How long a presence beacon stays live before the daemon expires
   * it. Presence events (`state: "editing"`) are broadcast to the
   * rail so the human sees "agent is editing …"; the daemon emits a
   * matching `presence.idle` at this timeout so a stalled agent
   * does not pin the badge on forever. Default: 30 s. */
  readonly presenceTtlMs?: number;
}

/** A handle on a running daemon. `stop()` is idempotent and removes
 * `.revkit/serve.json`. */
export interface DaemonHandle {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchCode: string;
  readonly launchUrl: string;
  /** Diagnostic counters from the re-anchoring service. Exposed on
   * the handle (not over HTTP) so in-process tests can drive
   * mutation checks against the file-read / pipeline-run rates
   * without adding an operator-facing endpoint that would leak
   * internal state. See `packages/cli/src/serve/reanchor-daemon.ts`.
   * (PR #45 round-3 review.) */
  readonly reanchorDiagnostics: {
    fileReadCount(): number;
    pipelineRunCount(): number;
    watchedPaths(): number;
    watchedDirs(): number;
  };
  stop(): Promise<void>;
}

/** Data attached to each WebSocket connection: which subscriber the
 * bus knows this connection as, so `close` detaches it. `audience`
 * separates the AGENT stream (channel client, `Monitor` fallback,
 * `revkit events --follow`) — which the delivery-mode state gates
 * per event — from the RAIL stream (the browser tab), which sees
 * every event unconditionally so the reviewer's own view is never
 * hidden by their delivery-mode choice. */
interface WebSocketData {
  since: number;
  requestId: string;
  audience: "agent" | "rail";
  subscriber?: Subscriber;
  detach?: () => void;
}

/** A `Subscriber` backed by a WebSocket. Its `audience` (agent or
 * rail) is what the `EventBus.publish` mask compares against; a
 * publish call with `audiences: ["rail"]` skips this subscriber
 * when its audience is `"agent"` (M2 item 6 round 2). */
class WebSocketSubscriber implements Subscriber {
  #closed = false;
  readonly audience: "agent" | "rail";
  constructor(
    private readonly ws: ServerWebSocket<WebSocketData>,
    audience: "agent" | "rail",
  ) {
    this.audience = audience;
  }
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

/** JSON body schemas for the delivery-mode surface (M2 item 6).
 * Kept at module scope so unit tests can reference them and so a
 * `superRefine`'d schema does not rebuild on every request. */
const modeChangeRequestSchema = z.object({ mode: z.string().min(1) }).strict();
const presenceRequestSchema = z
  .object({
    state: z.enum(["editing", "idle"]),
    path: z.string().min(1).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const startSet = value.startLine !== undefined;
    const endSet = value.endLine !== undefined;
    if (startSet !== endSet) {
      ctx.addIssue({
        code: "custom",
        path: [startSet ? "endLine" : "startLine"],
        message: "presence: startLine and endLine must be set together.",
      });
    } else if (startSet && (value.endLine ?? 0) < (value.startLine ?? 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "presence: endLine must be >= startLine.",
      });
    }
  });

/** Start the daemon. Returns a handle whose `stop()` is idempotent. */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const logger = makeLogger({ sink: options.logSink ?? defaultSink() });
  const requestedPort = options.port ?? 0;

  // `.revkit/` mode is owned by `ensureRevkitDir` in serve-state.ts
  // (one owner, one place — round-4 review nit). Call it here so the
  // sqlite file's parent exists before `SqliteThreadStore.open`,
  // even if the caller passed a custom sqlite path outside `.revkit/`.
  const sqlitePath = options.sqlitePath ?? `${options.repoRoot}/.revkit/threads.sqlite`;
  if (sqlitePath !== ":memory:") {
    ensureRevkitDir(options.repoRoot);
    // If the caller supplied a non-standard sqlitePath outside
    // `.revkit/`, still guarantee its parent exists (mode default).
    if (dirname(sqlitePath) !== `${options.repoRoot}/.revkit`) {
      mkdirSync(dirname(sqlitePath), { recursive: true });
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

  // Re-anchoring daemon (M2 item 5b, story A8). Watches anchored
  // source files + the site's `dist` for changes, re-runs the
  // review-core pipeline for every open/orphaned thread whose file
  // moved, and appends `thread.reanchored`/`thread.orphaned`
  // events. Also serves the lazy trigger the request path calls
  // from `/api/threads` and `/events` catch-up. Watches use
  // `fs.watch` with a polling fallback (WSL, containerised bind
  // mounts). See `reanchor-daemon.ts`.
  const reanchor = startReanchorDaemon({
    store,
    bus,
    repoRoot: options.repoRoot,
    distDir: options.dir,
    logger,
    ...(options.reanchor ?? {}),
  });

  // Delivery-mode adapter (ADR-0007, M2 item 6 round 2). The mode
  // and the pending batch are derived from the durable log —
  // `delivery.mode_changed` records every mode transition,
  // `handover` events record every delivery to the agent. This
  // module owns the idle-flush timer only.
  const delivery: DeliveryAdapter = openDeliveryAdapter({
    ...(options.deliveryIdleFlushMs !== undefined ? { idleFlushMs: options.deliveryIdleFlushMs } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });

  // Presence hub (M2 item 6 round 2): EPHEMERAL broadcast. Never
  // touches the store. Fresh subscribers get the current state on
  // connect; a restart wipes all beacons (which is correct — the
  // agent is not still editing after a restart).
  const presence: PresenceHub = openPresenceHub({
    ...(options.presenceTtlMs !== undefined ? { ttlMs: options.presenceTtlMs } : {}),
    onBroadcast: (frame) => {
      // Route directly to the bus, bypassing the store. Bus
      // subscribers are typed on `ReviewEvent`, but our
      // `PresenceFrame` has the same "kind" discriminator shape
      // (minus seq) so consumers that switch on `event.kind` can
      // recognise it. The cast is safe: subscribers that only
      // read `.kind` see "presence"; subscribers that dereference
      // `.seq` on presence would be a bug regardless of typing
      // (round-2: no seq on presence). Rail + channel handle it.
      void bus.publish(frame as unknown as ReviewEvent);
    },
  });

  // Inline-script hash allowlist (ADR-0012 rule "the daemon applies
  // the allowlist of the revkit version it runs, never hashes found
  // in an artifact"): the SHA-256 hex keys in the committed
  // `dist-check-allowlist.json` — the same set `revkit check-dist`
  // enforces on disk. Read from the CLI package itself. If a served
  // dir happens to ship a `.revkit/csp-hashes.json` file, the daemon
  // IGNORES it: whoever controls the build output must not control
  // `script-src` (this is the M3 PR-preview attacker model; ADR-0013
  // amendment 2026-09-30 fixes the earlier design).
  const cspHashes: readonly string[] = Object.freeze(
    Array.from(new Set(Object.keys(ALLOWLIST_JSON.sha256 as Record<string, unknown>))).sort(),
  );
  logger.info("csp.hashes.loaded", { count: cspHashes.length });

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
  // System actor for daemon-emitted events with no human or agent
  // origin — the lazy `ask.expired` sweep, in particular. PR #52
  // review: reusing `agent` there would falsely attribute the
  // transition to the agent that raised the ask, which the
  // channel-server's actor-filter then hides as "loopback echo"
  // and never surfaces.
  const systemActor: Author = { kind: "system", id: "revkit-daemon" };

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
        return withHygiene(new Response("Internal Server Error", { status: 500 }), "text", "text/plain; charset=utf-8");
      }
    },
    websocket: {
      async open(ws) {
        const data = ws.data;
        try {
          // Lazy re-anchor trigger (M2 item 5b): a WebSocket
          // subscriber's initial prime is symmetric with the SSE
          // path — re-anchor before shipping the resume slice.
          await reanchor.refreshAll();
          const primer = await store.since(data.since);
          // Prime frames go through the SAME delivery-mode filter as
          // live fan-out for AGENT audience: an agent connecting
          // mid-handover must not see the batched human events on the
          // resume slice either — the pending set is still owed a
          // single `handover` promotion when the reviewer hands over.
          const audience = data.audience;
          const primeFilter = (event: ReviewEvent): boolean =>
            audience === "rail" ? true : delivery.shouldFanOutToAgent(event);
          for (const event of primer) {
            if (!primeFilter(event)) continue;
            ws.send(JSON.stringify(event));
          }
          // Round-2: prime the rail with the current presence state
          // so a fresh tab sees existing "agent is editing …" chips
          // without waiting for the next beacon. Agents don't need
          // to see peer beacons on connect (they only care about
          // NEW state).
          if (audience === "rail") {
            for (const frame of presence.currentStates()) {
              ws.send(JSON.stringify(frame));
            }
          }
          const subscriber = new WebSocketSubscriber(ws, audience);
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

  // Header context (ADR-0012 CSP + hygiene). Bound now that we have
  // the port. The context is IMMUTABLE for the lifetime of the
  // daemon — every response goes through `applyResponseHeaders` in
  // `withHygiene`, so nothing on disk after start can widen it.
  const headerCtx: HeaderContext = {
    port,
    inlineScriptHashes: cspHashes,
  };

  // Per-start opaque id, echoed by `GET /-/health` so a client can
  // confirm the port answers as THIS daemon, and required by
  // `serve.json`'s ownership check on shutdown.
  const instanceId = mintToken();
  const state: ServeState = {
    pid: process.pid,
    port,
    url: boundUrl,
    agentToken,
    startedAt: new Date().toISOString(),
    version: options.version,
    instanceId,
  };
  // `acquireAndPublish` (serve-state.ts) tries to take the OS-held
  // lock on `.revkit/daemon.lock` and, on success, atomically
  // writes serve.json. The lock is the single source of truth for
  // "is another daemon running" — it is fcntl-based and the kernel
  // releases it only on process exit, so a SIGSTOPped or hung
  // daemon still holds it. The returned `release()` cleans up the
  // state file (only if the on-disk `instanceId` still matches
  // ours) and drops the lock.
  const publish = acquireAndPublish(options.repoRoot, state);
  if (publish.kind === "already-running") {
    server.stop(true);
    store.close();
    staticServer.close();
    const existing = publish.state;
    const where = existing !== undefined
      ? `pid ${existing.pid}, ${existing.url}`
      : "no advertisement on disk";
    throw new Error(
      `revkit serve: another daemon holds .revkit/daemon.lock (${where}). ` +
        `Stop it, then retry.`,
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

  // Boot-time hydration (round-3). Load the full log ONCE and
  // rebuild the delivery cache from it. Every subsequent append
  // folds a single event into the cache via `delivery.ingest`.
  // If the caller supplied an `initialMode` AND the log has no
  // `delivery.mode_changed` yet, write one so the log records the
  // boot-time choice. Then re-arm the idle timer if the derived
  // batch is non-empty — a reviewer left comments in `handover`
  // mode; the daemon restarted; the drafts must still auto-flush
  // on the SAME schedule.
  const bootstrapEvents0 = await store.since(0);
  delivery.rebuildFromLog(bootstrapEvents0);
  if (options.deliveryMode !== undefined && options.deliveryMode !== delivery.currentMode()) {
    const hasChange = bootstrapEvents0.some((e) => e.kind === "delivery.mode_changed");
    if (!hasChange) {
      try {
        const seq = await store.append({
          kind: "delivery.mode_changed",
          actor: localActor,
          from: null,
          to: options.deliveryMode,
        });
        // Fold the boot event into the cache.
        const written = await store.since(seq - 1);
        const event = written.find((e) => e.seq === seq);
        if (event !== undefined) delivery.ingest(event);
      } catch (error) {
        logger.warn("delivery.boot-mode.failed", {
          errorKind: (error as Error).name,
        });
      }
    }
  }
  delivery.reconcileIdleTimer(() => {
    void flushPendingHandover("idle");
  });

  let stopped = false;
  const handle: DaemonHandle = {
    url: boundUrl,
    port,
    agentToken,
    launchCode,
    launchUrl,
    reanchorDiagnostics: {
      fileReadCount: () => reanchor.fileReadCount(),
      pipelineRunCount: () => reanchor.pipelineRunCount(),
      watchedPaths: () => reanchor.watchedPaths(),
      watchedDirs: () => reanchor.watchedDirs(),
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of keepaliveTimers) clearInterval(timer);
      keepaliveTimers.clear();
      bus.closeAll();
      // Tear down the re-anchor watchers BEFORE closing the store —
      // a fire-and-forget refresh queued mid-shutdown would
      // otherwise try to write to a closed sqlite handle.
      try {
        await reanchor.stop();
      } catch {
        // Best-effort — a failure to close a watcher never blocks shutdown.
      }
      delivery.stop();
      presence.stop();
      try {
        server.stop(true);
      } catch {
        // Server already stopping.
      }
      store.close();
      staticServer.close();
      // `publish.release()` does the ownership-checked unlink of
      // serve.json AND drops the OS-held lock. If a racing daemon
      // took over serve.json (impossible while we hold the lock,
      // but defensive), the release refuses to delete their file.
      publish.release();
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
      return withHygiene(new Response("Misdirected Request", { status: 421 }), "text", "text/plain; charset=utf-8");
    }

    // Issue #44 fix: canonicalise to `127.0.0.1:<port>`. The daemon
    // accepts both loopback aliases at the Host check (defence in
    // depth) but redirects any `localhost:<port>` request to its
    // `127.0.0.1:<port>` twin so BOTH the launch-code exchange AND
    // every subsequent request settle on ONE origin.
    //
    // Why redirect (chosen over "accept the exact origin" alone):
    //
    //   - Browsers scope cookies to a HOST, not to a port pair. If
    //     the launch happens on 127.0.0.1 and the user later opens
    //     `http://localhost:<port>/`, the browser has no cookie for
    //     `localhost` and every `/api/*` fetch from the rail returns
    //     401 — the reported bug.
    //   - Two hosts means two session cookies, two code exchanges,
    //     two mental models. Canonicalising collapses that to one.
    //   - The redirect is TEMPORARY (307), preserves method + body,
    //     and carries the query string — so a `localhost` launch URL
    //     the human typed into a bookmark still round-trips through
    //     the launch code exchange on 127.0.0.1.
    //   - CSP still lists both aliases so an already-loaded page's
    //     asset fetches never fail on the way in; the browser
    //     follows the 307 to 127.0.0.1 and loads there.
    //
    // WebSocket upgrades don't follow redirects; a `localhost` upgrade
    // would fail. In practice the rail opens `/events` from the
    // page's own origin (already canonicalised), so this is a paper
    // hazard. We refuse a `localhost` upgrade with a plain 421 rather
    // than issue a 307 the client cannot follow.
    if (hostHeader === `localhost:${port}`) {
      const upgrade = request.headers.get("upgrade");
      if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
        logger.warn("request.rejected.ws-localhost", { requestId });
        return withHygiene(
          new Response("Misdirected Request", { status: 421 }),
          "text",
          "text/plain; charset=utf-8",
        );
      }
      const location = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      const response = new Response(null, {
        status: 307,
        headers: { location },
      });
      logger.info("request.redirect.localhost-canonical", { requestId, path: url.pathname });
      return withHygiene(response, "text", undefined);
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
      return withHygiene(new Response(body, { status: 200 }), "json", "application/json; charset=utf-8");
    }

    // Fresh launch-code mint (PR #38 round-2 blocker 3). The startup
    // launch code has a 60 s TTL; an auto-started daemon (spawned
    // by `revkit mcp`) prints it to a stdout the parent ignored, so
    // no human ever sees it. This endpoint lets a caller with the
    // agent bearer mint a NEW single-use code so it can hand the
    // human a fresh URL. Bearer-authed only, exact Host check
    // already applied above, no cookie path.
    if (method === "POST" && url.pathname === "/-/launch-code") {
      const bearer = bearerFromHeader(request.headers.get("authorization"));
      if (bearer === undefined || !auth.isAgent(bearer)) {
        logger.warn("launch-code.rejected.auth", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
      }
      const minted = auth.mintLaunchCode();
      const launchUrl = `${boundUrl}/-/auth?code=${minted.value}`;
      const body = JSON.stringify({
        launchCode: minted.value,
        launchUrl,
        ttlMs: options.launchCodeTtlMs ?? 60_000,
      });
      logger.info("launch-code.minted", { requestId });
      // `kind: "auth"` adds `Cache-Control: no-store` — a fresh
      // launch code must never sit in a shared or disk cache
      // between the agent handing it to the human and the
      // human's browser exchanging it.
      return withHygiene(new Response(body, { status: 200 }), "auth", "application/json; charset=utf-8");
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

    // Delivery mode + handover + presence + delivered-set (M2 item 6,
    // ADR-0007). All share the /api/ auth + Origin discipline the
    // thread endpoints use.
    if (
      url.pathname === "/api/delivery-mode" ||
      url.pathname === "/api/handover" ||
      url.pathname === "/api/presence" ||
      url.pathname === "/api/delivered" ||
      url.pathname === "/api/pending"
    ) {
      return handleDeliveryApi(request, url, method, requestId);
    }

    // Ask JSON API (M2 item 7, story A1). Same Origin gate as threads.
    if (url.pathname === "/api/asks" || url.pathname.startsWith("/api/asks/")) {
      return handleAsksApi(request, url, method, requestId);
    }

    // `/ask/<id>` — the HTML page the human opens. Session cookie
    // required; a caller without one is redirected to `/-/auth` with
    // `next=/ask/<id>` so the launch-code flow lands them back here.
    if (url.pathname.startsWith("/ask/")) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return handleAskPage(request, url, method, requestId);
    }

    // Rail bundle — served from memory (built with `Bun.build` on
    // first request, cached forever). The rail is opt-in by the
    // page: the daemon's HTMLRewriter appends
    // `<script type="module" src="/-/rail.js"></script>` to every
    // static HTML response's `<head>`. Rail assets are public (no
    // user data), so no cookie or Origin check runs here — same
    // stance as the static branch below.
    if (url.pathname === RAIL_JS_PATH || url.pathname === RAIL_CSS_PATH) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return handleRailAsset(url, method, requestId);
    }

    // Ask page bundle — mirrors the rail asset shape. Public, no
    // cookie required (the bundle carries no user data; the answer
    // POST it makes is what the cookie / Origin gate covers).
    if (url.pathname === ASK_JS_PATH || url.pathname === ASK_CSS_PATH) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return handleAskAsset(url, method, requestId);
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
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      if (sfs !== null && sfs !== "same-origin" && sfs !== "none") {
        logger.warn("request.rejected.sec-fetch", { requestId, reason: sfs });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      return undefined;
    }

    if (origin !== null) {
      if (!isLoopbackOrigin(origin, port)) {
        logger.warn("request.rejected.origin", { requestId, origin });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      if (sfs !== null && sfs !== "same-origin") {
        logger.warn("request.rejected.sec-fetch", { requestId, reason: sfs });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
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
    return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
  }

  function methodNotAllowed(): Response {
    return withHygiene(new Response("Method Not Allowed", { status: 405 }), "text", "text/plain; charset=utf-8");
  }

  function handleAuthExchange(url: URL, requestId: string): Response {
    const code = url.searchParams.get("code") ?? "";
    if (code.length === 0) {
      logger.warn("auth.exchange.missing-code", { requestId });
      return withHygiene(new Response("Bad Request", { status: 400 }), "text", "text/plain; charset=utf-8");
    }
    const outcome = auth.exchangeLaunchCode(code);
    if (!outcome.ok) {
      logger.warn("auth.exchange.rejected", { requestId, reason: outcome.reason });
      return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
    }
    logger.info("auth.exchange.ok", { requestId });
    // Deep-link target. The MCP `review_url` tool sets `?next=<path>`
    // so the browser lands on a specific page (an ADR, a design)
    // after the login redirect. Guard against open-redirect:
    // accept `next` ONLY if it is a same-origin relative path
    // (single leading `/`, no `//`, no `\`, no scheme, no control
    // chars, resolves inside the served dir). Otherwise fall back
    // to `/`.
    const nextParam = url.searchParams.get("next");
    const location = safeNextRedirect(nextParam) ?? "/";
    const response = new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": setCookieHeader(cookieName(port), outcome.cookie),
      },
    });
    // `kind: "auth"` — the Set-Cookie response must not be cached
    // anywhere (no reverse proxy sits in front of a loopback
    // daemon, but the same policy on the host-mode Worker is the
    // point of one-source-of-truth here).
    return withHygiene(response, "auth", undefined);
  }

  /** Validate a `next=` value for the auth redirect. Returns the
   * accepted target (leading slash + optional query; fragments
   * are dropped by `URL.searchParams.get`, which decodes only the
   * query, and the query is preserved on the returned target)
   * or undefined if the value is unsafe. Rules:
   *
   *   - `next` must not be null.
   *   - After percent-decoding (which the URL parser has done for
   *     us since we read via `searchParams.get`), the value must
   *     start with a SINGLE `/`, must not start with `//` (protocol-
   *     relative), must not start with `/\` (Windows path or
   *     escape), must not contain a scheme (`:` before `/`), must
   *     not contain a backslash or a control character, and its
   *     resolved absolute path (via `staticServer.resolve`) must
   *     land under the served dir.
   *
   * Test coverage in `test/serve/launch-code.test.ts` (round-3). */
  function safeNextRedirect(next: string | null): string | undefined {
    if (next === null) return undefined;
    if (!next.startsWith("/")) return undefined;
    if (next.startsWith("//")) return undefined;
    if (next.startsWith("/\\")) return undefined;
    if (next.includes("\\")) return undefined;
    for (let i = 0; i < next.length; i++) {
      const cc = next.charCodeAt(i);
      if (cc < 0x20 || cc === 0x7f) return undefined;
    }
    // Reject a scheme-shaped prefix that URL parsing may have left
    // in an already-percent-decoded value. `javascript:` /
    // `https:` don't start with `/`; a value like
    // `/x?u=javascript:alert(1)` would still pass here because
    // we resolve on the pathname only.
    if (/^\/[a-z][a-z0-9+.-]*:/i.test(next)) return undefined;
    // Take the pathname component only — drop query / fragment
    // that a URL parser might have kept.
    const pathOnly = next.split("?")[0]!.split("#")[0]!;
    // Allow known daemon-virtual routes that do not live in the
    // static dir. Today: `/ask/<idSchema>` (M2 item 7 — the ask
    // page). The path segment must pass `isValidId` so no scary
    // characters slip through, and the tail after the id must be
    // empty (no `/ask/x/y`, no `/ask/x?...` — the query lives in
    // `next` and is preserved as `next` is what we return). This
    // is the SOLE list — the reason `safeNextRedirect` is not the
    // right place to widen to "any daemon route" is that widening
    // is the door open-redirect protection is built to close.
    const askMatch = pathOnly.match(/^\/ask\/([^/]+)$/);
    if (askMatch !== null) {
      const askId = askMatch[1] ?? "";
      if (isValidId(askId)) return next;
      return undefined;
    }
    // Resolve inside the served dir.
    const resolved = staticServer.resolve(pathOnly);
    if (!resolved.ok) return undefined;
    // Rebuild the redirect target from the (URL-safe) pathname,
    // preserving any query the caller included.
    return next;
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
      return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
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
      // Lazy re-anchor trigger (M2 item 5b): a page-load fetch is
      // the moment the human is about to look at the rail, so we
      // pay the re-anchor cost here even if the watcher missed the
      // event or the site was edited while the daemon was down.
      // Serialised per-path in `reanchor-daemon.ts`, so a repeated
      // call joins the in-flight promise.
      if (filter.path !== undefined) {
        await reanchor.refresh(filter.path);
      } else {
        await reanchor.refreshAll();
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
      // Anchor authority: the daemon (a) confirms the source file
      // exists under the repo root (containment prevents an anchor
      // to `/etc/passwd` or `../outside/file`) and (b) OVERRIDES
      // the client-supplied `revision` with `revisionOf(source)`.
      // Re-anchoring (M2 item 5) depends on the revision matching
      // the actual file bytes at thread creation, so a client
      // value (rail's textContent hash) would fail the pipeline
      // silently. PR #38 review.
      const anchorResolution = await resolveAnchorSource(parsed.data.anchor, options.repoRoot);
      if (!anchorResolution.ok) {
        return badRequest([{ code: "custom", path: ["anchor", "path"], message: anchorResolution.reason }]);
      }
      const anchorWithServerRevision: Anchor = {
        ...parsed.data.anchor,
        revision: anchorResolution.revision,
      };
      // Snapshot the source under this revision so the re-anchoring
      // pipeline (M2 item 5b) can read it back on a later rebuild.
      // Content-addressed — a second thread on the same revision is
      // an idempotent INSERT OR IGNORE. The daemon's own read path is
      // the only writer, so a hostile client cannot flood the table.
      try {
        store.putSnapshot(anchorResolution.revision, anchorResolution.source);
      } catch (error) {
        logger.warn("snapshot.put.failed", {
          requestId,
          errorKind: (error as Error).name,
        });
      }
      const threadId = parsed.data.threadId ?? randomUUID();
      const commentId = parsed.data.commentId ?? randomUUID();
      // Round-2 nit: parse mentions on the daemon at append time
      // and store them on the event so the rail renders chips
      // WITHOUT bundling a parser. `extractMentions` uses the real
      // Markdown AST — a `\@agent`, an inline `<code>`, an HTML
      // comment, an indented code block, or mismatched backticks
      // all fail to fire.
      const mentions = actor.kind === "agent" ? undefined : extractMentions(parsed.data.body).mentions;
      const input: ReviewEventInput = {
        kind: "comment.created",
        actor,
        threadId,
        commentId,
        anchor: anchorWithServerRevision,
        body: parsed.data.body,
        ...(mentions !== undefined && mentions.length > 0
          ? { mentions: mentions.map((m) => ({ ...m, range: [m.range[0], m.range[1]] as [number, number] })) }
          : {}),
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
      // Structural id check on the URL path (PR #38 review):
      // review-core's `idSchema` refuses `<`, `>`, `"`, etc.
      if (!isValidId(threadId)) {
        return badRequest([{ code: "custom", path: ["threadId"], message: "identifier fails idSchema" }]);
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
        const mentions = actor.kind === "agent" ? undefined : extractMentions(parsed.data.body).mentions;
        const input: ReviewEventInput = {
          kind: "comment.replied",
          actor,
          threadId,
          commentId,
          parentId: parsed.data.parentId,
          body: parsed.data.body,
          ...(mentions !== undefined && mentions.length > 0
            ? { mentions: mentions.map((m) => ({ ...m, range: [m.range[0], m.range[1]] as [number, number] })) }
            : {}),
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

    return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
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
    // Rehydrate the persisted event. `since(seq - 1)` returns
    // exactly the row just written.
    const events = await store.since(seq - 1);
    const event = events.find((e) => e.seq === seq);
    if (event !== undefined) {
      // Round-3: fold this event into the derived cache FIRST so
      // subsequent audit / snapshot / etc. read the fresh state.
      delivery.ingest(event);
      // Round-2 ATOMICITY: the delivery event (if any) is appended
      // FIRST, so the fan-out decision at publish time reads a log
      // that already reflects the delivery. Otherwise a
      // `comment.created` under agent-now would publish to the
      // rail-only audience because the covering `handover` event
      // is not yet on the log.
      //
      // The delivery event covers BY IDS: a comment appended
      // concurrently whose id is not in the pending snapshot here
      // stays pending.
      if (event.kind === "comment.created" || event.kind === "comment.replied") {
        if (event.actor.kind !== "agent") {
          const body = (event as { body?: string }).body ?? "";
          const scan = extractMentions(body);
          const modeSnapshot = delivery.currentMode();
          if (modeSnapshot === "live") {
            await appendDeliveryEvent([event.commentId], "live", requestId);
          } else if (scan.hasAgentNow) {
            // @agent now flushes the pending batch alongside.
            const pending = delivery.pendingCommentIds();
            const ids = new Set<string>(pending);
            ids.add(event.commentId);
            await appendDeliveryEvent([...ids], "agent-now", requestId);
          }
          // handover mode without @agent now: comment stays
          // pending. quiet: never delivered (pull-only).
        }
      }
      // NOW publish the original event with a fan-out decision
      // read from the cache.
      const audiences = auditFanOutAudiences(event);
      void bus.publish(event, { audiences });
      // Re-arm the idle timer based on the updated cache (includes
      // any delivery event we just appended).
      delivery.reconcileIdleTimer(() => {
        void flushPendingHandover("idle");
      });
    }
    // Reconcile the re-anchor watchers so a NEW thread on a NEW
    // path gets a watcher installed immediately (fire-and-forget:
    // the daemon does not block the POST response on this).
    void reanchor.reconcileWatchers();
    logger.info("api.append.ok", {
      requestId,
      seq,
      ...(fields.threadId !== undefined ? { threadId: fields.threadId } : {}),
      ...(fields.commentId !== undefined ? { commentId: fields.commentId } : {}),
    });
    return jsonResponse({ seq, event }, 201);
  }

  /** Decide which audiences receive THIS event. Reads the derived
   * cache (round-3). Rail always sees everything; agent visibility
   * follows the derived rules in the adapter. */
  function auditFanOutAudiences(event: ReviewEvent): readonly ("agent" | "rail")[] {
    const rail: ("agent" | "rail")[] = ["rail"];
    if (delivery.shouldFanOutToAgent(event)) rail.push("agent");
    return rail;
  }

  /** Append a `handover` delivery event covering `ids` under the
   * given `trigger`. The revision is the SHA-256 of a synthetic
   * "delivered:<ISO ts>" string — the log's own reference for the
   * frame, not an anchor revision. Returns the emitted event or
   * undefined on any store failure (logged). */
  async function appendDeliveryEvent(
    ids: readonly string[],
    trigger: HandoverTrigger,
    requestId: string,
  ): Promise<ReviewEvent | undefined> {
    if (ids.length === 0) return undefined;
    const revision = await revisionOf(`delivered:${new Date().toISOString()}\n`);
    const note = {
      live: "Comment pushed under live delivery.",
      "agent-now": "Batch flushed alongside an @agent-now marker.",
      handover: "Reviewer handed the batch to the agent.",
      "mode-change-flush": "Batch flushed on handover→live mode change.",
    }[trigger];
    const input: ReviewEventInput = {
      kind: "handover",
      actor: localActor,
      commentIds: [...ids],
      revision,
      trigger,
      note,
    };
    try {
      const seq = await store.append(input);
      const events = await store.since(seq - 1);
      const event = events.find((e) => e.seq === seq);
      if (event !== undefined) {
        // Fold into the cache BEFORE fan-out, so shouldFanOutToAgent
        // reads the fresh state.
        delivery.ingest(event);
        const audiences = auditFanOutAudiences(event);
        void bus.publish(event, { audiences });
      }
      logger.info("delivery.appended", { seq, count: ids.length, from: trigger });
      return event;
    } catch (error) {
      logger.warn("delivery.append.failed", {
        requestId,
        errorKind: (error as Error).name,
      });
      return undefined;
    }
  }

  /** Flush the current pending batch (derived from the log) as one
   * `handover` event with the given trigger. Cover BY IDS: the
   * pending snapshot captures ids at THIS moment; a comment
   * appended concurrently that is not in the snapshot stays
   * pending. Returns the emitted event or undefined when nothing
   * was pending. */
  async function flushPendingHandover(trigger: "handover" | "mode-change-flush" | "idle"): Promise<ReviewEvent | undefined> {
    const pending = delivery.pendingCommentIds();
    if (pending.size === 0) return undefined;
    // Map "idle" reason onto the schema's `handover` trigger — idle
    // is the reviewer implicitly handing over (they walked away).
    const effectiveTrigger: HandoverTrigger = trigger === "idle" ? "handover" : trigger;
    const requestId = "flush-" + trigger;
    return await appendDeliveryEvent([...pending], effectiveTrigger, requestId);
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

  async function handleDeliveryApi(
    request: Request,
    url: URL,
    method: string,
    requestId: string,
  ): Promise<Response> {
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    const hasValidBearer = bearer !== undefined && auth.isAgent(bearer);
    const originRejection = checkOrigin(request, requestId, hasValidBearer);
    if (originRejection !== undefined) return originRejection;

    const actor = identifyActor(request);
    if (actor === undefined) {
      logger.warn("delivery.rejected.auth", { requestId, path: url.pathname });
      return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
    }

    if (url.pathname === "/api/delivery-mode" && method === "GET") {
      // Round-3: cache read; no full-log scan.
      return jsonResponse(delivery.snapshot());
    }

    if (url.pathname === "/api/delivered" && method === "GET") {
      // Round-2: exposes the derived "delivered to agent" set so
      // the hook + catch-up summary filter to threads whose last
      // comment has actually reached the agent. Round-3 reads
      // the incremental cache.
      const ids = delivery.deliveredCommentIds();
      return jsonResponse({ deliveredCommentIds: [...ids] });
    }

    if (url.pathname === "/api/pending" && method === "GET") {
      const ids = delivery.pendingCommentIds();
      return jsonResponse({ pendingCommentIds: [...ids] });
    }

    if (url.pathname === "/api/delivery-mode" && method === "POST") {
      // Round-2 authority rule (ADR-0007 amendment):
      //   - The MCP `mode` tool does NOT expose a `set` verb, so
      //     a prompt-injected agent has no surface to flip modes.
      //   - The HTTP endpoint accepts both the reviewer's cookie
      //     AND the agent bearer — the bearer is filesystem-gated
      //     on `.revkit/serve.json` (mode 600), which is the
      //     reviewer's CLI credential too. A prompt-injected
      //     agent without filesystem read cannot obtain it.
      //   - This is documented in ADR-0007 so the trade-off is
      //     explicit: the security envelope is "local filesystem
      //     access" (not "identity of the bearer").
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) {
        return bodyRead.kind === "too-large"
          ? payloadTooLarge()
          : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      }
      const parsed = modeChangeRequestSchema.safeParse(bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      const mode = parseMode(parsed.data.mode);
      if (mode === undefined) {
        return badRequest([{ code: "custom", path: ["mode"], message: "unknown mode" }]);
      }
      const before = delivery.currentMode();
      if (mode === before) {
        // No-op — do not emit a duplicate mode_changed event.
        return jsonResponse(delivery.snapshot());
      }
      // A handover→live transition flushes the pending batch first
      // (documented, ADR-0007). handover→quiet does NOT flush: the
      // drafts stay pending and follow the "quiet: never delivered"
      // rule once the reviewer flips back OR uses @agent-now.
      if (before === "handover" && mode === "live") {
        await flushPendingHandover("mode-change-flush");
      }
      try {
        await store.append({
          kind: "delivery.mode_changed",
          actor,
          from: before,
          to: mode,
        });
      } catch (error) {
        if (error instanceof ThreadStoreAppendError) {
          return badRequest([{ code: "custom", path: [], message: error.rejection.kind }]);
        }
        throw error;
      }
      // Fan out the mode-change (rail-only per audit rules).
      // Round-3: read the just-written event by seq and fold it
      // into the cache before publishing.
      const eventsAfter = await store.since(0);
      const modeEvent = eventsAfter[eventsAfter.length - 1];
      if (modeEvent !== undefined) {
        delivery.ingest(modeEvent);
        const audiences = auditFanOutAudiences(modeEvent);
        void bus.publish(modeEvent, { audiences });
      }
      delivery.reconcileIdleTimer(() => {
        void flushPendingHandover("idle");
      });
      logger.info("delivery.mode.changed", { requestId, from: before, to: mode });
      return jsonResponse(delivery.snapshot());
    }

    if (url.pathname === "/api/handover" && method === "POST") {
      // Explicit hand-over: flush the derived pending set. Round-2
      // atomicity: covered BY IDS. A comment appended concurrently
      // whose id is not in the pending snapshot below stays pending
      // until the next flush covers it.
      const event = await flushPendingHandover("handover");
      if (event === undefined) {
        return jsonResponse({ ok: true, flushed: 0 });
      }
      const count = (event as { commentIds?: readonly string[] }).commentIds?.length ?? 0;
      return jsonResponse({ ok: true, flushed: count, event }, 201);
    }

    if (url.pathname === "/api/presence" && method === "POST") {
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) {
        return bodyRead.kind === "too-large"
          ? payloadTooLarge()
          : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      }
      const parsed = presenceRequestSchema.safeParse(bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      // Only agent-authored presence beacons matter for the "agent
      // is editing …" chip. A local caller's presence is refused
      // so the daemon does not become a signal-passer for the
      // browser to spoof.
      if (actor.kind !== "agent") {
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      // Round-2: EPHEMERAL. No store.append; the hub keeps state
      // in memory and broadcasts to /events subscribers directly.
      const frame =
        parsed.data.state === "editing"
          ? presence.editing(actor, {
              ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
              ...(parsed.data.startLine !== undefined ? { startLine: parsed.data.startLine } : {}),
              ...(parsed.data.endLine !== undefined ? { endLine: parsed.data.endLine } : {}),
            })
          : presence.idle(actor, parsed.data.path !== undefined ? { path: parsed.data.path } : undefined);
      return jsonResponse({ ok: true, frame });
    }

    return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
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
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
      }
    } else {
      // `/events` accepts the session cookie or the agent token. A
      // channel client that attaches without `?for=agent` (agent side)
      // still authenticates via the bearer token.
      const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
      if (!auth.hasSession(cookieValue) && !hasValidBearer) {
        logger.warn("events.rejected.no-session", { requestId });
        return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
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

    const audience: "agent" | "rail" = forParam === "agent" ? "agent" : "rail";

    // WebSocket upgrade branch.
    const upgrade = request.headers.get("upgrade");
    if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
      const data: WebSocketData = { since, requestId, audience };
      const upgraded = srv.upgrade(request, { data });
      if (!upgraded) {
        return withHygiene(new Response("Upgrade Failed", { status: 426 }), "text", "text/plain; charset=utf-8");
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
      audience,
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
          // Lazy re-anchor trigger (M2 item 5b): a fresh subscriber
          // (a channel client reconnecting, a page load's
          // EventSource) is a moment we can pay the re-anchor cost
          // before the first frame goes out. This is what keeps the
          // catch-up correct after a daemon restart — any file that
          // changed while the daemon was down is re-anchored here.
          await reanchor.refreshAll();
          const primer = await store.since(since);
          for (const event of primer) {
            if (
              audience === "agent" &&
              !delivery.shouldFanOutToAgent(event)
            ) {
              continue;
            }
            controller.enqueue(encoder.encode(sseFrame(event)));
          }
          // Prime the rail with current presence beacons (agent
          // stream deliberately skips these — an agent only cares
          // about NEW peer activity, not the pre-existing state).
          if (audience === "rail") {
            for (const frame of presence.currentStates()) {
              controller.enqueue(encoder.encode(sseFrame(frame as unknown as ReviewEvent)));
            }
          }
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
        // `no-cache, no-transform` is stronger than `no-store` for
        // an SSE stream: an intermediary that treats `no-store` as
        // "hold nothing" may buffer the whole response instead of
        // forwarding frames as they arrive. `applyResponseHeaders`
        // sees `kind: "sse"` and does not overwrite this value.
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
    return withHygiene(response, "sse", undefined);
  }

  // ── static branch ─────────────────────────────────────────────────

  async function handleStatic(request: Request, url: URL, requestId: string): Promise<Response> {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      logger.warn("static.rejected.invalid-encoding", { requestId, path: url.pathname });
      return withHygiene(new Response("Bad Request", { status: 400 }), "text", "text/plain; charset=utf-8");
    }
    const result = staticServer.resolve(decodedPath);
    if (!result.ok) {
      // Refused paths log the kind (traversal / symlink / outside /
      // invalid / not-found) so a probe shows up structured. 400 for
      // a malformed path, 404 for everything else — the response never
      // reveals whether a "symlink" or "outside" file exists.
      logger.warn("static.rejected", { requestId, path: decodedPath, errorKind: result.kind });
      const status = result.kind === "invalid" || result.kind === "traversal" ? 400 : 404;
      return withHygiene(new Response(status === 400 ? "Bad Request" : "Not Found", { status }), "text", "text/plain; charset=utf-8");
    }
    const contentType = contentTypeForExtension(extname(result.absolutePath).toLowerCase());
    if (contentType === null) {
      // Unknown extension: refuse rather than sniff.
      logger.warn("static.rejected.mime", { requestId, path: decodedPath });
      return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
    }
    // `kind: "html"` gets the full CSP header. SVG carries `kind:
    // "svg"` (script can run inside SVG; ADR-0012 mandates
    // `sandbox` on served SVG); XML carries `kind: "xml"` (an
    // XSLT-styled XML also renders as a document). Everything
    // else is an ordinary asset (JS chunk, CSS, image, font, JSON
    // side file, `.wasm`, `.pf_meta`); those carry NO CSP header
    // — browsers apply the embedding document's CSP to
    // subresource fetches, and a Worker's own `fetch()` would be
    // denied by an inherited `default-src 'none'`.
    const staticKind: ResponseKind = contentType.startsWith("text/html")
      ? "html"
      : contentType.startsWith("image/svg+xml")
        ? "svg"
        : contentType.startsWith("application/xml") || contentType.startsWith("text/xml")
          ? "xml"
          : "asset";
    if (request.method === "HEAD") {
      const size = staticServer.size(result.absolutePath);
      return withHygiene(new Response(null, { status: 200, headers: { "content-length": String(size) } }), staticKind, contentType);
    }
    const body = Bun.file(result.absolutePath);
    const rawResponse = withHygiene(new Response(body, { status: 200 }), staticKind, contentType);
    // Only HTML responses get the rail injected; a JS asset, CSS,
    // JSON, or image is served untouched. `injectRail` materialises
    // the body before feeding it to `HTMLRewriter` — a Bun 1.3.13
    // `Bun.file()` body handed straight to `.transform()` hangs when
    // `Bun.serve` tries to write it (the socket sits waiting on a
    // never-flushed stream). Buffering is cheap for HTML: even a
    // large Astro page is a few hundred KiB.
    if (contentType.startsWith("text/html")) {
      return await injectRail(rawResponse, {
        onOversize: (bodyBytes: number) => {
          logger.warn("static.rail.skipped-oversize", {
            requestId,
            path: decodedPath,
            bytes: bodyBytes,
          });
        },
      });
    }
    return rawResponse;
  }

  /** Serve the rail bundle (`/-/rail.js` and `/-/rail.css`). Built
   * once with `Bun.build` on first request, then held in memory for
   * the daemon's lifetime — the bundle is deterministic in the
   * package's source tree. */
  async function handleRailAsset(url: URL, method: string, requestId: string): Promise<Response> {
    let bundle;
    try {
      bundle = await buildRailBundle();
    } catch (error) {
      logger.error("rail.build.failed", { requestId, errorKind: (error as Error).name });
      return withHygiene(new Response("Internal Server Error", { status: 500 }), "text", "text/plain; charset=utf-8");
    }
    const isJs = url.pathname === RAIL_JS_PATH;
    const body = isJs ? bundle.js : bundle.css;
    const contentType = isJs ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    if (method === "HEAD") {
      return withHygiene(
        new Response(null, { status: 200, headers: { "content-length": String(body.byteLength) } }),
        "asset",
        contentType,
      );
    }
    // `body` is a `Uint8Array`; `new Response(body)` widens through
    // `BodyInit` — a cast keeps TS's stricter DOM types happy without
    // a runtime copy.
    return withHygiene(new Response(body as BodyInit, { status: 200 }), "asset", contentType);
  }

  /** Serve the `/ask/<id>` page bundle. Same shape as
   * `handleRailAsset`: build once, cache forever. */
  async function handleAskAsset(url: URL, method: string, requestId: string): Promise<Response> {
    let bundle;
    try {
      bundle = await buildAskPageBundle();
    } catch (error) {
      logger.error("ask.build.failed", { requestId, errorKind: (error as Error).name });
      return withHygiene(new Response("Internal Server Error", { status: 500 }), "text", "text/plain; charset=utf-8");
    }
    const isJs = url.pathname === ASK_JS_PATH;
    const body = isJs ? bundle.js : bundle.css;
    const contentType = isJs ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    if (method === "HEAD") {
      return withHygiene(
        new Response(null, { status: 200, headers: { "content-length": String(body.byteLength) } }),
        "asset",
        contentType,
      );
    }
    return withHygiene(new Response(body as BodyInit, { status: 200 }), "asset", contentType);
  }

  // ── /ask/<id> HTML page ─────────────────────────────────────────

  /** Parse an id out of `/ask/<id>` (no trailing path). Returns
   * undefined for any shape that is not a bare id (extra path
   * segments, missing id, malformed percent-encoding). */
  function askIdFromPath(pathname: string): string | undefined {
    if (!pathname.startsWith("/ask/")) return undefined;
    const rest = pathname.slice("/ask/".length);
    if (rest.length === 0 || rest.includes("/")) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return undefined;
    }
    return isValidId(decoded) ? decoded : undefined;
  }

  async function handleAskPage(request: Request, url: URL, method: string, requestId: string): Promise<Response> {
    void method;
    // Same-origin discipline for a page navigation is lighter than
    // for an API POST: a top-level navigation lands with
    // `Sec-Fetch-Site: none` (URL bar, launch link click, 302 from
    // `/-/auth`), and a cross-site link would be `cross-site`. We
    // refuse `cross-site` explicitly and accept `same-origin` /
    // `same-site` / `none` (or a missing header). The page's own CSP
    // (`frame-ancestors 'none'`) blocks foreign iframes; a foreign
    // page's `<a href>` following that lands here as `cross-site`
    // and is refused below. The bearer path (test client) is
    // accepted regardless.
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    const hasValidBearer = bearer !== undefined && auth.isAgent(bearer);
    const origin = request.headers.get("origin");
    const sfs = request.headers.get("sec-fetch-site");
    if (!hasValidBearer) {
      if (origin !== null && !isLoopbackOrigin(origin, port)) {
        logger.warn("ask.page.rejected.origin", { requestId, origin });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      if (sfs === "cross-site") {
        logger.warn("ask.page.rejected.sec-fetch", { requestId, reason: sfs });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
    }

    // Session cookie required for the human path. A page without a
    // cookie 302s through the launch-code exchange so a click on
    // the launch URL lands here directly. `next=` is validated at
    // redirect time (`safeNextRedirect`).
    if (!hasValidBearer) {
      const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
      if (!auth.hasSession(cookieValue)) {
        // Redirecting to `/-/auth` without a valid code would just
        // 403; instead, tell the caller which page they wanted so
        // whichever tool holds their fresh launch URL can append
        // `?next=/ask/<id>`. The rail's own login flow does the
        // same — we never mint a code on a cookie-miss because that
        // would defeat the "codes are single-use, short-lived"
        // property. Answer as 401 with a helpful hint.
        logger.warn("ask.page.rejected.no-session", { requestId, path: url.pathname });
        return withHygiene(new Response("Unauthorized — open the launch URL first.", { status: 401 }), "text", "text/plain; charset=utf-8");
      }
    }

    const id = askIdFromPath(url.pathname);
    if (id === undefined) {
      return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
    }
    const record = await loadAskWithLazyExpire(id);
    if (record === undefined) {
      return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
    }
    const html = renderAskPage(record);
    // `/-/ask.js` is added to `script-src` ONLY on this response —
    // no other HTML page allowlists the ask bundle path (PR #52
    // review). See `headers.ts::buildCspHeader`.
    return withHygiene(
      new Response(html, { status: 200 }),
      "html",
      "text/html; charset=utf-8",
      [ASK_JS_PATH],
    );
  }

  // ── /api/asks branch (M2 item 7, story A1) ──────────────────────

  /** Handle every `/api/asks*` route. Same Origin discipline as
   * `/api/threads`: the gate runs before auth so a page on another
   * loopback port cannot smuggle a cookie into a same-site call. */
  async function handleAsksApi(request: Request, url: URL, method: string, requestId: string): Promise<Response> {
    const bearer = bearerFromHeader(request.headers.get("authorization"));
    const hasValidBearer = bearer !== undefined && auth.isAgent(bearer);
    const originRejection = checkOrigin(request, requestId, hasValidBearer);
    if (originRejection !== undefined) return originRejection;

    const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
    const hasSession = auth.hasSession(cookieValue);
    if (!hasValidBearer && !hasSession) {
      logger.warn("api.asks.rejected.auth", { requestId, path: url.pathname });
      return withHygiene(new Response("Unauthorized", { status: 401 }), "text", "text/plain; charset=utf-8");
    }

    // GET /api/asks?status=
    if (url.pathname === "/api/asks" && method === "GET") {
      const filter: AskFilter = {};
      const statusParam = url.searchParams.get("status");
      if (statusParam !== null) {
        const parts = statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const parsedStatus = z.array(askStatusSchema).min(1).safeParse(parts);
        if (!parsedStatus.success) {
          return badRequest([{ code: "custom", path: ["status"], message: "invalid status value(s)" }]);
        }
        if (parsedStatus.data.length === 1) filter.status = parsedStatus.data[0];
        else filter.status = parsedStatus.data;
      }
      // Lazy expire pass — sweep pending asks past their deadline.
      // Cheap: we already reduce the log to answer the read.
      await sweepExpiredAsks();
      const asks = await store.asks(filter);
      return jsonResponse({ asks, head: store.head() });
    }

    // POST /api/asks (create) — agent bearer only
    if (url.pathname === "/api/asks" && method === "POST") {
      if (!hasValidBearer) {
        logger.warn("api.asks.create.rejected.role", { requestId });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) return bodyRead.kind === "too-large" ? payloadTooLarge() : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      const parsed = createAskRequestSchema.safeParse(bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      const askId = parsed.data.id ?? randomUUID();
      // Idempotence: refuse a client-supplied id that already
      // maps to an ask on the log. The `duplicate-ask` rejection
      // from validateNext would surface as a 400 with a machine-
      // readable kind; short-circuiting here also skips the disk
      // write.
      if ((await store.ask(askId)) !== undefined) {
        return badRequest([{ code: "custom", path: ["id"], message: "duplicate-ask" }]);
      }
      // Compute the wall-clock deadline (ms since epoch). Passed
      // in on `ask.created` so a re-derived AskRecord carries it
      // without a schema-version bump later.
      const nowMs = options.nowMs?.() ?? Date.now();
      const expiresAtMs = parsed.data.ttlMs !== undefined ? nowMs + parsed.data.ttlMs : undefined;
      const urlPath = `/ask/${askId}`;
      // PR #52 review: write the on-disk spec file AFTER the event
      // is accepted. Under the previous order, a rejected append
      // (duplicate-ask id collision, or any other 400) still left
      // the id-file on disk, and that stray then blocked every
      // future retry with ask-file-write-failed. Now we append
      // first, and on any outcome other than 201 no disk state
      // was ever created.
      const input: ReviewEventInput = {
        kind: "ask.created",
        actor: agentActor,
        askId,
        spec: parsed.data.spec,
        url: urlPath,
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      };
      const appendResponse = await appendAndReturn(input, requestId, {});
      if (appendResponse.status !== 201) return appendResponse;
      // Event accepted — persist the spec file. A failure here (a
      // full disk, a permission surprise) removes the ask from
      // the log too, so the id does not become a ghost the
      // operator has to inspect.
      try {
        writeAskFile(options.repoRoot, askId, parsed.data.spec);
      } catch (error) {
        logger.error("api.asks.create.file-failed-after-append", {
          requestId,
          askId,
          errorKind: (error as Error).name,
        });
        // PR #52 round-2 review — cancel the just-appended ask and
        // FAN THE EVENT out on `/events` like any other terminal
        // transition, so `await_answer` waiters and the rail
        // notice the ask no longer exists. Returns 500 (a
        // server-side I/O failure — the client's request was
        // well-formed) rather than a 400 with `path: ["id"]`
        // (a client shape complaint).
        try {
          const cancelSeq = await store.append({
            kind: "ask.cancelled",
            actor: systemActor,
            askId,
            reason: "file-write-failed",
          });
          const cancelEvents = await store.since(cancelSeq - 1);
          const cancelEvent = cancelEvents.find((e) => e.seq === cancelSeq);
          if (cancelEvent !== undefined) void bus.publish(cancelEvent);
        } catch {
          // Cancel is best-effort — if it also failed, the ask is
          // still on the log as pending and a subsequent read
          // will report it. Not silent: the earlier logger.error
          // has already reported the I/O failure.
        }
        return internalServerError({ error: "ask-file-write-failed" });
      }
      const record = await store.ask(askId);
      return jsonResponse({ ask: record, url: urlPath }, 201);
    }

    // Paths of shape /api/asks/:id[/answer|/cancel]
    const match = url.pathname.match(/^\/api\/asks\/([^/]+)(?:\/(answer|cancel))?$/);
    if (match === null) {
      return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
    }
    let askId: string;
    try {
      askId = decodeURIComponent(match[1] ?? "");
    } catch {
      return badRequest([{ code: "custom", path: ["askId"], message: "invalid percent-encoding" }]);
    }
    if (!isValidId(askId)) {
      return badRequest([{ code: "custom", path: ["askId"], message: "identifier fails idSchema" }]);
    }
    const action = match[2];

    // GET /api/asks/:id
    if (action === undefined && method === "GET") {
      const record = await loadAskWithLazyExpire(askId);
      if (record === undefined) {
        return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
      }
      return jsonResponse({ ask: record });
    }

    // POST /api/asks/:id/answer — cookie only (the human's role)
    if (action === "answer" && method === "POST") {
      if (hasValidBearer && !hasSession) {
        // A bearer-only caller trying to answer their own question
        // would defeat the "human answers, agent listens" split.
        logger.warn("api.asks.answer.rejected.role", { requestId, askId });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) return bodyRead.kind === "too-large" ? payloadTooLarge() : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      // Answer body size cap (defence in depth on top of the 1 MiB
      // request cap): a huge coordinate array or a runaway
      // `rank.ranking` list would fit under the request cap but is
      // still not a well-formed answer.
      if (typeof bodyRead.value === "object" && bodyRead.value !== null) {
        const raw = JSON.stringify(bodyRead.value);
        if (Buffer.byteLength(raw, "utf8") > MAX_ANSWER_BODY_BYTES) return payloadTooLarge();
      }
      const parsed = answerAskRequestSchema.safeParse(bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      // Sweep first — an answer POST that raced past an expiry
      // deadline should see the terminal state, not silently
      // succeed and then discover it lost the race after commit.
      await sweepExpiredAsks(askId);
      const input: ReviewEventInput = {
        kind: "ask.answered",
        actor: localActor,
        askId,
        answer: parsed.data.answer,
      };
      return await appendAndReturn(input, requestId, {});
    }

    // POST /api/asks/:id/cancel — bearer only (agent's role)
    if (action === "cancel" && method === "POST") {
      if (!hasValidBearer) {
        logger.warn("api.asks.cancel.rejected.role", { requestId, askId });
        return withHygiene(new Response("Forbidden", { status: 403 }), "text", "text/plain; charset=utf-8");
      }
      const bodyRead = await readCappedJsonBody(request);
      if (!bodyRead.ok) return bodyRead.kind === "too-large" ? payloadTooLarge() : badRequest([{ code: "custom", path: [], message: "invalid json" }]);
      const parsed = cancelAskRequestSchema.safeParse(bodyRead.value === undefined ? {} : bodyRead.value);
      if (!parsed.success) return badRequest(parsed.error.issues);
      const input: ReviewEventInput = {
        kind: "ask.cancelled",
        actor: agentActor,
        askId,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      };
      return await appendAndReturn(input, requestId, {});
    }

    return withHygiene(new Response("Not Found", { status: 404 }), "text", "text/plain; charset=utf-8");
  }

  /** Load one ask by id, first sweeping it for expiry so a caller
   * that hits `/api/asks/:id` after the deadline sees the terminal
   * `expired` state rather than a stale `pending`. Returns
   * undefined if the ask does not exist. */
  async function loadAskWithLazyExpire(id: string): Promise<AskRecord | undefined> {
    await sweepExpiredAsks(id);
    return await store.ask(id);
  }

  /** Sweep pending asks past their `expiresAtMs`. If `onlyId` is
   * given, only that ask is considered — the fast path for a
   * `GET /api/asks/:id` / an answer POST. Otherwise every pending
   * ask is checked, e.g. on `GET /api/asks`.
   *
   * The append that carries `ask.expired` may lose a race with a
   * concurrent `ask.answered`: `validateNext` refuses the second
   * transition with `ask-not-pending`, and we swallow that
   * rejection silently — the ask reached a terminal state, that
   * is what we wanted. Any other append error is logged. */
  async function sweepExpiredAsks(onlyId?: string): Promise<void> {
    const nowMs = options.nowMs?.() ?? Date.now();
    const candidates = onlyId !== undefined
      ? [(await store.ask(onlyId))].filter((a): a is AskRecord => a !== undefined)
      : await store.asks({ status: "pending" });
    for (const record of candidates) {
      if (record.status !== "pending") continue;
      if (record.expiresAtMs === undefined) continue;
      if (record.expiresAtMs > nowMs) continue;
      const input: ReviewEventInput = {
        kind: "ask.expired",
        actor: systemActor,
        askId: record.id,
      };
      try {
        const seq = await store.append(input);
        const events = await store.since(seq - 1);
        const event = events.find((e) => e.seq === seq);
        if (event !== undefined) void bus.publish(event);
      } catch (error) {
        if (error instanceof ThreadStoreAppendError && error.rejection.kind === "ask-not-pending") {
          // Raced against an answer / cancel — the ask reached a
          // terminal state, sweep is idempotent.
          continue;
        }
        // Anything else is real; log but do not throw so a read
        // path stays live even if the sweep hiccups.
        logger.warn("api.asks.expire.failed", {
          errorKind: (error as Error).name,
          askId: record.id,
        });
      }
    }
  }

  /** Attach the ADR-0012 response-hygiene headers (issue #22): CSP on
   * HTML, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
   * no-referrer`, the cross-origin isolation pair, a
   * `Permissions-Policy` denying the powerful features, and the
   * per-kind `Cache-Control`. `kind` selects the CSP + Cache-Control
   * shape (see `headers.ts`); `contentType` sets an explicit
   * Content-Type when the response body needs one. `extraScriptPaths`
   * (PR #52 review) — route-specific `script-src` paths added ONLY
   * to that response's CSP; today the ask-page handler passes
   * `[ASK_JS_PATH]` so the ask bundle is not allowlisted on any
   * other HTML page. */
  function withHygiene(
    response: Response,
    kind: ResponseKind,
    contentType: string | undefined,
    extraScriptPaths: readonly string[] = [],
  ): Response {
    return applyResponseHeaders(response, kind, contentType, headerCtx, extraScriptPaths);
  }

  /** JSON body from `/api/*` (writes and reads). `kind: "json"` adds
   * `Cache-Control: no-store` in addition to the hygiene triplet. */
  function jsonResponse(body: unknown, status = 200): Response {
    const response = new Response(JSON.stringify(body), { status });
    return withHygiene(response, "json", "application/json; charset=utf-8");
  }

  /** 400 body used by every request-validation path. Always JSON. */
  function badRequest(issues: unknown): Response {
    const response = new Response(JSON.stringify({ error: "invalid-body", issues }), { status: 400 });
    return withHygiene(response, "json", "application/json; charset=utf-8");
  }

  /** 413 body used by the request-size caps. */
  function payloadTooLarge(): Response {
    const response = new Response(JSON.stringify({ error: "payload-too-large" }), { status: 413 });
    return withHygiene(response, "json", "application/json; charset=utf-8");
  }

  /** 500 JSON body used by the ask-create disk-failure path — a
   * server-side I/O failure, NOT a client shape complaint. Kept
   * separate from `badRequest` so the error kind never lands
   * inside a `path: ["id"]` shape a client might parse as
   * "reject this id and use another one." PR #52 round-2 review. */
  function internalServerError(body: { readonly error: string }): Response {
    const response = new Response(JSON.stringify(body), { status: 500 });
    return withHygiene(response, "json", "application/json; charset=utf-8");
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
/** Cap on the serialised size of one answer body. The `text` answer
 * variant already caps its own field at 65,535 chars in the browser
 * form; the outer 1 MiB request cap catches oversize composites
 * (a huge `region` coordinate array, a `rank` with a runaway
 * option list). This is the wire byte cap `/api/asks/:id/answer`
 * refuses at 413. */
export const MAX_ANSWER_BODY_BYTES = 262_144; // 256 KiB

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

// `resolveAnchorSource` (server-side revision authority) and its
// counterpart `resolveSourceUnderRoot` (path-only for the M2 item 5b
// re-anchoring service) now live in `anchor-source.ts` so the
// re-anchoring service can import them without a circular dep on
// this file. Re-exported here to keep the existing test imports
// working.
export { resolveAnchorSource };
