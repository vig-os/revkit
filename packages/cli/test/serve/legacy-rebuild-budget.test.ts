import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, isLineAnchor, prepareReanchor, reanchorWith, reanchorEvent, type Anchor } from "@revkit/review-core";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";
import { REANCHOR_ACTOR_ID, startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";

const PATH = "docs/probe.md";
const THREAD_COUNT = 1000;

async function rebuild(daemon: boolean): Promise<number> {
  const source = "before **deep** after";
  const next = source + "\n\nUnrelated paragraph.";
  const root = mkdtempSync(join(tmpdir(), "revkit-rebuild-budget-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, PATH), next);
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  let service: ReturnType<typeof startReanchorDaemon> | undefined;
  try {
    const revision = await revisionOf(source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision, quote: { exact: "before deep after", prefix: "", suffix: "" } };
    store.putSnapshot(revision, source);
    for (let i = 0; i < THREAD_COUNT; i++) await store.append({ kind: "comment.created", actor: { kind: "local", id: "u" }, threadId: `legacy-${i}`, commentId: `comment-${i}`, body: "Legacy comment", anchor });
    if (daemon) service = startReanchorDaemon({ store, bus: new EventBus(), repoRoot: root, logger: makeLogger({ sink: { write: () => {} } }) });
    const before = performance.now();
    if (service) await service.refresh(PATH);
    else {
      // dev's non-yielding baseline: the same real renderer, diff, recovery
      // and SQLite event writes, with no timer delay charged per thread.
      const threads = await store.threads({ path: PATH });
      const ctx = await prepareReanchor(source, next);
      store.putSnapshot(await revisionOf(next), next);
      const rendered = await renderProvenance(root, PATH, source);
      for (const thread of threads) {
        if (!isLineAnchor(thread.anchor)) throw new Error("line anchor required");
        const recovered = recoverLegacyAnchor(rendered, source, thread.anchor);
        if (!recovered) throw new Error("unique legacy quote required");
        const event = reanchorEvent(thread.id, { kind: "agent", id: REANCHOR_ACTOR_ID }, await reanchorWith(ctx, recovered));
        if (!event) throw new Error("reanchor event required");
        const seq = await store.append(event);
        await store.since(seq - 1);
      }
    }
    const elapsed = performance.now() - before;
    expect((await store.since(0)).filter((event) => event.kind === "thread.reanchored")).toHaveLength(THREAD_COUNT);
    return elapsed;
  } finally {
    await service?.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a 1000-thread rebuild stays within 3x dev's non-yielding baseline", async () => {
  const baseline: number[] = [];
  const daemon: number[] = [];
  // Warm the shared renderer/runtime and alternate measurement order.
  await rebuild(false);
  for (let i = 0; i < 3; i++) {
    if (i % 2 === 0) { baseline.push(await rebuild(false)); daemon.push(await rebuild(true)); }
    else { daemon.push(await rebuild(true)); baseline.push(await rebuild(false)); }
  }
  const baselineMedian = baseline.sort((a, b) => a - b)[1]!;
  const daemonMedian = daemon.sort((a, b) => a - b)[1]!;
  console.info(`1000-thread rebuild: baseline ${baselineMedian.toFixed(2)} ms, daemon ${daemonMedian.toFixed(2)} ms`);
  // A small relative constant tolerates daemon bookkeeping and scheduling.
  // a compulsory timer turn per thread instead costs roughly a second.
  expect(daemonMedian / baselineMedian).toBeLessThanOrEqual(3);
});
