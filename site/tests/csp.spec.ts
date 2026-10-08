// Playwright end-to-end for the ADR-0012 CSP + response hygiene on
// `revkit serve` (issue #22). Boots a real `revkit serve` subprocess
// against `site/dist` and walks the dogfood pages a reviewer will
// hit (an ADR, the math + plots page, the landing page), asserting
// that each carries the ADR-0012 CSP AND emits ZERO
// `securitypolicyviolation` events. Also drives the rail open on
// the ADR page so the CSP-live headers are exercised while the
// rail's own DOM is present.
//
// The daemon spawn plus `bootDaemon` / `shutdownDaemon` shape mirrors
// `daemon-cross-site.spec.ts` — every spawned pid is registered with
// the CLI test's daemon registry so the hygiene test can insist that
// spawned daemons were killed in `finally`.

import { bootDaemon as startTestDaemon, stopDaemon } from "./helpers/daemon.ts";
import { expect, test, type Page } from "@playwright/test";
import { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDaemonPid, unregisterDaemonPid } from "../../packages/cli/test/helpers/daemon-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly port: number;
  readonly launchUrl: string;
}

interface BootDaemonOptions {
  /** Files to write into the served `dist/`. */
  readonly pages: readonly { rel: string; body: string }[];
  /** Whole directories to copy verbatim out of the real built dist
   * (`site/dist/`). Used for `/pagefind/` and `/_astro/` in the
   * search spec; each copied directory shows up under the daemon's
   * served root at the same relative path. */
  readonly copyDistDirs?: readonly string[];
}

/** Spawn a daemon rooted at a temp `--dir` that carries the pages
 * (and optional real-build directories) the test needs. */
async function bootDaemon(options: BootDaemonOptions): Promise<DaemonCtx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-csp-e2e-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  // Package the tree the daemon will serve.
  for (const page of options.pages) {
    const abs = join(dist, page.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, page.body, "utf8");
  }
  for (const rel of options.copyDistDirs ?? []) {
    const src = join(DIST, rel);
    if (!existsSync(src)) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`CSP spec: ${rel} missing under site/dist; run \`just build\` first.`);
    }
    cpSync(src, join(dist, rel), { recursive: true });
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true, type: "module" }));

  const ctx = await startTestDaemon({ root, args: [REVKIT_BIN, "serve", "--port", "0", "--dir", dist] });
  registerDaemonPid(ctx.child.pid!);
  return ctx;
}

async function shutdownDaemon(ctx: DaemonCtx): Promise<void> {
  await stopDaemon(ctx.child);
  unregisterDaemonPid(ctx.child.pid!);
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Hook into the browser BEFORE navigation so `securitypolicyviolation`
 * listeners survive a page load. Playwright's `addInitScript` runs
 * on every new document, so `page.goto` cannot race the listener. */
async function collectCspViolations(page: Page): Promise<() => Promise<CspViolation[]>> {
  await page.addInitScript(() => {
    interface RevkitCspStore {
      __revkitCspViolations: Array<{
        blockedURI: string;
        violatedDirective: string;
        sourceFile: string;
        lineNumber: number;
        sample: string;
      }>;
    }
    const win = window as unknown as RevkitCspStore;
    win.__revkitCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const e = event as SecurityPolicyViolationEvent;
      win.__revkitCspViolations.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        sample: e.sample,
      });
    });
  });
  return async () => {
    return await page.evaluate(() => {
      const win = window as unknown as { __revkitCspViolations?: CspViolation[] };
      return win.__revkitCspViolations ?? [];
    });
  };
}

interface CspViolation {
  blockedURI: string;
  violatedDirective: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}

test.describe("ADR-0012 CSP + response hygiene on `revkit serve` @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(90_000);

  test("dogfood pages carry the CSP header and emit ZERO CSP violations", async ({ page }) => {
    // Copy in a representative selection of real built pages: the
    // landing page (Starlight's own bootstrap), a math+plots page
    // (KaTeX + Vega SVG + inline styles), an ADR (long-form doc
    // with anchors), and a design (larger doc). If a page doesn't
    // exist in the built dist we skip it — the build layout is
    // stable enough that all should be present.
    const candidates = [
      "index.html",
      "math-and-plots/index.html",
      "adr/0012-hosted-security-threat-model/index.html",
      "designs/design-0001-revkit-architecture/index.html",
    ];
    const pages: { rel: string; body: string }[] = [];
    for (const rel of candidates) {
      const abs = join(DIST, rel);
      if (existsSync(abs)) {
        pages.push({ rel, body: readFileSync(abs, "utf8") });
      }
    }
    expect(pages.length).toBeGreaterThan(0);
    // Copy Astro's chunk directory too — the page HTML references
    // `<script src="/_astro/…">`; without those files the browser
    // gets 404s and the page's own bootstrap never runs (masking
    // any late CSP violation).
    const daemon = await bootDaemon({ pages, copyDistDirs: ["_astro"] });
    try {
      for (const p of pages) {
        const readViolations = await collectCspViolations(page);
        const url = daemon.url + "/" + p.rel.replace(/index\.html$/, "");
        const response = await page.goto(url, { waitUntil: "networkidle" });
        expect(response, `no response for ${url}`).not.toBeNull();
        expect(response!.status(), `bad status for ${url}`).toBe(200);
        // CSP is EXACTLY what the header builder produced.
        const csp = response!.headers()["content-security-policy"];
        expect(csp, `no CSP on ${url}`).toBeDefined();
        expect(csp!).toContain("default-src 'none'");
        expect(csp!).toContain(`http://127.0.0.1:${daemon.port}/-/rail.js`);
        expect(csp!).toContain(`http://127.0.0.1:${daemon.port}/_astro/`);
        expect(csp!).toContain("connect-src 'self'");
        expect(csp!).toContain("frame-ancestors 'none'");
        // Hygiene triplet.
        expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
        expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
        expect(response!.headers()["cross-origin-opener-policy"]).toBe("same-origin");
        // Give the page a beat to run its Starlight bootstrap and
        // KaTeX / plot scripts so any late violation fires. The
        // math page uses `requestIdleCallback` for its plot init;
        // `waitUntil: networkidle` waits for the network, then we
        // explicitly wait for one animation frame + a small idle
        // slice.
        await page.waitForFunction(() => document.readyState === "complete");
        await page.waitForTimeout(200);
        const violations = await readViolations();
        expect(
          violations,
          `CSP violation(s) on ${url}: ${JSON.stringify(violations, null, 2)}`,
        ).toEqual([]);
      }
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("MUTATION: an inline <script> injected into a page fixture fires a CSP violation and does NOT run", async ({ page }) => {
    // Negative case: prove the CSP actively blocks. We serve a page
    // with an inline `<script>` whose HASH is NOT in our allowlist.
    // The daemon does not trust page HTML — CSP is set by the
    // daemon, not by the page. So the browser must refuse to
    // execute the inline script and MUST fire
    // `securitypolicyviolation`.
    const injected = `<!doctype html><html><head><title>injected</title></head>
      <body>
        <div id="target">before</div>
        <script id="attacker">document.getElementById('target').textContent = 'RAN';</script>
      </body></html>`;
    const daemon = await bootDaemon({ pages: [{ rel: "injected.html", body: injected }] });
    try {
      const readViolations = await collectCspViolations(page);
      const response = await page.goto(daemon.url + "/injected.html", { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      // The inline script must NOT have executed: the target text
      // stays at its default. This is the STRONGEST assertion — a
      // patch that widened `script-src` to `'unsafe-inline'` would
      // let the script run and this test flips red.
      const text = await page.locator("#target").textContent();
      expect(text).toBe("before");
      // And the browser fired at least one violation for the
      // inline `<script>` block.
      await page.waitForTimeout(100);
      const violations = await readViolations();
      expect(violations.length, "browser should have fired a securitypolicyviolation").toBeGreaterThan(0);
      expect(violations.some((v) => v.violatedDirective.startsWith("script-src"))).toBe(true);
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("browser tab on the daemon's origin: rail bundle loads + SSE + fetch(/api) work UNDER the CSP", async ({ page }) => {
    // Exercises the rail-shaped runtime paths with the CSP live:
    // the rail bundle is served from `/-/rail.js` (external, path-
    // allowed by `script-src`); its API POST goes to `/api/threads`
    // (same-origin, covered by `connect-src 'self'`), and the SSE
    // stream at `/events` runs under `connect-src`. Any tightening
    // that broke one of these paths would surface as a CSP
    // violation captured by the init-script listener.
    const landing = readFileSync(join(DIST, "index.html"), "utf8");
    const daemon = await bootDaemon({ pages: [{ rel: "index.html", body: landing }] });
    try {
      const readViolations = await collectCspViolations(page);
      // 1) Cookie-log in. The launch endpoint 302s to `/`; use
      //    `commit` (not `load` or `networkidle`) so the promise
      //    resolves at the redirect rather than trying to wait for
      //    an idle network on a page that keeps a `/events` SSE
      //    stream open.
      const authNav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 10_000 });
      expect(authNav?.status(), "auth redirect must land").toBeLessThan(400);
      // 2) Land on the injected landing page — the daemon appended
      //    `<script src="/-/rail.js">` via HTMLRewriter; the rail
      //    bundle then loads at this URL.
      const landingNav = await page.goto(daemon.url + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
      expect(landingNav?.status()).toBe(200);
      // 3) From the page's own origin, drive:
      //    - a same-origin `fetch('/api/threads')` (browsers OMIT
      //      Origin on a no-cors same-origin GET),
      //    - a same-origin `EventSource('/events')` — the SSE path
      //      the rail's runtime uses.
      //    Both are `connect-src 'self'` fetches; either would
      //    trigger a CSP violation if the directive were narrower.
      const outcome = await page.evaluate(async () => {
        const apiResponse = await fetch("/api/threads");
        const es = new EventSource("/events");
        const opened = await new Promise<boolean>((resolve) => {
          es.addEventListener("open", () => resolve(true), { once: true });
          es.addEventListener("error", () => resolve(false), { once: true });
          setTimeout(() => resolve(false), 3000);
        });
        es.close();
        return { opened, apiStatus: apiResponse.status };
      });
      expect(outcome.apiStatus, "same-origin API GET must succeed under the CSP").toBe(200);
      expect(outcome.opened, "same-origin EventSource must open under the CSP").toBe(true);
      // Let any late script activity finish before reading the
      // violation log.
      await page.waitForTimeout(200);
      const violations = await readViolations();
      expect(
        violations,
        `CSP fired while the browser tab exercised the API/SSE: ${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("Starlight search (pagefind) loads, returns a result, and fires ZERO CSP violations", async ({ page, context }) => {
    // Load a real Starlight page whose HTML carries the search
    // trigger + `<site-search>` custom element, plus the full
    // `/_astro/` and `/pagefind/` trees. Then open search (kbd
    // shortcut `/`), type a word we know is in the docs, and
    // assert at least one result appears — proving that:
    //   - `/pagefind/pagefind.js` loaded under `script-src`
    //   - Pagefind's Worker spawned under the path-scoped
    //     `worker-src http://…/pagefind/` (M2 item 5b: no other Worker
    //     src can spawn)
    //   - The .pagefind WASM instantiated under `'wasm-unsafe-eval'`
    //   - The .pf_meta / .pf_index / .pf_fragment blobs fetched
    //     under `connect-src 'self'` and served with an
    //     `application/octet-stream` MIME (no `nosniff` refusal)
    // If any of those pieces regressed, the search box shows
    // "no results" or a CSP violation fires — both flip this test.
    const landingHtml = readFileSync(join(DIST, "index.html"), "utf8");
    const daemon = await bootDaemon({
      pages: [{ rel: "index.html", body: landingHtml }],
      copyDistDirs: ["_astro", "pagefind"],
    });
    try {
      const readViolations = await collectCspViolations(page);
      // Capture console errors: if pagefind's Worker throws while
      // compiling the wasm or fetching the index, the browser
      // reports it on the main-thread console. Surfacing those in
      // the failure message keeps CI diagnosable.
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const loc = msg.location();
          consoleErrors.push(`${msg.text()} @ ${loc.url}:${loc.lineNumber}`);
        }
      });
      const requestFailures: string[] = [];
      page.on("requestfailed", (req) => {
        requestFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`);
      });
      const httpErrors: string[] = [];
      const pagefindResponses: string[] = [];
      // `page.on("response")` sees main-thread and Worker responses
      // in recent Playwright, but the Worker's `fetch` goes through
      // the browser context's network stack; `context.on` catches
      // both. Register on the context so Pagefind's Worker fetches
      // (`/pagefind/*.pf_meta`, `/pagefind/wasm.en.pagefind`) are
      // captured too.
      context.on("response", (resp) => {
        if (resp.status() >= 400) httpErrors.push(`${resp.status()} ${resp.request().method()} ${resp.url()}`);
        if (resp.url().includes("/pagefind/")) pagefindResponses.push(`${resp.status()} ${resp.url()}`);
      });
      await page.goto(daemon.url + "/", { waitUntil: "domcontentloaded" });
      // Open Starlight's search dialog by clicking its
      // `data-open-modal` button (the keyboard shortcut is
      // Cmd/Ctrl+K, but the click path is more deterministic
      // across platforms). The button lives inside the
      // `<site-search>` custom element in the top nav.
      await page.locator("site-search button[data-open-modal]").click();
      // Starlight's Search.astro loads Pagefind's UI lazily on
      // dialog open; the actual `<input>` is `pagefind-ui__search-input`,
      // rendered by Pagefind into the `<dialog>` body after
      // `/pagefind/pagefind-ui.js` finishes fetching + running.
      const searchInput = page.locator("site-search dialog[open] input.pagefind-ui__search-input");
      await searchInput.waitFor({ state: "visible", timeout: 10_000 });
      await searchInput.fill("channel");
      // Pagefind is worker-driven; give it a beat to fetch its
      // .pf_meta / wasm blob, run the query, and paint results.
      // Assert on the search results list Pagefind's own UI
      // component populates. The Starlight processResult wrapper
      // strips the `.pagefind-ui__result-link` class in some
      // versions; accept either the class OR any `<a>` that carries
      // an `href` inside the results list Pagefind renders.
      const anyResultLink = page.locator("site-search dialog[open] .pagefind-ui__results a[href]");
      try {
        await anyResultLink.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch (e) {
        // Enrich the failure with browser-side context so a CI
        // failure is diagnosable without a headed run.
        const diagBody = await page.locator("site-search dialog[open]").innerHTML().catch(() => "<no dialog>");
        const violations = await readViolations();
        throw new Error(
          `pagefind result never appeared.\n` +
            `CSP violations: ${JSON.stringify(violations, null, 2)}\n` +
            `console errors: ${JSON.stringify(consoleErrors, null, 2)}\n` +
            `request failures: ${JSON.stringify(requestFailures, null, 2)}\n` +
            `HTTP >=400 responses: ${JSON.stringify(httpErrors, null, 2)}\n` +
            `pagefind responses: ${JSON.stringify(pagefindResponses, null, 2)}\n` +
            `dialog inner HTML: ${diagBody.slice(0, 3000)}\n` +
            `original: ${(e as Error).message}`,
        );
      }
      const resultCount = await anyResultLink.count();
      expect(resultCount, "pagefind must return at least one result for 'channel'").toBeGreaterThan(0);
      // No CSP violations while search compiled, spawned a Worker,
      // fetched .pagefind assets, and rendered results.
      const violations = await readViolations();
      expect(
        violations,
        `CSP fired during pagefind search: ${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("localhost:<port> works too: same CSP shape, same rail bundle loads, no violations", async ({ page }) => {
    // The daemon accepts both `127.0.0.1:<port>` and
    // `localhost:<port>` as valid Host / Origin values. If the CSP
    // named only the 127.0.0.1 alias, opening the daemon at
    // `http://localhost:<port>/` would refuse the rail bundle
    // load (`/-/rail.js` at the localhost origin is a different
    // URL from the CSP's 127.0.0.1 source). Prove both aliases
    // work with a fresh landing page fetched over `localhost`.
    const landing = readFileSync(join(DIST, "index.html"), "utf8");
    const daemon = await bootDaemon({
      pages: [{ rel: "index.html", body: landing }],
      copyDistDirs: ["_astro"],
    });
    try {
      const readViolations = await collectCspViolations(page);
      const localhostUrl = `http://localhost:${daemon.port}/`;
      const response = await page.goto(localhostUrl, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      const csp = response!.headers()["content-security-policy"]!;
      // Both aliases named in the header.
      expect(csp).toContain(`http://127.0.0.1:${daemon.port}/-/rail.js`);
      expect(csp).toContain(`http://localhost:${daemon.port}/-/rail.js`);
      await page.waitForTimeout(200);
      const violations = await readViolations();
      expect(
        violations,
        `CSP fired on localhost:<port> load: ${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("BYTE-EXACT: the CSP header on a served HTML page matches the pinned shape", async ({ page }) => {
    // A byte-exact assertion catches ordering drifts and stray
    // whitespace that `toContain` would miss. The Playwright test
    // asserts against the header the browser actually received;
    // the unit test in `test/serve/headers.test.ts` asserts on
    // the pure builder output.
    const landing = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
    const daemon = await bootDaemon({ pages: [{ rel: "index.html", body: landing }] });
    try {
      const response = await page.goto(daemon.url + "/", { waitUntil: "domcontentloaded" });
      const csp = response!.headers()["content-security-policy"]!;
      // The set of committed inline-script hashes lives in
      // `packages/cli/src/dist-check-allowlist.json`. Load it from
      // disk here so the test tracks whatever the CLI ships with.
      const allowlistJson = JSON.parse(
        readFileSync(resolve(__dirname, "..", "..", "packages", "cli", "src", "dist-check-allowlist.json"), "utf8"),
      ) as { sha256: Record<string, unknown> };
      const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
      const sortedHashes = Array.from(new Set(Object.keys(allowlistJson.sha256))).sort();
      const hashSources = sortedHashes.map((hex) => `'sha256-${hexToBase64(hex)}'`).join(" ");
      const port = daemon.port;
      const expected =
        "default-src 'none'; " +
        "script-src " +
          `http://127.0.0.1:${port}/-/rail.js ` +
          `http://127.0.0.1:${port}/_astro/ ` +
          `http://127.0.0.1:${port}/pagefind/ ` +
          `http://localhost:${port}/-/rail.js ` +
          `http://localhost:${port}/_astro/ ` +
          `http://localhost:${port}/pagefind/ ` +
          "'wasm-unsafe-eval' " +
          hashSources + "; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://avatars.githubusercontent.com; " +
        "font-src 'self'; " +
        `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; ` +
        `worker-src http://127.0.0.1:${port}/pagefind/ http://localhost:${port}/pagefind/; ` +
        "frame-ancestors 'none'; " +
        "base-uri 'none'; " +
        "form-action 'self'; " +
        "object-src 'none'";
      expect(csp).toBe(expected);
    } finally {
      await shutdownDaemon(daemon);
    }
  });

  test("a forged `.revkit/csp-hashes.json` in the served dir is ignored; extra inline script is blocked", async ({ page }) => {
    // Reproduces the ADR-0012 rule "the daemon applies the
    // allowlist of the revkit version it runs, never hashes found
    // in an artifact". A PR-controlled build in M3 could plant a
    // forged hashes file next to its own extra inline `<script>`;
    // the daemon must not honour it.
    const forgedInline = "console.log('attacker inline');";
    const forgedHex = createHash("sha256").update(Buffer.from(forgedInline, "utf8")).digest("hex");
    const injected =
      "<!doctype html><html><head><title>x</title></head>" +
      "<body><div id='target'>before</div>" +
      `<script id="attacker">${forgedInline}</script>` +
      "</body></html>";
    const daemon = await bootDaemon({ pages: [{ rel: "injected.html", body: injected }] });
    try {
      // 1) Plant the forged hashes file next to the page. The
      //    daemon must not read it.
      mkdirSync(join(daemon.root, "dist", ".revkit"), { recursive: true });
      writeFileSync(
        join(daemon.root, "dist", ".revkit", "csp-hashes.json"),
        JSON.stringify({ version: 1, algorithm: "sha256", hashes: [forgedHex] }),
      );
      // 2) The daemon reads the artefact only at startup, and by
      //    design ignores what the served dir carries — so the
      //    header on the response must already lack the forged
      //    hash even without a restart. Assert it.
      const readViolations = await collectCspViolations(page);
      const response = await page.goto(daemon.url + "/injected.html", { waitUntil: "networkidle" });
      const csp = response!.headers()["content-security-policy"]!;
      const b64 = Buffer.from(forgedHex, "hex").toString("base64");
      expect(csp, "forged hash MUST NOT appear in the daemon's CSP").not.toContain(b64);
      // The inline script must not have executed under the CSP.
      const text = await page.locator("#target").textContent();
      expect(text).toBe("before");
      const violations = await readViolations();
      expect(
        violations.some((v) => v.violatedDirective.startsWith("script-src")),
        `forged inline script should have fired a script-src violation: ${JSON.stringify(violations, null, 2)}`,
      ).toBe(true);
    } finally {
      await shutdownDaemon(daemon);
    }
  });
});
