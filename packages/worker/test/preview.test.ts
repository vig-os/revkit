// ADR-0012's preview-path rules, over workerd (issue #101).
//
// The control this file exists for is ADR-0012's FIRST Decision bullet:
//
//   > **Preview paths never serve executable content.** Under `/<repo>/pr-<n>/`
//   > the Worker serves only HTML, JSON, images (PNG/JPEG/WebP/AVIF) and
//   > fonts; `.js`, `.mjs`, `.css`, `.wasm` and anything else are refused. SVG is
//   > served with `Content-Security-Policy: sandbox` and
//   > `Content-Disposition: inline` so it can't run script.
//
// and its hygiene clause, "the Worker derives `Content-Type` from the file
// extension against its own allowlist, never from artifact or object metadata".
//
// Before this slice the Worker answered `501` on every preview path, so none of
// that was provable — a header shape existed with no route that served content,
// which is the shape of a control that reads as present and is inert. What was
// missing is itemised in `gh issue view 101`.
//
// ── WHY ONE HARNESS, AND WHY IT IS THE WRAPPING ONE ─────────────────────────
//
// "The R2 binding is never called" is not observable from outside workerd: an R2
// bucket has no request log, and a refused path and a read of a missing object
// produce the same 404 with the same empty body. So this file runs the REAL
// Worker with ONE binding replaced by a counter
// (`test/fixtures/preview-spy.ts` — it imports `src/index.ts` and calls the real
// `fetch`; nothing but `env.PREVIEWS` differs). That costs a workerd instance,
// and `test/harness.ts` records the measured budget this host tolerates, so this
// file has exactly one and reuses it for everything — including the pure
// allowlist cases, which need no runtime at all.
//
// The counter is pinned by a CONTRAST case below: same harness, same session,
// same bucket, and `reads` goes 0 → 0 for a refused path and 0 → 1 for an
// allowlisted one. A counter stuck at zero would make every "never called"
// assertion here true for the wrong reason, and that is the failure mode a
// counting wrapper creates.
//
// ── WHAT IS NOT HERE, AND WHERE IT IS ───────────────────────────────────────
//
// The UPLOAD side. Nothing in this Worker writes to the bucket: CI publishing a
// PR-head build, the bucket's provisioning and the credential that could do
// either are separate issues. So a write verb on a preview path is still 405
// (`#96`'s read-verbs-only rule), and the rest of the gate's matrix lives in
// `test/authorization.test.ts` and `test/invites.test.ts` rather than here.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { classifyRoute } from "../src/authz.ts";
import { BROWSER_COOKIE_NAME, mintInvite, redeemInvite } from "../src/invites.ts";
import {
  ALLOWED_PREVIEW_EXTENSIONS,
  PREVIEW_INDEX_OBJECT,
  PREVIEW_MEDIA_TYPES,
  PREVIEW_REFUSALS,
  previewTargetFor,
  type PreviewRefusal,
} from "../src/preview-assets.ts";
import { previewScopePath } from "../src/router.ts";
import { SESSION_COOKIE_NAME, mintToken } from "../src/session.ts";
import {
  PREVIEW_SPY_READS_PATH,
  PREVIEW_SPY_RESET_PATH,
  authHeaders,
  clearPreviews,
  issueTestSession,
  previewSpyBundle,
  readWranglerConfig,
  resetInvites,
  startWorker,
  testTokenHasher,
  type Harness,
} from "./harness.ts";

/** The review every case in this file serves. One spelling, built by the same
 *  `previewScopePath` the route's scope uses, so the key a case seeds and the
 *  key the Worker reads cannot be two hand-written strings that happen to agree
 *  today. */
const REPO = "revkit";
const PR = 7;
const SCOPE = previewScopePath(REPO, PR);
/** The R2 key `<repo>/pr-<n>/index.html` — DESIGN-0001 §6.1's layout, and the
 *  object the review's own trailing slash resolves to. */
const INDEX_KEY = `${REPO}/pr-${PR}/${PREVIEW_INDEX_OBJECT}`;
/** `REVKIT_VERSION` as `wrangler.jsonc` pins it, so the `script-src` assertion
 *  below compares against the SHIPPED var rather than against a literal that
 *  could drift from it. `wrangler.jsonc` is the source for the Worker too. */
const VERSION = (readWranglerConfig()["vars"] as Record<string, string>)["REVKIT_VERSION"] as string;

/** The stored metadata a PR's build pipeline would attach. **`text/javascript`
 *  under `index.html` is the case this file's centre exists for**: if any line of
 *  the handler read `httpMetadata`, this object would be served as script on the
 *  revkit-owned origin, at the one path a reviewer is invited to open. */
const HOSTILE_METADATA = {
  httpMetadata: { contentType: "text/javascript; charset=utf-8" },
  customMetadata: { contenttype: "text/html", kind: "html" },
} as const;

/** What the seeded preview document says, and what each seeded asset says.
 *  Markers rather than real content: a case asserts on its OWN bytes and against
 *  every other review's, which is how "this object and not that one" is checked
 *  instead of merely "not empty". */
const DOCUMENT = "<!doctype html><title>revkit preview</title><p>PR-HEAD-MARKER</p>";

let harness: Harness;
let keys: Awaited<ReturnType<typeof testTokenHasher>>;

beforeAll(async () => {
  harness = await startWorker({ script: await previewSpyBundle() });
  keys = await testTokenHasher();
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await clearPreviews(harness.previews);
  await resetInvites(harness.db);
  await resetSpy();
});

/** Zero the counter, through its own route, so a case cannot "reset" by not
 *  looking. */
async function resetSpy(): Promise<void> {
  const response = await harness.dispatch(`http://localhost${PREVIEW_SPY_RESET_PATH}`, { method: "POST" });
  expect(response.status).toBe(204);
}

interface SpyReads {
  readonly reads: number;
  readonly keys: readonly string[];
}

async function spyReads(): Promise<SpyReads> {
  const response = await harness.dispatch(`http://localhost${PREVIEW_SPY_READS_PATH}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SpyReads;
}

/** A URL inside this file's review. */
function previewUrl(objectPath: string): string {
  return `http://localhost${SCOPE}/${objectPath}`;
}

/** Seed one object under the layout's key. The bytes and the stored media type
 *  are both explicit, because a case about "typed from the path" has to be able
 *  to store a type that disagrees with the path. */
async function seedPreview(
  key: string,
  body: string,
  options: { readonly httpMetadata?: R2HTTPMetadata; readonly customMetadata?: Record<string, string> } = {},
): Promise<void> {
  await harness.previews.put(key, body, options);
}

/** The dispatch response type, taken from the harness rather than named, for the
 *  same reason `Harness.dispatch` does: `bun`'s and `@cloudflare/workers-types`'
 *  declarations of `Response` disagree (one has `textStream`, the other does
 *  not), and a local name for it would import that disagreement into every case
 *  in this file. */
type DispatchResponse = ReturnType<Harness["dispatch"]>;

async function get(path: string, headers: Record<string, string>): Promise<DispatchResponse> {
  return harness.dispatch(path, { headers });
}

// ── the allowlist, as data ─────────────────────────────────────────────────
//
// Pure, so these run against the same function the Worker calls with no runtime
// in the way. The HTTP cases below then prove the Worker's answers agree with
// this table.

describe("ADR-0012's allowlist is DATA, and it is the ADR's list", () => {
  test("every extension maps to exactly one media type and one response kind", () => {
    expect(PREVIEW_MEDIA_TYPES).toEqual({
      html: { contentType: "text/html; charset=utf-8", kind: "html" },
      json: { contentType: "application/json; charset=utf-8", kind: "json" },
      svg: { contentType: "image/svg+xml", kind: "svg" },
      png: { contentType: "image/png", kind: "asset" },
      jpg: { contentType: "image/jpeg", kind: "asset" },
      jpeg: { contentType: "image/jpeg", kind: "asset" },
      webp: { contentType: "image/webp", kind: "asset" },
      avif: { contentType: "image/avif", kind: "asset" },
      woff: { contentType: "font/woff", kind: "asset" },
      woff2: { contentType: "font/woff2", kind: "asset" },
    });
  });

  test("the served set is the ADR's families and nothing else", () => {
    // ADR-0012: "HTML, JSON, images (PNG/JPEG/WebP/AVIF) and fonts", plus SVG by
    // its own sentence. Asserted as an EXACT set, so a later slice that adds one
    // has to change this line rather than grow the table quietly — and so `.xml`
    // and `.txt`, the two a build emits most often and the ADR names least, are
    // visibly absent rather than accidentally so.
    expect([...ALLOWED_PREVIEW_EXTENSIONS]).toEqual([
      "avif",
      "html",
      "jpeg",
      "jpg",
      "json",
      "png",
      "svg",
      "webp",
      "woff",
      "woff2",
    ]);
    // The four the ADR names by hand as refused, plus the spellings a browser or
    // a CDN might produce for the same content.
    for (const absent of ["js", "mjs", "cjs", "css", "wasm", "xml", "txt", "map"]) {
      expect(ALLOWED_PREVIEW_EXTENSIONS, absent).not.toContain(absent);
    }
  });

  test("every extension resolves to its own media type through the function the Worker calls", () => {
    for (const extension of ALLOWED_PREVIEW_EXTENSIONS) {
      const expected = PREVIEW_MEDIA_TYPES[extension];
      expect(expected, extension).toBeDefined();
      if (expected === undefined) continue;
      const decision = previewTargetFor(SCOPE, `${SCOPE}/page.${extension}`);
      expect(decision.kind, extension).toBe("serve");
      if (decision.kind !== "serve") continue;
      expect(decision.target.key, extension).toBe(`${REPO}/pr-${PR}/page.${extension}`);
      expect(decision.target.contentType, extension).toBe(expected.contentType);
      expect(decision.target.kind, extension).toBe(expected.kind);
    }
  });

  test("a `.constructor` extension is a MISS, not a prototype member", () => {
    // The reason the lookup is a `Map` and not a property read: the extension is
    // attacker-chosen, and `MEDIA_TYPES["constructor"]` on a plain object is
    // `Object`'s own constructor — a non-undefined value for an extension nobody
    // allowlisted. Over HTTP this arrives as `/x.constructor`.
    const decision = previewTargetFor(SCOPE, `${SCOPE}/x.constructor`);
    expect(decision).toEqual({ kind: "refused", reason: "extension-not-allowlisted" });
  });
});

// ── the refusal set, and that it happens BEFORE the R2 read ────────────────

describe("a refused path is a 404 with no body, and the bucket is never read", () => {
  /** Every spelling ADR-0012's bullet names, plus the ones only a careful reader
   *  would think of: the case variants, the compound name, the trailing dot, and
   *  the two forms of a bare name.
   *
   *  **`.js` is in this list and is the point of the issue.** A PR that ships its
   *  own script under a preview path is the isolation failure ADR-0012 names
   *  first, and the assertion is not "404" — it is "404, no body, and the counter
   *  did not move". */
  const REFUSED: readonly (readonly [string, string, PreviewRefusal])[] = [
    ["a script", "app.js", "extension-not-allowlisted"],
    ["a module script", "app.mjs", "extension-not-allowlisted"],
    ["a stylesheet", "site.css", "extension-not-allowlisted"],
    ["a wasm module", "engine.wasm", "extension-not-allowlisted"],
    ["a double extension whose LAST extension is executable", "page.html.js", "extension-not-allowlisted"],
    ["an uppercase executable extension", "APP.JS", "extension-not-allowlisted"],
    ["an uppercase ALLOWED extension", "LOGO.PNG", "extension-not-allowlisted"],
    ["mixed case on the extension only", "logo.Png", "extension-not-allowlisted"],
    ["an Object.prototype member as the extension", "x.constructor", "extension-not-allowlisted"],
    ["no extension at all", "README", "no-extension"],
    ["a name that is nothing but an extension", ".html", "no-extension"],
    ["a trailing slash on a directory-ish name", "docs/", "no-extension"],
    ["a trailing dot", "index.html.", "trailing-dot"],
    ["a bare directory name", "docs", "no-extension"],
  ];

  for (const [label, objectPath, reason] of REFUSED) {
    test(`${label} — \`${objectPath}\``, async () => {
      // Seed the object the path WOULD name, so the refusal cannot pass because
      // the bucket was empty: a handler that read first and refused afterwards
      // would serve these bytes, and this case would fail on the body.
      await seedPreview(`${REPO}/pr-${PR}/${objectPath}`, "SHOULD-NEVER-BE-SERVED");
      const issued = await issueTestSession(harness.db);
      const before = await spyReads();
      const response = await get(previewUrl(objectPath), authHeaders(issued));
      expect(response.status, label).toBe(404);
      // **No body at all.** Not a JSON error, not an empty string with a length.
      expect(await response.text(), label).toBe("");
      // ADR-0012's hygiene still applies — a 404 is a response a browser renders
      // — and `no-store` is on it because an intermediary that cached this would
      // keep answering it after a push that published the object.
      expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(response.headers.get("cache-control"), label).toBe("no-store");
      // **The load-bearing assertion.** Zero, not "no more than before": a
      // refusal that consulted the bucket once would still answer 404 and still
      // answer with no body.
      expect(await spyReads(), label).toEqual({ reads: before.reads, keys: before.keys });
      expect(before.reads, "the counter is live — see the contrast case below").toBe(0);
      // The path's SHAPE is the reason, and it is one of the closed vocabulary's
      // members. Asserted here so a case cannot drift from the reason it claims.
      expect(PREVIEW_REFUSALS as readonly string[], label).toContain(reason);
      expect(previewTargetFor(SCOPE, `${SCOPE}/${objectPath}`), label).toEqual({ kind: "refused", reason });
    });
  }

  test("the refusal REASONS are one closed list", () => {
    expect([...PREVIEW_REFUSALS].sort()).toEqual([
      "doubled-slash",
      "encoded-separator",
      "extension-not-allowlisted",
      "no-extension",
      "scope-mismatch",
      "trailing-dot",
      "traversal",
    ]);
  });

  test("CONTRAST: the same harness, session and bucket DO read an allowlisted path", async () => {
    // Without this the whole group is vacuous — a counter stuck at zero makes
    // every "never called" above true for the wrong reason. Same session, same
    // bucket, one key, and the counter moves by exactly one, naming the key the
    // layout says it should be.
    await seedPreview(INDEX_KEY, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(await spyReads()).toEqual({ reads: 1, keys: [INDEX_KEY] });
  });

  test("a path the GRAMMAR refuses is the surface's existing 404, and also reads nothing", async () => {
    // The other half of the refusal story, and a DIFFERENT mechanism: an encoded
    // separator, a `..` that escapes and a doubled slash are refused by
    // `parsePreviewPath` before the route is classified, so these are `unknown` —
    // the surface's existing JSON 404 — rather than the preview handler's empty
    // one. Asserted as the separate answer it is, because "every preview-ish path
    // 404s with no body" would be a claim about two refusals, and this is the one
    // that is not the allowlist's.
    const issued = await issueTestSession(harness.db);
    for (const objectPath of ["index%2ehtml", "docs%2findex.html", "docs%5cindex.html", "../index.html", "docs//index.html"]) {
      const response = await get(previewUrl(objectPath), authHeaders(issued));
      expect(response.status, objectPath).toBe(404);
      expect(await response.json(), objectPath).toMatchObject({ error: "not-found" });
    }
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });
  });

  test("the three SHAPE refusals are the allowlist's second line, and the grammar is the first", async () => {
    // `doubled-slash`, `encoded-separator` and `traversal` cannot be reached over
    // HTTP, and it is worth saying so rather than letting the table imply they
    // can: `parsePreviewPath` refuses all three before `classifyRoute` returns
    // `preview`, so no request carrying one ever reaches this handler. They are
    // pinned by calling the function directly, because the property that makes
    // them safe — "the key is never built from a path that could address another
    // review's object" — is a property of THIS module and not of the one that
    // happens to run first.
    for (const [objectPath, reason] of [
      ["docs//index.html", "doubled-slash"],
      ["index%2ehtml", "encoded-separator"],
      ["../index.html", "traversal"],
    ] as const) {
      expect(previewTargetFor(SCOPE, `${SCOPE}/${objectPath}`), objectPath).toEqual({ kind: "refused", reason });
      // And the grammar's own answer, which is what a request actually meets.
      expect(classifyRoute(`${SCOPE}/${objectPath}`, "GET").kind, objectPath).toBe("unknown");
    }
  });

  test("normalisation aliases serve BYTE-IDENTICAL content under ONE key", async () => {
    // **Aliases, and inert — the same treatment `/_revkit/`'s four spellings get.**
    // A WHATWG path removes single-dot segments and treats a backslash as a
    // separator, so three spellings normalise ONTO `docs/index.html` and read one
    // key. They cannot diverge, because the key comes from the normalised
    // pathname and there is only one object behind it. Asserted rather than
    // argued, and the counter is what shows they are the same read.
    await seedPreview(`${REPO}/pr-${PR}/docs/index.html`, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    for (const alias of ["docs/index.html", "./docs/index.html", "docs/./index.html", "docs\\index.html"]) {
      await resetSpy();
      const response = await get(previewUrl(alias), authHeaders(issued));
      expect(response.status, alias).toBe(200);
      expect(await response.text(), alias).toBe(DOCUMENT);
      expect(await spyReads(), alias).toEqual({ reads: 1, keys: [`${REPO}/pr-${PR}/docs/index.html`] });
    }
  });

  test("`%2e%2e` normalises onto ANOTHER review, and the scope check follows it there", async () => {
    // **The alias that is not inert-looking, so it gets its own case.** A URL
    // spec decodes `%2e` inside a path segment far enough to recognise `..`, so
    // `/revkit/pr-7/%2e%2e/pr-8/index.html` is a request for **pr-8** by the time
    // anything in this Worker sees it. That is safe because the scope travels
    // WITH the normalised path — `Route.scope` is derived from the same string the
    // key is — so a guest scoped to pr-7 is refused on the pr-8 spelling and an
    // operator reads pr-8's object. What would NOT be safe is a scope derived from
    // the spelling and a key derived from the normalisation, and this case pins
    // that both come from the same one.
    const issued = await issueTestSession(harness.db);
    await seedPreview(`${REPO}/pr-8/index.html`, "PR-8-MARKER");
    await seedPreview(INDEX_KEY, DOCUMENT);
    const aliased = await get(previewUrl("%2e%2e/pr-8/index.html"), authHeaders(issued));
    expect(aliased.status).toBe(200);
    expect(await aliased.text()).toBe("PR-8-MARKER");
    expect(await spyReads()).toEqual({ reads: 1, keys: [`${REPO}/pr-8/index.html`] });

    // And a guest scoped to pr-7 is refused on it, so the alias is not a way
    // around the scope gate.
    await resetSpy();
    const guest = await guestFor(REPO, PR);
    const refused = await get(previewUrl("%2e%2e/pr-8/index.html"), { cookie: guest });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "invite-scope-mismatch" });
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });
  });
});

// ── ADR-0012: the type comes from the PATH, never from the object ──────────

describe("Content-Type is derived from the request path, never from object metadata", () => {
  test("an object whose stored contentType is `text/javascript` is served as HTML", async () => {
    await seedPreview(INDEX_KEY, DOCUMENT, { httpMetadata: HOSTILE_METADATA.httpMetadata, customMetadata: HOSTILE_METADATA.customMetadata });
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(DOCUMENT);
  });

  test("the same object under a `.png` name is served as PNG, whatever its metadata says", async () => {
    // The other direction of the same rule: the metadata is not outvoted for
    // HTML, it is not read at all. `customMetadata` says `text/html` here and
    // the answer is `image/png`, because the path ends in `.png`.
    await seedPreview(`${REPO}/pr-${PR}/logo.png`, "PNG-BYTES", {
      httpMetadata: HOSTILE_METADATA.httpMetadata,
      customMetadata: HOSTILE_METADATA.customMetadata,
    });
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl("logo.png"), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("PNG-BYTES");
  });

  test("an object with NO metadata at all is typed the same way — the PATH is the source", async () => {
    // The complement, and it is what rules out "the hostile case passed because
    // the metadata was only partly read": a bare object is typed identically.
    await seedPreview(`${REPO}/pr-${PR}/data.json`, '{"ok":true}');
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl("data.json"), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // `nosniff` is what makes the derived type load-bearing rather than
    // advisory — without it a browser may run the response as something else.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe('{"ok":true}');
  });
});

// ── the full directive set, on the RESPONSE ────────────────────────────────

describe("a preview document carries ADR-0012's FULL CSP on the response", () => {
  test("every directive the ADR names is on the served document, not only on the header module", async () => {
    await seedPreview(INDEX_KEY, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), authHeaders(issued));
    expect(response.status).toBe(200);
    // Asserted on the RESPONSE, the way `test/invites.test.ts` asserts it for the
    // invite page. Asserting `buildCspHeader` in isolation would stay green if a
    // route reached for the wrong wrapper, which is the defect this clause is
    // about: a header shape that exists with no route that serves content.
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp, "default-src").toContain("default-src 'none'");
    expect(csp, "style-src").toContain("style-src 'self' 'unsafe-inline'");
    expect(csp, "img-src").toContain("img-src 'self' data: https://avatars.githubusercontent.com");
    expect(csp, "font-src").toContain("font-src 'self'");
    expect(csp, "connect-src").toContain("connect-src 'self'");
    expect(csp, "frame-ancestors").toContain("frame-ancestors 'none'");
    expect(csp, "base-uri").toContain("base-uri 'none'");
    expect(csp, "form-action").toContain("form-action 'self'");
    expect(csp, "object-src").toContain("object-src 'none'");
    // `script-src` names revkit's OWN bundle path and nothing else. A PR's
    // document cannot load a script at all, which is ADR-0012's second Decision
    // bullet and the reason refusing a `.js` is a second line of defence rather
    // than the only one.
    //
    // **The ORIGIN is not asserted, deliberately.** `workerHeaderContext` takes
    // the origin from `request.url`, and miniflare addresses the Worker on a
    // loopback port of its own choosing, so the origin here is an artefact of the
    // harness rather than a property of this route. The PATH is the part ADR-0012
    // constrains, and it is asserted exactly.
    const scriptSrc = directive(csp, "script-src");
    expect(scriptSrc).toContain(`/_revkit/${VERSION}/`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    // **And it names exactly ONE path.** The whole content of ADR-0012's
    // `/_revkit/` rule is that `script-src` is pinned to a version directory
    // rather than to the origin root, so a widening to `/` — which a denylist
    // would happily accept — has to fail here.
    expect(directive(csp, "script-src").split(" ").filter((source) => source.includes("/_revkit/")).length).toBe(1);
    // The narrow WASM keyword IS in the policy — pre-existing, and recorded in
    // ADR-0012's slice-5b amendment. Asserted so its absence would also be a
    // change rather than something nobody had looked at.
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // `style-src` may name `'unsafe-inline'`; `script-src` may not. `directive()`
    // is what makes that a statement about one directive rather than about words
    // appearing somewhere in the header.
    expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
    // And the hygiene quartet plus Permissions-Policy, which is every response's
    // — a preview document is the surface a reviewer most wants to embed.
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // `no-store`, and for the KEY's reason rather than the bytes': `pr-7` names a
    // different document after every push, so nothing here may be cached.
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The bytes are the ones that were stored, and the request id is on the
    // answer (ADR-0020) — a preview is the surface a reviewer quotes from.
    expect(await response.text()).toBe(DOCUMENT);
    expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/** One directive's value out of a CSP header. */
function directive(csp: string, name: string): string {
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed === name || trimmed.startsWith(`${name} `)) return trimmed.slice(name.length).trim();
  }
  return "";
}

// ── SVG: the sandbox, on a real response ───────────────────────────────────

describe("a served SVG carries `sandbox` AND `Content-Disposition: inline`", () => {
  test("with the minimal CSP, and bytes that really do carry a script", async () => {
    await seedPreview(`${REPO}/pr-${PR}/plot.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl("plot.svg"), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    // ADR-0012: "SVG is served with `Content-Security-Policy: sandbox` and
    // `Content-Disposition: inline` so it can't run script." Both — and on a
    // response that really is an SVG, where `applySvgHeaders` had exactly one
    // reference in the package before this slice: its own definition.
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toBe("inline");
    // The MINIMAL policy, deliberately: the full ADR-0012 CSP on an SVG would
    // name `script-src`, which is not a relaxation but is not what this rule is
    // for, and the minimal one is what carries `sandbox`.
    expect(csp).not.toContain("script-src");
    // The bytes carry a `<script>` — the reason the case exists is that they can.
    expect(await response.text()).toContain("<script>alert(1)</script>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ── images and fonts: the asset policy ─────────────────────────────────────

describe("images and fonts take the ASSET policy: typed, no CSP, no-store", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["logo.png", "image/png"],
    ["logo.jpg", "image/jpeg"],
    ["logo.jpeg", "image/jpeg"],
    ["logo.webp", "image/webp"],
    ["logo.avif", "image/avif"],
    ["inter.woff", "font/woff"],
    ["inter.woff2", "font/woff2"],
  ];

  for (const [name, contentType] of CASES) {
    test(`${name} is ${contentType}, with NO CSP of its own`, async () => {
      await seedPreview(`${REPO}/pr-${PR}/${name}`, "ASSET-BYTES");
      const issued = await issueTestSession(harness.db);
      const response = await get(previewUrl(name), authHeaders(issued));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      // **No CSP, and that is the shared policy's rule rather than an omission:**
      // browsers apply the EMBEDDING DOCUMENT's CSP to subresource loads, so a
      // `default-src 'none'` here would deny the document's own load of the very
      // asset it asked for. The document's `default-src 'none'` is the control.
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("ASSET-BYTES");
    });
  }
});

// ── the key layout, and what it prevents ───────────────────────────────────

describe("the key layout is `<repo>/pr-<n>/<path>`, and one review cannot read another's", () => {
  test("an object under a nested path is served at exactly that URL", async () => {
    await seedPreview(`${REPO}/pr-${PR}/docs/guide/index.html`, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl("docs/guide/index.html"), authHeaders(issued));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    expect(await spyReads()).toEqual({ reads: 1, keys: [`${REPO}/pr-${PR}/docs/guide/index.html`] });
  });

  test("the review's own trailing slash resolves to its `index.html`", async () => {
    // The redemption's `303` target is `<repo>/pr-<n>/`, so without this the
    // product's own entry point would be refused for having no extension.
    await seedPreview(INDEX_KEY, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    const response = await get(`http://localhost${SCOPE}/`, authHeaders(issued));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    expect(await spyReads()).toEqual({ reads: 1, keys: [INDEX_KEY] });
  });

  test("another PR's object is not reachable from this review's path", async () => {
    await seedPreview(`${REPO}/pr-99/index.html`, "PR-99-MARKER");
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), authHeaders(issued));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PR-99-MARKER");
    // And the key it asked for is THIS review's — the partition stated as an
    // observation rather than as a claim about the layout.
    expect(await spyReads()).toEqual({ reads: 1, keys: [INDEX_KEY] });
  });

  test("another repository's object is not reachable either", async () => {
    await seedPreview("other-repo/pr-7/index.html", "OTHER-REPO-MARKER");
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), authHeaders(issued));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("OTHER-REPO-MARKER");
  });

  test("a missing object is a 404 with no body — the same answer as a refusal", async () => {
    const issued = await issueTestSession(harness.db);
    const response = await get(previewUrl("nothing-here.html"), authHeaders(issued));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    // It DID read — which is what tells this apart from the refusal group, and
    // is why the two cannot be confused by a caller.
    expect(await spyReads()).toEqual({ reads: 1, keys: [`${REPO}/pr-${PR}/nothing-here.html`] });
  });

  test("a query string is not part of the key, and the counter says so", async () => {
    // Two spellings of one object, and inert: the key comes from the PATHNAME,
    // the scope check ran on that same path, and two requests that read one key
    // cannot get different bytes. Asserted rather than argued, the way the
    // `/_revkit/` normalisation aliases are.
    await seedPreview(INDEX_KEY, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    const response = await get(`${previewUrl(PREVIEW_INDEX_OBJECT)}?v=2`, authHeaders(issued));
    expect(response.status).toBe(200);
    expect(await spyReads()).toEqual({ reads: 1, keys: [INDEX_KEY] });
  });
});

// ── verbs, and the gate in front of everything ─────────────────────────────

describe("verbs and the gate are unchanged by this surface gaining content", () => {
  test("HEAD is GET without a body, and every other verb is still 405 with no read", async () => {
    await seedPreview(INDEX_KEY, DOCUMENT);
    const issued = await issueTestSession(harness.db);
    const head = await harness.dispatch(previewUrl(PREVIEW_INDEX_OBJECT), {
      method: "HEAD",
      headers: authHeaders(issued),
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    // The headers a HEAD exists to return are asserted on it: the type and the
    // policy are what a client decides whether to GET on.
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("content-security-policy")).toContain("default-src 'none'");
    // One read for the pair, not two.
    expect(await spyReads()).toEqual({ reads: 1, keys: [INDEX_KEY] });

    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      await resetSpy();
      const response = await harness.dispatch(previewUrl(PREVIEW_INDEX_OBJECT), {
        method,
        headers: authHeaders(issued),
      });
      expect(response.status, method).toBe(405);
      expect(await response.json(), method).toMatchObject({ error: "method-not-allowed" });
      // A verb with no route reads nothing either — the 405 is made before the
      // handler, so it cannot have consulted the bucket to find that out.
      expect(await spyReads(), method).toEqual({ reads: 0, keys: [] });
    }
  });

  test("no session is 401 and no read — the gate is in front of the bucket", async () => {
    await seedPreview(INDEX_KEY, DOCUMENT);
    const response = await get(previewUrl(PREVIEW_INDEX_OBJECT), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "no-session-cookie" });
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });
  });

  test("a GUEST out of scope is 403 and no read; an in-scope guest is served, and one guest cannot cross into another's review", async () => {
    // The property that would be lost if preview serving had been added as an
    // ungated route, or as one the scope check did not reach. A guest session is
    // minted the way ADR-0009's own flow mints one — `mintInvite` +
    // `redeemInvite`, both library functions with no HTTP caller — because the
    // open/redeem round trip is `test/invites.test.ts`'s fixture and a second copy
    // of it here would be a second thing to keep in step.
    await seedPreview(INDEX_KEY, DOCUMENT);
    await seedPreview(`${REPO}/pr-99/index.html`, "PR-99-MARKER");
    const guest = await guestFor(REPO, PR);
    const other = await guestFor(REPO, 99);
    const otherScope = previewScopePath(REPO, 99);

    // In scope: this review's own document.
    const served = await get(previewUrl(PREVIEW_INDEX_OBJECT), { cookie: guest });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(DOCUMENT);

    // Out of scope: 403 with the gate's own reason, and the bucket untouched —
    // the refusal happens before any handler, so no key is ever built.
    await resetSpy();
    const refused = await get(`http://localhost${otherScope}/index.html`, { cookie: guest });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "invite-scope-mismatch" });
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });

    // And the mirror image: the guest scoped to pr-99 reads THAT one, and cannot
    // reach pr-7. Two guests, one bucket, one partition.
    const theirs = await get(`http://localhost${otherScope}/index.html`, { cookie: other });
    expect(theirs.status).toBe(200);
    expect(await theirs.text()).toBe("PR-99-MARKER");
    await resetSpy();
    const crossed = await get(previewUrl(PREVIEW_INDEX_OBJECT), { cookie: other });
    expect(crossed.status).toBe(403);
    expect(await spyReads()).toEqual({ reads: 0, keys: [] });
  });

  test("the spy's own paths are not routes on the shipped Worker", async () => {
    // So the count this file trusts cannot be confused with a product answer, and
    // so a reader can see the wrapper adds no reachable surface.
    for (const path of [PREVIEW_SPY_READS_PATH, PREVIEW_SPY_RESET_PATH]) {
      const route = classifyRoute(path, "GET");
      expect(route.kind, path).toBe("unknown");
      expect(route.requiresSession, path).toBe(false);
    }
  });
});

/** The `Cookie` header for a guest session scoped to one review.
 *
 *  `mintInvite` and `redeemInvite` are the two library functions ADR-0009's flow
 *  is made of, and neither has an HTTP route — so calling them directly produces
 *  exactly the state the gate reads, without this file re-implementing the
 *  open/redeem round trip. The binding is minted here and sent back in the
 *  cookie, because the gate re-reads it on every authorized call. */
async function guestFor(repo: string, pr: number): Promise<string> {
  const minted = await mintInvite(harness.db, { repo, pr }, { keys });
  if (!minted.ok) throw new Error(`mint failed: ${minted.refusal}`);
  const binding = mintToken();
  const redeemed = await redeemInvite(
    harness.db,
    { token: minted.minted.token, binding, displayName: "A Guest" },
    { keys },
  );
  if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.refusal}`);
  return `${SESSION_COOKIE_NAME}=${redeemed.issued.sessionId}; ${BROWSER_COOKIE_NAME}=${binding}`;
}
