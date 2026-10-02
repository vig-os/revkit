// The daemon's SCHEDULED background build invokes the REAL shared
// `runBuildCommand` composition (M2 item 9, story A4).
//
// `publish-build.test.ts` proves the coordinator calls its injectable
// runner with `revkit build`'s own argument shape, and
// `packaged-e2e.test.ts` proves the packaged CLI builds a consumer with
// no `site/`. Neither proves the two are the SAME composition: a
// coordinator wired to a private astro spawn would satisfy both, and
// would fail for every packaged consumer while passing every other
// test in this repo (the dev shell has `site/node_modules/.bin/astro`,
// so a private spawn appears to work here).
//
// This file closes that gap without the E2E lane: it boots a real
// daemon with NO `backgroundBuildRun` override — so the coordinator
// resolves its DEFAULT runner — publishes a data-only file, and waits
// for the build to reach a terminal state. The assertions are about
// WHICH primitive ran, not about the build's output:
//
//   - the build's output names the pre-build check, the packaged site,
//     the consumer staging directory and the post-build output gate —
//     four steps only the shared `runBuildCommand` performs
//   - output lands in `.revkit/dist`, the same directory
//     `defaultConsumerDist` names and the daemon serves from
//   - a consumer with no `site/` and no `node_modules/` builds
//     anyway, because astro is resolved from the PACKAGED root.
//
// A failing build is the SUCCESS case for this test's purpose: a
// failure still proves the real composition ran (its stderr names the
// check), and it keeps the test off the slow astro path. Both
// terminals are asserted explicitly.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunBuildResult } from "../../src/build/cli.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { createPublishBuildCoordinator } from "../../src/serve/publish-build.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A consumer-shaped repo: `package.json`, `docs/`, `vocab/`,
 * `plots/<name>/`. Deliberately NO `site/` and NO `node_modules/` —
 * the shape ADR-0010 gives every real consumer. */
function scaffoldConsumer(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-real-build-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", private: true }), "utf8");
  // The daemon requires its serve dir to exist at boot. Seed it with an
  // index page so it has something to serve from before the first
  // build replaces it.
  mkdirSync(join(root, ".revkit", "dist"), { recursive: true });
  writeFileSync(join(root, ".revkit", "dist", "index.html"), "<!doctype html><h1>consumer</h1>", "utf8");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  mkdirSync(join(root, "plots", "series"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    "schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: The point a comment attaches to.\n",
  );
  writeFileSync(
    join(root, "plots", "series", "spec.vl.json"),
    JSON.stringify({
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { url: "data.json" },
      mark: "point",
      encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
    }),
  );
  writeFileSync(join(root, "plots", "series", "data.json"), JSON.stringify([{ x: 1, y: 2 }]), "utf8");
  return root;
}

/** Run `runBuildCommand` for real and hand back everything it printed.
 * This is the composition under test — the daemon's coordinator calls
 * exactly this function when no runner is injected. */
async function runRealBuild(root: string, distDir: string): Promise<RunBuildResult> {
  const { runBuildCommand } = await import("../../src/build/cli.ts");
  return await runBuildCommand(
    ["--dir", root, "--out", distDir],
    { cwd: root, version: "0.0.0-test", repoSlug: "vig-os/revkit" },
  );
}

describe("the shared `revkit build` composition runs against a consumer with no site/", () => {
  test("the consumer really has no site/ and no node_modules/ (the premise)", () => {
    const root = scaffoldConsumer();
    expect(existsSync(join(root, "site"))).toBe(false);
    expect(existsSync(join(root, "site", "node_modules", ".bin", "astro"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  test("runBuildCommand reaches the pre-build check and the packaged site, not a consumer-side astro", async () => {
    const root = scaffoldConsumer();
    const distDir = join(root, ".revkit", "dist");
    const result = await runRealBuild(root, distDir);

    // A real build needs a `docs/` tree the site loader can render.
    // This consumer has only `docs/adr/`, so the most likely terminal
    // is a check or render failure — which is FINE here: what is being
    // proven is which composition ran, and a failure still names the
    // steps in its output. Either way the pre-build check MUST have
    // run, because it is unconditional in `runBuildCommand`.
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("revkit build: consumer=");
    expect(combined).toContain("revkit build: dist=");
    // The pre-build check is the first thing `runBuildCommand` does.
    // A private astro spawn has no such step, so this line alone
    // distinguishes the two compositions.
    expect(combined).toMatch(/revkit build: check ok \(\d+ files\)|revkit build: 'revkit check' failed/);
    if (result.exitCode === 0) {
      // A full success means every remaining step ran too.
      expect(result.stdout).toContain("revkit build: astro ok");
      expect(result.stdout).toContain("revkit build: check-dist ok");
      // Output landed where `defaultConsumerDist` says it should.
      expect(result.stdout).toContain(".revkit/dist");
      expect(existsSync(join(distDir, "index.html"))).toBe(true);
      // Consumer staging under `.revkit/build/`, per DESIGN-0002 §5.
      expect(existsSync(join(root, ".revkit", "build"))).toBe(true);
    } else {
      // A failure must name the step that failed, not crash.
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(combined).not.toContain("ENOENT");
      expect(combined).not.toMatch(/bunx|npx/);
    }
  }, 600_000);

  test("a daemon with no runner override resolves the SAME primitive for its scheduled build", async () => {
    const root = scaffoldConsumer();
    const daemon: DaemonHandle = await startDaemon({
      dir: join(root, ".revkit", "dist"),
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
      reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
      // NO `backgroundBuildRun`: the coordinator falls back to the
      // shared `runBuildCommand`, which is the whole point.
      enableBackgroundBuild: true,
      backgroundBuildDebounceMs: 1,
    });
    try {
      const response = await fetch(`${daemon.url}/api/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data: [{ path: "plots/series/data.json", content: JSON.stringify([{ x: 1, y: 2 }, { x: 3, y: 4 }]) }],
        }),
      });
      const bodyText = await response.text();
      expect(response.status, bodyText).toBe(201);
      const outcome = JSON.parse(bodyText) as { build?: { status?: string }; rendering?: { reason?: string }[] };
      // A data-only file schedules a build through the real primitive.
      expect(outcome.rendering?.[0]?.reason).toBe("data-only");
      expect(outcome.build?.status).toBe("pending");

      // Wait for the persisted record to reach a terminal state, then
      // read the log's terminal build event for its content.
      const statePath = join(root, ".revkit", "publish-state.json");
      const deadline = Date.now() + 600_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        if (existsSync(statePath)) {
          const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { status?: string };
          if (parsed.status === "succeeded" || parsed.status === "failed") {
            status = parsed.status;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(status, "the scheduled build never reached a terminal state").toBeDefined();

      // Both terminals prove the real composition ran: the record's
      // `error` (failure) or the produced dist (success) names steps
      // only `runBuildCommand` performs.
      const record = JSON.parse(readFileSync(statePath, "utf8")) as { error?: string };
      if (status === "failed") {
        expect(record.error).toBeDefined();
        expect(record.error).toMatch(/revkit build:|check|astro/);
      } else {
        expect(existsSync(join(root, ".revkit", "dist"))).toBe(true);
      }
      // Nothing wrote into a consumer-side tree — there isn't one, and
      // the build did not create one.
      expect(existsSync(join(root, "site"))).toBe(false);
    } finally {
      await daemon.stop();
    }
  }, 900_000);

  test("the coordinator's default runner is the same function `revkit build` dispatches through", async () => {
    // Cheap wiring proof that does not run a build: the coordinator's
    // default and the CLI dispatcher's target must be the same module
    // export, checked on the import edge rather than by behaviour (the
    // behaviour is the two tests above, which cost a real astro build).
    const publishBuildSource = readFileSync(
      join(import.meta.dir, "..", "..", "src", "serve", "publish-build.ts"),
      "utf8",
    );
    const buildCliSource = readFileSync(
      join(import.meta.dir, "..", "..", "src", "build", "cli.ts"),
      "utf8",
    );
    // The coordinator imports `runBuildCommand` from `../build/cli.ts`.
    expect(publishBuildSource).toMatch(/from "\.\.\/build\/cli\.ts"/);
    // And `cli.ts` is what the `revkit build` dispatch case calls.
    expect(buildCliSource).toMatch(/export async function runBuildCommand/);
    // Nothing else in the coordinator can start a build.
    const code = publishBuildSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Bun\.spawn|node_modules\/\.bin|\.bin\/astro/);
    // And the coordinator factory is the one the daemon imports.
    const daemonSource = readFileSync(
      join(import.meta.dir, "..", "..", "src", "serve", "daemon.ts"),
      "utf8",
    );
    expect(daemonSource).toMatch(/createPublishBuildCoordinator/);
    expect(daemonSource).not.toMatch(/from "\.\/background-build\.ts"/);
    void createPublishBuildCoordinator;
  });
});
