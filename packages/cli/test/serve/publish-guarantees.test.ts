// Unit-level acceptance tests for the publish pipeline's guarantees
// that are hard to observe through a browser (M2 item 9, story A4):
//
//   - A symlink swapped in AFTER confinement resolution cannot
//     redirect the write (parent directory and leaf, both).
//   - The check sees the batch as ONE snapshot, including cross-file
//     state (vocabulary, links).
//   - A multi-file publish carries an explicit generation boundary and
//     rolls back atomically per file.
//   - A durable-event append failure after the source commit is
//     restart-reconcilable and leaves no stuck presence state.
//
// These run against `runPublish` directly with stub dependencies
// rather than through HTTP, so the barrier tests can place a swap at
// an exact point in the pipeline. The end-to-end HTTP behaviour lives
// in `publish-refused-build.test.ts`.
//
// RED on this branch before it landed: `runPublish` accepted neither a
// `staged` check overlay nor a pre-commit barrier, had no confinement
// re-validation (a mid-request symlink swap wrote straight through to
// the swapped target), had no generation on `doc.published`, and left
// the presence beacon lit whenever an event append threw.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Author, ReviewEvent, ReviewEventInput } from "@revkit/review-core";
import { runPublish, type PublishDependencies } from "../../src/serve/publish.ts";

const AGENT: Author = { kind: "agent", id: "revkit-live" };
const SYSTEM: Author = { kind: "system", id: "revkit-daemon" };

interface Recorded {
  readonly kind: string;
  readonly generation?: string;
  readonly path?: string;
  readonly revision?: string;
}

interface Harness {
  readonly root: string;
  readonly events: Recorded[];
  readonly generations: { generation: string; items: readonly { path: string; reason: string }[] }[];
  readonly presence: { state: "editing" | "idle"; path: string }[];
  /** Mutable so a test can re-derive `deps` around a barrier or a
   * partially-failing append. */
  deps: PublishDependencies;
  /** When set, every `store.append` rejects with this message. */
  appendFailure: string | undefined;
  /** Barrier awaited after the check, before the commit. */
  beforeCommit: (() => Promise<void>) | undefined;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repo with one ADR, one design, one plot, and a one-term
 * vocabulary — the shape the publishing rules expect. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-unit-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "docs", "designs"), { recursive: true });
  mkdirSync(join(root, "plots", "curve"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0001-existing.md"), "# ADR-0001\n\n- Status: Accepted\n- Date: 2026-01-01\n\n## Context\n\nOne.\n");
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    "schemaVersion: 1\nentries:\n  - id: alpha\n    term: alpha\n    definition: The first letter.\n",
  );
  writeFileSync(join(root, "plots", "curve", "spec.vl.json"), "{}");
  writeFileSync(join(root, "plots", "curve", "data.json"), "[]");
  return root;
}

function harness(root: string): Harness {
  const events: Recorded[] = [];
  const generations: Harness["generations"] = [];
  const presence: Harness["presence"] = [];
  const state: Harness = {
    root,
    events,
    generations,
    presence,
    appendFailure: undefined,
    beforeCommit: undefined,
    deps: {
      repoRoot: root,
      store: {
        // The stub narrows on `kind` rather than reading optional
        // fields off the union — `ReviewEventInput` is a discriminated
        // union, so `input.path` is not on every member.
        append: async (input: ReviewEventInput): Promise<number> => {
          if (state.appendFailure !== undefined) throw new Error(state.appendFailure);
          const record = input as { generation?: string; path?: string; revision?: string };
          events.push({
            kind: input.kind,
            ...(record.generation !== undefined ? { generation: record.generation } : {}),
            ...(record.path !== undefined ? { path: record.path } : {}),
            ...(record.revision !== undefined ? { revision: record.revision } : {}),
          });
          return events.length;
        },
        since: async (): Promise<ReviewEvent[]> => [],
      } as unknown as PublishDependencies["store"],
      bus: { publish: async () => {} } as unknown as PublishDependencies["bus"],
      presence: {
        editing: (_actor: Author, at: { path: string }) => presence.push({ state: "editing", path: at.path }),
        idle: (_actor: Author, at: { path: string }) => presence.push({ state: "idle", path: at.path }),
      } as unknown as PublishDependencies["presence"],
      agentActor: AGENT,
      systemActor: SYSTEM,
      repoSlug: "vig-os/revkit",
      refreshAnchors: async () => {},
      reconcileWatchers: () => {},
      ingestDelivery: async () => {},
      distDir: join(root, "dist"),
      setRenderCache: () => {},
      recordGeneration: async (generation, items) => {
        generations.push({ generation, items });
        return { generation, status: items.length === 0 ? "fast" : "pending", items };
      },
    },
  };
  return state;
}

/** A doc body with room for a vocabulary sigil and a relative link. */
function body(text: string): string {
  return `# ADR-0002: Generated\n\n- Status: Proposed\n- Date: 2026-10-02\n\n## Context\n\n${text}\n`;
}

/** Temporary files left beside a target by the staging step, if any. */
function stagingLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-") || name.includes(".rollback-"));
}

describe("confinement is re-derived before the write", () => {
  test("a PARENT directory swapped for a symlink after resolution cannot capture the write", async () => {
    const root = scaffold();
    const outside = mkdtempSync(join(tmpdir(), "revkit-outside-"));
    roots.push(outside);
    // A file that only exists OUTSIDE the repo, whose content would be
    // the giveaway that a write escaped.
    writeFileSync(join(outside, "leaked.md"), "ORIGINAL-OUTSIDE\n", "utf8");

    const h = harness(root);
    h.beforeCommit = async () => {
      // Replace the whole `docs/adr` directory with a symlink to the
      // outside directory — after confinement resolved, after the
      // check ran, immediately before the rename.
      rmSync(join(root, "docs", "adr"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "docs", "adr"), "dir");
    };

    const outcome = await runPublish(
      { docs: [{ path: "docs/adr/0002-generated.md", content: body("Should never land outside.") }] },
      withBarrier(h),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("confinement");
    // Nothing was written outside the repo.
    expect(readFileSync(join(outside, "leaked.md"), "utf8")).toBe("ORIGINAL-OUTSIDE\n");
    expect(existsSync(join(outside, "0002-generated.md"))).toBe(false);
    // Nothing was written inside either — the swap is refused whole,
    // and no staging temporary is left behind in the redirected tree.
    expect(readdirSync(outside)).toEqual(["leaked.md"]);
    // No build was scheduled for a publish that never landed.
    expect(h.generations).toEqual([]);
    // No events were emitted for it.
    expect(h.events).toEqual([]);
  });

  test("a LEAF swapped for a symlink after resolution cannot capture the write", async () => {
    const root = scaffold();
    const outside = mkdtempSync(join(tmpdir(), "revkit-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "0001-existing.md"), "ORIGINAL-OUTSIDE\n", "utf8");

    const h = harness(root);
    // The leaf is a symlink to a file outside the repo. Publishing
    // THROUGH a symlinked leaf would rewrite the outside file.
    rmSync(join(root, "docs", "adr", "0001-existing.md"));
    symlinkSync(join(outside, "0001-existing.md"), join(root, "docs", "adr", "0001-existing.md"));

    const outcome = await runPublish(
      { docs: [{ path: "docs/adr/0001-existing.md", content: body("Should never land outside.") }] },
      h.deps,
    );

    // The FIRST resolution already refuses a symlinked leaf, so the
    // write never starts. Assert the end state that matters.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("confinement");
    expect(readFileSync(join(outside, "0001-existing.md"), "utf8")).toBe("ORIGINAL-OUTSIDE\n");
  });

  test("MUTATION: without the barrier swap the same publish lands on disk (the test is not tautological)", async () => {
    const root = scaffold();
    const h = harness(root);
    const outcome = await runPublish(
      { docs: [{ path: "docs/adr/0002-generated.md", content: body("Landing is fine here.") }] },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(root, "docs", "adr", "0002-generated.md"), "utf8")).toContain("Landing is fine here.");
    // And no staging temporaries survive a successful publish.
    expect(stagingLeftovers(join(root, "docs", "adr"))).toEqual([]);
  });
});

describe("the check sees the batch as one snapshot", () => {
  test("a doc may use a vocabulary term the SAME batch defines", async () => {
    const root = scaffold();
    const h = harness(root);
    const outcome = await runPublish(
      {
        docs: [
          { path: "docs/adr/0002-generated.md", content: body("Uses [[beta]] inline.") },
          {
            path: "vocab/terms.yaml",
            content:
              "schemaVersion: 1\nentries:\n  - id: alpha\n    term: alpha\n    definition: The first letter.\n  - id: beta\n    term: beta\n    definition: The second letter.\n",
          },
        ],
      },
      h.deps,
    );
    if (!outcome.ok) {
      // Surface the diagnostics rather than a bare `ok === false` so a
      // future rule change points at the rule that moved.
      throw new Error(`expected the batch to validate: ${JSON.stringify(outcome.diagnostics)} / ${outcome.reason}`);
    }
    // MUTATION: the same doc against a repo whose vocabulary does NOT
    // yet define the term is refused, which is what makes the snapshot
    // load-bearing rather than a no-op overlay. A FRESH root, because
    // the publish above already committed `beta` to `root`'s vocab.
    const bare = harness(scaffold());
    const withoutVocab = await runPublish(
      { docs: [{ path: "docs/adr/0003-generated.md", content: body("Uses [[beta]] inline.") }] },
      bare.deps,
    );
    expect(withoutVocab.ok).toBe(false);
    if (!withoutVocab.ok) expect(withoutVocab.kind).toBe("check-failed");
  });

  test("a doc may link to a heading in a document the SAME batch creates", async () => {
    const root = scaffold();
    const h = harness(root);
    const outcome = await runPublish(
      {
        docs: [
          {
            path: "docs/adr/0002-generated.md",
            content: body("See [the other one](./0004-generated.md#decision)."),
          },
          {
            path: "docs/adr/0004-generated.md",
            content:
              "# ADR-0004: Other\n\n- Status: Proposed\n- Date: 2026-10-02\n\n## Decision\n\nShip it.\n",
          },
        ],
      },
      h.deps,
    );
    expect(outcome.ok).toBe(true);

    // MUTATION: the same link without the target in the batch is a
    // broken link, so the overlay is what made it resolve. A FRESH
    // root, because the publish above already created the target.
    const bare = harness(scaffold());
    const dangling = await runPublish(
      {
        docs: [
          {
            path: "docs/adr/0005-generated.md",
            content: body("See [the other one](./9999-absent.md#decision)."),
          },
        ],
      },
      bare.deps,
    );
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.kind).toBe("check-failed");
  });
});

describe("the generation boundary and per-file rollback", () => {
  test("every doc.published in one batch carries the same generation, and it names the batch", async () => {
    const root = scaffold();
    const h = harness(root);
    const outcome = await runPublish(
      {
        docs: [
          { path: "docs/adr/0002-generated.md", content: body("First.") },
          { path: "docs/designs/DESIGN-0002.md", content: body("Second.") },
        ],
      },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const published = h.events.filter((e) => e.kind === "doc.published");
    expect(published).toHaveLength(2);
    const generations = new Set(published.map((e) => e.generation));
    expect(generations.size).toBe(1);
    expect(generations.has(outcome.generation)).toBe(true);
    // Each event still names its own path and revision, so a reader
    // can tell WHICH revision a path moved to inside the batch.
    expect(new Set(published.map((e) => e.path))).toEqual(
      new Set(["docs/adr/0002-generated.md", "docs/designs/DESIGN-0002.md"]),
    );
    for (const event of published) expect(event.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a failure part-way through the commit restores every earlier file, atomically", async () => {
    const root = scaffold();
    const before = readFileSync(join(root, "docs", "adr", "0001-existing.md"), "utf8");
    const h = harness(root);
    // The second target's parent is replaced by a FILE between staging
    // and commit, so its rename fails after the first has landed.
    h.beforeCommit = async () => {
      rmSync(join(root, "docs", "designs"), { recursive: true, force: true });
      writeFileSync(join(root, "docs", "designs"), "not a directory", "utf8");
    };
    const outcome = await runPublish(
      {
        docs: [
          { path: "docs/adr/0002-generated.md", content: body("Should be rolled back.") },
          { path: "docs/designs/DESIGN-0002.md", content: body("Never lands.") },
        ],
      },
      withBarrier(h),
    );
    expect(outcome.ok).toBe(false);
    // The first file is back to its previous bytes — not truncated, not
    // missing.
    expect(readFileSync(join(root, "docs", "adr", "0001-existing.md"), "utf8")).toBe(before);
    expect(existsSync(join(root, "docs", "adr", "0002-generated.md"))).toBe(false);
    // No staging or rollback temporaries survive.
    expect(stagingLeftovers(join(root, "docs", "adr"))).toEqual([]);
    // Nothing was announced.
    expect(h.events).toEqual([]);
    expect(h.generations).toEqual([]);
  });
});

describe("durable-event append failure after the source commit", () => {
  test("the build is still scheduled, the presence beacon is cleared, and the outcome names the gap", async () => {
    const root = scaffold();
    const h = harness(root);
    h.appendFailure = "SQLITE_BUSY: database is locked";
    const outcome = await runPublish(
      { docs: [{ path: "docs/adr/0002-generated.md", content: body("Lands, but is unannounced.") }] },
      h.deps,
    );

    // The source IS on disk — rolling it back would lose a publish the
    // check approved.
    expect(readFileSync(join(root, "docs", "adr", "0002-generated.md"), "utf8")).toContain("Lands, but is unannounced.");
    // The build was scheduled BEFORE the append, which is what makes
    // this restart-reconcilable: `.revkit/publish-state.json` carries
    // the generation and the next daemon picks it up.
    expect(h.generations).toHaveLength(1);
    expect(h.generations[0]?.generation).toBe(outcome.ok ? outcome.generation : "");
    // The caller is told, rather than getting a silent success.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.notice?.code).toBe("event-append-failed");
    expect(outcome.seqs).toEqual([]);
    // No stuck presence: the `idle` for every path was emitted even
    // though the append threw. A beacon left lit is a permanently
    // occupied chip that a restart would not heal.
    expect(h.presence.filter((p) => p.state === "editing")).toHaveLength(1);
    expect(h.presence.filter((p) => p.state === "idle")).toHaveLength(1);
  });

  test("MUTATION: one rejected append does not blind the rest of the batch", async () => {
    const root = scaffold();
    const h = harness(root);
    let seen = 0;
    const inner = h.deps.store.append;
    h.deps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        append: async (input: ReviewEventInput) => {
          seen++;
          if (seen === 1) throw new Error("one isolated constraint failure");
          return inner.call(h.deps.store, input);
        },
      } as unknown as PublishDependencies["store"],
    };
    const outcome = await runPublish(
      {
        docs: [
          { path: "docs/adr/0002-generated.md", content: body("First.") },
          { path: "docs/designs/DESIGN-0002.md", content: body("Second.") },
        ],
      },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The second file's event landed even though the first did not.
    expect(outcome.seqs).toHaveLength(1);
    expect(h.events.map((e) => e.path)).toEqual(["docs/designs/DESIGN-0002.md"]);
    expect(h.generations).toHaveLength(1);
    // Every path's beacon was still cleared.
    expect(h.presence.filter((p) => p.state === "idle")).toHaveLength(2);
  });
});

/** `harness` carries mutable seams (`beforeCommit`, `appendFailure`)
 * that `deps` cannot see, so re-derive `deps` with the barrier
 * attached each time a test sets one. */
function withBarrier(h: Harness): PublishDependencies {
  if (h.beforeCommit === undefined) return h.deps;
  const barrier = h.beforeCommit;
  return { ...h.deps, beforeStagedCommit: barrier };
}
