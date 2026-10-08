import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rail from "../../src/rail/bundle.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

test("rail build completes before serve state is published or startup returns", async () => {
  rail._resetRailBundleForTests();
  const originalBuild = rail.buildRailBundle;
  let completed = false;
  const build = spyOn(rail, "buildRailBundle").mockImplementation(async () => {
    const bundle = await originalBuild();
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
    completed = true;
    return bundle;
  });
  const root = mkdtempSync(join(tmpdir(), "revkit-rail-ready-"));
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>Ready</title></head><body><h1>Ready</h1></body></html>");
  let completedAtAnnouncement = false;
  let handle: DaemonHandle | undefined;
  try {
    handle = await startDaemon({
      dir: dist, repoRoot: root, port: 0, sqlitePath: ":memory:",
      version: "0.0.0-test", localUserId: "test", installSignalHandlers: false,
      logSink: { write: (line) => {
        if (line.includes('"serve.start"')) completedAtAnnouncement = completed;
      } },
    });
    expect(completedAtAnnouncement).toBe(true);
    expect(build.mock.calls.length).toBe(1);
    const result = build.mock.results[0]!;
    expect(result.type).toBe("return");
    const bundle = await (result.value as Promise<rail.RailBundle>);
    const response = await fetch(`${handle.url}/-/rail.js`, {
      headers: { authorization: `Bearer ${handle.agentToken}` },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bundle.js));
  } finally {
    await handle?.stop();
    build.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
