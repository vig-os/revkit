// Tests for the `trusted-proxy` auth provider (ADR-0026 §"Plain Linux
// host / VM"). Covers each bullet of issue #244 AC 3 plus the two
// AC-5 forged-header cases and the ADR-recommended "re-derive per
// request" revocation decision.

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
});
