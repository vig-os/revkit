import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAdapter, type GhReviewThread, type PrRef } from "@revkit/review-core";
import { populateStoreFromPr, threadIdOf } from "../../src/review/import-threads.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { makeFakeGithubFetch } from "./helpers/fake-github.ts";

const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 114 };
const headSha = "a".repeat(40);
const roots: string[] = [];
const stores: SqliteThreadStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One comment generates a creation event and a GitHub link event. */
function remoteThread(databaseId = 114): GhReviewThread {
  return {
    id: "PRT_114", path: "index.md", isResolved: false, isOutdated: false,
    resolvedByLogin: null, diffSide: "RIGHT", startDiffSide: null,
    line: 1, originalLine: 1, startLine: null, originalStartLine: null,
    subjectType: "LINE",
    comments: [{
      nodeId: "PRRC_114", databaseId, body: "please review", authorLogin: "reviewer",
      authorType: "User", createdAt: "2026-10-01T00:00:00Z",
      url: "https://github.com/vig-os/revkit/pull/114#discussion_r114",
      originalCommitOid: headSha, diffHunk: null,
    }],
  };
}

function options() {
  const root = mkdtempSync(join(tmpdir(), "revkit-import-114-"));
  roots.push(root);
  writeFileSync(join(root, "index.md"), "reviewed line\n");
  const store = SqliteThreadStore.open({ filename: join(root, "threads.sqlite") });
  stores.push(store);
  const adapter = new GitHubAdapter({
    token: { async getToken() { return "fake-token"; } },
    fetch: makeFakeGithubFetch([]),
  });
  return { pr, headSha, baseRef: "dev", adapter, materializedRoot: root, store };
}

describe("#114 import refusal contract", () => {
  test("a clean second import skips both events without refusing either", async () => {
    const opts = { ...options(), threads: [remoteThread()] };
    const first = await populateStoreFromPr(opts);
    expect([first.appended, first.skipped, first.refused]).toEqual([2, 0, 0]);
    const second = await populateStoreFromPr(opts);
    expect([second.appended, second.skipped, second.refused]).toEqual([0, 2, 0]);
    expect(await opts.store.since(0)).toHaveLength(2);
  });

  test("only the same comment/backend/external id is skipped; a conflicting link stays refused", async () => {
    const opts = options();
    await populateStoreFromPr({ ...opts, threads: [remoteThread()] });
    // The same node id maps to the same local comment, but a DIFFERENT
    // database id is a conflicting GitHub link, not a re-presentation.
    const conflict = await populateStoreFromPr({ ...opts, threads: [remoteThread(115)] });
    expect([conflict.appended, conflict.skipped, conflict.refused]).toEqual([0, 1, 1]);
    expect((await opts.store.thread(threadIdOf(pr, remoteThread())))?.comments[0]?.external?.github?.commentId).toBe(114);
    const same = await populateStoreFromPr({ ...opts, threads: [remoteThread()] });
    expect([same.appended, same.skipped, same.refused]).toEqual([0, 2, 0]);
    expect(await opts.store.since(0)).toHaveLength(2);
  });

  test("a malformed link is refused once and emits a diagnostic", async () => {
    const diagnostics: string[] = [];
    const opts = options();
    const outcome = await populateStoreFromPr({
      ...opts, threads: [remoteThread(0)],
      onRefused: (event, error) => diagnostics.push(`${event.kind}:${error.rejection.kind}`),
    });
    expect([outcome.appended, outcome.skipped, outcome.refused]).toEqual([1, 0, 1]);
    expect(diagnostics).toEqual(["comment.linked:invalid-shape"]);
    expect(await opts.store.since(0)).toHaveLength(1);
  });

  test("a stored node id and an absent remote link node id still skip the same external comment", async () => {
    const opts = { ...options(), threads: [remoteThread()] };
    await populateStoreFromPr(opts);
    const before = await opts.store.since(0);
    expect(before[1]?.kind).toBe("comment.linked");
    if (before[1]?.kind !== "comment.linked") throw new Error("missing stored link");
    expect(before[1].external.github?.nodeId).toBe("PRRC_114");
    const mapThreads = GitHubAdapter.mapThreadsToEvents;
    // Keep comment identity intact; emulate an import carrying only
    // the backend's database id on its link event.
    const mapper = spyOn(GitHubAdapter, "mapThreadsToEvents").mockImplementation(async (input) => {
      const result = await mapThreads(input);
      return { ...result, events: result.events.map((event) => {
        if (event.kind !== "comment.linked" || event.external.github === undefined) return event;
        const { nodeId: _nodeId, ...github } = event.external.github;
        expect(github).not.toHaveProperty("nodeId");
        return { ...event, external: { github } };
      }) };
    });
    try {
      const repeated = await populateStoreFromPr(opts);
      expect([repeated.appended, repeated.skipped, repeated.refused]).toEqual([0, 2, 0]);
      expect(await opts.store.since(0)).toEqual(before);
    } finally {
      mapper.mockRestore();
    }
  });
});
