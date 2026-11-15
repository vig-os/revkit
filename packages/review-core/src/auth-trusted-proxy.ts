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
//
// Hardening (rounds 2 and 3, #244):
//
//   * Header names are validated at construction against RFC 9110
//     §5.6.2 (token) via the shared `validateHeaderName` in
//     `auth-internal.ts` — one validator across every in-core
//     provider. An invalid header name is a startup error, so
//     `authenticate()` never throws (the provider contract pins
//     refusal as the only error shape).
//   * Repeated subject header: the Fetch `Headers.get()` comma-joins
//     multiple values for one header name. A subject that contains
//     `,` is treated as repeated / malformed and refused with 401
//     `missing-subject`. A stable proxy-asserted subject never
//     contains a comma; the same rule applies to display name.
//     Groups are reserved — the header name is validated but not
//     consumed yet; when a later issue parses it (#195 allowed-
//     groups), the documented format is comma-separated tokens, so
//     the comma-refusal does not apply there.
//   * Display name: C0 (U+0000..U+001F), DEL (U+007F) and C1
//     (U+0080..U+009F) control characters are stripped, Unicode
//     whitespace is trimmed, and the result is capped at
//     `DISPLAY_NAME_MAX_CHARS` (256) code units. A value that becomes
//     empty after stripping/trimming falls back to the subject. The
//     `none` provider shares the same sanitisation via
//     `sanitiseDisplayName` (`auth-internal.ts`).
//   * IP parsing refuses `1.2.3.4::` and similar — the IPv4 dotted
//     quad is allowed ONLY as the very last 32 bits of the address
//     (RFC 4291 §2.2.3). A zone id (`%zone`) is accepted ONLY for
//     IPv6 link-local-style literals and the rule zone must match the
//     peer zone exactly; a zone id on an IPv4 address is refused.
//   * IPv4-mapped IPv6 peers (`::ffff:127.0.0.1`) are normalised to
//     their IPv4 form on both the peer side and the rule side, so a
//     rule like `127.0.0.0/8` matches an `::ffff:127.0.0.1` peer.
//   * An unparsable peer entry is a construction-time error, so a
//     typo in the allowlist is a startup failure, not a silent
//     fail-closed at runtime.
//   * CIDR prefix syntax: leading zeros are refused (`/08` would
//     otherwise be ambiguous with the IPv4 octet rule that already
//     refuses `010`). Prefix lengths with no leading zeros are
//     syntactically valid; semantic rejection of `/0` happens below.
//   * Zero-length prefixes (`0.0.0.0/0`, `::/0`,
//     `::ffff:0:0/96` → reinterpreted to `/0` in IPv4 space) are
//     refused at construction: they would trust every peer and defeat
//     the ADR-0026 §Identity fail-closed gate. An operator who
//     legitimately wants to trust every peer must say so one host at
//     a time, not with a wildcard rule.

import type {
  AuthProvider,
  AuthRequest,
  AuthRequestPeer,
  AuthResult,
  Capability,
} from "./auth.ts";
import {
  containsControlChar,
  sanitiseDisplayName,
  validateHeaderName,
} from "./auth-internal.ts";

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
   * (#195 implementation scope, ADR-0026 §Authorization). When a later
   * issue parses it, the documented wire format is a comma-separated
   * token list, so the subject's "refuse a comma" rule does not apply
   * to this header. */
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

/** Documented bound on the stripped subject header value. */
const SUBJECT_MAX_CHARS = 256;

/** Create a `trusted-proxy` auth provider.
 *
 * @throws Error if the peer list is empty; any entry fails to parse as
 *  an IPv4/IPv6 address or CIDR (including leading zeros in a prefix
 *  length); any configured prefix normalises to `/0` — a rule that
 *  would trust every peer and defeat ADR-0026's fail-closed gate; any
 *  configured header name is not an RFC 9110 §5.6.2 token. Catching
 *  these at construction turns a typo into a startup error and
 *  preserves the `authenticate()` "MUST NOT throw" contract from
 *  `auth.ts`.
 */
export function createTrustedProxyAuthProvider(
  config: TrustedProxyAuthProviderConfig,
): AuthProvider {
  validateHeaderName("trusted-proxy subject header", config.headers.subject);
  if (config.headers.displayName !== undefined) {
    validateHeaderName("trusted-proxy displayName header", config.headers.displayName);
  }
  if (config.headers.groups !== undefined) {
    validateHeaderName("trusted-proxy groups header", config.headers.groups);
  }

  const subjectHeader = config.headers.subject;
  const displayHeader = config.headers.displayName;
  const capability: Capability = config.capability ?? "comment";

  let peerMatcher: ((peer: AuthRequestPeer) => boolean) | null = null;
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
      const peerParsed = parsePeerAddress(peer.address);
      if (peerParsed === undefined) return false;
      for (const rule of parsed) {
        if (matchesPeerRule(peerParsed, rule)) return true;
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
      } else {
        // `peerMatcher` is non-null whenever `config.trust.kind` is
        // "peers" (set together above). The typed union lets TS prove
        // this; the `!` is the discriminated-union witness.
        if (!peerMatcher!(request.peer)) {
          return refuse("untrusted-peer", 403);
        }
      }

      const subjectRaw = request.headers.get(subjectHeader);
      const subject = normaliseSubject(subjectRaw);
      if (subject === undefined) return refuse("missing-subject", 401);

      let displayName = subject;
      if (displayHeader !== undefined) {
        const displayRaw = request.headers.get(displayHeader);
        const normalised = normaliseDisplayName(displayRaw);
        if (normalised !== undefined) displayName = normalised;
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

/** Trim + validate a subject header value.
 *
 * - `null` / empty / whitespace-only → `undefined` (treated as missing).
 * - Contains any control char (C0 / C1 / DEL) → `undefined`.
 * - Contains `,` → `undefined`. `Headers.get()` comma-joins multiple
 *   values for the same header name, so a duplicate `x-auth-user`
 *   header surfaces as `"admin, alice"`. A stable subject id has no
 *   legitimate comma in it, and treating it as repeated-header is the
 *   safe refusal (401 `missing-subject`).
 * - Longer than `SUBJECT_MAX_CHARS` → `undefined`.
 */
function normaliseSubject(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > SUBJECT_MAX_CHARS) return undefined;
  if (trimmed.includes(",")) return undefined;
  if (containsControlChar(trimmed)) return undefined;
  return trimmed;
}

/** Trim and sanitise a display-name header value.
 *
 * - `null` / empty / whitespace-only → `undefined` (fall back to subject).
 * - Contains `,` → `undefined` (repeated-header defence; same rule as
 *   subject, so a legitimately comma-containing display name cannot
 *   silently combine two values).
 * - Control characters (C0 / C1 / DEL) are stripped out by the shared
 *   `sanitiseDisplayName`, which also trims Unicode whitespace and
 *   truncates to `DISPLAY_NAME_MAX_CHARS` code units. If the
 *   stripped+capped value is empty, falls back to `undefined`.
 */
function normaliseDisplayName(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (raw.includes(",")) return undefined;
  return sanitiseDisplayName(raw);
}

/** A parsed peer rule: a single IPv4/IPv6 literal (prefix = max bits)
 * or a CIDR range. Mixed-family matching is a miss. */
interface PeerRule {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

function parsePeerRule(entry: string): PeerRule {
  const slash = entry.indexOf("/");
  const addrPart = slash === -1 ? entry : entry.slice(0, slash);
  const prefixPart = slash === -1 ? undefined : entry.slice(slash + 1);
  const parsed = parseConfiguredAddress(addrPart);
  if (parsed === undefined) {
    throw new Error(`trusted-proxy: not an IP address or CIDR: ${JSON.stringify(entry)}`);
  }
  const normalised = normaliseMappedIpv6(parsed);
  // The CIDR prefix is bounded by the WRITTEN family's bit width,
  // not the normalised one. That way `::ffff:10.0.0.0/104` is a
  // valid IPv6-space prefix (104 ≤ 128) that then reinterprets to
  // /8 in IPv4 space, and a bogus `10.0.0.0/42` is still refused
  // against the IPv4 32-bit bound.
  const parsedMaxBits = parsed.family === 4 ? 32 : 128;
  const normalisedMaxBits = normalised.family === 4 ? 32 : 128;
  let prefixBits = normalisedMaxBits;
  if (prefixPart !== undefined) {
    // `/08` is refused for the same reason `010.0.0.1` is refused on
    // the IPv4 side (classic SSRF-bypass octal shape): a well-formed
    // integer has no leading zeros, with `0` as the only exception.
    // `0` on its own is syntactically valid; it is rejected below as
    // a zero-length prefix for a security reason, not a syntax one.
    if (!/^(0|[1-9][0-9]*)$/.test(prefixPart)) {
      throw new Error(
        `trusted-proxy: CIDR prefix must be a non-negative integer with no leading zeros: ${JSON.stringify(entry)}`,
      );
    }
    let raw = Number.parseInt(prefixPart, 10);
    if (raw < 0 || raw > parsedMaxBits) {
      throw new Error(
        `trusted-proxy: CIDR prefix out of range for ${parsed.family === 4 ? "IPv4" : "IPv6"}: ${JSON.stringify(entry)}`,
      );
    }
    // If the caller wrote `::ffff:127.0.0.1/104` (an IPv6 prefix on
    // what normalises to an IPv4 rule), reinterpret the prefix in the
    // IPv4 space so the same rule covers the normalised peer.
    if (parsed.family === 6 && normalised.family === 4) {
      // The low 32 bits are the IPv4 part; a /128 → /32, a /104 → /8.
      // A prefix shorter than /96 bites into the `::ffff:` tag or the
      // top zeros, which cannot describe an IPv4 range — refuse it.
      if (raw < 96) {
        throw new Error(
          `trusted-proxy: IPv4-mapped IPv6 rule needs a /96 or longer prefix: ${JSON.stringify(entry)}`,
        );
      }
      raw = raw - 96;
    }
    prefixBits = raw;
  }
  // Architect decision (round 3): a zero-length prefix is a
  // trust-everyone rule — `0.0.0.0/0`, `::/0` and `::ffff:0:0/96`
  // (reinterpreted to `/0` in IPv4 space) all land here. ADR-0026
  // §Identity requires a non-empty allowlist precisely to keep the
  // gate fail-closed; admitting a /0 rule would defeat that even
  // though the allowlist is technically non-empty. Operators who
  // need to trust every peer must say so one host at a time (or
  // move to a unix socket), not with a wildcard rule.
  if (prefixBits === 0) {
    throw new Error(
      `trusted-proxy: zero-length prefix would trust every peer and defeat ADR-0026's fail-closed gate: ${JSON.stringify(entry)}`,
    );
  }
  return { family: normalised.family, bytes: normalised.bytes, prefixBits };
}

function matchesPeerRule(peer: ParsedAddress, rule: PeerRule): boolean {
  const normalised = normaliseMappedIpv6(peer);
  // A rule family mismatch is a miss. Without this guard an IPv6
  // rule like `2001:db8::/32` would be byte-compared against an IPv4
  // peer `32.1.13.184`, and the first four bytes would match.
  if (normalised.family !== rule.family) return false;
  const fullBytes = Math.floor(rule.prefixBits / 8);
  const remainderBits = rule.prefixBits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (normalised.bytes[i] !== rule.bytes[i]) return false;
  }
  if (remainderBits === 0) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return (normalised.bytes[fullBytes]! & mask) === (rule.bytes[fullBytes]! & mask);
}

/** Collapse an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) to its
 * IPv4 form. Any other IPv6 value and all IPv4 values pass through
 * untouched. */
function normaliseMappedIpv6(addr: ParsedAddress): ParsedAddress {
  if (addr.family !== 6) return addr;
  const b = addr.bytes;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return addr;
  if (b[10] !== 0xff || b[11] !== 0xff) return addr;
  return { family: 4, bytes: b.slice(12, 16) };
}

/** Parse an address spelled in the allowlist. Zone ids on IPv4 are a
 * configuration error; zone ids on IPv6 are refused at the allowlist
 * for now (RFC 4007 scopes are host-local, not meaningful between
 * hosts, so a trusted peer never legitimately carries one). Document
 * the decision so the behaviour is explicit. */
function parseConfiguredAddress(input: string): ParsedAddress | undefined {
  if (input.includes("%")) return undefined;
  return parseIpAddress(input);
}

/** Parse the transport peer address. Zone ids on IPv4 are malformed;
 * on IPv6 they are refused here too — the configured allowlist refuses
 * zoned entries so a zoned peer could never match anyway, and refusing
 * them explicitly keeps the parser small and spec-consistent. */
function parsePeerAddress(input: string): ParsedAddress | undefined {
  if (input.includes("%")) return undefined;
  return parseIpAddress(input);
}

/** Parse an IPv4 (`a.b.c.d`) or IPv6 (RFC 4291, including `::`
 * compression and dotted-quad tail) literal. `undefined` on malformed
 * input. */
function parseIpAddress(input: string): ParsedAddress | undefined {
  if (input.includes(":")) return parseIpv6(input);
  return parseIpv4(input);
}

function parseIpv4(input: string): ParsedAddress | undefined {
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

function parseIpv6(input: string): ParsedAddress | undefined {
  const compressionIdx = input.indexOf("::");
  const hasCompression = compressionIdx !== -1;

  const leftRaw = hasCompression ? input.slice(0, compressionIdx) : input;
  const rightRaw = hasCompression ? input.slice(compressionIdx + 2) : "";
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = rightRaw === "" ? [] : rightRaw.split(":");

  // RFC 4291 §2.2.3: the IPv4 dotted-quad form may only appear as the
  // final element of the full address (representing the trailing 32
  // bits). Expand the dotted-quad in place into two 16-bit hex groups
  // so the group-count and per-group hex-regex checks below catch
  // every other placement. A dot anywhere other than the tail leaves
  // a group that fails the hex regex. The `1.2.3.4::` shape
  // (compression with an empty right side) leaves `1.2.3.4` as a
  // group in `left`, which fails that same regex. And a second `::`
  // (`::1::2`) leaves an empty-string group that fails that same
  // regex. One validation path, no redundant position / double-`::`
  // guards.
  const finalTail = hasCompression ? (right.length > 0 ? right : null) : left;
  if (finalTail !== null && finalTail.length > 0) {
    const tailLast = finalTail[finalTail.length - 1]!;
    if (tailLast.includes(".")) {
      const dotted = parseIpv4(tailLast);
      if (dotted === undefined) return undefined;
      const b = dotted.bytes;
      finalTail.pop();
      finalTail.push(((b[0]! << 8) | b[1]!).toString(16), ((b[2]! << 8) | b[3]!).toString(16));
    }
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
