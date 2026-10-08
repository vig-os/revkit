import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImmediate, setImmediate } from "node:timers";
import { revisionOf, isLineAnchor, type Anchor } from "@revkit/review-core";
import { startDaemon } from "../../src/serve/daemon.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";
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

test("depth-1000 legacy recovery keeps a 50 ms heartbeat responsive and POST succeeds", async () => {
  const source = "- ".repeat(1000) + "deep x";
  const root = fixture(source);
  const daemon = await startDaemon({ dir: join(root, "dist"), repoRoot: root, port: 0, sqlitePath: ":memory:", version: "0.0.0-test", localUserId: "u", installSignalHandlers: false, logSink: { write: () => {} } });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const revision = await revisionOf(source);
    // Rendering itself is synchronous and scales differently. Warm/render
    // before the heartbeat so its gap measures ONLY legacy recovery.
    const rendered = await renderProvenance(root, PATH, source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision, quote: { exact: "deep", prefix: "", suffix: "" } };
    let last = performance.now();
    const gaps: number[] = [];
    timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 50);
    await new Promise((done) => setTimeout(done, 60));
    const before = gaps.length;
    const recovered = recoverLegacyAnchor(rendered, source, anchor);
    expect(recovered?.quote.exact).toBe("deep");
    // Count the first heartbeat after synchronous recovery finishes too.
    await new Promise((done) => setTimeout(done, 60));
    expect(gaps.length).toBeGreaterThan(before);
    // Five heartbeat periods permit scheduling jitter while detecting the
    // former ~70 s recovery stall, independently of Markdown rendering.
    expect(Math.max(...gaps)).toBeLessThan(250);
    clearInterval(timer);
    timer = undefined;
    // Exercise the real legacy-quote POST outside the recovery-only timing
    // window: rendering must not contaminate the responsiveness assertion.
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST", headers: { cookie, origin: daemon.url, "content-type": "application/json" },
      body: JSON.stringify({ anchor, body: "A deep comment" }),
    });
    expect(response.status).toBe(201);
    const { event } = await response.json() as { event: { anchor: Anchor } };
    expect(event.anchor).toEqual(recovered!);
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
  let workMs = 0;
  const service = startReanchorDaemon({ store, bus, repoRoot: root, nowMs: () => workMs, logger: makeLogger({ sink: { write: () => {} } }) });
  let cancelTimer: (() => void) | undefined;
  let delivered = 0;
  let deliveredAtTick = -1;
  const detach = bus.subscribe({ close() {}, deliver(event) {
    if (event.kind !== "thread.reanchored") return;
    delivered++;
    workMs += 10;
    if (delivered === 1) {
      const timer = setImmediate(() => { deliveredAtTick = delivered; });
      cancelTimer = () => clearImmediate(timer);
    }
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
    cancelTimer?.();
    detach();
    await service.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild skips threads resolved during its yield without rejection warnings", async () => {
  const source = "before **deep** after";
  const root = fixture(source);
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const bus = new EventBus();
  const warnings: string[] = [];
  let workMs = 0;
  const service = startReanchorDaemon({ store, bus, repoRoot: root, nowMs: () => workMs, logger: makeLogger({ sink: { write: (line) => { if (JSON.parse(line).level === "warn") warnings.push(line); } } }) });
  let close: Promise<unknown> | undefined;
  let cancelTimer: (() => void) | undefined;
  const detach = bus.subscribe({ close() {}, deliver(event) {
    if (event.kind !== "thread.orphaned" || event.threadId !== "legacy-0") return;
    // The next thread reaches the budget deterministically. The human's
    // resolve runs on that event-loop turn, after the bucket was captured.
    workMs += 10;
    close = new Promise<void>((done, fail) => {
      const timer = setImmediate(() => { store.append({ kind: "thread.resolved", actor: { kind: "local", id: "u" }, threadId: "legacy-2" }).then(() => done(), fail); });
      cancelTimer = () => clearImmediate(timer);
    });
  } });
  try {
    const revision = await revisionOf(source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision, quote: { exact: "missing", prefix: "", suffix: "" } };
    store.putSnapshot(revision, source);
    for (let i = 0; i < 3; i++) await store.append({ kind: "comment.created", actor: { kind: "local", id: "u" }, threadId: `legacy-${i}`, commentId: `comment-${i}`, body: "Legacy comment", anchor });
    writeFileSync(join(root, PATH), source + "\n\nUnrelated paragraph.");
    await service.refresh(PATH);
    await close;
    const events = await store.since(0);
    expect(events.some((event) => event.kind === "thread.orphaned" && event.threadId === "legacy-2")).toBe(false);
    expect((await store.thread("legacy-2"))?.status).toBe("resolved");
    expect(warnings).toEqual([]);
    expect(events.filter((event) => event.kind === "thread.orphaned")).toHaveLength(2);
  } finally {
    cancelTimer?.();
    detach();
    await service.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
