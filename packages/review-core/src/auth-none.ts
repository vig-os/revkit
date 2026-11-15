// `none` auth provider (ADR-0026). Used by the local target and by
// the private-VPN target in #192 — both targets where the NETWORK is
// the boundary. The provider issues an identity for a SELF-DECLARED
// display name, which the attribution layer renders as unverified
// ("Name (guest)", ADR-0009 amended by ADR-0026). This issue does not
// rewire the loopback daemon; a later sub-issue of #195 composes the
// provider with the daemon's existing local-actor model, and the
// shape at that point is the daemon's `{ kind: "local", id,
// displayName? }` author being derived from this provider's
// `Identity` — not a pre-existing session reused unchanged.
//
// "Self-declared" shape: a configurable header the surface sets from
// its UI (or from a VPN peer's own identity). A missing or empty
// header falls back to the configured default name — `none`'s whole
// job is to accept a guest even when no header is set, so the "no
// anonymous fallthrough" rule of ADR-0026 applies to AUTHENTICATION
// (which `none` does not perform), not to the shape of this provider.
//
// Hardening (round 3, #244):
//
//   * The configured `displayNameHeader` is validated against RFC 9110
//     §5.6.2 at construction via the shared `validateHeaderName` in
//     `auth-internal.ts`. An invalid header name is a startup error,
//     so `authenticate()` keeps its "MUST NOT throw" contract from
//     `auth.ts` even when the config is wrong.
//   * The runtime header value goes through the shared
//     `sanitiseDisplayName` (same path as `trusted-proxy`): C0 / DEL /
//     C1 control characters are stripped, Unicode whitespace is
//     trimmed, and the result is capped at 256 code units. A value
//     that becomes empty after sanitisation falls back to the
//     configured default display name.

import type { AuthProvider, AuthRequest, AuthResult, Capability } from "./auth.ts";
import { sanitiseDisplayName, validateHeaderName } from "./auth-internal.ts";

/** Configuration for `createNoneAuthProvider`. */
export interface NoneAuthProviderConfig {
  /** Header carrying the self-declared display name. Defaults to
   * `x-revkit-display-name`; a VPN deployment may rename it to match
   * an existing UI field. Validated at construction against RFC 9110
   * §5.6.2 — a non-token name is a startup error. */
  readonly displayNameHeader?: string;
  /** Default display name used when the header is missing, empty, or
   * sanitises to empty. Defaults to `"guest"`. */
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
 * @throws Error if `displayNameHeader` is not an RFC 9110 §5.6.2
 *  token. Catching this at construction turns a typo into a startup
 *  error and preserves the `authenticate()` "MUST NOT throw" contract
 *  from `auth.ts`.
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
  validateHeaderName("none displayNameHeader", headerName);
  const defaultName = config.defaultDisplayName ?? DEFAULT_DISPLAY_NAME;
  const capability: Capability = config.capability ?? "comment";

  return {
    id: "none",
    async authenticate(request: AuthRequest): Promise<AuthResult> {
      const raw = request.headers.get(headerName);
      // Share the display-name sanitisation with `trusted-proxy`:
      // strip controls, trim Unicode whitespace, cap at 256 code
      // units. A header that sanitises to empty falls back to the
      // configured default — `none` accepts a guest even when no
      // header is set, so there is no refusal path here.
      const sanitised = raw === null ? undefined : sanitiseDisplayName(raw);
      const displayName = sanitised ?? defaultName;
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
