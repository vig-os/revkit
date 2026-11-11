import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { parseHTML } from "linkedom";
import { pathToFileURL } from "node:url";
import { revisionOf, isLineAnchor, type Anchor } from "@revkit/review-core";
import { buildSharedMarkdownConfig } from "../../../../site/src/lib/markdown-processor.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";

// These tests depend only on APIs already present on origin/dev, so RED is
// behavioural (orphan/wrong bounds), not a missing-new-module failure.
for (const line of [
  'He said "hi" -- ok... and it\'s fine.',
  "Wait... what... really... ok... fine... yes... done...",
  "Dots...... here...... and...... a...... word...... fine",
]) test(`legacy renderer quote converges through append, word edit, append: ${line}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-legacy-oracle-"));
  const path = "docs/probe.md";
  mkdirSync(join(root, "docs"));
  const source = `# Title\n\n${line}\n\nTail paragraph.`;
  writeFileSync(join(root, path), source);
  const processor = await createMarkdownProcessor({ ...buildSharedMarkdownConfig(root), syntaxHighlight: false } as Parameters<typeof createMarkdownProcessor>[0]);
  const { code } = await processor.render(source, { fileURL: pathToFileURL(join(root, path)) });
  const { document } = parseHTML(`<html><body>${code}</body></html>`);
  const exact = document.querySelector("p")!.textContent!;
  expect(exact).not.toBe(line);
  const revision = await revisionOf(source);
  const anchor: Anchor = { path, startLine: 3, endLine: 3, revision, quote: { exact, prefix: "", suffix: "" } };
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const daemon = startReanchorDaemon({ store, bus: new EventBus(), repoRoot: root, logger: makeLogger({ sink: { write: () => {} } }) });
  try {
    store.putSnapshot(revision, source);
    await store.append({ kind: "comment.created", actor: { kind: "local", id: "reviewer" }, threadId: "legacy", commentId: "initial", body: "A legacy comment", anchor });
    let next = source;
    for (const edit of ["append", "word", "append"] as const) {
      next = edit === "word" ? next.replace("fine", "wrong") : next + "\n\nUnrelated paragraph.";
      writeFileSync(join(root, path), next);
      await daemon.refresh(path);
      const thread = (await store.threads())[0]!;
      expect(thread.status).toBe("open");
      if (!isLineAnchor(thread.anchor)) throw new Error("source line anchor required");
      expect(thread.anchor.startLine).toBe(3);
      expect(thread.anchor.endLine).toBe(3);
      expect(thread.anchor.quote.exact).toBe(next.split("\n")[2]!);
      expect(thread.anchor.revision).toBe(await revisionOf(next));
    }
    const events = await store.since(0);
    expect(events).toHaveLength(4);
    expect(events.slice(1).every((e) => e.kind === "thread.reanchored")).toBe(true);
    expect((events[0] as { anchor: Anchor }).anchor.quote.exact).toBe(exact);
  } finally { await daemon.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
