// Tests for the `trusted-proxy` auth provider (ADR-0026 §"Plain Linux
// host / VM"). Covers each bullet of issue #244 AC 3 plus the two
// AC-5 forged-header cases and the ADR-recommended "re-derive per
// request" revocation decision. The round-2 blocker tests (§"IP
// parser hardening" and below) pin the mutation targets the fresh
// reviewer called out — each test fails before the paired source
// edit and passes after.

import { describe, expect, test } from "bun:test";
import {
  createTrustedProxyAuthProvider,
  identityKey,
  type AuthRequest,
  type TrustedProxyAuthProviderConfig,
} from "../src/index.ts";

const BASE_HEADERS = {
  subject: "x-auth-user",
  displayName: "x-auth-name",
} as const;

function tcpRequest(
  address: string,
  headers: Record<string, string> = {},
): AuthRequest {
  return {
    method: "GET",
    url: "http://proxy.example/",
    headers: new Headers(headers),
    peer: { transport: "tcp", address },
  };
}

function unixRequest(headers: Record<string, string> = {}): AuthRequest {
  return {
    method: "GET",
    url: "http://proxy.example/",
    headers: new Headers(headers),
    peer: { transport: "unix" },
  };
}

function peersConfig(
  peers: readonly string[],
  overrides: Partial<TrustedProxyAuthProviderConfig> = {},
): TrustedProxyAuthProviderConfig {
  return {
    headers: BASE_HEADERS,
    trust: { kind: "peers", peers },
    ...overrides,
  };
}

describe("createTrustedProxyAuthProvider — construction", () => {
  test("has provider id 'trusted-proxy'", () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    expect(provider.id).toBe("trusted-proxy");
  });

  test("refuses an empty peer list at construction (ADR-0026 bullet 5, AC 3 bullet 2)", () => {
    // ADR-0026: "a missing or empty trusted-peer list refuses every
    // request; there is no default". Catching this at construction
    // keeps a startup typo from becoming a silent fail-closed.
    expect(() => createTrustedProxyAuthProvider(peersConfig([]))).toThrow(
      /peers array is empty/i,
    );
  });

  test("refuses an unparsable peer entry at construction", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["not-an-ip"])),
    ).toThrow(/not an IP address or CIDR/i);
  });

  test("refuses an out-of-range CIDR prefix at construction", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["10.0.0.0/42"])),
    ).toThrow(/out of range/i);
  });
});

describe("createTrustedProxyAuthProvider — peer trust (TCP)", () => {
  test("accepts a single address and mints the identity (AC 3 bullet 5)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", {
        "x-auth-user": "alice",
        "x-auth-name": "Alice",
      }),
    );
    expect(result).toEqual({
      kind: "identity",
      identity: {
        provider: "trusted-proxy",
        subject: "alice",
        displayName: "Alice",
        capability: "comment",
      },
    });
  });

  test("accepts an IPv4 address inside a CIDR", async () => {
    const provider = createTrustedProxyAuthProvider(
      peersConfig(["10.0.0.0/24"]),
    );
    const result = await provider.authenticate(
      tcpRequest("10.0.0.42", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });

  test("accepts an IPv6 address inside a CIDR", async () => {
    const provider = createTrustedProxyAuthProvider(
      peersConfig(["2001:db8::/32"]),
    );
    const result = await provider.authenticate(
      tcpRequest("2001:db8:1::1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });

  test("refuses an address outside the CIDR with 403 (AC 3 bullet 3)", async () => {
    const provider = createTrustedProxyAuthProvider(
      peersConfig(["10.0.0.0/24"]),
    );
    const result = await provider.authenticate(
      tcpRequest("10.0.1.1", { "x-auth-user": "alice" }),
    );
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "untrusted-peer", status: 403 },
    });
  });

  test("refuses a trusted-peer request with an empty subject header with 401 (AC 3 bullet 4)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "   " }),
    );
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "missing-subject", status: 401 },
    });
  });

  test("refuses a trusted-peer request with no subject header with 401 (AC 3 bullet 4)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(tcpRequest("127.0.0.1"));
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("missing-subject");
    expect(result.reason.status).toBe(401);
  });

  test("falls back to the subject when the display-name header is absent", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("alice");
  });

  test("honours a `capability: 'view'` default", async () => {
    const provider = createTrustedProxyAuthProvider(
      peersConfig(["127.0.0.1"], { capability: "view" }),
    );
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.capability).toBe("view");
  });
});

describe("createTrustedProxyAuthProvider — unix-socket trust (AC 3 bullet 1)", () => {
  test("accepts a unix-socket request with a subject header", async () => {
    const provider = createTrustedProxyAuthProvider({
      headers: BASE_HEADERS,
      trust: { kind: "unix-socket" },
    });
    const result = await provider.authenticate(
      unixRequest({ "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });

  test("refuses a TCP request on a unix-socket-only provider with 403", async () => {
    // Unix-socket trust means the filesystem permissions are the
    // check. A TCP connection to the same process is not that path and
    // MUST NOT be accepted (ADR-0026 names the trust modes as
    // alternatives, not as a fallthrough).
    const provider = createTrustedProxyAuthProvider({
      headers: BASE_HEADERS,
      trust: { kind: "unix-socket" },
    });
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.status).toBe(403);
  });

  test("refuses a unix-socket request on a TCP-only provider with 403", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      unixRequest({ "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.status).toBe(403);
  });
});

describe("createTrustedProxyAuthProvider — AC 5 forged-header cases", () => {
  test("ignores X-Forwarded-For: a request whose connection peer is untrusted but XFF claims a trusted address is 403", async () => {
    // ADR-0026 §Identity, bullet 6: "On TCP the check uses the
    // transport peer address of the connection, never
    // `X-Forwarded-For`." The provider must not consult XFF at all.
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const forged = tcpRequest("203.0.113.5", {
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
      forwarded: "for=127.0.0.1",
      "x-auth-user": "attacker",
    });
    const result = await provider.authenticate(forged);
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "untrusted-peer", status: 403 },
    });
  });

  test("a client-supplied identity header passed through an untrusted peer is refused with 403 before the identity step", async () => {
    // AC 5: the provider must refuse a forged identity header from an
    // untrusted peer BEFORE it reads the header, so a forged header
    // from an untrusted address never reaches the identity step.
    const provider = createTrustedProxyAuthProvider(peersConfig(["10.0.0.0/24"]));
    const forged = tcpRequest("198.51.100.1", {
      "x-auth-user": "staff-member",
      "x-auth-name": "Pretend Staff",
    });
    const result = await provider.authenticate(forged);
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "untrusted-peer", status: 403 },
    });
  });
});

describe("createTrustedProxyAuthProvider — ADR-0026 revocation decision", () => {
  test("re-derives identity per request: the provider holds no state across authenticate() calls (AC 3 bullet 7)", async () => {
    // ADR-0026 open-question entry on revocation: "Re-deriving per
    // request is the safer default because it needs no revocation."
    // #244 picks that default; a later change that introduces a
    // session for proxy-derived identities must add revocation and
    // session-binding tests.
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const first = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice" }),
    );
    const second = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "bob" }),
    );
    expect(first.kind).toBe("identity");
    expect(second.kind).toBe("identity");
    if (first.kind !== "identity" || second.kind !== "identity") return;
    // A cached session would have returned alice twice; a pure
    // provider reflects the second request's subject.
    expect(first.identity.subject).toBe("alice");
    expect(second.identity.subject).toBe("bob");
  });
});

describe("createTrustedProxyAuthProvider — IP parser hardening (round 2 blocker 1)", () => {
  // Each `peers: [...]` entry here is a MALFORMED IP literal; the
  // parser must throw at construction so a typo is a startup failure.
  // Before the parser fix some of these were accepted (notably
  // `1.2.3.4::` and the `%zone`-tailed IPv4), which turned a malformed
  // allowlist entry into a silent fail-closed at runtime.
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["1.2.3.4::", "trailing :: with a dotted-quad is invalid (RFC 4291 §2.2.3)"],
    ["1.2.3.4::1", "embedded dotted-quad in the left side"],
    ["::1.2.3.4:5", "dotted-quad not at the end of the right side"],
    ["127.0.0.1%junk", "zone id on an IPv4 literal"],
    ["fe80::1%eth0", "zone id on an IPv6 rule is refused"],
    ["010.0.0.1", "leading zeros (SSRF-bypass shape)"],
    ["1:2:3:4:5:6:7:8::", "`::` with no zero groups left to compress"],
    ["not-an-ip", "garbage"],
    ["256.0.0.1", "IPv4 octet out of range"],
    ["gggg::1", "IPv6 group with non-hex characters"],
  ];
  for (const [entry, why] of malformed) {
    test(`refuses "${entry}" at construction (${why})`, () => {
      expect(() => createTrustedProxyAuthProvider(peersConfig([entry]))).toThrow(
        /trusted-proxy:/,
      );
    });
  }

  // These malformed PEER addresses must never match a trusted rule.
  // `parsePeerAddress` returns `undefined` for them and the matcher
  // misses; the provider returns 403 `untrusted-peer`.
  test("refuses peer address with an IPv4 zone id at runtime", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1%bogus", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("untrusted-peer");
  });

  test("refuses peer address with an IPv6 zone id at runtime", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["fe80::1"]));
    const result = await provider.authenticate(
      tcpRequest("fe80::1%eth0", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("untrusted-peer");
  });

  test("refuses an IPv6 literal with two `::` compressions at runtime", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["::1"]));
    const result = await provider.authenticate(
      tcpRequest("::1::2", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("untrusted-peer");
  });

  test("accepts well-formed IPv6-with-dotted-quad peers (regression guard)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["::1.2.3.4"]));
    const result = await provider.authenticate(
      tcpRequest("::1.2.3.4", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });
});

describe("createTrustedProxyAuthProvider — repeated subject / display-name header (round 2 blocker 2)", () => {
  // `Headers.get()` comma-joins when the same header name is appended
  // twice, so two `x-auth-user` copies surface as `"admin, alice"`.
  // Without the "refuse a comma in subject" rule the provider would
  // mint an identity for the joined value. The repeat is a 401
  // `missing-subject`.
  test("refuses a subject header that was sent more than once", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const headers = new Headers();
    headers.append("x-auth-user", "admin");
    headers.append("x-auth-user", "alice");
    const result = await provider.authenticate({
      method: "GET",
      url: "http://proxy.example/",
      headers,
      peer: { transport: "tcp", address: "127.0.0.1" },
    });
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "missing-subject", status: 401 },
    });
  });

  test("refuses a subject value that contains a comma (indistinguishable from a repeated header)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "admin, alice" }),
    );
    expect(result).toEqual({
      kind: "refused",
      reason: { reason: "missing-subject", status: 401 },
    });
  });

  test("refuses a display-name value that contains a comma (repeated-header defence)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", {
        "x-auth-user": "alice",
        "x-auth-name": "Alice Admin, Attacker",
      }),
    );
    // A comma in the display name is treated as a repeated header
    // and the display name falls back to the subject (since the
    // display-name header value is discarded, not the whole request).
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("alice");
  });

  test("refuses a subject carrying a C0 control character", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice\u0001evil" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("missing-subject");
  });
});

describe("createTrustedProxyAuthProvider — peer-matching mutation kills (round 2 blocker 3)", () => {
  // Fresh-reviewer mutation: removing the IPv4/IPv6 family check (the
  // `if (parsed.family !== rule.family) return false;` line) survived
  // the old test suite. An IPv6 `2001:db8::/32` rule must NOT match
  // the IPv4 `32.1.13.184` peer — their first four bytes happen to be
  // equal and a byte-wise compare without the family guard would
  // accept the peer.
  test("IPv6 rule does NOT match an IPv4 peer with equal leading bytes (kills the 'drop family check' mutation)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["2001:db8::/32"]));
    const result = await provider.authenticate(
      tcpRequest("32.1.13.184", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("untrusted-peer");
  });

  // Fresh-reviewer mutation: turning `if (remainderBits === 0) return
  // true` into a bare `return true` makes every non-byte-aligned
  // prefix accept any peer whose full-byte prefix matched. The three
  // prefix widths below cover an aligned mid-range (/12 on IPv4), a
  // non-byte-aligned middle (/25 on IPv4) and a non-byte-aligned IPv6
  // (/127). For each the test accepts an inside peer and rejects a
  // just-outside peer, so the mask arithmetic cannot be stubbed out.
  const prefixCases: ReadonlyArray<readonly [string, string, string]> = [
    ["10.0.0.0/25", "10.0.0.42", "10.0.0.129"], // /25: half of /24
    ["10.16.0.0/12", "10.17.255.1", "10.32.0.1"], // /12: byte-aligned on nibble, non-aligned on byte
    ["2001:db8::/127", "2001:db8::1", "2001:db8::2"], // /127: last-bit IPv6
  ];
  for (const [rule, inside, outside] of prefixCases) {
    test(`rule ${rule} accepts ${inside} and refuses ${outside} (kills the 'strip mask' mutation)`, async () => {
      const provider = createTrustedProxyAuthProvider(peersConfig([rule]));
      const accepted = await provider.authenticate(
        tcpRequest(inside, { "x-auth-user": "alice" }),
      );
      expect(accepted.kind).toBe("identity");
      const refused = await provider.authenticate(
        tcpRequest(outside, { "x-auth-user": "alice" }),
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind !== "refused") return;
      expect(refused.reason.reason).toBe("untrusted-peer");
    });
  }

  // Fresh-reviewer mutation: dropping the "leading zeros refuse" in
  // `parseIpv4`. `010.0.0.1` would then parse to 10.0.0.1 and an
  // allowlist written `010.0.0.1` would unintentionally cover
  // `10.0.0.1` — the classic SSRF-bypass shape.
  test("leading zeros in an IPv4 allowlist entry are a construction error (kills the 'drop leading-zero rejection' mutation)", () => {
    expect(() => createTrustedProxyAuthProvider(peersConfig(["010.0.0.1"]))).toThrow(
      /trusted-proxy:/,
    );
  });

  // Fresh-reviewer mutation: `missing < 1` is what makes `::` with a
  // left+right that already fill the 8 groups invalid. Without it the
  // parser accepts `1:2:3:4:5:6:7:8::` and silently stores an
  // address that cannot represent more zeros. The paired-fail peer
  // test uses a canonical 8-group address to confirm the correct
  // shape is still accepted.
  test("IPv6 with `::` and no room to compress is refused (kills the 'drop missing<1' mutation)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["1:2:3:4:5:6:7:8::"])),
    ).toThrow(/trusted-proxy:/);
  });

  // Fresh-reviewer mutation: removing the `.trim()` on the display
  // name leaks surrounding Unicode whitespace. The Fetch `Headers`
  // normaliser only strips HTTP whitespace (space, tab) when values
  // are set/appended, so non-breaking space (U+00A0) and ideographic
  // space (U+3000) travel through unchanged. `String.prototype.trim`
  // strips all Unicode whitespace, so dropping the `.trim()` call
  // leaks them into the display name; this test catches that.
  test("trims Unicode whitespace from the display-name header (kills the 'drop trim()' mutation)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", {
        "x-auth-user": "alice",
        "x-auth-name": "  Alice ",
      }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("Alice");
  });
});

describe("createTrustedProxyAuthProvider — IPv4-mapped IPv6 peers", () => {
  test("`::ffff:127.0.0.1` matches an IPv4 rule", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.0/8"]));
    const result = await provider.authenticate(
      tcpRequest("::ffff:127.0.0.1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });

  test("an IPv4-mapped allowlist entry normalises to IPv4 and matches the plain IPv4 peer", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["::ffff:10.0.0.0/104"]));
    const result = await provider.authenticate(
      tcpRequest("10.0.0.42", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
  });

  test("an unmapped IPv6 peer does NOT match an IPv4 rule", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.0/8"]));
    const result = await provider.authenticate(
      tcpRequest("::1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("refused");
  });
});

describe("createTrustedProxyAuthProvider — header-name validation", () => {
  // Invalid header names must throw at construction (not at
  // `authenticate` time), so `authenticate()` keeps its "MUST NOT
  // throw" contract from auth.ts even if an operator fat-fingers the
  // config.
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["x auth user", "space"],
    ["x-auth-user:", "colon"],
    ["x-auth-user\n", "newline"],
    ["", "empty"],
  ];
  for (const [name, why] of invalid) {
    test(`subject header name "${name}" is a construction error (${why})`, () => {
      expect(() =>
        createTrustedProxyAuthProvider({
          headers: { subject: name },
          trust: { kind: "peers", peers: ["127.0.0.1"] },
        }),
      ).toThrow(/invalid HTTP header name/);
    });
  }

  test("display-name header name is validated too", () => {
    expect(() =>
      createTrustedProxyAuthProvider({
        headers: { subject: "x-auth-user", displayName: "bad name" },
        trust: { kind: "peers", peers: ["127.0.0.1"] },
      }),
    ).toThrow(/invalid HTTP header name/);
  });

  test("groups header name is validated even though it is not consumed yet", () => {
    expect(() =>
      createTrustedProxyAuthProvider({
        headers: { subject: "x-auth-user", groups: "bad\tname" },
        trust: { kind: "peers", peers: ["127.0.0.1"] },
      }),
    ).toThrow(/invalid HTTP header name/);
  });
});

describe("createTrustedProxyAuthProvider — display-name hardening", () => {
  test("strips C0 control characters from the display name", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", {
        "x-auth-user": "alice",
        "x-auth-name": "A\u0007l\u0001ice",
      }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("Alice");
  });

  test("caps the display name at 256 code units", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const big = "A".repeat(300);
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice", "x-auth-name": big }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName.length).toBe(256);
  });

  test("falls back to the subject when the display name is only control chars", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", {
        "x-auth-user": "alice",
        "x-auth-name": "\u0001\u0002\u0003",
      }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("alice");
  });
});

describe("createTrustedProxyAuthProvider — round-3 blocker: IPv6-mapped `raw < 96` guard", () => {
  // Without the `raw < 96` guard in parsePeerRule, `::ffff:10.0.0.0/64`
  // would compute `prefixBits = 64 - 96 = -32`. JavaScript's
  // `Math.floor(-32 / 8)` is `-4` and `-32 % 8` is `-0`, so the matcher
  // would run with an impossible negative prefix. The outcome depends
  // on the matcher's byte-loop behaviour, but the right answer is to
  // refuse the config up front — a `/64` in IPv6 space cannot describe
  // an IPv4 range once the rule is reinterpreted.
  test("refuses `::ffff:10.0.0.0/64` at construction (/<96 IPv4-mapped prefix)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["::ffff:10.0.0.0/64"])),
    ).toThrow(/needs a \/96 or longer prefix/i);
  });

  test("refuses `::ffff:127.0.0.1/95` at construction (just below the /96 floor)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["::ffff:127.0.0.1/95"])),
    ).toThrow(/needs a \/96 or longer prefix/i);
  });

  test("accepts `::ffff:10.0.0.0/104` at construction (regression guard)", () => {
    // The paired regression: a /104 reinterprets to /8 in IPv4 space,
    // which matches the plain IPv4 peer 10.0.0.42 — same test as the
    // IPv4-mapped IPv6 group above, duplicated here so the paired
    // "fails before, passes after" is in one block with the /64 case.
    const provider = createTrustedProxyAuthProvider(
      peersConfig(["::ffff:10.0.0.0/104"]),
    );
    expect(provider.id).toBe("trusted-proxy");
  });
});

describe("createTrustedProxyAuthProvider — round-3 blocker: IPv6 parser mutation kills", () => {
  // Fresh-reviewer mutation (parseIpv6:groups.length !== 8): without
  // this guard a 9-group literal like `1:2:3:4:5:6:7:8:9` would reach
  // the hex-regex loop (all nine groups are valid hex) and be accepted
  // with a truncated or over-sized byte buffer. The test fails before
  // the guard and passes after.
  test("refuses `1:2:3:4:5:6:7:8:9` at construction (kills the 'drop groups.length !== 8' mutation)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["1:2:3:4:5:6:7:8:9"])),
    ).toThrow(/trusted-proxy:/);
  });

  // Fresh-reviewer mutation (parseIpv6 per-group `/^[0-9a-fA-F]{1,4}$/`):
  // widening the `{1,4}` bound would accept `12345::1`, a 5-nibble
  // "group" that cannot represent 16 bits. The test fails before the
  // guard and passes after.
  test("refuses `12345::1` at construction (kills the 'widen hex-group {1,4}' mutation)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["12345::1"])),
    ).toThrow(/trusted-proxy:/);
  });
});

describe("createTrustedProxyAuthProvider — round-3 blocker: subject trim + length cap + C1 refusal", () => {
  // Fresh-reviewer mutation (normaliseSubject `.trim()` call, line
  // ~219): without the trim, the Fetch `Headers` normaliser only
  // strips HTTP whitespace (space, tab), so a Unicode-whitespace-
  // wrapped subject like `" alice "` would leak into the
  // identity verbatim. With the trim, it is normalised to "alice".
  test("trims Unicode whitespace from the subject (kills the 'drop subject trim()' mutation)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": " alice " }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.subject).toBe("alice");
  });

  // Fresh-reviewer mutation (normaliseSubject SUBJECT_MAX_CHARS cap,
  // line ~221): without the cap, an oversized subject (say 300 chars)
  // would mint an identity with a 300-char `subject` field. The 256-
  // char edge is accepted, 257 is refused.
  test("accepts a subject at exactly 256 code units", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const subject = "a".repeat(256);
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": subject }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.subject.length).toBe(256);
  });

  test("refuses a subject longer than 256 code units (kills the 'drop SUBJECT_MAX_CHARS cap' mutation)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "a".repeat(257) }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("missing-subject");
  });

  // Fresh-reviewer mutation (containsControlChar C1 half, `c >= 0x7f &&
  // c <= 0x9f`): dropping that clause would let C1 characters through
  // the subject refusal. U+0085 (NEL) is a C1 character; U+007F (DEL)
  // is the boundary case that lives in the same clause.
  test("refuses a subject carrying a C1 (U+0085 NEL) control character (kills the 'drop C1 range' mutation)", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice\u0085evil" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("missing-subject");
  });

  test("refuses a subject carrying a DEL (U+007F) control character", async () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await provider.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice\u007fevil" }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason.reason).toBe("missing-subject");
  });
});

describe("createTrustedProxyAuthProvider — round-3 architect decision: zero-length prefixes refused", () => {
  // A /0 rule would trust every peer and defeat ADR-0026 §Identity's
  // fail-closed gate. The allowlist shape says "explicit list of
  // peers"; a wildcard rule violates that shape even though the array
  // is technically non-empty. An operator who really wants to trust
  // every peer must say so one host at a time (or switch to a unix
  // socket). This block covers the three shapes that normalise to /0.
  test("refuses `0.0.0.0/0` at construction", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["0.0.0.0/0"])),
    ).toThrow(/zero-length prefix/i);
  });

  test("refuses `::/0` at construction", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["::/0"])),
    ).toThrow(/zero-length prefix/i);
  });

  test("refuses `::ffff:0:0/96` at construction (reinterprets to /0 in IPv4 space)", () => {
    // After the mapped-IPv6 reinterpret, `/96` becomes `/0` in IPv4
    // space — the same trust-everyone shape. The zero-length check
    // must fire AFTER the reinterpret so this entry does not slip
    // through just because the written prefix was nominally 96.
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["::ffff:0:0/96"])),
    ).toThrow(/zero-length prefix/i);
  });

  test("accepts `0.0.0.0/32` at construction (single exact host is explicit, not a wildcard)", () => {
    // Regression guard: the /0 rejection is for zero-length prefixes
    // only. A `/32` on IPv4 picks exactly one host, which is explicit
    // and matches the allowlist shape.
    const provider = createTrustedProxyAuthProvider(peersConfig(["0.0.0.0/32"]));
    expect(provider.id).toBe("trusted-proxy");
  });
});

describe("createTrustedProxyAuthProvider — round-3 architect decision: prefix syntax hardening", () => {
  // The existing IPv4-octet rule refuses `010` to avoid the classic
  // octal-SSRF bypass. The same rule applies to the CIDR prefix, for
  // the same reason: a human reading `/08` has no way to tell whether
  // it is octal 8 or decimal 8, and the only safe policy is to refuse
  // the ambiguity at parse time.
  test("refuses `127.0.0.1/08` at construction (leading-zero prefix length)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["127.0.0.1/08"])),
    ).toThrow(/leading zeros/i);
  });

  test("refuses `127.0.0.1/032` at construction (leading-zero prefix length)", () => {
    expect(() =>
      createTrustedProxyAuthProvider(peersConfig(["127.0.0.1/032"])),
    ).toThrow(/leading zeros/i);
  });

  test("accepts `127.0.0.1/8` at construction (regression: single-digit prefix is fine)", () => {
    const provider = createTrustedProxyAuthProvider(peersConfig(["10.0.0.0/8"]));
    expect(provider.id).toBe("trusted-proxy");
  });
});

describe("identityKey — AC 4 provider namespacing", () => {
  test("an identity with provider=none and subject=S does not match one with provider=trusted-proxy and subject=S", async () => {
    const trusted = createTrustedProxyAuthProvider(peersConfig(["127.0.0.1"]));
    const result = await trusted.authenticate(
      tcpRequest("127.0.0.1", { "x-auth-user": "alice" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    const trustedKey = identityKey(result.identity);
    const forged = identityKey({
      provider: "none",
      subject: "alice",
      displayName: "alice",
      capability: "comment",
    });
    expect(trustedKey).not.toBe(forged);
    expect(trustedKey).toBe("trusted-proxy:alice");
    expect(forged).toBe("none:alice");
  });

  test("refuses a provider id that could create key collisions with another provider's subject", () => {
    // `${provider}:${subject}` is collision-free only when the
    // provider id itself contains no `:`. A caller that manufactures
    // an `Identity` with `provider: "a:b"` (or whitespace, or other
    // punctuation) is refused at the `identityKey` boundary so such
    // a construction cannot silently merge with another provider's
    // subject (`a:b` + `c` would otherwise collide with `a` + `b:c`).
    expect(() =>
      identityKey({
        provider: "a:b",
        subject: "c",
        displayName: "x",
        capability: "comment",
      }),
    ).toThrow(/kebab-case/);
    expect(() =>
      identityKey({
        provider: "SomeProvider",
        subject: "x",
        displayName: "x",
        capability: "comment",
      }),
    ).toThrow(/kebab-case/);
  });
});
