// Playwright reproduction of the round-2 blocker on
// `feature/7-revkit-serve` (#36): a real headless Chromium logs in
// through the launch URL, then from the daemon's own origin does a
// `fetch('/api/threads')` and opens an `EventSource('/events')`.
// Both must succeed — browsers omit `Origin` on a same-origin GET
// and on `EventSource`, so an Origin-required check would return
// 403 for the daemon's own UI. The unit suite uses fetch with
// hand-set headers, which does NOT reproduce this, hence the
// Playwright reproduction.
//
// After the fetch and EventSource attach, the test POSTs a comment
// via the agent bearer (a bearer-authenticated caller does not need
// Sec-Fetch-Site) and asserts the browser's EventSource received it.
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.describe("same-origin daemon UI", () => {
  test("a browser tab on the daemon's own origin can fetch /api/threads and EventSource /events", async ({ page }) => {
    // Fresh temp directory as the daemon's --dir and its .revkit/
    // root. Drop a `package.json` named "revkit" so the CLI's
    // workspace-root lookup treats this tree as the root.
    const root = mkdtempSync(join(tmpdir(), "revkit-same-origin-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    // Serve an empty landing page from the daemon — the browser
    // stays on the daemon's origin while running the fetch and the
    // EventSource against relative URLs.
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><body><div id='outcome'>pending</div></body></html>",
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true, type: "module" }));
    // Seed the anchor's source file — the daemon computes
    // `anchor.revision` server-side and refuses an anchor pointing
    // at a non-existent file (PR #38 review).
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "x.md"), "# x\n\nhello\n");

    const cliBin = resolve(import.meta.dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
    const daemon = spawn("bun", [cliBin, "serve", "--port", "0", "--dir", dist], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let daemonPort = 0;
    let launchUrl = "";
    let agentToken = "";
    try {
      const info = await waitForDaemon(daemon);
      daemonPort = info.port;
      launchUrl = info.launchUrl;
      // The agent token lives in serve.json (mode 600). Read it.
      const serveJsonPath = join(root, ".revkit", "serve.json");
      const serveJson = JSON.parse(readFileSync(serveJsonPath, "utf8"));
      agentToken = String(serveJson.agentToken);
      expect(agentToken.length).toBeGreaterThan(0);

      // Step 1 — exchange the launch code for the session cookie.
      // Playwright follows the 302 and stores the cookie on the
      // page's context.
      await page.goto(launchUrl);
      // Confirm the cookie is set. `document.cookie` cannot see it
      // (HttpOnly), so we check via the context.
      const cookies = await page.context().cookies();
      const sessionCookie = cookies.find((c) => c.name === `revkit_session_${daemonPort}`);
      expect(sessionCookie, "session cookie should have been set by the launch exchange").toBeDefined();

      // Step 2 — same-origin fetch of /api/threads. Chromium sends
      // Sec-Fetch-Site: same-origin and OMITS Origin on this
      // no-cors same-origin GET.
      await page.goto(`http://127.0.0.1:${daemonPort}/`);
      const fetchStatus = await page.evaluate(async () => {
        const r = await fetch("/api/threads");
        return r.status;
      });
      expect(fetchStatus, "same-origin GET /api/threads from the daemon's tab must succeed").toBe(200);

      // Step 3 — open EventSource, then POST a comment via the
      // agent bearer, then wait for the frame to land in the ES.
      const receivedPromise = page.evaluate(
        (): Promise<string> =>
          new Promise((resolveInner, rejectInner) => {
            const es = new EventSource("/events");
            const timeout = setTimeout(() => {
              es.close();
              rejectInner(new Error("timeout waiting for EventSource frame"));
            }, 8000);
            es.onmessage = (ev) => {
              clearTimeout(timeout);
              es.close();
              resolveInner(String(ev.data));
            };
            es.onerror = () => {
              // EventSource fires "error" on 4xx open failure. If the
              // daemon rejects the connection, the message never
              // arrives and the timer fires. Log the readyState so
              // the test failure has context.
              (window as unknown as { __esError?: number }).__esError = es.readyState;
            };
            (window as unknown as { __esReady?: boolean }).__esReady = true;
          }),
      );
      // Give the EventSource a moment to open.
      await page.waitForFunction(() => (window as unknown as { __esReady?: boolean }).__esReady === true);
      // POST a comment via the agent bearer (allowed with no Origin
      // and no Sec-Fetch-Site — MCP-style caller).
      const postRes = await fetch(`http://127.0.0.1:${daemonPort}/api/threads`, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemonPort}`,
          authorization: `Bearer ${agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          anchor: {
            path: "docs/x.md",
            startLine: 1,
            endLine: 1,
            quote: { exact: "hi", prefix: "", suffix: "" },
            revision: "a".repeat(64),
          },
          body: "hello from playwright",
        }),
      });
      expect(postRes.status).toBe(201);
      const framePayload = await receivedPromise;
      const parsed = JSON.parse(framePayload) as { kind: string; body: string };
      expect(parsed.kind).toBe("comment.created");
      expect(parsed.body).toBe("hello from playwright");
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitForDaemon(child: ChildProcess): Promise<{ port: number; launchUrl: string }> {
  return new Promise((resolveOuter, rejectOuter) => {
    let stdout = "";
    let stderr = "";
    const outStream = child.stdout;
    const errStream = child.stderr;
    if (outStream === null || errStream === null) {
      rejectOuter(new Error("daemon stdio not piped"));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOuter(new Error(`daemon startup timeout. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    outStream.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const listen = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const launch = stdout.match(/launch:\s+(http:\/\/[^ \n]+)/);
      if (listen !== null && launch !== null) {
        clearTimeout(timer);
        resolveOuter({ port: Number.parseInt(listen[1] ?? "0", 10), launchUrl: launch[1] ?? "" });
      }
    });
    errStream.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectOuter(new Error(`daemon exited early (${code}). stdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}
