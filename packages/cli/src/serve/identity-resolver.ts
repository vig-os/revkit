// Identity resolution for the composable request handler
// (ADR-0025 one core, ADR-0026 pluggable auth).
//
// Each target resolves one request into an `Author` or a refusal
// through this interface. The daemon's call sites stay narrow:
// `identityResolver.resolve(request)` → `IdentityResolution`; the
// handler returns `401/403` on `refused`, otherwise it carries the
// `actor` through the write path.
//
// Three built-in resolvers today:
//
//   - `createLocalIdentityResolver` — wraps today's `AuthState`
//     (launch-code / session-cookie / agent-bearer flow, ADR-0013).
//     This is the local-provider wrap the #279 brief describes: the
//     `none` provider CANNOT carry the local flow by itself, because
//     today's local flow has three distinct credentials with three
//     distinct lifecycles (launch code → mint cookie; cookie →
//     authenticate browser; agent bearer → authenticate the MCP
//     bridge), and the ADR-0026 `AuthProvider.authenticate` returns a
//     single identity from headers alone. The local resolver keeps
//     the three-credential state behind `AuthState` and projects
//     exactly the `local` or `agent` actor each credential already
//     mints on today's daemon. Observable behaviour is unchanged.
//
//   - `createAuthProviderIdentityResolver` — wraps an ADR-0026
//     `AuthProvider` (e.g. `trusted-proxy` for the Linux-host target)
//     into an `IdentityResolver`. Minted identities become `local`
//     actors with `id = subject`, `displayName = identity.displayName`.
//     A `refused` becomes the handler's `401` / `403`.
//
//   - `createStaticIdentityResolver` — for AC2 tests: a resolver
//     that always returns the same actor. The test can drive the
//     thread API and SSE without spinning up a real provider.

import type { Author } from "@revkit/review-core";
import type { AuthProvider, AuthRefusal, AuthRequestPeer } from "@revkit/review-core";
import type { AuthState } from "./auth.ts";
import { bearerFromHeader, cookieName, readCookie } from "./auth.ts";

/** Outcome of identity resolution. `ok` carries the actor the write
 * path should attribute; `refused` carries the HTTP status the
 * handler should return and a stable reason code safe for logs. */
export type IdentityResolution =
  | { readonly kind: "ok"; readonly actor: Author }
  | { readonly kind: "refused"; readonly status: 401 | 403; readonly reason: string };

/** One request → one identity (or a refusal). An auth provider is a
 * resolver with a specific shape; a local resolver is a resolver
 * that composes the three local credentials; a stub is a resolver
 * that returns a fixed actor for tests.
 *
 * #245 adds the optional `peer` argument so the dispatcher can tell
 * the resolver which socket the request arrived on. The host target's
 * `trusted-proxy` provider is the whole reason: its allowlist check
 * runs on the TCP peer address (NOT `X-Forwarded-For`), and the peer
 * only becomes known once the request reaches `Bun.serve`'s fetch
 * callback. Local and static resolvers ignore the argument; it is
 * optional so existing call sites (and the resolver's own unit tests
 * that pin a constant peer at construction) stay compiling. */
export interface IdentityResolver {
  /** Short label for structured logs (`local`, `trusted-proxy`,
   * `stub`). */
  readonly id: string;
  resolve(request: Request, peer?: AuthRequestPeer): Promise<IdentityResolution>;
}

/** Options for the local identity resolver. `agentActor` is minted on
 * a valid agent bearer; `localActor` on a valid session cookie. */
export interface LocalIdentityResolverOptions {
  readonly auth: AuthState;
  readonly port: number;
  readonly localActor: Author;
  readonly agentActor: Author;
}

/** Wrap today's `AuthState` as the local target's identity resolver.
 * Matches `identifyActor`'s historical behaviour exactly: agent
 * bearer wins; session cookie is the human path; anything else is
 * `401`. The `peer` argument is accepted for interface uniformity
 * but ignored — the local target binds to loopback only, so the
 * credential IS the identity (ADR-0013). */
export function createLocalIdentityResolver(options: LocalIdentityResolverOptions): IdentityResolver {
  const { auth, port, localActor, agentActor } = options;
  return {
    id: "local",
    async resolve(request: Request, _peer?: AuthRequestPeer): Promise<IdentityResolution> {
      void _peer;
      const bearer = bearerFromHeader(request.headers.get("authorization"));
      if (bearer !== undefined && auth.isAgent(bearer)) {
        return { kind: "ok", actor: agentActor };
      }
      const cookieValue = readCookie(request.headers.get("cookie"), cookieName(port));
      if (auth.hasSession(cookieValue)) {
        return { kind: "ok", actor: localActor };
      }
      return { kind: "refused", status: 401, reason: "no-session" };
    },
  };
}

/** Options for the AuthProvider-backed resolver.
 *
 * #245 made the dispatcher's `resolve(request, peer)` call carry the
 * peer, so the construction-time `peer` function is now a FALLBACK —
 * used only when the caller (test code; a resolver run outside the
 * dispatcher) does not pass one. The dispatcher always passes one in
 * production, computed from the real `Bun.serve` socket (TCP peer
 * address, or `{transport: "unix"}` for a socket listener). This
 * closes the #281 review gap: the earlier shape forced the peer to be
 * known at resolver-construction time, which was before `Bun.serve`
 * had bound a socket, so the host target had no way to reach the real
 * peer address. */
export interface AuthProviderIdentityResolverOptions {
  readonly provider: AuthProvider;
  /** Fallback peer selector for callers that do not pass a `peer`
   * into `resolve`. Optional; when absent, a `resolve` call without
   * an explicit `peer` is a programmer error — the resolver refuses
   * with `401` / `no-peer` so a dispatcher that forgot to wire it
   * through fails loudly instead of silently handing the provider a
   * unix-socket transport it may not trust. */
  readonly peer?: (request: Request) => AuthRequestPeer;
}

/** Map an ADR-0026 `AuthProvider` onto the handler's resolver shape.
 * The minted identity becomes a `local` actor (today's write-path
 * `kind`) with `id = subject` and `displayName = identity.displayName`;
 * a refused result becomes the handler's `401` / `403` with the
 * provider's stable reason code. */
export function createAuthProviderIdentityResolver(
  options: AuthProviderIdentityResolverOptions,
): IdentityResolver {
  const { provider, peer: fallbackPeer } = options;
  return {
    id: provider.id,
    async resolve(request: Request, peer?: AuthRequestPeer): Promise<IdentityResolution> {
      const effective = peer ?? fallbackPeer?.(request);
      if (effective === undefined) {
        // Fail-closed: a dispatcher that neither passes a peer nor
        // configured a fallback cannot satisfy the provider's trust
        // check. Refusing beats guessing a transport.
        return { kind: "refused", status: 401, reason: "no-peer" };
      }
      const result = await provider.authenticate({
        method: request.method,
        url: request.url,
        headers: request.headers,
        peer: effective,
      });
      if (result.kind === "identity") {
        const actor: Author = {
          kind: "local",
          id: result.identity.subject,
          ...(result.identity.displayName !== "" ? { displayName: result.identity.displayName } : {}),
        };
        return { kind: "ok", actor };
      }
      const refusal: AuthRefusal = result.reason;
      return { kind: "refused", status: refusal.status, reason: refusal.reason };
    },
  };
}

/** Options for the static (test) identity resolver. */
export interface StaticIdentityResolverOptions {
  readonly actor: Author;
  /** Optional refusal predicate — return a refusal for specific
   * requests (e.g. "unauthenticated path only"). Defaults to always
   * returning `ok`. */
  readonly refuse?: (request: Request) => { readonly status: 401 | 403; readonly reason: string } | undefined;
}

/** A static resolver that returns a fixed actor on every request
 * (or a configured refusal per request). Intended for the AC2 tests
 * and the AC3 host-policy tests: it exercises the handler's
 * identity-dependent code paths without spinning up a provider. */
export function createStaticIdentityResolver(options: StaticIdentityResolverOptions): IdentityResolver {
  return {
    id: "stub",
    async resolve(request: Request, _peer?: AuthRequestPeer): Promise<IdentityResolution> {
      void _peer;
      const refusal = options.refuse?.(request);
      if (refusal !== undefined) {
        return { kind: "refused", status: refusal.status, reason: refusal.reason };
      }
      return { kind: "ok", actor: options.actor };
    },
  };
}
