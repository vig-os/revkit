// ADR-0012 header policy on the hosted surface: A18-A22.
//
// The policy itself is pinned once in
// `packages/review-core/test/http-headers.test.ts`, which is where it now
// LIVES. This file pins the hosted ADAPTER's two decisions — which origin
// script sources are named against, and that the inline-script hashes come
// from the revkit release's committed allowlist and never from served
// content — because those are exactly the parts a second surface could get
// wrong, and they are the parts ADR-0012 spells out per origin.
//
// A18 is asserted HERE on real Worker responses rather than on a
// `Response` object, because "every response carries hygiene headers"
// includes the 404 and 500 paths, which only exist in the router.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildMinimalCspHeader, hexToBase64 } from "@revkit/review-core/http-headers";
import {
  REQUEST_ID_HEADER,
  applyHtmlHeaders,
  applySvgHeaders,
  buildMinimalCspHeader as reexportedMinimal,
  requestOrigin,
  revkitBundlePath,
  workerHeaderContext,
} from "../src/headers.ts";
import { startWorker, type Harness } from "./harness.ts";

/** The COMMITTED release artefact. Path is the one ADR-0012's amendment
 * fixes: the allowlist of the revkit version the Worker runs, never one
 * found in an artifact. */
const ALLOWLIST_PATH = new URL("../../cli/src/dist-check-allowlist.json", import.meta.url);
const ALLOWLIST = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as { sha256: Record<string, string> };
const COMMITTED_DIGESTS = Object.keys(ALLOWLIST.sha256);

/** A digest that is NOT in the allowlist — the hostile-artefact case. */
const HOSTILE_DIGEST = "d".repeat(64);

const VERSION = "0.0.0";
const ORIGIN = "https://review.example.test";

function ctx(): ReturnType<typeof workerHeaderContext> {
  return workerHeaderContext({ origin: ORIGIN, version: VERSION, inlineScriptHashes: COMMITTED_DIGESTS });
}

function cspOf(response: Response): string {
  return response.headers.get("content-security-policy") ?? "";
}

describe("ADR-0012 headers on the hosted surface", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  // ── A18 ───────────────────────────────────────────────────────────────
  test("A18: every real response carries the full hygiene set, 200 and 404 alike", async () => {
    const responses = [
      await harness.dispatch("http://localhost/healthz"),
      await harness.dispatch("http://localhost/nope"),
      await harness.dispatch("http://localhost/api/threads"),
      await harness.dispatch("http://localhost/api/threads", { method: "POST" }),
      await harness.dispatch("http://localhost/_revkit/0.0.0/x.js"),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
    }
  });

  test("A18: Permissions-Policy denies every feature ADR-0012's amendment names", async () => {
    const response = await harness.dispatch("http://localhost/healthz");
    const policy = response.headers.get("permissions-policy") ?? "";
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "payment",
      "usb",
      "publickey-credentials-create",
      "display-capture",
    ]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  // ── A19 ───────────────────────────────────────────────────────────────
  test("A19: the hosted CSP carries ADR-0012's baseline directives", async () => {
    const csp = cspOf(applyHtmlHeaders(new Response("<!doctype html>"), ctx()));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  // ── A20 ───────────────────────────────────────────────────────────────
  test("A20: script-src carries EVERY digest from the committed release allowlist", async () => {
    expect(COMMITTED_DIGESTS.length).toBeGreaterThan(0);
    const csp = cspOf(applyHtmlHeaders(new Response("<!doctype html>"), ctx()));
    for (const digest of COMMITTED_DIGESTS) {
      expect(csp).toContain(`'sha256-${hexToBase64(digest)}'`);
    }
  });

  test("A20: a digest planted in a FAKE artefact never reaches the header", async () => {
    // The attacker model ADR-0012's amendment fixes: whoever controls a
    // build controls the `<script>` tags in it, so a build-owned hash file
    // would let a build widen its own `script-src`. The Worker reads ONE
    // file — the committed one — and this asserts a hash that is absent
    // from it stays absent, no matter what an artefact claims.
    const fakeArtifact = { sha256: { [HOSTILE_DIGEST]: "a build wrote me" } };
    const attackerHashes = Object.keys(fakeArtifact.sha256);
    expect(attackerHashes).toEqual([HOSTILE_DIGEST]);
    const csp = cspOf(applyHtmlHeaders(new Response("<!doctype html>"), ctx()));
    expect(csp).not.toContain(hexToBase64(HOSTILE_DIGEST));
    // And a ctx built FROM the fake artefact does carry it — so the
    // assertion above is about the allowlist choice, not about a redactor
    // that would swallow every hash either way.
    const poisoned = workerHeaderContext({
      origin: ORIGIN,
      version: VERSION,
      inlineScriptHashes: attackerHashes,
    });
    expect(cspOf(applyHtmlHeaders(new Response("x"), poisoned))).toContain(hexToBase64(HOSTILE_DIGEST));
  });

  test("A20: the Worker's ONLY allowlist import is the committed release artefact", async () => {
    // A structural guard rather than a comment: if a future slice adds a
    // second `import` of a hash file — say one discovered from a preview
    // artefact — this goes red.
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .*from "([^"]+)"/gm)].map((m) => m[1] ?? "");
    const hashish = imports.filter((specifier) => /allowlist|hash/i.test(specifier));
    expect(hashish).toEqual(["../../cli/src/dist-check-allowlist.json"]);
  });

  // ── A21 ───────────────────────────────────────────────────────────────
  test("A21: an SVG response carries `sandbox` AND `Content-Disposition: inline`", async () => {
    const response = applySvgHeaders(new Response("<svg/>"), ctx());
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    // Hygiene too — an SVG is still a response.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("A21: the re-exported minimal builder is the shared one, not a second copy", async () => {
    expect(reexportedMinimal).toBe(buildMinimalCspHeader);
    expect(buildMinimalCspHeader("xml")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  // ── A22 ───────────────────────────────────────────────────────────────
  test("A22: script-src names exactly the current version's bundle path", async () => {
    const csp = cspOf(applyHtmlHeaders(new Response("<!doctype html>"), ctx()));
    expect(csp).toContain(`${ORIGIN}/_revkit/${VERSION}/`);
  });

  test("A22: `latest` and a trailing-slash alias are refused at path construction", async () => {
    // ADR-0012: `/_revkit/` never redirects (a browser drops the path part
    // of a CSP source after a redirect, which would widen script-src), so
    // an alias must not even be constructible.
    expect(() => revkitBundlePath("latest")).toThrow(/non-version or redirecting alias/);
    expect(() => revkitBundlePath("1.4.0/")).toThrow(/non-version or redirecting alias/);
    expect(() => revkitBundlePath("")).toThrow(/non-version or redirecting alias/);
    expect(revkitBundlePath("1.4.0")).toBe("/_revkit/1.4.0/");
  });

  test("A22: the hosted policy names no worker-src and no eval", async () => {
    const csp = cspOf(applyHtmlHeaders(new Response("<!doctype html>"), ctx()));
    // Slice 1 serves no Web Worker, so an emitted `worker-src 'self'`
    // would let a stored HTML start one from ANY path on the origin.
    expect(csp).not.toContain("worker-src");
    // ADR-0012's script-src has no eval at all; only the narrow WASM
    // keyword is ever present.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  // ── the origin decision ───────────────────────────────────────────────
  test("the script origin comes from the address the request arrived on", async () => {
    // ADR-0008 makes the hostname per-org configuration, so it cannot be a
    // constant. Deriving it from the request cannot widen `script-src`
    // past the document's own origin, and the version-scoped PATH — the
    // part ADR-0012 actually constrains — is fixed.
    expect(requestOrigin(new Request("https://review.exoma.org/x/y"))).toBe("https://review.exoma.org");
    const csp = cspOf(
      applyHtmlHeaders(
        new Response("x"),
        workerHeaderContext({ origin: "https://other-org.example", version: VERSION, inlineScriptHashes: [] }),
      ),
    );
    expect(csp).toContain(`https://other-org.example/_revkit/${VERSION}/`);
    expect(csp).not.toContain("review.exoma.org");
  });

  test("the request id header name is the one the Worker stamps", async () => {
    expect(REQUEST_ID_HEADER).toBe("x-revkit-request-id");
    const response = await harness.dispatch("http://localhost/healthz");
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
