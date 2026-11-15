// Auth-provider interface (ADR-0026). Runtime-neutral so one shape runs
// in the Bun daemon (`revkit serve`), in the Linux-host executable
// behind a trusted proxy (#195), in the hosted Cloudflare Worker (D2),
// and in whatever target lands later.
//
// Four rules the ADR fixes and this module implements:
//   1. `AuthRequest` is method + URL + headers + the transport peer
//      address, and nothing else. A provider does not read globals,
//      cookies parsed elsewhere, or a secondary subsystem.
//   2. `AuthResult` is either an `Identity` the surface may act on,
//      or a `refused` with a stable reason code and HTTP status.
//   3. Exactly one provider is configured per deployment; a provider
//      that cannot positively establish an identity MUST refuse — no
//      anonymous fallthrough.
//   4. Subjects are namespaced by provider id. `identityKey` is the
//      one way to compare two identities, and the "AC 4 provider
//      namespacing" test pins that rule.
//
// Providers in core: `none` (`auth-none.ts`, local + VPN targets) and
// `trusted-proxy` (`auth-trusted-proxy.ts`, Linux-host target).
// `site-token` and `cloudflare-access` are later sub-issues of #195.

/** Capability of an authenticated identity. `view` cannot write,
 * `comment` can; ADR-0026 adds no role system. Set per-identity so one
 * provider can mint `view` or `comment` on different inputs. */
export type Capability = "view" | "comment";

/** Transport the request arrived on. ADR-0026 §"Plain Linux host / VM"
 * makes this load-bearing: `trusted-proxy` picks between filesystem-
 * permission trust (unix socket, no IP) and a peer-address allowlist
 * (TCP, the connection's peer, NEVER `X-Forwarded-For`). */
export type AuthRequestPeer =
  | { readonly transport: "unix" }
  | { readonly transport: "tcp"; readonly address: string };

/** Everything a provider is allowed to see about a request. Any field
 * a future surface needs must appear here, not slip in through a side
 * channel. */
export interface AuthRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly peer: AuthRequestPeer;
}

/** The identity a provider established. `provider` + `subject` are the
 * identity; `displayName` is for rendering only. The ADR-0026 rule
 * "two providers never merge" is enforced by `identityKey`. */
export interface Identity {
  /** Equal to `AuthProvider.id` that minted it. Namespaces `subject`. */
  readonly provider: string;
  /** Stable id from the provider (never an email or a mutable display
   * name): a login, a token-scoped guest id, a proxy-asserted subject. */
  readonly subject: string;
  /** Human-readable name for rendering. The attribution layer mirrors
   * this to GitHub as "Name (guest)" for any non-GitHub identity
   * (ADR-0009 amended by ADR-0026); such a line cannot count as an
   * approval. */
  readonly displayName: string;
  readonly capability: Capability;
}

/** Why a provider refused a request. `status` is the HTTP status the
 * surface should return; `reason` is a stable machine-readable code
 * safe for logs; `message` is optional operator prose and MUST NOT
 * reflect user-supplied input. */
export interface AuthRefusal {
  readonly reason: AuthRefusalReason;
  readonly status: 401 | 403;
  readonly message?: string;
}

/** Stable refusal codes, matching ADR-0026 §"Plain Linux host / VM"
 * → Identity:
 *   - `untrusted-peer` (403) — the TCP peer is outside the list, or
 *     the transport does not match the configured trust. An empty
 *     peer list is a construction-time error in `trusted-proxy`, not
 *     a runtime refusal, so there is no separate "no trust
 *     configured" reason code.
 *   - `missing-subject` (401) — the peer is trusted but the subject
 *     header is missing or empty.
 * Future providers extend this union. */
export type AuthRefusalReason =
  | "untrusted-peer"
  | "missing-subject";

export type AuthResult =
  | { readonly kind: "identity"; readonly identity: Identity }
  | { readonly kind: "refused"; readonly reason: AuthRefusal };

/** An auth provider turns one request into an identity or a refusal.
 * MUST NOT throw on an unauthenticated request — refusal is an
 * ordinary return value, so the call site stays linear. */
export interface AuthProvider {
  /** Stable provider id, embedded in every `Identity` it mints. */
  readonly id: string;
  authenticate(request: AuthRequest): Promise<AuthResult>;
}

/** Provider ids embedded in `Identity.provider` must be a short
 * kebab-case token so `identityKey` is collision-free with a plain
 * `:` separator — otherwise `a:b` + `c` would collide with `a` + `b:c`.
 * The in-core providers (`none`, `trusted-proxy`) match; a provider
 * added later must match too, and the exported constant is the one
 * place that rule is stated. */
export const PROVIDER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Comparable key enforcing ADR-0026's "two providers never merge"
 * rule: the provider id is prefixed, with a colon separator, before
 * the subject. No whitespace collapse, no case folding — a provider
 * that wants case-insensitive subjects folds them before returning
 * the `Identity`. `displayName` and `capability` are not part of the
 * key: two sessions of the same person at different capabilities are
 * still the same person. Throws if the `identity.provider` field is
 * not a `PROVIDER_ID_RE` token; without that guard a provider id
 * containing `:` could manufacture a key collision with another
 * provider's subject (`a:b` + `c` vs `a` + `b:c`). */
export function identityKey(identity: Identity): string {
  if (!PROVIDER_ID_RE.test(identity.provider)) {
    throw new Error(
      `identityKey: provider id is not a kebab-case token (needed for collision-free keys): ${JSON.stringify(identity.provider)}`,
    );
  }
  return `${identity.provider}:${identity.subject}`;
}
