// `none` auth provider (ADR-0026). Used by the local target (today's
// loopback daemon, re-expressed behind the ADR-0026 interface) and by
// the private-VPN target in #192 — both targets where the NETWORK is
// the boundary. The provider issues a session for a SELF-DECLARED
// display name, which the attribution layer renders as unverified
// ("Name (guest)", ADR-0009 amended by ADR-0026).
//
// "Self-declared" shape: a configurable header the surface sets from
// its UI (or from a VPN peer's own identity). A missing or empty
// header falls back to the configured default name — `none`'s whole
// job is to accept a guest even when no header is set, so the "no
// anonymous fallthrough" rule of ADR-0026 applies to AUTHENTICATION
// (which `none` does not perform), not to the shape of this provider.

import type { AuthProvider, AuthRequest, AuthResult, Capability } from "./auth.ts";

/** Configuration for `createNoneAuthProvider`. */
export interface NoneAuthProviderConfig {
  /** Header carrying the self-declared display name. Defaults to
   * `x-revkit-display-name`; a VPN deployment may rename it to match
   * an existing UI field. */
  readonly displayNameHeader?: string;
  /** Default display name used when the header is missing or empty.
   * Defaults to `"guest"`. */
  readonly defaultDisplayName?: string;
  /** Capability to mint identities with. Defaults to `"comment"`: the
   * local daemon is single-user and the VPN target already trusts
   * every peer on the network, so `view` would be a surprising
   * default. */
  readonly capability?: Capability;
}

const DEFAULT_DISPLAY_NAME_HEADER = "x-revkit-display-name";
const DEFAULT_DISPLAY_NAME = "guest";

/** Create a `none` auth provider.
 *
 * @example
 *   const provider = createNoneAuthProvider();
 *   const result = await provider.authenticate({
 *     method: "GET",
 *     url: "http://127.0.0.1:12345/",
 *     headers: new Headers({ "x-revkit-display-name": "Alice" }),
 *     peer: { transport: "tcp", address: "127.0.0.1" },
 *   });
 *   // result.kind === "identity"
 *   // result.identity === { provider: "none", subject: "Alice",
 *   //                       displayName: "Alice", capability: "comment" }
 */
export function createNoneAuthProvider(
  config: NoneAuthProviderConfig = {},
): AuthProvider {
  const headerName = config.displayNameHeader ?? DEFAULT_DISPLAY_NAME_HEADER;
  const defaultName = config.defaultDisplayName ?? DEFAULT_DISPLAY_NAME;
  const capability: Capability = config.capability ?? "comment";

  return {
    id: "none",
    async authenticate(request: AuthRequest): Promise<AuthResult> {
      const raw = request.headers.get(headerName);
      const trimmed = raw === null ? "" : raw.trim();
      const displayName = trimmed.length > 0 ? trimmed : defaultName;
      return {
        kind: "identity",
        identity: {
          provider: "none",
          // The self-declared name IS the stable id `none` can offer.
          // It is unverified, as the attribution layer renders; the
          // subject exists so `identityKey` applies uniformly.
          subject: displayName,
          displayName,
          capability,
        },
      };
    },
  };
}
