// Route groups for the composable request handler (ADR-0025, ADR-0026).
//
// The handler is the same across the local daemon and the
// Linux-host target (#245). What differs is which routes the target
// *registers*: the local daemon exposes every route, but the host
// target must not expose the agent surface (the MCP bridge, publish,
// asks, the launch-code mint, and the `/events?for=agent` stream).
// ADR-0026 §"Plain Linux host / VM" → Authorization:
//
// > Agent routes (`/api/*`, `/events?for=agent`, agent-token
// > Authorization) are not registered on the host target at all; a
// > request on the host listener that looks like an agent call is a
// > `404`.
//
// The handler consults this record on dispatch. A false flag turns a
// group's paths into `404 Not Found` with no body work — the same
// response the server would send for any path it does not know.
//
// Agent-only route groups MUST NOT be enabled under a non-loopback
// guard policy. The handler enforces this at construction, closing
// the misconfiguration door before it could land in a running host
// server (AC3 of #279). `assertRouteGroupsCompatibleWithPolicy`
// below codifies the rule in one place so the test can pin it.

import type { GuardPolicy } from "./guard-policy.ts";

/** Which route groups the handler should answer. Setting a group to
 * `false` makes every path in it 404, including the paths the group
 * owns at nested URLs. Omission is not a default — the handler asks
 * for every key explicitly so a new route group lands with a visible
 * choice at every call site. */
export interface RouteGroups {
  /** `/-/auth` — launch-code exchange for the ADR-0013 cookie flow.
   * Local-only. The host target has no launch code; identity comes
   * from the `trusted-proxy` provider on every request. */
  readonly localAuthExchange: boolean;
  /** `POST /-/launch-code` — agent-authenticated fresh launch-code
   * mint (PR #38). Local-only; the host has no agent bearer. */
  readonly launchCodeMint: boolean;
  /** `GET /-/health` — the per-start identity probe the next
   * `revkit serve` reads. Local-only diagnostic. */
  readonly localHealth: boolean;
  /** `/events` — SSE + WebSocket live stream. Shared. The
   * `?for=agent` branch is gated by {@link agentEvents}; the rail
   * branch is covered by this flag alone. */
  readonly events: boolean;
  /** `/events?for=agent` — agent-audience branch of `/events`.
   * Local-only. ADR-0026 bars it from the host target. */
  readonly agentEvents: boolean;
  /** `/api/threads*` — the thread CRUD surface. Shared. Every target
   * serves it under its own identity. */
  readonly threadsApi: boolean;
  /** `/api/events-head` — cursor-only tip of the event log the rail
   * fetches before opening `/events`. Shared. */
  readonly eventsHeadApi: boolean;
  /** `/api/delivery-mode`, `/api/handover`, `/api/presence`,
   * `/api/delivered`, `/api/pending` — the ADR-0007 delivery-mode
   * surface. Local-only (the host has no agent bridge). */
  readonly deliveryApi: boolean;
  /** `/api/asks*` and `/ask/<id>` — the ADR-0007 ask surface.
   * Local-only. */
  readonly asks: boolean;
  /** `/api/publish` — the single publish endpoint used by the agent
   * to request a rebuild (M2 item 9). Local-only; agent-bearer
   * authenticated. */
  readonly publishApi: boolean;
  /** `/api/review*` — M3 part 2b review-mode surface. Local-only for
   * now; the GitHub review posting path is the reviewer's own `gh`
   * identity and is tied to a local worktree. */
  readonly reviewApi: boolean;
  /** `/-/rail.js` and `/-/rail.css` — the rail bundle. Shared; every
   * target that renders the reviewer UI ships it. */
  readonly railAssets: boolean;
  /** `/-/ask.js` and `/-/ask.css` — the ask-page bundle. Local-only
   * (it only exists when {@link asks} does). */
  readonly askAssets: boolean;
  /** Static-file branch for the served dir. Shared. */
  readonly staticFiles: boolean;
}

/** The local daemon's full set of routes (ADR-0013). Every group is
 * enabled; this is the historical behaviour of `revkit serve`. */
export const LOCAL_DAEMON_ROUTE_GROUPS: RouteGroups = Object.freeze({
  localAuthExchange: true,
  launchCodeMint: true,
  localHealth: true,
  events: true,
  agentEvents: true,
  threadsApi: true,
  eventsHeadApi: true,
  deliveryApi: true,
  asks: true,
  publishApi: true,
  reviewApi: true,
  railAssets: true,
  askAssets: true,
  staticFiles: true,
});

/** The Linux-host target's route set (ADR-0026 §"Plain Linux host /
 * VM" → Authorization). The agent surface is off; the thread API,
 * events (rail only), rail assets and static files are on. */
export const HOST_TARGET_ROUTE_GROUPS: RouteGroups = Object.freeze({
  localAuthExchange: false,
  launchCodeMint: false,
  localHealth: false,
  events: true,
  agentEvents: false,
  threadsApi: true,
  eventsHeadApi: true,
  deliveryApi: false,
  asks: false,
  publishApi: false,
  // Review mode stays loopback-only (the GitHub comment path is
  // bound to the reviewer's local `gh` identity + worktree).
  reviewApi: false,
  railAssets: true,
  askAssets: false,
  staticFiles: true,
});

/** Names of the route groups that reach the agent surface. If any of
 * these is true, the handler must be running under the loopback
 * policy. Kept in one place so a future route group ADR-0026 bars
 * cannot be forgotten by a new target's call site. */
export const AGENT_ONLY_ROUTE_GROUP_NAMES: readonly (keyof RouteGroups)[] = Object.freeze([
  "localAuthExchange",
  "launchCodeMint",
  "localHealth",
  "agentEvents",
  "deliveryApi",
  "asks",
  "publishApi",
  "reviewApi",
  "askAssets",
] as const);

/** Enforce the "agent-only routes require the loopback policy" rule
 * at handler construction. ADR-0026 §"Plain Linux host / VM" bars the
 * agent surface from any non-loopback target; a misconfiguration that
 * enabled it under a non-loopback policy would silently expose the
 * agent bearer flow. Throwing at construction is the single door that
 * closes the misconfiguration, not a runtime check per request.
 *
 * Returns the list of offending group names so the error message
 * names them. Throws `Error` on violation; the caller catches at a
 * policy boundary. */
export function assertRouteGroupsCompatibleWithPolicy(
  groups: RouteGroups,
  policy: GuardPolicy,
): void {
  if (policy.id === "loopback") return;
  const offenders: string[] = [];
  for (const name of AGENT_ONLY_ROUTE_GROUP_NAMES) {
    if (groups[name]) offenders.push(name);
  }
  if (offenders.length === 0) return;
  throw new Error(
    `route-groups: agent-only route group(s) ${offenders.join(", ")} cannot be enabled under guard policy ${JSON.stringify(policy.id)}. ADR-0026 bars the agent surface from any non-loopback target.`,
  );
}
