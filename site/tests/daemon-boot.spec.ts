import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootDaemon, bootProcess, stopDaemon } from "./helpers/daemon.ts";

const CLI = resolve(import.meta.dirname, "../../packages/cli/bin/revkit.js");

for (let worker = 0; worker < 4; worker++) {
  test(`cold daemon ${worker}: readiness and first rail response`, async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-boot-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}');
    writeFileSync(join(root, "dist/index.html"), "<!doctype html><html><head><title>Boot</title></head><body><h1>Boot</h1></body></html>");
    const started = performance.now();
    const ctx = await bootDaemon({ root, args: [CLI, "serve", "--dir", join(root, "dist")] });
    try {
      const readyMs = Math.round(performance.now() - started);
      const requested = performance.now();
      const response = await fetch(`${ctx.url}/-/rail.js`, {
        headers: { authorization: `Bearer ${ctx.agentToken}` },
      });
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
      if (process.env.REVKIT_E2E_TIMINGS === "1") {
        console.log(`cold daemon ${worker}: ready=${readyMs}ms first-rail=${Math.round(performance.now() - requested)}ms`);
      }
    } finally {
      await stopDaemon(ctx.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("boot diagnostics distinguish a crash and redact credentials", async () => {
  await expect(bootProcess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("launch: http://localhost/-/auth?code=secret\\n"); process.stderr.write("crashed\\n"); process.exit(7)'],
    root: tmpdir(),
    ready: () => undefined,
  })).rejects.toThrow(/exited before readiness; elapsed=\d+ms; exitCode=7; signal=null; alive=false[\s\S]*crashed[\s\S]*code=\[redacted\]/);
});

test("boot diagnostics distinguish a live slow start", async () => {
  await expect(bootProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    root: tmpdir(),
    timeoutMs: 100,
    ready: () => undefined,
  })).rejects.toThrow(/timed out; elapsed=\d+ms; exitCode=null; signal=null; alive=true/);
});
