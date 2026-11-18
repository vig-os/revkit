// #279 round 2 — `createAuthProviderIdentityResolver` with the REAL
// `trusted-proxy` provider, not a stub. The bridge between the
// ADR-0026 auth provider interface and the daemon's `IdentityResolver`
// is load-bearing for the host target (#245): the resolver is what
// every write-path handler consults, so if it mis-maps a provider's
// refusal or passes the wrong peer shape to `authenticate`, a proxied
// reviewer's identity never reaches the store (or, worse, an
// untrusted peer's forged header does).
//
// Pinned here:
//
//   * Trusted TCP peer + a stable subject header → resolution is
//     `ok` with a `local` actor whose `id` matches the subject and
//     whose `displayName` is what the provider minted.
//   * TCP peer outside the configured allowlist → resolution is
//     `refused` with `403` / `untrusted-peer`. The bridge must
//     surface the provider's status code, not collapse everything
//     to `401`.
//   * Trusted peer with no subject header → resolution is `refused`
//     with `401` / `missing-subject`.
//
// The trusted-proxy provider's own tests are extensive; this file
// focuses on the bridge the daemon runs.

import { describe, expect, test } from "bun:test";
import { createTrustedProxyAuthProvider, type AuthRequestPeer } from "@revkit/review-core";
import { createAuthProviderIdentityResolver } from "../../src/serve/identity-resolver.ts";

/** Minimal provider for the three branches we exercise. Headers are
 * the only ones the provider reads; the display name is optional. */
function trustedPeerProvider() {
  return createTrustedProxyAuthProvider({
    headers: { subject: "x-auth-user", displayName: "x-auth-name" },
    trust: { kind: "peers", peers: ["192.0.2.10"] },
  });
}

/** Build a `peer` callback that always answers with `peer` — matches
 * the host target's shape (one unix socket or one TCP stripe per
 * listener). */
function constantPeer(peer: AuthRequestPeer): (request: Request) => AuthRequestPeer {
  return () => peer;
}

describe("#279 createAuthProviderIdentityResolver — real trusted-proxy provider", () => {
  test("trusted peer + subject header → ok with the minted actor", async () => {
    const resolver = createAuthProviderIdentityResolver({
      provider: trustedPeerProvider(),
      peer: constantPeer({ transport: "tcp", address: "192.0.2.10" }),
    });
    const request = new Request("http://review.example.com/api/threads", {
      method: "GET",
      headers: {
        host: "review.example.com",
        "x-auth-user": "alice",
        "x-auth-name": "Alice Example",
      },
    });
    const outcome = await resolver.resolve(request);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.actor.kind).toBe("local");
      expect(outcome.actor.id).toBe("alice");
      expect(outcome.actor.displayName).toBe("Alice Example");
    }
  });

  test("untrusted TCP peer → refused 403 untrusted-peer", async () => {
    const resolver = createAuthProviderIdentityResolver({
      provider: trustedPeerProvider(),
      peer: constantPeer({ transport: "tcp", address: "198.51.100.1" }),
    });
    const request = new Request("http://review.example.com/api/threads", {
      method: "GET",
      headers: {
        host: "review.example.com",
        "x-auth-user": "someone",
      },
    });
    const outcome = await resolver.resolve(request);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.status).toBe(403);
      expect(outcome.reason).toBe("untrusted-peer");
    }
  });

  test("trusted peer + missing subject header → refused 401 missing-subject", async () => {
    const resolver = createAuthProviderIdentityResolver({
      provider: trustedPeerProvider(),
      peer: constantPeer({ transport: "tcp", address: "192.0.2.10" }),
    });
    const request = new Request("http://review.example.com/api/threads", {
      method: "GET",
      headers: { host: "review.example.com" },
    });
    const outcome = await resolver.resolve(request);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.status).toBe(401);
      expect(outcome.reason).toBe("missing-subject");
    }
  });

  test("display name falls back to subject when the header is absent", async () => {
    const resolver = createAuthProviderIdentityResolver({
      provider: createTrustedProxyAuthProvider({
        headers: { subject: "x-auth-user", displayName: "x-auth-name" },
        trust: { kind: "peers", peers: ["192.0.2.10"] },
      }),
      peer: constantPeer({ transport: "tcp", address: "192.0.2.10" }),
    });
    const request = new Request("http://review.example.com/api/threads", {
      method: "GET",
      headers: { host: "review.example.com", "x-auth-user": "alice" },
    });
    const outcome = await resolver.resolve(request);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      // When the provider returns `displayName === subject`, the
      // bridge still carries a displayName (the empty-string
      // omission rule in `identity-resolver.ts` applies only to an
      // explicitly empty string).
      expect(outcome.actor.id).toBe("alice");
      expect(outcome.actor.displayName).toBe("alice");
    }
  });
});
