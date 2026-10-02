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
// ## What runs where, and why that matters
//
// The previous version of this file had a plot-spec fixture with no
// `schemaVersion`, so the pre-build `revkit check` REFUSED it and the
// build never reached `stageAstroRoot` / `spawnAstroBuild`. Every
// packaged-path assertion sat behind `if (exitCode === 0)` and
// silently never ran — the test "passed" in 21–48 ms having proved
// only that check rejects a malformed spec. The fixture is fixed, and
// the assertions are now split by what each lane can honestly prove:
//
//   - **Fast lane (always).** The fixture is now VALID, so the build
//     gets past the pre-build check — that alone is a real result: it
//     means the daemon's scheduled build ran `runBuildCommand`'s step
//     1, not some private spawn. The assertions are therefore
//     LAYOUT-INDEPENDENT: whatever the terminal, a failure must NOT
//     come from `revkit check`, and the output must show check ran and
//     passed. A dev checkout's isolated linker cannot always complete
//     the astro step, and pretending otherwise would be a worse lie
//     than the one it replaces.
//
//   - **E2E lane (`REVKIT_E2E_BUILD=1`).** The packaged CLI from
//     `nix build .#revkit`, whose dependency tree is
//     FOD-materialised, completes the whole chain. Only there are the
//     astro / staging / `check-dist` / output assertions made — and
//     they are `describe.skipIf`, so a skipped reader sees plainly
//     that they did not run.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execSync } from "node:child_process";
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
      // REQUIRED by the plot-structure rule (ADR-0003). Its absence
      // made the pre-build check refuse this fixture and stopped the
      // build before the astro step, which is the bug this file was
      // written to catch.
      schemaVersion: 1,
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { url: "data.json" },
      mark: "point",
      encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
    }),
  );
  writeFileSync(join(root, "plots", "series", "data.json"), JSON.stringify([{ x: 1, y: 2 }]), "utf8");
  // A doc the packaged site can actually render, so the packaged lane
  // has something to prove. `Consumer Marker` is the string that lane
  // greps for in the built HTML.
  writeFileSync(
    join(root, "docs", "index.mdx"),
    "---\ntitle: Consumer\ndescription: A packaged-lane consumer.\n---\n\n## Consumer Marker\n\nBody paragraph.\n",
    "utf8",
  );
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

    // THE FAST-LANE ASSERTION. The pre-build `revkit check` is the
    // first thing `runBuildCommand` does and a private astro spawn
    // has no such step, so this line alone distinguishes the two
    // compositions. It is an EQUALITY against the passing form, not a
    // disjunction with the failing one: the fixture is valid, so a
    // check refusal here means something regressed and must be red
    // rather than quietly accepted.
    expect(combined).toMatch(/revkit build: check ok \(\d+ files\)/);
    expect(combined).not.toContain("'revkit check' failed");

    if (result.exitCode === 0) {
      expect(result.stdout).toContain("revkit build: astro ok");
      expect(result.stdout).toContain("revkit build: check-dist ok");
      expect(existsSync(join(distDir, "index.html"))).toBe(true);
      expect(existsSync(join(root, ".revkit", "build"))).toBe(true);
    } else {
      // A failure must name the step that failed, and that step must
      // be AFTER the check. Asserting "not the check" is what makes
      // this lane-independent: a dev checkout can fail to complete the
      // astro step (an isolated linker cannot always resolve the
      // packaged dep tree), and a packaged one can complete it — both
      // are fine, and both prove the shared composition ran.
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/revkit build: (astro build failed|'revkit check-dist' refused)/);
      // No registry-fetching subprocess anywhere in the output: the
      // trusted-toolchain rule (CLAUDE.md / ADR-0010).
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
        // The error must be the SHARED primitive's own diagnostic, and
        // must NOT be a pre-build check refusal: a check refusal would
        // mean the build stopped before the astro step, which is the
        // fixture bug this file exists to rule out. A private astro
        // spawn produces no `revkit build:` prefix at all, so this
        // assertion is what pins the composition.
        expect(record.error).toBeDefined();
        expect(record.error).toMatch(/^revkit build: /);
        expect(record.error).not.toContain("'revkit check' failed");
      } else {
        // A full success means the packaged site step ran and the
        // output landed.
        expect(existsSync(join(root, ".revkit", "dist"))).toBe(true);
        expect(existsSync(join(root, ".revkit", "dist", "index.html"))).toBe(true);
      }
      // Nothing wrote into a consumer-side tree — there isn't one, and
      // the build did not create one.
      expect(existsSync(join(root, "site"))).toBe(false);
      // And no consumer-side node_modules appeared either: astro came
      // from the packaged root, not from anything the consumer owns.
      expect(existsSync(join(root, "node_modules"))).toBe(false);
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

// The packaged-CLI lane. `REVKIT_E2E_BUILD=1` (which `just test`
// sets, and which CI's `Tests` job sets) lets this exec the PACKAGED
// CLI from `nix build .#revkit`, whose dependency tree is
// FOD-materialised, so the astro step completes and every packaged
// assertion can be made for real.
//
// It execs the binary rather than importing `runBuildCommand` again,
// and that distinction is the whole reason this is a separate lane:
// importing the source function runs the DEV checkout's linker, which
// cannot resolve the packaged dep tree from a staged
// `node_modules` — so it fails for a reason unrelated to the code.
// Only the packaged binary proves what a consumer actually gets.
const E2E = process.env.REVKIT_E2E_BUILD === "1";
const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

describe.skipIf(!E2E)("packaged CLI lane — the build completes the whole chain", () => {
  test("the packaged CLI builds a consumer with no site/ end to end", async () => {
    const storePath = execSync("nix build .#revkit --no-link --print-out-paths", {
      cwd: CHECKOUT_ROOT,
      encoding: "utf8",
    }).trim().split("\n").at(-1)!.trim();
    const revkitBin = join(storePath, "bin", "revkit");
    expect(existsSync(revkitBin)).toBe(true);

    const root = scaffoldConsumer();
    // A fresh consumer has neither tree. Everything below has to work
    // without them.
    expect(existsSync(join(root, "site"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    const stdout = execSync(`"${revkitBin}" build --dir "${root}"`, {
      encoding: "utf8",
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "e2e-home-")) },
    });
    // Every step of the shared composition, in order.
    expect(stdout).toContain("revkit build: check ok");
    expect(stdout).toContain("revkit build: astro ok");
    expect(stdout).toContain("revkit build: staging");
    expect(stdout).toContain("revkit build: check-dist ok");
    // Real output, in the directory the daemon serves from.
    const distIndex = join(root, ".revkit", "dist", "index.html");
    expect(existsSync(distIndex)).toBe(true);
    expect(readFileSync(distIndex, "utf8")).toContain("Consumer Marker");
    // Consumer staging + cache dirs (DESIGN-0002 §5), and still no
    // consumer-side site/ or node_modules/ afterwards — the packaged
    // root supplied astro, not the consumer.
    expect(existsSync(join(root, ".revkit", "build"))).toBe(true);
    expect(existsSync(join(root, ".revkit", "cache", "astro"))).toBe(true);
    expect(existsSync(join(root, ".revkit", "cache", "vite"))).toBe(true);
    expect(existsSync(join(root, "site"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  }, 900_000);
});
