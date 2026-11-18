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
 * that returns a fixed actor for tests. */
export interface IdentityResolver {
  /** Short label for structured logs (`local`, `trusted-proxy`,
   * `stub`). */
  readonly id: string;
  resolve(request: Request): Promise<IdentityResolution>;
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
 * `401`. */
export function createLocalIdentityResolver(options: LocalIdentityResolverOptions): IdentityResolver {
  const { auth, port, localActor, agentActor } = options;
  return {
    id: "local",
    async resolve(request: Request): Promise<IdentityResolution> {
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

/** Options for the AuthProvider-backed resolver. `peer` is how the
 * resolver tells the provider which transport the request arrived on
 * (ADR-0026 `AuthRequest.peer`). Callers that cannot determine the
 * peer per request may pass a constant (e.g. the unix socket of the
 * host listener). */
export interface AuthProviderIdentityResolverOptions {
  readonly provider: AuthProvider;
  /** Peer selector: compute the transport + address from the request.
   * For a unix-socket host, return `{ transport: "unix" }`. For a
   * loopback TCP single-tenant listener, return `{ transport: "tcp",
   * address }`. The function is called per request so a dual-stack
   * listener can decide by connection, not by configuration. */
  readonly peer: (request: Request) => AuthRequestPeer;
}

/** Map an ADR-0026 `AuthProvider` onto the handler's resolver shape.
 * The minted identity becomes a `local` actor (today's write-path
 * `kind`) with `id = subject` and `displayName = identity.displayName`;
 * a refused result becomes the handler's `401` / `403` with the
 * provider's stable reason code. */
export function createAuthProviderIdentityResolver(
  options: AuthProviderIdentityResolverOptions,
): IdentityResolver {
  const { provider, peer } = options;
  return {
    id: provider.id,
    async resolve(request: Request): Promise<IdentityResolution> {
      const result = await provider.authenticate({
        method: request.method,
        url: request.url,
        headers: request.headers,
        peer: peer(request),
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
    async resolve(request: Request): Promise<IdentityResolution> {
      const refusal = options.refuse?.(request);
      if (refusal !== undefined) {
        return { kind: "refused", status: refusal.status, reason: refusal.reason };
      }
      return { kind: "ok", actor: options.actor };
    },
  };
}
