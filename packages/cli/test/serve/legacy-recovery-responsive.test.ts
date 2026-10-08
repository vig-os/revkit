import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, isLineAnchor, type Anchor } from "@revkit/review-core";
import { startDaemon } from "../../src/serve/daemon.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";

const PATH = "docs/probe.md";

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-responsive-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, PATH), source);
  writeFileSync(join(root, "dist/index.html"), "<main>fixture</main>");
  return root;
}

test("a depth-1000 legacy quote POST keeps a 50 ms heartbeat responsive", async () => {
  const source = "- ".repeat(1000) + "deep x";
  const root = fixture(source);
  const daemon = await startDaemon({ dir: join(root, "dist"), repoRoot: root, port: 0, sqlitePath: ":memory:", version: "0.0.0-test", localUserId: "u", installSignalHandlers: false, logSink: { write: () => {} } });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const revision = await revisionOf(source);
    let last = performance.now();
    const gaps: number[] = [];
    timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 50);
    await new Promise((done) => setTimeout(done, 60));
    const before = gaps.length;
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST", headers: { cookie, origin: daemon.url, "content-type": "application/json" },
      body: JSON.stringify({ anchor: { path: PATH, startLine: 1, endLine: 1, revision, quote: { exact: "deep", prefix: "", suffix: "" } }, body: "A deep comment" }),
    });
    expect(response.status).toBe(201);
    const { event } = await response.json() as { event: { anchor: Anchor } };
    expect(event.anchor.quote.exact).toBe("deep");
    // Observe the first timer after POST too: a fast response can arrive
    // before the next heartbeat, and a stalled loop must count its gap.
    await new Promise((done) => setTimeout(done, 60));
    expect(gaps.length).toBeGreaterThan(before);
    // 500 ms permits scheduling/rendering jitter (10 heartbeat periods),
    // while detecting the former ~70 s synchronous recovery stall.
    expect(Math.max(...gaps)).toBeLessThan(500);
  } finally {
    if (timer !== undefined) clearInterval(timer);
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild yields to the event loop between legacy threads", async () => {
  const source = "before **deep** after";
  const root = fixture(source);
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const bus = new EventBus();
  const service = startReanchorDaemon({ store, bus, repoRoot: root, logger: makeLogger({ sink: { write: () => {} } }) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivered = 0;
  let deliveredAtTick = -1;
  const detach = bus.subscribe({ close() {}, deliver(event) {
    if (event.kind !== "thread.reanchored") return;
    delivered++;
    if (delivered === 1) timer = setTimeout(() => { deliveredAtTick = delivered; }, 0);
  } });
  try {
    const revision = await revisionOf(source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision, quote: { exact: "before deep after", prefix: "", suffix: "" } };
    store.putSnapshot(revision, source);
    for (let i = 0; i < 40; i++) await store.append({ kind: "comment.created", actor: { kind: "local", id: "u" }, threadId: `legacy-${i}`, commentId: `comment-${i}`, body: "Legacy comment", anchor });
    writeFileSync(join(root, PATH), source + "\n\nUnrelated paragraph.");
    await service.refresh(PATH);
    await new Promise((done) => setTimeout(done, 0));
    expect(delivered).toBe(40);
    expect(deliveredAtTick).toBeGreaterThanOrEqual(1);
    expect(deliveredAtTick).toBeLessThan(40);
    for (const thread of await store.threads()) {
      expect(thread.status).toBe("open");
      expect(isLineAnchor(thread.anchor) && thread.anchor.quote.exact).toBe(source);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach();
    await service.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
