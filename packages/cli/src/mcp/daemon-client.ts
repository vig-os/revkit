// Thin HTTP client for the daemon's `/api/*` surface — used by the
// MCP tools (`threads`, `reply`, `resolve`) and by the SSE
// subscriber (`event-subscriber.ts`).
//
// One class, one bearer token, `fetch` under the hood. The client
// **never** sends an `Origin` header: the daemon's Origin check
// (post-PR#36-fix) refuses a mismatched Origin on non-GET requests
// but accepts a bearer-token request with no Origin at all — which
// is exactly what we are (a subprocess without a browser
// same-origin envelope). Missing the header is not a bypass: the
// bearer token IS the credential.

/** Error thrown by DaemonClient methods on a non-OK response. The
 * caller can inspect `.status` to decide whether to retry
 * (5xx / transport) or surface the message unchanged (4xx). PR #38
 * round-3 review: a 4xx from the daemon (bad `parent_id`, invalid
 * anchor path) must NOT trigger the tool-call reconnect loop. */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "DaemonHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Configuration for one connected client. `url` is the daemon's
 * loopback origin (`http://127.0.0.1:<port>`); `agentToken` is the
 * bearer token from `.revkit/serve.json`. */
export interface DaemonClientOptions {
  readonly url: string;
  readonly agentToken: string;
  /** Test hook: swap in a stub `fetch`. Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Daemon's reply shape for `POST /api/threads` and
 * `POST /api/threads/:id/replies`: `{seq, event}`. */
export interface AppendResponse {
  readonly seq: number;
  readonly event: unknown;
}

/** Filter parameters `GET /api/threads` accepts. Mirrors
 * `ThreadFilter` in review-core but kept local so the daemon-client
 * doesn't import the whole shape. */
export interface ThreadFilterOptions {
  readonly path?: string;
  readonly status?: "open" | "resolved" | ReadonlyArray<"open" | "resolved">;
}

/** Result of `GET /api/threads`. `head` is the current log's tip
 * `seq` — a client can pass it to `/events?since=` to resume from
 * exactly that point. */
export interface ListThreadsResponse {
  readonly threads: readonly unknown[];
  readonly head: number;
}

export class DaemonClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DaemonClientOptions) {
    this.#url = stripTrailingSlashes(options.url);
    this.#token = options.agentToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Base auth headers — bearer + JSON accept. Never includes
   * `Origin` (see file header). */
  #authHeaders(extra?: Record<string, string>): HeadersInit {
    return {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
      ...(extra ?? {}),
    };
  }

  /** `GET /api/threads?path=&status=`. Server-side filter is
   * exact-match on `path`, and `status` accepts one value or a
   * comma-list. `head` from the response is a snapshot of the log's
   * tip — record it if you plan to `/events?since=` later. */
  async listThreads(filter?: ThreadFilterOptions): Promise<ListThreadsResponse> {
    const url = new URL(`${this.#url}/api/threads`);
    if (filter?.path !== undefined) url.searchParams.set("path", filter.path);
    if (filter?.status !== undefined) {
      const value = Array.isArray(filter.status) ? filter.status.join(",") : String(filter.status);
      url.searchParams.set("status", value);
    }
    const response = await this.#fetch(url.toString(), {
      method: "GET",
      headers: this.#authHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(`daemon GET /api/threads → ${response.status}`, response.status, text);
    }
    return (await response.json()) as ListThreadsResponse;
  }

  /** `POST /api/threads/:id/replies` — reply as the agent to an
   * existing thread. The daemon fills `actor` from the bearer
   * token; the caller supplies `parentId` (last comment id, or the
   * thread's first comment id when replying at the root). */
  async reply(threadId: string, parentId: string, body: string): Promise<AppendResponse> {
    const response = await this.#fetch(
      `${this.#url}/api/threads/${encodeURIComponent(threadId)}/replies`,
      {
        method: "POST",
        headers: this.#authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ parentId, body }),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/threads/${threadId}/replies → ${response.status} ${text}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as AppendResponse;
  }

  /** `POST /-/launch-code` — mint a fresh single-use launch URL
   * the agent can hand a human. The agent bearer token IS the
   * authentication; no Origin / cookie is required and none is
   * checked. Returns `{launchUrl, ttlMs}`.
   *
   * Deep-link: an optional `pathHint` is appended as `?next=` on
   * the returned URL. The DAEMON validates the value at
   * redirect-time (`safeNextRedirect` in `daemon.ts`): only a
   * same-origin single-slash relative path that resolves under
   * the served dir is honoured; anything else falls back to `/`.
   * A malformed hint is not the client's problem to filter. */
  async mintLaunchUrl(pathHint?: string): Promise<{ launchUrl: string; ttlMs: number }> {
    const response = await this.#fetch(`${this.#url}/-/launch-code`, {
      method: "POST",
      headers: this.#authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /-/launch-code → ${response.status}`,
        response.status,
        text,
      );
    }
    const parsed = (await response.json()) as { launchUrl: string; ttlMs: number };
    if (pathHint !== undefined && pathHint.length > 0) {
      const url = new URL(parsed.launchUrl);
      url.searchParams.set("next", pathHint);
      return { launchUrl: url.toString(), ttlMs: parsed.ttlMs };
    }
    return parsed;
  }

  /** `GET /api/delivered` — the derived set of comment ids that
   * have already reached the agent stream. Used by the catch-up
   * summary + the UserPromptSubmit hook to hide handover drafts /
   * quiet-mode comments (round-2 review). */
  async getDeliveredCommentIds(): Promise<readonly string[]> {
    const response = await this.#fetch(`${this.#url}/api/delivered`, {
      method: "GET",
      headers: this.#authHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon GET /api/delivered → ${response.status}`,
        response.status,
        text,
      );
    }
    const parsed = (await response.json()) as { deliveredCommentIds?: readonly string[] };
    return Array.isArray(parsed.deliveredCommentIds) ? parsed.deliveredCommentIds : [];
  }

  /** `GET /api/delivery-mode` — read the daemon's current delivery
   * mode plus batched-count and last-updated timestamp. */
  async getMode(): Promise<{
    mode: "handover" | "live" | "quiet";
    batched: number;
    lastEventMsAgo: number | null;
    updatedAt: string;
    idleFlushMs: number;
  }> {
    const response = await this.#fetch(`${this.#url}/api/delivery-mode`, {
      method: "GET",
      headers: this.#authHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon GET /api/delivery-mode → ${response.status}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as {
      mode: "handover" | "live" | "quiet";
      batched: number;
      lastEventMsAgo: number | null;
      updatedAt: string;
      idleFlushMs: number;
    };
  }

  /** `POST /api/delivery-mode` — change the mode. Returns the same
   * shape as `getMode`. */
  async setMode(mode: "handover" | "live" | "quiet"): Promise<{
    mode: "handover" | "live" | "quiet";
    batched: number;
    lastEventMsAgo: number | null;
    updatedAt: string;
    idleFlushMs: number;
  }> {
    const response = await this.#fetch(`${this.#url}/api/delivery-mode`, {
      method: "POST",
      headers: this.#authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/delivery-mode → ${response.status}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as {
      mode: "handover" | "live" | "quiet";
      batched: number;
      lastEventMsAgo: number | null;
      updatedAt: string;
      idleFlushMs: number;
    };
  }

  /** `POST /api/presence` — emit an agent-authored presence beacon
   * (state=editing | idle, optional file + line range). The daemon
   * auto-expires an `editing` beacon after `presenceTtlMs`. */
  async presence(state: "editing" | "idle", location?: { path?: string; startLine?: number; endLine?: number }): Promise<AppendResponse> {
    const body: Record<string, unknown> = { state };
    if (location?.path !== undefined) body.path = location.path;
    if (location?.startLine !== undefined) body.startLine = location.startLine;
    if (location?.endLine !== undefined) body.endLine = location.endLine;
    const response = await this.#fetch(`${this.#url}/api/presence`, {
      method: "POST",
      headers: this.#authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/presence → ${response.status}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as AppendResponse;
  }

  /** `POST /api/asks` — create a new question spec (M2 item 7,
   * story A1). Returns `{ ask, url }` where `url` is the same-origin
   * path the human opens (`/ask/<id>`). The `ttlMs` cap governs
   * when the daemon emits `ask.expired` lazily. */
  async createAsk(spec: unknown, opts: { id?: string; ttlMs?: number } = {}): Promise<{ ask: unknown; url: string }> {
    const body: Record<string, unknown> = { spec };
    if (opts.id !== undefined) body.id = opts.id;
    if (opts.ttlMs !== undefined) body.ttlMs = opts.ttlMs;
    const response = await this.#fetch(`${this.#url}/api/asks`, {
      method: "POST",
      headers: this.#authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/asks → ${response.status} ${text}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as { ask: unknown; url: string };
  }

  /** `GET /api/asks/:id` — read the current state of an ask. */
  async getAsk(id: string): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#url}/api/asks/${encodeURIComponent(id)}`,
      { method: "GET", headers: this.#authHeaders() },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon GET /api/asks/${id} → ${response.status}`,
        response.status,
        text,
      );
    }
    const parsed = (await response.json()) as { ask: unknown };
    return parsed.ask;
  }

  /** `POST /api/asks/:id/cancel`. */
  async cancelAsk(id: string, reason?: string): Promise<unknown> {
    const body = reason !== undefined ? { reason } : {};
    const response = await this.#fetch(
      `${this.#url}/api/asks/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        headers: this.#authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/asks/${id}/cancel → ${response.status} ${text}`,
        response.status,
        text,
      );
    }
    return await response.json();
  }

  /** `POST /api/publish` — write one or more source files to the
   * repo, run `revkit check` on them, re-render the affected pages
   * for < 1 s live-update, and append `doc.published` events (M2
   * item 9, story A4). The daemon is the write authority — the
   * client sends the FULL file bodies.
   *
   * The response is deliberately explicit about VISIBILITY, because
   * "published" alone would over-promise. Every path in the batch is
   * either in `rendering[]` as `{ state: "fast" }` — served from the
   * in-memory splice within the request — or as a build item naming
   * the reason a full build was scheduled instead:
   *
   *   - `fast-path-refused` (also mirrored in `refused[]` with the
   *     renderer's tag in `reason`): the source uses fenced code, an
   *     indented code block or a Starlight aside, which the fast path
   *     cannot reproduce byte-for-byte. A build is scheduled; the page
   *     refreshes when it lands. Do NOT retry.
   *   - `render-failed`: the renderer threw after check approved the
   *     source. Same visible state, different cause.
   *   - `shell-missing`: the route has no previously built page to
   *     splice into (brand-new route, or a consumer that never ran a
   *     build). The build creates it.
   *   - `data-only`: the path has no route of its own (plot spec /
   *     data file, `vocab/terms.yaml`). The plots and pages that
   *     embed it are build-time products, so a build is scheduled.
   *
   * `build.status` is `fast` only when EVERY path in the batch
   * rendered; anything else means a build is outstanding. Lifecycle
   * events (`build.requested` / `build.started` / `build.succeeded`
   * / `build.failed`) are durable log events with positive seqs, so
   * they survive an SSE reconnect and a daemon restart.
   *
   * `warning` is present when the sources landed but a `doc.published`
   * append was rejected — the build is still scheduled, so the page
   * will refresh, but the rail learned about the batch from the build
   * rather than from `doc.published`. */
  async publish(request: {
    docs: readonly { path: string; content: string }[];
    data?: readonly { path: string; content: string }[];
  }): Promise<{
    published: readonly { path: string; route?: string; revision: string }[];
    seqs: readonly number[];
    overrides: readonly { route: string; dataSrcCount: number }[];
    refused: readonly { path: string; route?: string; reason: string }[];
    generation: string;
    rendering: readonly ({
      path: string;
      route?: string;
    } & (
      | { state: "fast" }
      | {
          reason: "data-only" | "fast-path-refused" | "render-failed" | "shell-missing";
          detail?: string;
        }
    ))[];
    build: { generation: string; status: "fast" | "pending" | "running" | "succeeded" | "failed" };
    warning?: string;
  }> {
    const body: Record<string, unknown> = { docs: request.docs };
    if (request.data !== undefined) body.data = request.data;
    const response = await this.#fetch(`${this.#url}/api/publish`, {
      method: "POST",
      headers: this.#authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/publish → ${response.status} ${text}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as Awaited<ReturnType<DaemonClient["publish"]>>;
  }

  /** `POST /api/threads/:id/resolve`. */
  async resolve(threadId: string, resolution?: string): Promise<AppendResponse> {
    const body = resolution !== undefined ? { resolution } : {};
    const response = await this.#fetch(
      `${this.#url}/api/threads/${encodeURIComponent(threadId)}/resolve`,
      {
        method: "POST",
        headers: this.#authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DaemonHttpError(
        `daemon POST /api/threads/${threadId}/resolve → ${response.status} ${text}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as AppendResponse;
  }
}

/** Strip any trailing slashes from a URL. Kept as a small loop
 * rather than `.replace(/\/+$/, "")` — the regex form is linear on
 * a well-formed URL, but CodeQL flags the anchored `+` as a
 * polynomial-regex hazard on uncontrolled input. A loop makes the
 * bounded-iteration guarantee explicit. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return end === value.length ? value : value.slice(0, end);
}
