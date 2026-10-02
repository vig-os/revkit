// Acceptance test for the publish fast path's build coordination
// (M2 item 9, story A4, PR-56):
//
//   1. A publish whose source the fast path REFUSES returns an
//      explicit `refused[]` entry naming the reason, and schedules a
//      real build through the shared `revkit build` primitive.
//   2. While that build is outstanding the route serves the previous
//      dist HTML with a visible "rendering..." banner.
//   3. The build lifecycle is DURABLE: `build.requested` /
//      `build.started` / `build.succeeded` land in the event log with
//      positive seqs, so an SSE client that connects afterwards
//      replays them via `?since=`.
//   4. On success the banner is gone and the fresh content is served.
//   5. A FAILED build swaps the spinner for a terminal error banner —
//      the reviewer is never left with an in-progress banner for a
//      build that is not running.
//   6. A data-only publish (plot data, no route) still schedules a
//      build and says so in `rendering[]`.
//   7. Generation safety: a build that succeeds for generation A must
//      NOT clear the refusal recorded by a later publish B.
//   8. Restart: a daemon that died with a build pending reschedules it
//      and still shows the banner on the first page view.
//
// **RED before this branch**: the daemon referenced a
// `./background-build.ts` module that did not exist, so every one of
// these behaviours was unreachable — the module failed to import.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { ARTICLE_OPEN_MARKER } from "../../src/serve/publish.ts";
import type { RunBuildResult } from "../../src/build/cli.ts";
import { revisionOf } from "@revkit/review-core";

const OLD_BODY_MARKER = "OLD-BODY-MARKER";
const NEW_BODY_MARKER = "NEW-BODY-MARKER-FROM-BACKGROUND-BUILD";
const ADR_REL = "docs/adr/9998-refused-flow.md";
const ADR_ROUTE = "/adr/9998-refused-flow/";
const OLD_SOURCE = `# ADR-9998: Refused flow

- Status: Proposed
- Date: 2026-09-30

## Context

Old body — replaced by the publish below.
${OLD_BODY_MARKER}
`;
const NEW_SOURCE = `# ADR-9998: Refused flow

- Status: Proposed
- Date: 2026-09-30

## Context

New body — but with a fenced code block that the fast path
refuses to render byte-for-byte:

\`\`\`ts
const x = 1;
\`\`\`

${NEW_BODY_MARKER}
`;

/** A build invocation the stub recorded. */
interface BuildCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

interface Ctx {
  handle: DaemonHandle;
  root: string;
  distPath: string;
  buildCalls: BuildCall[];
  /** Set by the test to decide what the next build reports. */
  failNextBuild: { value: string | undefined };
  /** One gate per build invocation, in order. Build N awaits
   * `gates[N]` when present, so a test can hold exactly the builds it
   * needs to hold — including the Nth, to catch the state between
   * build N-1 settling and build N landing. */
  buildGates: Promise<void>[];
}

function shellHtml(articleBody: string, revision: string): string {
  const stamp = `<span data-revkit-revision="${revision}" hidden></span>`;
  return `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body>
<header class="sl-header">nav</header>
<div class="content-panel"><div class="sl-container">${ARTICLE_OPEN_MARKER}${stamp}${articleBody}</div></div>
<footer>© 2026</footer>
</body></html>
`;
}

/** Seed a consumer-shaped repo with one built ADR. */
function seedRepo(): { root: string; distPath: string } {
  const root = mkdtempSync(join(tmpdir(), "revkit-refused-build-"));
  const distPath = join(root, "site", "dist", "adr", "9998-refused-flow", "index.html");
  mkdirSync(join(root, "site", "dist", "adr", "9998-refused-flow"), { recursive: true });
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  mkdirSync(join(root, "plots", "9998-series"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    "schemaVersion: 1\nentries:\n  - id: placeholder\n    term: placeholder\n    definition: A placeholder term for tests.\n",
  );
  return { root, distPath };
}

async function boot(ctx: Partial<Ctx> = {}): Promise<Ctx> {
  const { root, distPath } = seedRepo();
  const oldRev = await revisionOf(OLD_SOURCE);
  writeFileSync(distPath, shellHtml(`<p>${OLD_BODY_MARKER}</p>`, oldRev), "utf8");
  writeFileSync(join(root, "site", "dist", "index.html"), "<!doctype html><h1>root</h1>", "utf8");
  writeFileSync(join(root, ADR_REL), OLD_SOURCE, "utf8");
  writeFileSync(
    join(root, "plots", "9998-series", "spec.vl.json"),
    JSON.stringify({
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { url: "data.json" },
      mark: "point",
      encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
    }),
  );
  writeFileSync(join(root, "plots", "9998-series", "data.json"), JSON.stringify([{ x: 1, y: 2 }]), "utf8");

  const buildCalls: BuildCall[] = [];
  const failNextBuild = { value: undefined as string | undefined };
  const buildGates: Promise<void>[] = [];
  // The stub stands in for `runBuildCommand` — the SAME signature and
  // the SAME args the real primitive receives, so what this test
  // asserts about the call shape is what production does. What it
  // replaces is only the astro build itself.
  const runBuild = async (
    args: readonly string[],
    env: { readonly cwd: string; readonly version: string; readonly repoSlug: string },
  ): Promise<RunBuildResult> => {
    buildCalls.push({ args: [...args], cwd: env.cwd });
    // Model a real build honestly: it compiles what was on disk when
    // it STARTED. Reading the source after the gate matters — a
    // publish that lands mid-build is not in this build's output, and
    // a stub that re-read the file afterwards would paper over the
    // generation-safety behaviour the next test asserts.
    const sourceAtStart = readFileSync(join(root, ADR_REL), "utf8");
    const failure = failNextBuild.value;
    failNextBuild.value = undefined;
    const gate = buildGates[buildCalls.length - 1];
    if (gate !== undefined) await gate;
    if (failure !== undefined) return { exitCode: 1, stdout: "", stderr: failure };
    writeFileSync(distPath, shellHtml(`<p>${NEW_BODY_MARKER}</p>`, await revisionOf(sourceAtStart)), "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: join(root, "site", "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
    enableBackgroundBuild: true,
    backgroundBuildRun: runBuild,
    backgroundBuildDebounceMs: 20,
  });
  return { handle, root, distPath, buildCalls, failNextBuild, buildGates, ...ctx };
}

async function shutdown(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

async function publish(
  ctx: { readonly handle: DaemonHandle },
  docs: readonly { path: string; content: string }[],
): Promise<{
  status: number;
  body: {
    published: { path: string; revision: string }[];
    overrides: unknown[];
    refused: { path: string; route?: string; reason: string }[];
    rendering: ({ path: string; route?: string; detail?: string } & ({ state: string } | { reason: string }))[];
    generation: string;
    build: { generation: string; status: string };
  };
}> {
  const resp = await fetch(`${ctx.handle.url}/api/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.handle.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ docs }),
  });
  return { status: resp.status, body: (await resp.json()) as never };
}

/** Read every event kind the log holds, via the SSE replay endpoint
 * (`?since=0`), which is the same durable path a reconnecting client
 * takes. Also returns the seqs so a test can assert they are real
 * positive sequence numbers rather than synthetic frames. */
async function replayedEvents(ctx: { readonly handle: DaemonHandle }): Promise<{ kind: string; seq: number; generation?: string }[]> {
  const resp = await fetch(`${ctx.handle.url}/events?since=0`, {
    headers: { authorization: `Bearer ${ctx.handle.agentToken}` },
  });
  expect(resp.ok).toBe(true);
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  const events: { kind: string; seq: number; generation?: string }[] = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 300)),
    ]);
    if (read.value !== undefined) {
      for (const line of decoder.decode(read.value).split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(line.slice("data:".length).trim()) as { kind?: string; seq?: number; generation?: string };
          if (typeof parsed.kind === "string" && typeof parsed.seq === "number") {
            events.push({ kind: parsed.kind, seq: parsed.seq, ...(parsed.generation !== undefined ? { generation: parsed.generation } : {}) });
          }
        } catch {
          // keepalive comment
        }
      }
    }
    if (events.some((e) => e.kind === "build.succeeded" || e.kind === "build.failed")) break;
  }
  reader.cancel();
  return events;
}

let ctx: Ctx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await shutdown(ctx);
});

test("a refused publish names the reason, shows a banner, and the shared build primitive lands the new content", async () => {
  // Hold the build open so the mid-build state is observable rather
  // than raced.
  let releaseBuild: () => void = () => {};
  ctx.buildGates[0] = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });

  const published = await publish(ctx, [{ path: ADR_REL, content: NEW_SOURCE }]);
  expect(published.status).toBe(201);
  // (a) refused[] names the doc and the reason.
  expect(published.body.refused).toEqual([
    { path: ADR_REL, route: ADR_ROUTE, reason: "code-fence" },
  ]);
  // No override — the fast path did NOT render the source.
  expect(published.body.overrides).toEqual([]);
  // (b) `rendering[]` carries the typed no-override state, not silence.
  expect(published.body.rendering).toEqual([
    { path: ADR_REL, route: ADR_ROUTE, reason: "fast-path-refused", detail: "code-fence" },
  ]);
  // (c) A build was scheduled for this generation.
  expect(published.body.build.status).toBe("pending");
  expect(published.body.build.generation).toBe(published.body.generation);
  // Publish still landed on disk.
  expect(readFileSync(join(ctx.root, ADR_REL), "utf8")).toBe(NEW_SOURCE);

  // (d) The build goes through the SHARED primitive: `--dir` the
  //     consumer root, `--out` the serve dir, cwd the consumer root.
  //     A private `site/node_modules/.bin/astro` spawn would not look
  //     like this and would fail for a consumer that has no `site/`.
  await waitFor(() => ctx.buildCalls.length > 0);
  expect(ctx.buildCalls[0]?.args).toEqual(["--dir", ctx.root, "--out", join(ctx.root, "site", "dist")]);
  expect(ctx.buildCalls[0]?.cwd).toBe(ctx.root);

  // (e) IMMEDIATELY a GET of the route shows the "rendering..."
  //     banner (the build has not finished).
  const bannerResp = await fetch(`${ctx.handle.url}${ADR_ROUTE}`);
  const bannerHtml = await bannerResp.text();
  expect(bannerHtml).toContain('data-revkit-banner="rendering"');
  expect(bannerHtml).toContain("rendering&hellip;");
  expect(bannerHtml).toContain("full build in progress");
  // The banner is served alongside the OLD article body (dist has
  // not been rebuilt yet).
  expect(bannerHtml).toContain(OLD_BODY_MARKER);
  expect(bannerHtml).not.toContain(NEW_BODY_MARKER);

  releaseBuild();
  await waitFor(async () => {
    const resp = await fetch(`${ctx.handle.url}${ADR_ROUTE}`);
    return (await resp.text()).includes(NEW_BODY_MARKER);
  });

  // (f) Fresh content, banner gone — this is what the browser reload
  //     on `build.succeeded` picks up.
  const freshResp = await fetch(`${ctx.handle.url}${ADR_ROUTE}`);
  const freshHtml = await freshResp.text();
  expect(freshHtml).not.toContain('data-revkit-banner="rendering"');
  expect(freshHtml).toContain(NEW_BODY_MARKER);
});

test("build lifecycle events are durable with positive seqs and replay to a client that connects afterwards", async () => {
  await publish(ctx, [{ path: ADR_REL, content: NEW_SOURCE }]);
  await waitFor(async () => (await fetch(`${ctx.handle.url}${ADR_ROUTE}`)).text().then((h) => h.includes(NEW_BODY_MARKER)));

  // A client that was never connected reads the whole build from the
  // durable log via `?since=0` — the same frames a reconnecting SSE
  // client gets from `Last-Event-ID`.
  const events = await replayedEvents(ctx);
  const build = events.filter((e) => e.kind.startsWith("build."));
  expect(build.map((e) => e.kind)).toEqual(["build.requested", "build.started", "build.succeeded"]);
  // No seq-0 pseudo-events: every frame carries a real positive seq,
  // strictly increasing, so a resume point is meaningful.
  for (const event of build) {
    expect(event.seq).toBeGreaterThan(0);
  }
  const seqs = build.map((e) => e.seq);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  // Every build event names the generation it was scheduled for.
  const generation = build[0]!.generation;
  expect(generation).toBeDefined();
  for (const event of build) expect(event.generation).toBe(generation);
});

test("a failed build shows a terminal error banner, not an in-progress one", async () => {
  ctx.failNextBuild.value = "error during build:\nRollupError: Cannot find module './missing.js'";
  await publish(ctx, [{ path: ADR_REL, content: NEW_SOURCE }]);
  await waitFor(async () => (await fetch(`${ctx.handle.url}${ADR_ROUTE}`)).text().then((h) => h.includes('data-revkit-banner="build-failed"')));

  const html = await (await fetch(`${ctx.handle.url}${ADR_ROUTE}`)).text();
  expect(html).toContain('data-revkit-banner="build-failed"');
  // Terminal copy: the reviewer is told the build broke and that the
  // page is the previous one, and is NOT told a build is running.
  expect(html).not.toContain('data-revkit-banner="rendering"');
  expect(html).not.toContain("full build in progress");
  expect(html).toContain("Cannot find module");
  // The stale content is still served (nothing better exists), and it
  // is labelled as such.
  expect(html).toContain(OLD_BODY_MARKER);

  const events = await replayedEvents(ctx);
  expect(events.map((e) => e.kind)).toContain("build.failed");
  // The failure is retried by the NEXT publish, not by a hot loop:
  // exactly one build ran.
  expect(ctx.buildCalls.length).toBe(1);
});

test("a data-only publish schedules a build and reports the typed state for it", async () => {
  const dataResp = await publish(ctx, [
    {
      path: "plots/9998-series/data.json",
      content: JSON.stringify([{ x: 1, y: 2 }, { x: 2, y: 4 }]),
    },
  ]);
  expect(dataResp.status).toBe(201);
  expect(dataResp.body.refused).toEqual([]);
  expect(dataResp.body.overrides).toEqual([]);
  // A plot data file has no route and nothing the fast path can
  // render — but the plot's SVG is a build-time product, so a build
  // IS scheduled and the response says so with a typed reason rather
  // than implying everything rendered.
  expect(dataResp.body.rendering).toEqual([
    { path: "plots/9998-series/data.json", reason: "data-only" },
  ]);
  expect(dataResp.body.build.status).toBe("pending");
  await waitFor(() => ctx.buildCalls.length > 0);
});

test("a route with no built shell schedules a build and says the shell is missing", async () => {
  // No dist page exists for this ADR, so there is nothing to splice a
  // rendered fragment into.
  const freshRoute = await publish(ctx, [
    {
      path: "docs/adr/9999-brand-new.md",
      content: "# ADR-9999: Brand new\n\n- Status: Proposed\n- Date: 2026-10-02\n\n## Context\n\nHello.\n",
    },
  ]);
  expect(freshRoute.status).toBe(201);
  expect(freshRoute.body.refused).toEqual([]);
  expect(freshRoute.body.rendering).toEqual([
    { path: "docs/adr/9999-brand-new.md", route: "/adr/9999-brand-new/", reason: "shell-missing" },
  ]);
  expect(freshRoute.body.build.status).toBe("pending");
  await waitFor(() => ctx.buildCalls.length > 0);
});

test("a build that succeeds for an older generation does not clear a newer publish's refusal", async () => {
  // Build 1 is released by hand; build 2 never completes. That freezes
  // the exact window the priority is about: A's build has settled,
  // B's build has not landed, and the reviewer must still be told the
  // page is behind.
  let releaseBuild: () => void = () => {};
  ctx.buildGates[0] = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  ctx.buildGates[1] = new Promise<void>(() => {});

  // Generation A: a refusal, with its build held open.
  const first = await publish(ctx, [{ path: ADR_REL, content: NEW_SOURCE }]);
  await waitFor(() => ctx.buildCalls.length === 1);
  const generationA = first.body.generation;

  // While A's build is in flight, a NEWER publish B for the same
  // route lands and is refused too. B records its own generation.
  const second = await publish(ctx, [
    {
      path: ADR_REL,
      content: `${NEW_SOURCE}\n\nSecond refusal — the newer source.\n`,
    },
  ]);
  const generationB = second.body.generation;
  expect(generationB).not.toBe(generationA);
  // Single-flight: B's build has not started yet.
  expect(ctx.buildCalls.length).toBe(1);

  // Release A's build. It compiled A's source, so the dist it writes
  // is stamped with A's revision — the page is still behind B.
  releaseBuild();
  // The coordinator must NOT settle A as the current generation: B
  // landed while A was running, so B is rebuilt.
  await waitFor(() => ctx.buildCalls.length === 2);

  // B's banner is still on the page. A's success did not clear it,
  // even though A's build DID land its HTML — dist now serves A's
  // body, which is still behind B's source, and the banner is what
  // says so. A daemon that cleared the whole refusal map on any
  // build success would serve A's HTML here with no indication that
  // B is newer.
  const html = await (await fetch(`${ctx.handle.url}${ADR_ROUTE}`)).text();
  expect(html).toContain('data-revkit-banner="rendering"');
  expect(html).toContain(NEW_BODY_MARKER);
  // The persisted record advanced to B, never settled on A.
  const state = JSON.parse(
    readFileSync(join(ctx.root, ".revkit", "publish-state.json"), "utf8"),
  ) as { generation: string };
  expect(state.generation).toBe(generationB);

  // Every build event names B or A explicitly — never a bare
  // "succeeded" that a reader would have to guess the scope of.
  const events = await replayedEvents(ctx);
  const builds = events.filter((e) => e.kind.startsWith("build."));
  const generations = new Set(builds.map((e) => e.generation));
  expect(generations.has(generationA)).toBe(true);
  expect(generations.has(generationB)).toBe(true);
  expect(builds.every((e) => e.seq > 0)).toBe(true);
});

test("a daemon that restarts with a build outstanding reschedules it and re-announces on the log", async () => {
  // A daemon whose build runner never returns, published to, then
  // stopped: the record on disk is `running`, which is exactly the
  // state a process death mid-build leaves behind.
  const held = await boot();
  held.buildGates[0] = new Promise<void>(() => {
    // Never resolves — the build stays in flight.
  });
  await publish(held, [{ path: ADR_REL, content: NEW_SOURCE }]);
  await waitFor(() => held.buildCalls.length > 0);
  const statePath = join(held.root, ".revkit", "publish-state.json");
  const inFlight = JSON.parse(readFileSync(statePath, "utf8")) as { status: string; generation: string };
  expect(inFlight.status).toBe("running");
  await held.handle.stop();

  // Bring up a daemon WITH the coordinator: `running` is not
  // authoritative across a process boundary, so it must be demoted to
  // `pending` and retried, and `build.requested` must be re-announced
  // so the durable log tells the same story.
  const resumedBuilds: BuildCall[] = [];
  const resumed = await startDaemon({
    dir: join(held.root, "site", "dist"),
    repoRoot: held.root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
    enableBackgroundBuild: true,
    backgroundBuildDebounceMs: 20,
    backgroundBuildRun: async (args, env) => {
      resumedBuilds.push({ args: [...args], cwd: env.cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  try {
    await waitFor(() => resumedBuilds.length > 0);
    expect(JSON.parse(readFileSync(statePath, "utf8")).generation).toBe(inFlight.generation);
    const events = await replayedEvents({ handle: resumed });
    expect(events.map((e) => e.kind)).toContain("build.requested");
    // First page view after the restart already explains the stale
    // content rather than serving it bare.
    const html = await (await fetch(`${resumed.url}${ADR_ROUTE}`)).text();
    expect(html).toContain('data-revkit-banner="rendering"');
  } finally {
    await resumed.stop();
    rmSync(held.root, { recursive: true, force: true });
  }
});

/** Poll `predicate` until it is truthy. Keeps the assertions above
 * free of arbitrary sleeps while still giving the debounce + async
 * build a real budget. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: predicate never became true");
}
