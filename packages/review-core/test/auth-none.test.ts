// Tests for the `none` auth provider (ADR-0026). Local and VPN targets
// use this one: the network is the boundary, the display name is
// self-declared, and the attribution layer renders it as unverified.

import { describe, expect, test } from "bun:test";
import {
  createNoneAuthProvider,
  identityKey,
  type AuthRequest,
} from "../src/index.ts";

function request(headers: Record<string, string> = {}): AuthRequest {
  return {
    method: "GET",
    url: "http://127.0.0.1:12345/",
    headers: new Headers(headers),
    peer: { transport: "tcp", address: "127.0.0.1" },
  };
}

describe("createNoneAuthProvider", () => {
  test("has provider id 'none'", () => {
    expect(createNoneAuthProvider().id).toBe("none");
  });

  test("mints a comment-capable identity with the self-declared display name (AC 2)", async () => {
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "Alice" }),
    );
    expect(result).toEqual({
      kind: "identity",
      identity: {
        provider: "none",
        subject: "Alice",
        displayName: "Alice",
        capability: "comment",
      },
    });
  });

  test("trims surrounding whitespace from the display-name header", async () => {
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "  Bob  " }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.subject).toBe("Bob");
    expect(result.identity.displayName).toBe("Bob");
  });

  test("falls back to the default display name when the header is missing", async () => {
    const provider = createNoneAuthProvider({ defaultDisplayName: "anonymous" });
    const result = await provider.authenticate(request());
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("anonymous");
    expect(result.identity.subject).toBe("anonymous");
  });

  test("falls back when the header is present but whitespace-only", async () => {
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "   " }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    // Default display name when nothing meaningful was provided.
    expect(result.identity.displayName).toBe("guest");
  });

  test("respects a custom display-name header and capability override", async () => {
    const provider = createNoneAuthProvider({
      displayNameHeader: "x-vpn-user",
      capability: "view",
    });
    const result = await provider.authenticate(
      request({ "x-vpn-user": "Carol" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.capability).toBe("view");
    expect(result.identity.displayName).toBe("Carol");
  });

  test("identityKey of a `none` identity is distinct from any other provider's identity with the same subject (AC 4)", async () => {
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "Alice" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    const noneKey = identityKey(result.identity);
    const forgedKey = identityKey({
      provider: "trusted-proxy",
      subject: "Alice",
      displayName: "Alice",
      capability: "comment",
    });
    expect(noneKey).not.toBe(forgedKey);
    expect(noneKey).toBe("none:Alice");
    expect(forgedKey).toBe("trusted-proxy:Alice");
  });

  test("refuses an invalid `displayNameHeader` at construction (round-3 blocker: validate the header name)", () => {
    // auth.ts:91-93 pins "`authenticate()` MUST NOT throw on an
    // unauthenticated request". Without construction-time validation,
    // a typo'd header name (`Headers.get` throws TypeError on a
    // non-token name) would turn every request into a thrown error at
    // `authenticate` time. The shared `validateHeaderName` in
    // `auth-internal.ts` catches it as a startup error instead.
    expect(() =>
      createNoneAuthProvider({ displayNameHeader: "bad header" }),
    ).toThrow(/invalid HTTP header name/);
    expect(() =>
      createNoneAuthProvider({ displayNameHeader: "" }),
    ).toThrow(/invalid HTTP header name/);
    expect(() =>
      createNoneAuthProvider({ displayNameHeader: "x-auth-name\n" }),
    ).toThrow(/invalid HTTP header name/);
  });

  test("strips C0/DEL/C1 control characters from the display-name header (shared helper with trusted-proxy)", async () => {
    // Round-3 fix: `none` reuses `sanitiseDisplayName` so a header
    // like `"A\u0001lice\u0085"` becomes `"Alice"` — the same rule as
    // the trusted-proxy display-name path. The U+0085 (NEL) char
    // exercises the C1 range (0x7F..0x9F), which a dropped
    // `(c >= 0x7f && c <= 0x9f)` guard would leak into the identity.
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "A\u0001lice\u0085" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("Alice");
    expect(result.identity.subject).toBe("Alice");
  });

  test("falls back to the default when the display name is only control chars (shared helper refuses empty)", async () => {
    const provider = createNoneAuthProvider({ defaultDisplayName: "anonymous" });
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "\u0001\u0002\u0003" }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName).toBe("anonymous");
  });

  test("caps the display name at 256 code units (shared helper)", async () => {
    const provider = createNoneAuthProvider();
    const result = await provider.authenticate(
      request({ "x-revkit-display-name": "A".repeat(300) }),
    );
    expect(result.kind).toBe("identity");
    if (result.kind !== "identity") return;
    expect(result.identity.displayName.length).toBe(256);
    expect(result.identity.subject.length).toBe(256);
  });

  test("the provider holds no state between calls (per-request derivation)", async () => {
    const provider = createNoneAuthProvider();
    const first = await provider.authenticate(
      request({ "x-revkit-display-name": "Alice" }),
    );
    const second = await provider.authenticate(
      request({ "x-revkit-display-name": "Bob" }),
    );
    expect(first.kind).toBe("identity");
    expect(second.kind).toBe("identity");
    if (first.kind !== "identity" || second.kind !== "identity") return;
    // A session mechanism would have remembered Alice; a pure provider
    // reflects the second request's header exactly.
    expect(second.identity.subject).toBe("Bob");
  });
});
