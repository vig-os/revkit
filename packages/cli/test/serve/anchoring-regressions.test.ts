import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLineAnchor, revisionOf, type Anchor } from "@revkit/review-core";
import { renderFixture } from "../fixtures/render-markdown.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

// A2/A8, ADR-0006: use the shared Astro renderer's DOM text for legacy
// comments, then the real filesystem/daemon/sqlite/event/reducer pipeline.
// Seed old events directly: the current POST route mints source quotes and
// would hide a regression affecting comments created before PR #157.
async function checkEdits(
  line: string,
  shape: "legacy" | "source",
  edits: readonly string[],
  allowOrphan = false,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "revkit-anchoring-regression-"));
  const path = "docs/probe.md";
  const source = `# Title\n\n${line}\n\nTail paragraph.`;
  let daemon: ReturnType<typeof startReanchorDaemon> | undefined;
  let store: SqliteThreadStore | undefined;
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, path), source);
    const document = await renderFixture(root, path, source);
    const paragraph = document.querySelector("p")!;
    expect(paragraph.getAttribute("data-src")).toBe(`${path}:3-3`);
    const renderedQuote = paragraph.textContent!;
    expect(renderedQuote).not.toBe(line);
    const exact = shape === "legacy" ? renderedQuote : line;
    const anchor: Anchor = {
      path, startLine: 3, endLine: 3, revision: await revisionOf(source),
      quote: { exact, prefix: "", suffix: "" },
    };
    store = SqliteThreadStore.open({ filename: ":memory:" });
    store.putSnapshot(anchor.revision, source);
    await store.append({
      kind: "comment.created", actor: { kind: "local", id: "reviewer" },
      threadId: "regression", commentId: "original", body: "Review this paragraph", anchor,
    });
    daemon = startReanchorDaemon({
      store, bus: new EventBus(), repoRoot: root,
      logger: makeLogger({ sink: { write: () => {} } }),
    });
    for (const next of edits) {
      writeFileSync(join(root, path), next);
      await daemon.refresh(path);
      const threads = await store.threads();
      expect(threads).toHaveLength(1);
      const thread = threads[0]!;
      expect(thread.id).toBe("regression");
      const events = await store.since(0);
      // Check every persisted reanchor, even if a later refresh orphans.
      for (const event of events) {
        if (event.kind !== "thread.reanchored") continue;
        expect(event.anchor.path).toBe(path);
        expect(event.anchor.startLine).toBe(3);
        expect(event.anchor.endLine).toBe(3);
        const snapshot = store.getSnapshot(event.anchor.revision)!;
        expect(event.anchor.quote.exact).toBe(snapshot.split("\n")[2]!);
      }
      if (allowOrphan && thread.status === "orphaned") {
        expect(events.some((event) => event.kind === "thread.orphaned")).toBe(true);
        continue;
      }
      expect(thread.status).toBe("open");
      if (!isLineAnchor(thread.anchor)) throw new Error("Expected a source line anchor");
      expect(thread.anchor.path).toBe(path);
      expect(thread.anchor.startLine).toBe(3);
      expect(thread.anchor.endLine).toBe(3);
      expect(thread.anchor.quote.exact).toBe(next.split("\n")[2]!);
      expect(thread.anchor.revision).toBe(await revisionOf(next));
    }
    const events = await store.since(0);
    expect(events[0]!.kind).toBe("comment.created");
    if (events[0]!.kind === "comment.created") expect(events[0]!.anchor).toEqual(anchor);
    if (!allowOrphan) {
      expect(events.filter((event) => event.kind === "thread.reanchored")).toHaveLength(edits.length);
      expect(events.some((event) => event.kind === "thread.orphaned")).toBe(false);
    }
  } finally {
    await daemon?.stop();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function editAndAppend(line: string): string {
  return `# Title\n\n${line.replace("fine", "wrong")}\n\nTail paragraph.\n\nUnrelated paragraph.`;
}

test("#126: exact seven-ellipsis legacy reproduction stays within line 3 after edit+append", async () => {
  const line = "Wait... what... really... ok... fine... yes... done...";
  await checkEdits(line, "legacy", [editAndAppend(line)]);
});

test("#146: exact empty-context source quote never overruns its paragraph after edit+append", async () => {
  const line = "Dots...... here...... and...... a...... word...... fine";
  await checkEdits(line, "source", [editAndAppend(line)]);
});

test("#127: exact renderer measurement collapses each 3/4/5/6-dot run to one ellipsis", async () => {
  const source = "one... two and three.... four and five..... six and six...... seven";
  const document = await renderFixture("/repo", "docs/probe.md", source);
  expect(document.querySelector("p")!.textContent).toBe("one… two and three… four and five… six and six… seven");
});

for (const kind of ["ellipsis", "dash", "code", "smart quotes"] as const) {
  for (let runs = 1; runs <= 6; runs++) {
    const parts = Array.from({ length: runs }, (_, i) => {
      switch (kind) {
        case "ellipsis": return `word${i}...`;
        case "dash": return `word${i} -- next${i}`;
        case "code": return `word${i} \`code${i}\``;
        case "smart quotes": return `word${i} "quote${i}"`;
      }
    });
    const line = `${parts.join(" ")} fine done.`;
    test(`#126: legacy whole-block quote with ${runs} ${kind} runs is correct or orphaned after one word edit`, async () => {
      await checkEdits(line, "legacy", [editAndAppend(line)], true);
    });
  }
}

function successiveEdits(line: string): string[] {
  let source = `# Title\n\n${line}\n\nTail paragraph.`;
  let previous = "fine";
  return ["wrong", "right", "great"].map((word, index) => {
    source = source.replace(previous, word) + `\n\nUnrelated paragraph ${index}.`;
    previous = word;
    return source;
  });
}

for (const dots of [4, 5, 6, 7, 12]) {
  for (const shape of ["legacy", "source"] as const) {
    test(`#127: ${shape} quote with ${dots}-dot runs reanchors correctly through three successive word edits`, async () => {
      const run = ".".repeat(dots);
      const line = `Dots${run} here${run} and${run} a${run} word${run} fine`;
      await checkEdits(line, shape, successiveEdits(line));
    });
  }
}
