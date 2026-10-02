// Unit tests for `serve/publish-build.ts` (M2 item 9, story A4).
//
// Two properties the end-to-end suite cannot prove on its own:
//
//   1. The coordinator runs the SHARED build primitive, with the
//      argument shape `revkit build` itself takes. A coordinator that
//      shelled out to `site/node_modules/.bin/astro` would pass every
//      HTTP test in this repo and fail for every packaged consumer,
//      which has no `site/` directory at all.
//   2. The lifecycle is debounced, single-flight, generation-scoped,
//      and honest about a lifecycle that throws — no hot retry loop,
//      and a settled outcome that never touches a newer generation's
//      state.
//
// The build runner is injected throughout; the last test asserts the
// DEFAULT runner is the shared one, which is the only assertion here
// that touches the real module.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEventInput } from "@revkit/review-core";
import { createPublishBuildCoordinator, type BuildRunner } from "../../src/serve/publish-build.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-build-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, ".revkit"), { recursive: true });
  return root;
}

interface Attempt {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly version: string;
  readonly repoSlug: string;
}

/** A runner that records its attempts and reports whatever
 * `outcomes` says, shifting one entry per call. */
function stubRunner(outcomes: { exitCode: number; stdout?: string; stderr?: string }[]): {
  run: BuildRunner;
  attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  const run: BuildRunner = async (args, env) => {
    attempts.push({ args: [...args], cwd: env.cwd, version: env.version, repoSlug: env.repoSlug });
    const outcome = outcomes.shift() ?? { exitCode: 0 };
    return { exitCode: outcome.exitCode, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
  };
  return { run, attempts };
}

/** Collect appended lifecycle events by kind. */
interface CapturedEvent {
  readonly kind: string;
  readonly generation: string;
  readonly routes: readonly string[];
  readonly error?: string;
}

function collector(): {
  events: CapturedEvent[];
  append: (e: ReviewEventInput) => Promise<void>;
} {
  const events: CapturedEvent[] = [];
  const append = async (input: ReviewEventInput): Promise<void> => {
    // `ReviewEventInput` is a discriminated union on `kind`, so the
    // build envelope's fields are not on every member; narrow to the
    // shape the coordinator actually emits.
    if (!input.kind.startsWith("build.")) return;
    const record = input as { generation: string; routes: readonly string[]; error?: string };
    events.push({
      kind: input.kind,
      generation: record.generation,
      routes: record.routes,
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  };
  return { events, append };
}

/** Source with `//`-prefixed lines removed, so an assertion about what
 * the code DOES is not satisfied or broken by what its prose SAYS. */
function codeOnly(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const FLUSH = { debounceMs: 1 } as const;

describe("the coordinator runs the shared build primitive", () => {
  test("calls the runner with `revkit build`'s own argument shape", async () => {
    const root = scaffold();
    const dist = join(root, ".revkit", "dist");
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: dist,
      version: "9.9.9",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    await coordinator.record("g".repeat(64), [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }]);
    await coordinator.awaitIdle();

    expect(attempts).toHaveLength(1);
    // `--dir <consumer root> --out <serve dir>`, cwd the consumer root.
    // `revkit build` parses exactly these; anything else would be a
    // private build path that no consumer could run.
    expect(attempts[0]?.args).toEqual(["--dir", root, "--out", dist]);
    expect(attempts[0]?.cwd).toBe(root);
    expect(attempts[0]?.version).toBe("9.9.9");
    expect(attempts[0]?.repoSlug).toBe("vig-os/revkit");
    expect(events.map((e) => e.kind)).toEqual(["build.requested", "build.started", "build.succeeded"]);
    coordinator.stop();
  });

  test("the DEFAULT runner is the shared `runBuildCommand`, not a private astro spawn", async () => {
    // No `runBuildCommand` injected: the coordinator must fall back to
    // the module that `revkit build` dispatches through. Asserting the
    // wiring rather than running a build (a real astro build is the
    // subject of `test/build/`), by checking the module's own import
    // edge — a coordinator that reached for `node_modules/.bin/astro`
    // or `Bun.spawn` directly would fail this.
    const source = codeOnly(join(import.meta.dir, "..", "..", "src", "serve", "publish-build.ts"));
    expect(source).toMatch(/import \{ runBuildCommand as defaultRunBuildCommand/);
    expect(source).toMatch(/options\.runBuildCommand \?\? defaultRunBuildCommand/);
    // Comments are stripped: the file's PROSE names
    // `site/node_modules/.bin/astro` to explain why the code does NOT
    // use it, and the assertion is about the code.
    expect(source).not.toMatch(/Bun\.spawn|node_modules\/\.bin|\.bin\/astro/);
    // The packaged primitive is the one that resolves astro by absolute
    // path from the PACKAGED root — assert the daemon has no second
    // route to it either.
    expect(codeOnly(join(import.meta.dir, "..", "..", "src", "serve", "daemon.ts")))
      .not.toMatch(/Bun\.spawn|node_modules\/\.bin|\.bin\/astro/);
  });
});

describe("the lifecycle is debounced, single-flight and honest", () => {
  test("a burst of publishes coalesces into ONE build, for the newest generation", async () => {
    const root = scaffold();
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const settlements: string[] = [];
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      onSettled: (s) => settlements.push(`${s.generation}:${s.status}`),
      debounceMs: 30,
    });
    await coordinator.record("a".repeat(64), [{ path: "docs/adr/a.md", reason: "data-only" }]);
    await coordinator.record("b".repeat(64), [{ path: "docs/adr/b.md", reason: "data-only" }]);
    await coordinator.record("c".repeat(64), [{ path: "docs/adr/c.md", reason: "data-only" }]);
    await coordinator.awaitIdle();

    expect(attempts).toHaveLength(1);
    // Three requests announced, one build ran, and the lifecycle events
    // name the generation that actually built.
    expect(events.filter((e) => e.kind === "build.requested").map((e) => e.generation)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]);
    expect(events.filter((e) => e.kind === "build.started").map((e) => e.generation)).toEqual(["c".repeat(64)]);
    expect(settlements).toEqual([`${"c".repeat(64)}:succeeded`]);
    expect(coordinator.state()?.generation).toBe("c".repeat(64));
    expect(coordinator.state()?.status).toBe("succeeded");
    coordinator.stop();
  });

  test("an all-fast batch schedules nothing and emits no events", async () => {
    const root = scaffold();
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    const record = await coordinator.record("d".repeat(64), []);
    expect(record.status).toBe("fast");
    await coordinator.awaitIdle();
    expect(attempts).toHaveLength(0);
    expect(events).toEqual([]);
    coordinator.stop();
  });

  test("a failed build reports the stderr tail and does NOT retry in a loop", async () => {
    const root = scaffold();
    const { run, attempts } = stubRunner([
      { exitCode: 1, stderr: "error during build:\nRollupError: boom" },
    ]);
    const { events, append } = collector();
    const settlements: string[] = [];
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      onSettled: (s) => settlements.push(s.status),
      ...FLUSH,
    });
    await coordinator.record("e".repeat(64), [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }]);
    await coordinator.awaitIdle();
    // Give a hypothetical hot loop a generous chance to show itself.
    await new Promise((r) => setTimeout(r, 120));

    expect(attempts).toHaveLength(1);
    const failed = events.find((e) => e.kind === "build.failed");
    expect(failed?.error).toContain("RollupError: boom");
    expect(settlements).toEqual(["failed"]);
    expect(coordinator.state()?.status).toBe("failed");
    expect(coordinator.state()?.error).toContain("RollupError: boom");
    coordinator.stop();
  });

  test("each build settles ONLY its own generation, and the newer one waits for its own build", async () => {
    const root = scaffold();
    // First build blocks until released; the publish below lands while
    // it is in flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: Attempt[] = [];
    const run: BuildRunner = async (args, env) => {
      attempts.push({ args: [...args], cwd: env.cwd, version: env.version, repoSlug: env.repoSlug });
      await gate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { events, append } = collector();
    const settlements: string[] = [];
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      onSettled: (s) => settlements.push(`${s.generation.slice(0, 4)}:${s.status}`),
      ...FLUSH,
    });
    const older = "1".repeat(64);
    const newer = "2".repeat(64);
    await coordinator.record(older, [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }]);
    await waitFor(() => attempts.length === 1);
    await coordinator.record(newer, [{ path: "docs/adr/y.md", route: "/adr/y/", reason: "fast-path-refused" }]);
    release();
    await coordinator.awaitIdle();

    // The older build's success is reported under the OLDER
    // generation, and the newer generation is then rebuilt and settled
    // on its own — two settlements, in order, neither one borrowing
    // the other's outcome.
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(settlements[0]).toBe("1111:succeeded");
    // The newer generation is NOT settled by the older build's
    // result: its own build has to run first.
    expect(settlements.indexOf("2222:succeeded")).toBeGreaterThan(0);
    expect(settlements[settlements.length - 1]).toBe("2222:succeeded");
    // `build.started` fires for both — each build really began.
    const started = events.filter((e) => e.kind === "build.started").map((e) => e.generation.slice(0, 4));
    expect(started).toEqual(["1111", "2222"]);
    // `build.succeeded` fires ONLY for the generation that is still
    // current when the build lands. The superseded generation's build
    // really did exit 0, but announcing it would tell the rail "A is
    // live" about a dist that a newer publish has already superseded
    // — and the daemon clears refusals off the back of that event, so
    // a phantom success is exactly the bug generation-scoping exists to
    // prevent. The internal settlement still reports it, so nothing is
    // silently dropped.
    const succeeded = events.filter((e) => e.kind === "build.succeeded").map((e) => e.generation.slice(0, 4));
    expect(succeeded).toEqual(["2222"]);
    coordinator.stop();
  });

  test("a lifecycle that throws is terminal for the generation, not a hot retry", async () => {
    const root = scaffold();
    const attempts: Attempt[] = [];
    const run: BuildRunner = async (args, env) => {
      attempts.push({ args: [...args], cwd: env.cwd, version: env.version, repoSlug: env.repoSlug });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // The FIRST lifecycle append rejects (a locked store), so the
    // coordinator never reaches the runner for that generation.
    let firstAppend = true;
    const append = async (input: ReviewEventInput): Promise<void> => {
      if (input.kind === "build.requested" && firstAppend) {
        firstAppend = false;
        return;
      }
      if (input.kind === "build.started") throw new Error("sqlite is locked");
    };
    const settlements: string[] = [];
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      onSettled: (s) => settlements.push(s.status),
      ...FLUSH,
    });
    await coordinator.record("f".repeat(64), [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }]);
    await coordinator.awaitIdle();
    await new Promise((r) => setTimeout(r, 120));

    expect(attempts).toHaveLength(0);
    expect(settlements).toEqual(["failed"]);
    expect(coordinator.state()?.status).toBe("failed");
    // The persisted record is the reconciliation source, so a restart
    // can still see what this generation needed.
    const persisted = JSON.parse(readFileSync(join(root, ".revkit", "publish-state.json"), "utf8")) as {
      generation: string;
      status: string;
      items: { path: string; route?: string; reason: string }[];
    };
    expect(persisted.generation).toBe("f".repeat(64));
    expect(persisted.status).toBe("failed");
    expect(persisted.items).toEqual([
      { path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" },
    ]);
    coordinator.stop();
  });

  test("a build.requested append rejection still schedules the build", async () => {
    const root = scaffold();
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    let rejected = false;
    const append = async (input: ReviewEventInput): Promise<void> => {
      if (input.kind === "build.requested" && !rejected) {
        rejected = true;
        throw new Error("announcement lost");
      }
    };
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    await coordinator.record("7".repeat(64), [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }]);
    await coordinator.awaitIdle();
    // The source is committed and the build is owed — losing the
    // announcement must not skip the work.
    expect(attempts).toHaveLength(1);
    coordinator.stop();
  });

  test("routes are de-duplicated across a batch so the event stays under the schema cap", async () => {
    const root = scaffold();
    const { run } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    await coordinator.record("8".repeat(64), [
      { path: "docs/adr/x.md", route: "/adr/x/", reason: "data-only" },
      { path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" },
      { path: "plots/curve/data.json", reason: "data-only" },
    ]);
    await coordinator.awaitIdle();
    const requested = events.find((e) => e.kind === "build.requested");
    expect(requested?.routes).toEqual(["/adr/x/"]);
    coordinator.stop();
  });
});

describe("restart reconciliation", () => {
  test("a record left `pending` is rescheduled and re-announced", async () => {
    const root = scaffold();
    const statePath = join(root, ".revkit", "publish-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        generation: "9".repeat(64),
        status: "pending",
        items: [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }],
        updatedAt: new Date().toISOString(),
      }),
    );
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    await waitFor(() => attempts.length === 1);
    await coordinator.awaitIdle();
    expect(events.map((e) => e.kind)).toEqual(["build.requested", "build.started", "build.succeeded"]);
    expect(events[0]?.generation).toBe("9".repeat(64));
    coordinator.stop();
  });

  test("a record left `running` is demoted to pending and retried (running is not authoritative across processes)", async () => {
    const root = scaffold();
    const statePath = join(root, ".revkit", "publish-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        generation: "a".repeat(64),
        status: "running",
        items: [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "shell-missing" }],
        updatedAt: new Date().toISOString(),
      }),
    );
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    expect(coordinator.state()?.status).toBe("pending");
    await waitFor(() => attempts.length === 1);
    await coordinator.awaitIdle();
    expect(coordinator.state()?.status).toBe("succeeded");
    expect(events[0]?.kind).toBe("build.requested");
    coordinator.stop();
  });

  test("a terminal record is left alone — no reschedule, no re-announcement", async () => {
    for (const status of ["succeeded", "failed"] as const) {
      const root = scaffold();
      writeFileSync(
        join(root, ".revkit", "publish-state.json"),
        JSON.stringify({
          generation: "b".repeat(64),
          status,
          items: [{ path: "docs/adr/x.md", route: "/adr/x/", reason: "fast-path-refused" }],
          updatedAt: new Date().toISOString(),
        }),
      );
      const { run, attempts } = stubRunner([{ exitCode: 0 }]);
      const { events, append } = collector();
      const coordinator = createPublishBuildCoordinator({
        repoRoot: root,
        distDir: join(root, ".revkit", "dist"),
        version: "0.0.0",
        repoSlug: "vig-os/revkit",
        appendEvent: append,
        runBuildCommand: run,
        ...FLUSH,
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts).toHaveLength(0);
      expect(events).toEqual([]);
      expect(coordinator.state()?.status).toBe(status);
      coordinator.stop();
    }
  });

  test("a corrupt state file is ignored rather than crashing the daemon", async () => {
    const root = scaffold();
    writeFileSync(join(root, ".revkit", "publish-state.json"), "{not json", "utf8");
    const { run, attempts } = stubRunner([{ exitCode: 0 }]);
    const { events, append } = collector();
    const coordinator = createPublishBuildCoordinator({
      repoRoot: root,
      distDir: join(root, ".revkit", "dist"),
      version: "0.0.0",
      repoSlug: "vig-os/revkit",
      appendEvent: append,
      runBuildCommand: run,
      ...FLUSH,
    });
    expect(coordinator.state()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(attempts).toHaveLength(0);
    expect(events).toEqual([]);
    coordinator.stop();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: predicate never became true");
}
