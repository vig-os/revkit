import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf } from "@revkit/review-core";
import { renderDocFragment } from "../../src/serve/publish-render.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

for (const published of [true, false]) test(`daemon shares new preparation across revision buckets (renderer handoff: ${published})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-block-cache-"));
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const path = "docs/cache.md";
  const oldSources = ["# First\n\nThe original target phrase.", "# Second\n\nThe original target phrase."];
  const next = `# Third ${published}\n\nThe revised target phrase.`;
  const daemon = startReanchorDaemon({ repoRoot: root, store, bus: new EventBus(), logger: makeLogger({ sink: { write: () => {} } }) });
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, path), next);
    for (const [bucket, source] of oldSources.entries()) {
      const revision = await revisionOf(source);
      store.putSnapshot(revision, source);
      for (let i = 0; i < 2; i++) await store.append({ kind: "comment.created", actor: { kind: "local", id: "reviewer" }, threadId: `bucket-${bucket}-${i}`, commentId: `comment-${bucket}-${i}`, body: "Review", anchor: { path, revision, startLine: 3, endLine: 3, quote: { exact: "The original target phrase.", prefix: source.slice(0, source.indexOf("The")), suffix: "" } } });
    }
    // This is the existing publishing render. The refresh obtains its map
    // by revision, without rendering the current source again.
    if (published) await renderDocFragment({ repoRoot: root, path, source: next });
    await daemon.refresh(path);
    const expectedBytes = 2 * new TextEncoder().encode(oldSources.join("") + next).length;
    expect(daemon.blockPreparationStats()).toEqual({ snapshotsSegmented: 3, bytesSegmented: expectedBytes, mapsParsed: published ? 0 : 1, mapsCaptured: published ? 3 : 2, legacyRenders: 2 });
    const stats = daemon.blockPreparationStats();
    await daemon.refresh(path);
    expect(daemon.blockPreparationStats()).toEqual(stats);
    expect((await store.threads()).every((thread) => thread.status === "open")).toBe(true);
  } finally { await daemon.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
