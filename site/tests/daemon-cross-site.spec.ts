// Playwright reproduction of the round-1 blocker on
// `feature/7-revkit-serve` (#36): a page on ANOTHER loopback port
// runs `new WebSocket("ws://127.0.0.1:<daemon>/events")` and, absent
// the Origin check on the WebSocket upgrade, receives live comment
// frames — cookies flow because browsers do not partition cookies
// by port. This spec asserts the WebSocket handshake is refused
// when driven by a real headless Chromium.
//
// The test spawns its own `revkit serve` subprocess (independent of
// Playwright's `webServer`, which serves the built site) and a
// second Bun.serve that hosts a one-page attacker HTML on a
// different loopback port. The attacker page tries the hijack; the
// spec waits for the browser to report the outcome and asserts the
// WebSocket did NOT open.
import { bootDaemon, stopDaemon } from "./helpers/daemon.ts";
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

test.describe("cross-site WebSocket hijack", () => {
  test("a page on another loopback port cannot open a WebSocket to /events", async ({ page }) => {
    // Fresh temp directory as the daemon's --dir and its .revkit/
    // root. The CLI's `runServeCommand` looks up the workspace root
    // by walking up for a `package.json` named "revkit"; drop that
    // marker in the temp dir so the daemon uses IT as its repoRoot
    // (its `.revkit/serve.json` lands under this temp tree, not the
    // real repo).
    const root = mkdtempSync(join(tmpdir(), "revkit-hijack-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<h1>daemon</h1>");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true, type: "module" }));

    const cliBin = resolve(import.meta.dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
    const info = await bootDaemon({
      root, args: [cliBin, "serve", "--port", "0", "--dir", dist], timeoutMs: 10_000,
    });
    const daemon = info.child;

    let daemonPort = 0;
    let launchUrl = "";
    try {
      const daemonInfo = info;
      daemonPort = daemonInfo.port;
      launchUrl = daemonInfo.launchUrl;

      // Attacker page on a DIFFERENT loopback port — same site
      // (`127.0.0.1`) as the daemon so the browser sends cookies.
      const attackerHtml = `<!doctype html>
<html><body>
<div id="outcome">pending</div>
<script>
(async () => {
  // Give a browser session a chance to acquire the daemon's cookie
  // by fetching the launch URL first (a real attack shape: user
  // visited the daemon earlier, cookie is in the jar).
  try {
    await fetch(${JSON.stringify(launchUrl)}, { credentials: "include", mode: "no-cors" });
  } catch {}
  const outcome = document.getElementById("outcome");
  try {
    const ws = new WebSocket("ws://127.0.0.1:${daemonPort}/events");
    ws.addEventListener("open",  () => { outcome.textContent = "OPENED"; });
    ws.addEventListener("close", (e) => {
      if (outcome.textContent === "pending") outcome.textContent = "CLOSED:" + e.code;
    });
    ws.addEventListener("error", () => {
      if (outcome.textContent === "pending") outcome.textContent = "ERROR";
    });
  } catch (e) {
    outcome.textContent = "THROW:" + String(e);
  }
})();
</script>
</body></html>`;

      const attacker = await startAttackerServer(attackerHtml);
      try {
        await page.goto(`http://127.0.0.1:${attacker.port}/`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.getElementById("outcome")?.textContent !== "pending",
          { timeout: 5000 },
        );
        const outcome = await page.locator("#outcome").textContent();
        // The attack must NOT have succeeded. `OPENED` would mean the
        // browser upgraded the connection and could now read live
        // comment frames — the bug the reviewer reproduced.
        expect(outcome, `cross-site WebSocket should not have opened; got '${outcome}'`).not.toBe("OPENED");
      } finally {
        await new Promise<void>((r) => attacker.server.close(() => r()));
      }
    } finally {
      await stopDaemon(daemon);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Launch a tiny HTTP server on 127.0.0.1 (random port) that returns
 * one HTML document to any request. Node's `http` module rather than
 * `Bun.serve` because Playwright runs test files under Node. */
async function startAttackerServer(html: string): Promise<{ server: HttpServer; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("attacker server bound to no address");
  return { server, port: address.port };
}
