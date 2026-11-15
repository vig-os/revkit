// `trusted-proxy` auth provider (ADR-0026 §"Plain Linux host / VM").
// Verified identity on the Linux-host target comes from a reverse +
// auth proxy that terminates a browser session and sets a configured
// set of request headers naming subject (required), display name
// (optional) and groups (optional). The proxy MUST strip client-
// supplied copies before setting its own — revkit cannot verify that
// from inside, so the #195 deployment guide + end-to-end test are the
// control.
//
// Fail-closed (ADR-0026 §"Plain Linux host / VM" → Identity):
//   * empty/missing peer list with no socket refuses every request
//   * TCP request from a peer outside the list returns 403
//     `untrusted-peer` BEFORE the subject header is read, so a forged
//     header from an untrusted peer never reaches the identity step
//   * trusted peer with no subject header returns 401 `missing-subject`
//   * on TCP, only the transport peer address is consulted. The
//     provider ignores `X-Forwarded-For` entirely (not read, not
//     parsed, not even inspected to shape the refusal).
//
// Revocation: the provider holds NO state across calls. Every call to
// `authenticate` re-derives the identity, picking ADR-0026's open-
// question "re-derive per request" default — the safer one because it
// needs no revocation surface. Introducing a session later means
// landing session-binding + revocation tests at the same time.

import type {
  AuthProvider,
  AuthRequest,
  AuthRequestPeer,
  AuthResult,
  Capability,
} from "./auth.ts";

/** Header names carrying the identity assertions. No default preset is
 * shipped — the deployment picks the names its proxy sets, and the
 * #195 deployment guide lists common presets. */
export interface TrustedProxyHeaders {
  /** Required: the stable subject id. */
  readonly subject: string;
  /** Optional: the display name; falls back to the subject value. */
  readonly displayName?: string;
  /** Optional: a groups list. Not consumed in this issue — kept in the
   * config so the shape is stable when an allowed-groups gate lands
   * (#195 implementation scope, ADR-0026 §Authorization). */
  readonly groups?: string;
}

/** Peer trust: a unix socket OR a TCP peer allowlist. ADR-0026 names
 * these as alternatives; the typed union enforces "not both at once". */
export type TrustedProxyTrust =
  | { readonly kind: "unix-socket" }
  | {
      readonly kind: "peers";
      /** IPv4 or IPv6 literal addresses or CIDR ranges. An empty
       * array is rejected at construction (ADR-0026 §Identity, bullet
       * 5: "no default"). */
      readonly peers: readonly string[];
    };

export interface TrustedProxyAuthProviderConfig {
  readonly headers: TrustedProxyHeaders;
  readonly trust: TrustedProxyTrust;
  readonly capability?: Capability;
}

/** Create a `trusted-proxy` auth provider.
 *
 * @throws Error if the peer list is empty or any entry fails to parse
 *  as an IPv4/IPv6 address or CIDR. Catching these at construction
 *  turns a typo into a startup error instead of a silent fail-closed.
 */
export function createTrustedProxyAuthProvider(
  config: TrustedProxyAuthProviderConfig,
): AuthProvider {
  const subjectHeader = config.headers.subject;
  const displayHeader = config.headers.displayName;
  const capability: Capability = config.capability ?? "comment";

  let peerMatcher: ((peer: AuthRequestPeer) => boolean) | undefined;
  if (config.trust.kind === "peers") {
    if (config.trust.peers.length === 0) {
      throw new Error(
        "trusted-proxy: peers array is empty — ADR-0026 requires an explicit non-empty allowlist",
      );
    }
    const parsed: PeerRule[] = [];
    for (const entry of config.trust.peers) parsed.push(parsePeerRule(entry));
    peerMatcher = (peer) => {
      if (peer.transport !== "tcp") return false;
      for (const rule of parsed) {
        if (matchesPeerRule(peer.address, rule)) return true;
      }
      return false;
    };
  }

  return {
    id: "trusted-proxy",
    async authenticate(request: AuthRequest): Promise<AuthResult> {
      // Trust gate FIRST, header read SECOND. A forged header from an
      // untrusted peer must never reach the identity step (ADR-0026
      // §Identity, bullet 3). The provider never consults
      // `X-Forwarded-For`; `AuthRequest.peer` is the transport peer.
      if (config.trust.kind === "unix-socket") {
        if (request.peer.transport !== "unix") {
          return refuse("untrusted-peer", 403);
        }
      } else if (peerMatcher === undefined || !peerMatcher(request.peer)) {
        return refuse("untrusted-peer", 403);
      }

      const subjectRaw = request.headers.get(subjectHeader);
      const subject = subjectRaw === null ? "" : subjectRaw.trim();
      if (subject.length === 0) return refuse("missing-subject", 401);

      let displayName = subject;
      if (displayHeader !== undefined) {
        const displayRaw = request.headers.get(displayHeader);
        const trimmed = displayRaw === null ? "" : displayRaw.trim();
        if (trimmed.length > 0) displayName = trimmed;
      }

      return {
        kind: "identity",
        identity: { provider: "trusted-proxy", subject, displayName, capability },
      };
    },
  };
}

function refuse(reason: "untrusted-peer" | "missing-subject", status: 401 | 403): AuthResult {
  return { kind: "refused", reason: { reason, status } };
}

/** A parsed peer rule: a single IPv4/IPv6 literal (prefix = max bits)
 * or a CIDR range. Mixed-family matching is a miss. */
interface PeerRule {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

function parsePeerRule(entry: string): PeerRule {
  const slash = entry.indexOf("/");
  const addrPart = slash === -1 ? entry : entry.slice(0, slash);
  const prefixPart = slash === -1 ? undefined : entry.slice(slash + 1);
  const parsed = parseIpAddress(addrPart);
  if (parsed === undefined) {
    throw new Error(`trusted-proxy: not an IP address or CIDR: ${JSON.stringify(entry)}`);
  }
  const maxBits = parsed.family === 4 ? 32 : 128;
  let prefixBits = maxBits;
  if (prefixPart !== undefined) {
    if (!/^[0-9]+$/.test(prefixPart)) {
      throw new Error(`trusted-proxy: CIDR prefix is not an integer: ${JSON.stringify(entry)}`);
    }
    prefixBits = Number.parseInt(prefixPart, 10);
    if (prefixBits < 0 || prefixBits > maxBits) {
      throw new Error(
        `trusted-proxy: CIDR prefix out of range for ${parsed.family === 4 ? "IPv4" : "IPv6"}: ${JSON.stringify(entry)}`,
      );
    }
  }
  return { family: parsed.family, bytes: parsed.bytes, prefixBits };
}

function matchesPeerRule(address: string, rule: PeerRule): boolean {
  const parsed = parseIpAddress(address);
  if (parsed === undefined) return false;
  if (parsed.family !== rule.family) return false;
  const fullBytes = Math.floor(rule.prefixBits / 8);
  const remainderBits = rule.prefixBits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (parsed.bytes[i] !== rule.bytes[i]) return false;
  }
  if (remainderBits === 0) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return (parsed.bytes[fullBytes]! & mask) === (rule.bytes[fullBytes]! & mask);
}

/** Parse an IPv4 (`a.b.c.d`) or IPv6 (RFC 4291, including `::`
 * compression and dotted-quad tail) literal. `undefined` on malformed
 * input. An IPv6 zone id (`fe80::1%eth0`) is stripped — it is not
 * meaningful between hosts and a trusted peer never carries one in
 * the real request path. */
function parseIpAddress(input: string): { family: 4 | 6; bytes: Uint8Array } | undefined {
  const zoneAt = input.indexOf("%");
  const trimmed = zoneAt === -1 ? input : input.slice(0, zoneAt);
  if (trimmed.includes(":")) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

function parseIpv4(input: string): { family: 4; bytes: Uint8Array } | undefined {
  const parts = input.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    // Refuse leading zeros: `010` would parse as 10 here but mean 8
    // in a library that reads it as octal, which is the classic SSRF
    // bypass shape.
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const value = Number.parseInt(part, 10);
    if (value < 0 || value > 255) return undefined;
    bytes[i] = value;
  }
  return { family: 4, bytes };
}

function parseIpv6(input: string): { family: 6; bytes: Uint8Array } | undefined {
  const compressionIdx = input.indexOf("::");
  const hasCompression = compressionIdx !== -1;
  if (hasCompression && input.indexOf("::", compressionIdx + 1) !== -1) return undefined;

  const leftRaw = hasCompression ? input.slice(0, compressionIdx) : input;
  const rightRaw = hasCompression ? input.slice(compressionIdx + 2) : "";
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = rightRaw === "" ? [] : rightRaw.split(":");

  // IPv4-in-IPv6 dotted-quad tail: the last group of the trailing
  // segment list may be an IPv4 literal; expand in place to two 16-
  // bit hex groups. `tail` points at whichever side carries the end
  // of the address.
  const tail = right.length > 0 ? right : left;
  const tailLast = tail[tail.length - 1];
  if (tailLast !== undefined && tailLast.includes(".")) {
    const dotted = parseIpv4(tailLast);
    if (dotted === undefined) return undefined;
    const b = dotted.bytes;
    tail.pop();
    tail.push(((b[0]! << 8) | b[1]!).toString(16), ((b[2]! << 8) | b[3]!).toString(16));
  }

  const groups: string[] = [];
  groups.push(...left);
  if (hasCompression) {
    // `::` compresses one OR more zero groups. `missing === 0` means
    // there was no room for the `::` and the address is invalid.
    // `::` alone (left and right empty) is the valid all-zeros case.
    const missing = 8 - left.length - right.length;
    if (missing < 1) return undefined;
    for (let i = 0; i < missing; i++) groups.push("0");
  }
  groups.push(...right);

  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return { family: 6, bytes };
}
