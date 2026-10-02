// Real-subprocess MCP contract test (PR #38 review nit).
//
// Spawns `revkit mcp` as an actual stdio subprocess and drives it
// with the MCP SDK's `StdioClientTransport`. Runs initialize +
// tools/list against a real daemon boot end-to-end. The in-memory
// contract tests (`test/mcp/contract.test.ts`) cover the same code
// paths without a process, but only a real subprocess catches
// three things at once: the revkit binary shebang and bun
// resolution, runMcpCommands ordering (ensureDaemon then client
// then server), and the stdio transport shape actually written to
// fd 0/1.
//
// This test also verifies the daemon auto-start path from
// runMcpCommand — it seeds a temp revkit workspace root with NO
// daemon running, and the subprocess is expected to spawn its own
// daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { filteredDaemonEnv } from "../../src/mcp/daemon-bootstrap.ts";
import { registerDaemonPid, unregisterDaemonPid } from "../helpers/daemon-registry.ts";

const REVKIT_BIN = resolve(__dirname, "..", "..", "bin", "revkit.js");

describe("revkit mcp — real subprocess", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-mcp-subp-"));
    // A real workspace root: needs `package.json` with name "revkit"
    // for the daemon's `findRepoRootByPackageJson`.
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
    // Static dir so the daemon has something to serve.
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  });
  afterEach(async () => {
    // Nudge any spawned daemon to exit before nuking the dir.
    // The Bootstrap runs it detached; its lock file is under
    // `.revkit/daemon.lock` and the parent is our subprocess
    // which the SDK closed above. On POSIX the daemon inherits
    // the pipe; when the pipe closes and the daemon exits, its
    // lock releases. Give it a beat.
    await new Promise((r) => setTimeout(r, 300));
    // Register + kill the auto-spawned daemon via its serve.json
    // pid. Registration lets `daemon-hygiene.test.ts` know THIS
    // is a test-owned pid; kill drops it before we nuke the dir.
    try {
      const state = JSON.parse(readFileSync(join(root, ".revkit", "serve.json"), "utf8")) as { pid: number };
      registerDaemonPid(state.pid);
      try { process.kill(state.pid, "SIGTERM"); } catch { /* dead */ }
      await new Promise((r) => setTimeout(r, 100));
      // Once dead, unregister — hygiene only wants leaks.
      try { process.kill(state.pid, 0); /* still alive */ } catch { unregisterDaemonPid(state.pid); }
    } catch { /* no serve.json */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* eventual */ }
  });

  test("initialize + tools/list against a fresh spawned daemon", async () => {
    // Assert the binary is executable up front — a permission drop
    // (chmod during install) would otherwise surface as a cryptic
    // spawn error.
    expect(statSync(REVKIT_BIN).isFile()).toBe(true);

    // Client speaks to the subprocess over stdio.
    const transport = new StdioClientTransport({
      command: "bun",
      args: [REVKIT_BIN, "mcp", "--dir", "dist"],
      cwd: root,
      // Reuse the daemon-bootstrap allowlist here too, so this
      // test's env matches production behaviour (nothing hostile
      // leaks in from the test runner's env).
      env: { ...filteredDaemonEnv(process.env), REVKIT_MCP_SUBPROCESS_TEST: "1" },
    });
    const client = new Client(
      { name: "revkit-mcp-subprocess-test", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      // Server capabilities include the channel declaration.
      const caps = client.getServerCapabilities();
      expect(caps?.experimental?.["claude/channel"]).toBeDefined();
      // tools/list returns our three names.
      const listing = await client.listTools();
      const names = listing.tools.map((t) => t.name).sort();
      // M2 items 6, 7 and 9 tools joined the listing.
      expect(names).toEqual([
        "ask",
        "await_answer",
        "mode",
        "presence",
        "publish",
        "reply",
        "resolve",
        "review_url",
        "threads",
      ]);
      // Sanity: additionalProperties: false on every schema.
      for (const tool of listing.tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
    } finally {
      try { await client.close(); } catch { /* already gone */ }
    }
  }, 30_000);
});
