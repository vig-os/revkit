// PR #38 round-2 review — mutation G kill.
//
// The daemon must OVERRIDE any client-supplied `anchor.revision`
// with `revisionOf(source contents)`. Without that override, a
// client (the rail's rendered-text hash today, a manipulated
// tool tomorrow) can pin a thread to a revision that never
// existed — the M2 re-anchoring pipeline would then fuzzy-search
// against a source hash that has no relationship to the file's
// actual bytes.
//
// This test posts a comment with a hostile revision and asserts
// the daemon's returned event carries `revisionOf(seededSource)`
// instead. Under mutation G (comment out the override in
// `handleApi`'s `POST /api/threads`) the stored revision equals
// the client value and this test goes red.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

let daemon: DaemonHandle;
let root: string;
let cookie: string;
const SEEDED = "# X\n\nseed body line 3\nseed body line 4\n";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "revkit-rev-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0003.md"), SEEDED);
  daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
  });
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = response.headers.get("set-cookie") ?? "";
  const semi = raw.indexOf(";");
  cookie = raw.slice(0, semi === -1 ? undefined : semi).trim();
});
afterEach(async () => {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("daemon anchor revision — server-side override", () => {
  test("MUTATION G: a client-supplied revision is IGNORED; daemon returns revisionOf(source)", async () => {
    const clientRevision = "0".repeat(64); // valid shape, hostile value
    const anchor: Anchor = {
      path: "docs/adr/0003.md",
      startLine: 3,
      endLine: 3,
      quote: { exact: "seed body", prefix: "", suffix: "" },
      revision: clientRevision,
    };
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie,
        host: `127.0.0.1:${daemon.port}`,
        origin: daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "hi" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      event: { anchor: { revision: string } };
    };
    const expectedRevision = await revisionOf(SEEDED);
    // The RETURNED anchor's revision MUST equal revisionOf(source),
    // not the client-supplied value.
    expect(body.event.anchor.revision).toBe(expectedRevision);
    expect(body.event.anchor.revision).not.toBe(clientRevision);
  });
});
