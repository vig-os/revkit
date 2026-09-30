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
    this.#url = options.url.replace(/\/+$/, "");
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
      throw new Error(`daemon GET /api/threads → ${response.status}`);
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
      throw new Error(`daemon POST /api/threads/${threadId}/replies → ${response.status} ${text}`);
    }
    return (await response.json()) as AppendResponse;
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
      throw new Error(`daemon POST /api/threads/${threadId}/resolve → ${response.status} ${text}`);
    }
    return (await response.json()) as AppendResponse;
  }
}
