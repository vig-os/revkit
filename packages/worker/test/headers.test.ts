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
  CLIENT_ASSET_FILE,
  CLIENT_ASSET_MEDIA_TYPE,
  clientAssetDigest,
  clientAssetPath,
} from "../src/client-asset.ts";
import { INVITE_CLIENT_SCRIPT } from "../src/client-script.ts";
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

/** SHA-256 as lowercase hex, written out rather than imported so a case can
 * compute the digest of a RESPONSE BODY independently of the function that
 * named the URL it arrived at. */
async function digestOf(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

  // ── the client asset (M4 slice 5b): the first script the Worker serves ──
  //
  // Everything below shares THIS file's `harness`, deliberately. A second
  // `describe` with its own `startWorker()` would add a workerd instance to the
  // leg, and `test/harness.ts` records the measured cliff (five instances in one
  // process hangs the next file in `getD1Database` forever, on this host). The
  // asset is header policy, which is what this file is for, and a flat instance
  // count is worth more than a tidier file.
  describe("the client asset", () => {
    test("the exact content-addressed URL serves the exact committed bytes", async () => {
      const digest = await clientAssetDigest();
      expect(digest, "a SHA-256 hex digest").toMatch(/^[0-9a-f]{64}$/);
      const response = await harness.dispatch(`http://localhost${clientAssetPath(VERSION, digest)}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INVITE_CLIENT_SCRIPT);
      // Content-addressed means the NAME is the bytes: the same input must
      // always produce the same name, or the cache would be poisoned by a
      // rebuild that changed nothing.
      expect(await clientAssetDigest()).toBe(digest);
    });

    test("every other name under /_revkit/ is 404 — and never a redirect", async () => {
      const digest = await clientAssetDigest();
      const wrong = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
      const refused = [
        // No version segment, or the wrong one: ADR-0012 says `script-src`
        // names ONLY the current version so a page cannot load an older,
        // possibly vulnerable bundle.
        `/_revkit/${CLIENT_ASSET_FILE}`,
        "/_revkit/0.0.0/invite-deadbeef.js",
        `/_revkit/${VERSION.slice(0, -1)}0/${CLIENT_ASSET_FILE}`,
        // The same asset with the hash REMOVED — an unhashed alias would make
        // the content hash decorative, because a stable URL is what a browser
        // and every intermediary cache actually key on.
        `/_revkit/${VERSION}/invite.js`,
        `/_revkit/${VERSION}/invite-${wrong}.js`,
        // Right name, wrong extension: the media type is derived from the
        // extension against the Worker's OWN allowlist (ADR-0012), so a `.html`
        // or `.wasm` spelling of the same bytes must not resolve.
        `/_revkit/${VERSION}/invite-${digest}.mjs`,
        `/_revkit/${VERSION}/invite-${digest}.html`,
        // The version as a DIRECTORY: a trailing-slash alias would be the
        // redirect ADR-0012 forbids, because a browser drops the path part of
        // a CSP source after a redirect and `script-src` widens with it.
        `/_revkit/${VERSION}/`,
        `/_revkit/${VERSION}`,
        "/_revkit",
        "/_revkit/",
      ];
      for (const path of refused) {
        const response = await harness.dispatch(`http://localhost${path}`);
        // 3xx is the failure this whole list exists for: a redirect is how
        // `/_revkit/` would widen `script-src`.
        expect([301, 302, 303, 307, 308], `${path} must not redirect`).not.toContain(response.status);
        expect(response.status, path).toBe(404);
        expect(response.headers.get("location"), path).toBeNull();
      }
    });

    test("every verb on the asset is the same bytes or a 404, and nothing leaks review data", async () => {
      const digest = await clientAssetDigest();
      const exact = clientAssetPath(VERSION, digest);
      for (const method of ["GET", "HEAD", "POST", "PUT", "OPTIONS"]) {
        const response = await harness.dispatch(`http://localhost${exact}`, { method });
        expect([200, 404], `${method} ${exact}`).toContain(response.status);
      }
      // The route that leaks review data is path-scoped, and a preview path
      // must never be able to reach the asset grammar: `parsePreviewPath`
      // refuses `_revkit` as a repository name AND `classifyPath` tests the
      // bundle prefix FIRST, so there is no spelling of "serve me the script"
      // that arrives through `<repo>/pr-<n>/`.
      //
      // It is a GATED path, so the answer is 401 rather than 404 — which is the
      // stronger of the two, because it means the asset grammar is not even
      // reachable there without a session. What matters is asserted positively:
      // never a 200, and never a byte of the script.
      const viaPreview = await harness.dispatch(`http://localhost/scope-canary/pr-7/${CLIENT_ASSET_FILE}`);
      expect(viaPreview.status).not.toBe(200);
      expect([401, 404]).toContain(viaPreview.status);
      expect(await viaPreview.text(), "and not one byte of the script").not.toContain("replaceState");
    });

    test("the asset is served as JavaScript, with no CSP of its own and an immutable cache", async () => {
      const digest = await clientAssetDigest();
      const response = await harness.dispatch(`http://localhost${clientAssetPath(VERSION, digest)}`);
      expect(response.headers.get("content-type")).toBe(CLIENT_ASSET_MEDIA_TYPE);
      // ADR-0012: the media type comes from the extension against the
      // Worker's own allowlist, never from object metadata.
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      // `nosniff` is what makes that content type load-bearing rather than
      // advisory: without it a browser may run the response as HTML.
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // An ASSET carries no CSP of its own — the shared policy's rule, because
      // a `default-src 'none'` on a script response denies the document's own
      // load of it. `default-src 'none'` on the DOCUMENT is the control.
      expect(response.headers.get("content-security-policy")).toBeNull();
      // Content-addressed + version-scoped is what makes `immutable` true
      // rather than merely optimistic: a name that resolves always resolves to
      // these bytes for this version, and every other name is a 404.
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      // The hygiene quartet still applies — it is every response's.
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    });

    test("RED: script-src stays a PINNED PATH — no unsafe-inline, no nonce, no strict-dynamic", async () => {
      // The whole reason this slice keeps `script-src` a path allowlist is
      // that the page now loads a real external script and still needs nothing
      // looser. `default-src 'none'` survives; ADR-0012's policy module is
      // untouched.
      const scriptSrc = /script-src ([^;]*)/.exec(cspOf(applyHtmlHeaders(new Response("x"), ctx())))?.[1] ?? "";
      expect(scriptSrc).toContain(`${ORIGIN}/_revkit/${VERSION}/`);
      for (const loosener of [
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'self'",
        "*",
        "data:",
        "blob:",
        "strict-dynamic",
        "nonce-",
      ]) {
        expect(scriptSrc, scriptSrc).not.toContain(loosener);
      }

      // **The assertion that actually pins the narrowing, and it is here
      // because the first version of this test did not have it.** The list above
      // is a DENYLIST, and a mutation run proved a denylist is not enough:
      // adding `"/"` to `scriptPaths` — which widens `script-src` from one
      // pinned directory to the WHOLE ORIGIN, the exact regression ADR-0012's
      // path clause exists to prevent — left every test in this file green,
      // because none of those eight substrings appears in `${ORIGIN}/`.
      //
      // So the source list is compared as an EXACT SET instead. Any additional
      // path, origin, keyword or hash is now a red test, and so is a REMOVED
      // one — which matters just as much, since a `script-src` that stopped
      // naming the bundle path would silently stop constraining anything.
      expect(scriptSrc.split(" ")).toEqual([
        // The one pinned path, under the origin the request arrived on.
        `${ORIGIN}/_revkit/${VERSION}/`,
        // ADR-0012's narrow WASM keyword, and only that one.
        "'wasm-unsafe-eval'",
        // The committed inline allowlist, unchanged by this slice and still
        // sourced only from the committed release artefact (A20 above).
        ...COMMITTED_DIGESTS.map((digest) => `'sha256-${hexToBase64(digest)}'`),
      ]);
      // And the inline allowlist is genuinely still there.
      expect(COMMITTED_DIGESTS.length).toBeGreaterThan(0);
      for (const digest of COMMITTED_DIGESTS) {
        expect(scriptSrc).toContain(`'sha256-${hexToBase64(digest)}'`);
      }
    });

    test("the path `script-src` allowlists is the path the asset route serves under", async () => {
      // The pairing that makes the pinned path mean something, at the unit
      // level: `script-src` names `${ORIGIN}/_revkit/${VERSION}/`, and the one
      // URL that resolves under it is derived from the same `revkitBundlePath`.
      // The HTTP half — that the page's own `<script src>` equals the URL the
      // route answers — is in `test/invites.test.ts`, which mints an invite and
      // reads the real page.
      expect(revkitBundlePath(VERSION)).toBe(`/_revkit/${VERSION}/`);
      expect(clientAssetPath(VERSION, await clientAssetDigest()).startsWith(revkitBundlePath(VERSION))).toBe(true);
    });

    test("the filename IS the content address: the digest is SHA-256 of the served bytes", async () => {
      // The claim `immutable` and "a stale asset is a 404" both rest on, so it
      // is computed HERE from the response body rather than compared against the
      // function that produced the name. A digest function that drifted from
      // what it digested would leave both claims intact and both false.
      const digest = await clientAssetDigest();
      const served = await harness.dispatch(`http://localhost${clientAssetPath(VERSION, digest)}`);
      const body = await served.text();
      expect(await digestOf(body), "the digest in the filename is the digest of the body").toBe(digest);
      expect(clientAssetPath(VERSION, digest)).toContain(digest);
      // A content change moves the name, which is the only thing that makes the
      // "no staleness window" argument true rather than asserted.
      expect(clientAssetPath(VERSION, await digestOf(`${INVITE_CLIENT_SCRIPT}\n`))).not.toBe(clientAssetPath(VERSION, digest));
    });

    test("the served script carries neither of the two characters a template literal cannot hold", async () => {
      // `src/client-script.ts` embeds the browser source in a `String.raw`
      // template literal, so a backtick or a `${` in the OUTPUT would either
      // have ended the literal or survived into the served bytes. Neither is
      // possible today — the only `${` is the prefix substitution — and this is
      // what keeps that true on the next edit rather than leaving it to be
      // re-derived. A stray backtick in particular would be a syntax error in
      // the served file, i.e. a 200 that is not JavaScript.
      const body = await (await harness.dispatch(`http://localhost${clientAssetPath(VERSION, await clientAssetDigest())}`)).text();
      expect(body).not.toContain("`");
      expect(body).not.toContain("${");
      // …and it really is JavaScript: `new Function` compiles it. A page whose
      // only `<script src>` resolved to something unparsable would otherwise
      // pass every other assertion in this file.
      expect(() => new Function("window", body)).not.toThrow();
    });
  });
});
