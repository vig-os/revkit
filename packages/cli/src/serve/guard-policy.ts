// Request-shape guards (ADR-0013 for local, ADR-0026 for Linux-host).
//
// The daemon's request handler enforces three request-shape rules on
// every arrival, defence in depth above the auth provider:
//
//   1. **Host allowlist.** The `Host` header must match a configured
//      allowlist. For the local daemon that's `127.0.0.1:<port>` and
//      `localhost:<port>` (ADR-0013, DNS-rebinding defence). For the
//      Linux-host target it's the configured public origin's hostname.
//      Anything else is `421 Misdirected Request`.
//
//   2. **Origin + `Sec-Fetch-Site`.** On every non-GET (and every
//      WebSocket upgrade) the `Origin` must match the allowed origins
//      list and `Sec-Fetch-Site`, when present, must be `same-origin`
//      or `none`. ADR-0013 §request shape on local; ADR-0026 §"Request
//      checks" on host.
//
//   3. **Canonicalisation.** The local daemon redirects a
//      `localhost:<port>` request to its `127.0.0.1:<port>` twin so
//      cookie scoping is stable. The host target does no such
//      canonicalisation; its single public origin IS the canonical
//      origin.
//
// The policy also carries two capabilities the dispatcher consults
// directly:
//
//   - `allowsAgentRoutes` — a non-forgeable brand set only by the
//     loopback policy factory. `assertRouteGroupsCompatibleWithPolicy`
//     keys on this, not on `policy.id`, so a bespoke policy that
//     spells its id `"loopback"` cannot reach the agent surface.
//   - `basePath` — the path prefix every request on the host target
//     must carry (ADR-0026 §"Plain Linux host / VM" sub-path
//     deployment). Empty on loopback. The dispatcher 404s requests
//     outside the prefix before routing.
//
// The handler calls through a `GuardPolicy` so that the local and
// Linux-host servers can share one dispatcher, as ADR-0026
// §"Open questions" → "Dual-listener mechanism" anticipates
// ("two servers sharing a handler"). The policy is a *pure* function
// of (configuration, request) → outcome: it does not read globals or
// mutate state, and the handler owns the response construction.

/** Outcome of a guard check. `ok` means the request is allowed to
 * proceed. A `refused` outcome carries a stable reason code (safe
 * for logs) and the HTTP status the handler should return. A
 * `redirect` outcome carries a target the handler should 307 to. */
export type GuardOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly status: 400 | 403 | 421; readonly reason: GuardRefusalReason }
  | { readonly kind: "redirect"; readonly location: string };

/** Stable reason codes a guard can return — safe for structured logs.
 * The handler maps these onto log fields and response bodies (the
 * body is always a short plain-text string; the reason code is for
 * operators, not the browser). */
export type GuardRefusalReason =
  | "host-not-allowed"
  | "ws-upgrade-not-canonical"
  | "origin-not-allowed"
  | "sec-fetch-not-allowed";

/** Inputs to the origin check. `hasValidBearer` is true when the
 * caller has already presented a valid agent bearer; a bearer caller
 * still cannot claim a cross-site browser shape (that only comes from
 * a browser that stole the bearer), so the policy refuses a foreign
 * Origin or `cross-site` / `same-site` `Sec-Fetch-Site` even with a
 * valid bearer. */
export interface OriginCheckInput {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly hasValidBearer: boolean;
}

/** The pluggable guard policy. One implementation per target:
 * `createLoopbackGuardPolicy` for the local daemon (ADR-0013) and,
 * forthcoming in #245, a public-origin policy for the Linux-host
 * target (ADR-0026). The policy is constructed once per start; the
 * handler holds a reference to it for the daemon's lifetime. */
export interface GuardPolicy {
  /** Short policy label for structured logs (`loopback`, `host`, …). */
  readonly id: string;
  /** True only when this policy was minted by `createLoopbackGuardPolicy`.
   * A spoofed `id: "loopback"` on a bespoke policy cannot forge this
   * flag — it is read-only on the returned object and set by the
   * loopback factory alone. `assertRouteGroupsCompatibleWithPolicy`
   * keys on this flag (not on `id`), so the agent-route gate stays
   * authoritative. */
  readonly allowsAgentRoutes: boolean;
  /** Path prefix every request on this target must carry; empty when
   * the target serves at `/`. The dispatcher 404s requests whose URL
   * pathname is neither `basePath` itself nor starts with
   * `basePath + "/"`. The loopback policy sets `""` (no prefix).
   * The public-origin policy derives it from the configured public
   * origin's pathname so one configuration carries both the origin
   * and the prefix without a second config field to keep in sync. */
  readonly basePath: string;
  /** Check the `Host` header. `upgrade` is the lowercased `Upgrade`
   * header value when present; some policies canonicalise GET+non-WS
   * requests and refuse a WS upgrade on a non-canonical alias
   * (local daemon's `localhost:<port>` upgrade). */
  checkHost(host: string | null, upgrade: string | null, pathname: string, search: string): GuardOutcome;
  /** Check the `Origin` header + `Sec-Fetch-Site` on every write
   * (and every WebSocket upgrade). */
  checkOrigin(input: OriginCheckInput): GuardOutcome;
  /** Origins the CSP `script-src` / `worker-src` / `connect-src` must
   * name. For the loopback policy these are the two loopback aliases;
   * for the host policy this is the configured public origin plus
   * its `ws://` or `wss://` twin.
   *
   * Kept behind the policy so the ADR-0012 / ADR-0013 CSP amendment
   * and the ADR-0026 §"Plain Linux host / VM" CSP amendment land one
   * header builder. (This field is informational on the local path —
   * `headers.ts` currently derives its origins from `port` directly;
   * #245 will route the host target's CSP through the policy.) */
  readonly cspOrigins: {
    readonly http: readonly string[];
    readonly ws: readonly string[];
  };
}

/** Options for the loopback guard policy. */
export interface LoopbackGuardPolicyOptions {
  /** Loopback port the daemon bound to. */
  readonly port: number;
}

/** Is the request's Host header one of the two loopback names for
 * `port`? DNS-rebinding defence: a public DNS record that resolves
 * to 127.0.0.1 cannot present a matching Host. The loopback policy
 * factory calls this; tests also exercise it directly. Moved here
 * from `auth.ts` so the daemon's production path and the test path
 * share one implementation (#279 round-2 blocker 2). */
export function isLoopbackHost(host: string | null, port: number): boolean {
  if (host === null) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Is the request's Origin header one of the two allowed loopback
 * origins for `port`? Applied to every non-GET request. Moved here
 * from `auth.ts` so the daemon's production path and the test path
 * share one implementation (#279 round-2 blocker 2). */
export function isLoopbackOrigin(origin: string | null, port: number): boolean {
  if (origin === null) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** Reject Sec-Fetch-Site values that are neither `same-origin` nor
 * `none`. Missing header is accepted (older browsers, non-browser
 * callers) — Origin already refuses a cross-site browser POST. Moved
 * here from `auth.ts` alongside the other request-shape helpers. */
export function isSecFetchAcceptable(secFetchSite: string | null): boolean {
  if (secFetchSite === null) return true;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

/** Create the loopback (ADR-0013) guard policy. Rules match the
 * daemon's historical inline checks byte-for-byte: `127.0.0.1:<port>`
 * and `localhost:<port>` on `Host`, with a 307 canonicalisation from
 * `localhost` to `127.0.0.1` on non-WS requests and a 421 refusal of
 * a `localhost` WS upgrade; `http://127.0.0.1:<port>` and
 * `http://localhost:<port>` on `Origin`; `same-origin` or `none` on
 * `Sec-Fetch-Site`. A bearer caller still cannot claim a cross-site
 * shape; the pre-split daemon enforced this and so does this
 * implementation. */
export function createLoopbackGuardPolicy(options: LoopbackGuardPolicyOptions): GuardPolicy {
  const port = options.port;
  const loopbackLh = `localhost:${port}`;
  const allowedOrigins = Object.freeze([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ] as const);
  const wsOrigins = Object.freeze([
    `ws://127.0.0.1:${port}`,
    `ws://localhost:${port}`,
  ] as const);
  return {
    id: "loopback",
    allowsAgentRoutes: true,
    basePath: "",
    checkHost(host, upgrade, pathname, search): GuardOutcome {
      if (!isLoopbackHost(host, port)) {
        return { kind: "refused", status: 421, reason: "host-not-allowed" };
      }
      if (host === loopbackLh) {
        // A `localhost` WS upgrade cannot follow a 307; refuse it.
        if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
          return { kind: "refused", status: 421, reason: "ws-upgrade-not-canonical" };
        }
        return { kind: "redirect", location: `http://127.0.0.1:${port}${pathname}${search}` };
      }
      return { kind: "ok" };
    },
    checkOrigin({ origin, secFetchSite, hasValidBearer }): GuardOutcome {
      const originAllowed = isLoopbackOrigin(origin, port);
      if (hasValidBearer) {
        if (origin !== null && !originAllowed) {
          return { kind: "refused", status: 403, reason: "origin-not-allowed" };
        }
        if (!isSecFetchAcceptable(secFetchSite)) {
          return { kind: "refused", status: 403, reason: "sec-fetch-not-allowed" };
        }
        return { kind: "ok" };
      }
      if (origin !== null) {
        if (!originAllowed) {
          return { kind: "refused", status: 403, reason: "origin-not-allowed" };
        }
        if (secFetchSite !== null && secFetchSite !== "same-origin") {
          return { kind: "refused", status: 403, reason: "sec-fetch-not-allowed" };
        }
        return { kind: "ok" };
      }
      if (secFetchSite === "same-origin") return { kind: "ok" };
      return { kind: "refused", status: 403, reason: "origin-not-allowed" };
    },
    cspOrigins: {
      http: allowedOrigins,
      ws: wsOrigins,
    },
  };
}

/** Options for the public-origin guard policy used by the Linux-host
 * target (#245). Kept here so the shared handler compiles today — the
 * host entry wires it up next. */
export interface PublicOriginGuardPolicyOptions {
  /** The single configured public origin (`https://review.example.com`
   * or `http://review.example.com/review`). The handler compares
   * `Host` against this origin's hostname+port and refuses any other
   * value. Writes require `Origin` equal to this exact origin
   * (scheme + host, pathname excluded; `Origin` headers do not carry
   * a path). The pathname, when present, becomes the deployment's
   * `basePath` (ADR-0026 §"Plain Linux host / VM", #195 sub-path
   * support): requests outside the prefix are 404'd before routing. */
  readonly publicOrigin: string;
  /** Additional `Host` values accepted alongside the public origin's
   * hostname. Empty by default; the vhost case uses only the public
   * origin's hostname, and the sub-path case uses the vhost's
   * hostname. The caller provides a non-empty list only when a
   * reverse proxy forwards two hostnames to one backend. */
  readonly extraAllowedHosts?: readonly string[];
}

/** Public-origin guard policy for the Linux-host target. Checks
 * `Host` against a small allowlist derived from the configured public
 * origin and refuses writes whose `Origin` differs from that origin.
 * Does NOT canonicalise — a sub-path deployment serves its one
 * canonical origin unchanged.
 *
 * Carries the deployment's `basePath` (derived from the public
 * origin's URL pathname) so the shared dispatcher can 404 requests
 * outside the sub-path. An origin spelled with no path (or `/`)
 * yields an empty basePath; `http://review.example.com/review`
 * yields `/review`. ADR-0026 §"Plain Linux host / VM" calls out
 * "Base-path support for a sub-path deployment is #195 implementation
 * scope" — the policy already carries it so #245 wires it with no
 * further config field.
 *
 * Used today by the AC2/AC3 integration tests; #245 composes it with
 * the unix-socket listener. */
export function createPublicOriginGuardPolicy(options: PublicOriginGuardPolicyOptions): GuardPolicy {
  let parsed: URL;
  try {
    parsed = new URL(options.publicOrigin);
  } catch {
    throw new Error(
      `createPublicOriginGuardPolicy: publicOrigin is not a URL: ${JSON.stringify(options.publicOrigin)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `createPublicOriginGuardPolicy: publicOrigin must be http(s): ${JSON.stringify(options.publicOrigin)}`,
    );
  }
  const originString = `${parsed.protocol}//${parsed.host}`;
  const hostHeader = parsed.host;
  const allowedHosts = new Set<string>([hostHeader, ...(options.extraAllowedHosts ?? [])]);
  const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsOrigin = `${wsScheme}//${parsed.host}`;
  // Derive the basePath from the configured origin's pathname. `/`
  // and the empty string both mean "no prefix". Trailing slashes are
  // stripped so `/review/` and `/review` collapse to the same value.
  // A path with query/fragment is a configuration error at a higher
  // layer; `URL`'s own parser would not have accepted one in host
  // position anyway. basePath never contains a trailing slash.
  const rawPath = parsed.pathname;
  const basePath =
    rawPath === "" || rawPath === "/" ? "" : rawPath.replace(/\/+$/u, "");
  return {
    id: "public-origin",
    allowsAgentRoutes: false,
    basePath,
    checkHost(host): GuardOutcome {
      if (host === null || !allowedHosts.has(host)) {
        return { kind: "refused", status: 421, reason: "host-not-allowed" };
      }
      return { kind: "ok" };
    },
    checkOrigin({ origin, secFetchSite, hasValidBearer }): GuardOutcome {
      // The host target serves one public origin: any Origin must
      // equal it. `hasValidBearer` is ignored here (the host has no
      // agent bearer — the agent surface stays loopback-only; ADR-0026
      // §"Plain Linux host / VM" → Authorization).
      void hasValidBearer;
      if (origin !== null) {
        if (origin !== originString) {
          return { kind: "refused", status: 403, reason: "origin-not-allowed" };
        }
        if (secFetchSite !== null && secFetchSite !== "same-origin") {
          return { kind: "refused", status: 403, reason: "sec-fetch-not-allowed" };
        }
        return { kind: "ok" };
      }
      if (secFetchSite === "same-origin") return { kind: "ok" };
      return { kind: "refused", status: 403, reason: "origin-not-allowed" };
    },
    cspOrigins: {
      http: Object.freeze([originString]),
      ws: Object.freeze([wsOrigin]),
    },
  };
}
