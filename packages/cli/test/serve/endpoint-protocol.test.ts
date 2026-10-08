// Independent wire regression: only uses APIs available on dev, so the
// RED run reaches the old strict request schema rather than failing imports.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { startDaemon } from "../../src/serve/daemon.ts";

test("leaf endpoints without client quote select the second rendered entity/literal occurrence", async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-endpoint-wire-"));
  const source = "A &amp; B and A & B";
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "docs/probe.md"), source);
  writeFileSync(join(root, "dist/index.html"), "<main>probe</main>");
  const daemon = await startDaemon({ dir: join(root, "dist"), repoRoot: root, port: 0, sqlitePath: ":memory:", version: "0.0.0-test", localUserId: "u", installSignalHandlers: false, logSink: { write: () => {} } });
  try {
    const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const revision = await revisionOf(source);
    const leaf = `v1-${createHash("sha256").update("docs/probe.md\0" + source).digest("hex")}-0-19`;
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST", headers: { cookie, origin: daemon.url, "content-type": "application/json" },
      body: JSON.stringify({ anchor: { path: "docs/probe.md", startLine: 1, endLine: 1, revision }, body: "The second copy", selection: { kind: "range", version: 1, revision, start: { leaf, offset: 10 }, end: { leaf, offset: 15 } } }),
    });
    expect(response.status).toBe(201);
    const { event } = await response.json() as { event: { anchor: Anchor } };
    expect(event.anchor.quote).toEqual({ exact: "A & B", prefix: "A &amp; B and ", suffix: "" });
    expect([event.anchor.startLine, event.anchor.endLine]).toEqual([1, 1]);
    expect(event.anchor.revision).toBe(revision);
  } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});
