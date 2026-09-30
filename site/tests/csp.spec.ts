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

import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDaemonPid, unregisterDaemonPid } from "../../packages/cli/test/helpers/daemon-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");
const CSP_ARTEFACT_REL = ".revkit/csp-hashes.json";

interface DaemonCtx {
  readonly child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly port: number;
  readonly launchUrl: string;
}

/** Spawn a daemon rooted at a temp `--dir` that COPIES two files out
 * of the real built dist: `index.html` (the landing page) and the
 * emitted `.revkit/csp-hashes.json` so the CSP `sha256-...` sources
 * include the real Starlight hashes.
 *
 * We do not point `--dir` at `site/dist` directly because
 * `daemon-cross-site.spec.ts` and `rail-roundtrip.spec.ts` do the
 * same thing (one temp root per daemon so `.revkit/daemon.lock` does
 * not collide with a real dogfood daemon running elsewhere). */
async function bootDaemon(pages: readonly { rel: string; body: string }[]): Promise<DaemonCtx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-csp-e2e-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  // Package the tree the daemon will serve.
  for (const page of pages) {
    const abs = join(dist, page.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, page.body, "utf8");
  }
  // Copy the real emitter's csp-hashes.json so the daemon's CSP
  // includes the Starlight inline-script hashes. If the artefact is
  // missing (a partial build), fail loudly here — the CSP spec is
  // meaningless without a real hash set.
  const artefactSrc = join(DIST, CSP_ARTEFACT_REL);
  if (!existsSync(artefactSrc)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `CSP spec: ${CSP_ARTEFACT_REL} missing under site/dist; run \`just build\` first.`,
    );
  }
  mkdirSync(join(dist, ".revkit"), { recursive: true });
  writeFileSync(join(dist, CSP_ARTEFACT_REL), readFileSync(artefactSrc));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true, type: "module" }));

  const child = spawn("bun", [REVKIT_BIN, "serve", "--port", "0", "--dir", dist], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerDaemonPid(child.pid!);
  let stdout = "";
  const chunks: string[] = [];
  child.stderr?.on("data", (b: Buffer) => chunks.push(b.toString("utf8")));
  child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
  const deadline = Date.now() + 15_000;
  let listenLine: RegExpMatchArray | null = null;
  let launchLine: RegExpMatchArray | null = null;
  while (Date.now() < deadline) {
    listenLine = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    launchLine = stdout.match(/launch:\s+(http:\/\/[^ \n]+)/);
    if (listenLine !== null && launchLine !== null) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (listenLine === null || launchLine === null) {
    child.kill("SIGTERM");
    unregisterDaemonPid(child.pid!);
    rmSync(root, { recursive: true, force: true });
    throw new Error(`daemon did not print listen+launch lines: stdout=${stdout}, stderr=${chunks.join("")}`);
  }
  const port = Number.parseInt(listenLine[1]!, 10);
  return { child, root, url: `http://127.0.0.1:${port}`, port, launchUrl: launchLine[1]! };
}

async function shutdownDaemon(ctx: DaemonCtx): Promise<void> {
  try { ctx.child.kill("SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 250));
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
    const daemon = await bootDaemon(pages);
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
    const daemon = await bootDaemon([{ rel: "injected.html", body: injected }]);
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
    const daemon = await bootDaemon([{ rel: "index.html", body: landing }]);
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
});
