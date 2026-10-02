// Playwright: the publish live-refresh path must SETTLE (M2 item 9,
// story A4).
//
// The rejected-head blocker: `rail.tsx` opened `new EventSource("/events")`
// with NO resume point, so the daemon replayed the entire durable log
// from seq 1 on every page load, and this PR's new
// `window.location.reload()` triggers fired again on each replay:
// load → replay → reload → replay → reload, forever. The reviewer
// measured 212 navigations in 8 s on an unrelated route after a
// data-only publish. The existing `publish.spec.ts` could not see it
// because it only asserts that the new content APPEARS — a page that
// reloads 212 times still shows the content.
//
// This spec asserts the property the old one missed: after a publish,
// the page reaches a FIXED POINT. A bounded navigation budget during
// the settle window, plus a zero-delta quiescence check afterwards.
//
// The daemon here is the real CLI (`revkit serve`) against the real
// `site/dist`, with NO runner override — so every scheduled build runs
// the real shared `revkit build` primitive, not a stub.
//
// ## Why every scheduled build in this file fails at the PRE-BUILD CHECK
//
// These tests care about the RAIL's reaction to build events, not about
// whether astro can compile a site. `runBuildCommand`'s first step is
// `revkit check` over the whole consumer tree, so a consumer carrying
// one vocab-violating sibling makes every scheduled build fail there in
// ~100 ms — with NO `stageAstroRoot` and NO spawned `astro`.
//
// That is a suite-stability decision, not just a speed one. Playwright
// runs fully parallel, so a handful of real astro builds here contend
// with every Chromium instance and starve other specs' timing-sensitive
// assertions: `rail-reanchor.spec.ts`'s rename-save assertion failed
// ~2 in 10 of the full leg while passing 8/8 on its own. The
// packaged-astro proof — that the shared composition really completes
// against a consumer with no `site/` — is not lost to this choice: it
// is owned by the E2E lane of
// `packages/cli/test/build/publish-build-real.test.ts`, which execs the
// PACKAGED binary. Nothing here is faked; this file simply does not ask
// for a build that has to compile anything.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVKIT_BIN = resolve(__dirname, "..", "..", "packages", "cli", "bin", "revkit.js");
const DIST = resolve(__dirname, "..", "dist");
const REPO_ROOT = resolve(__dirname, "..", "..");

const ADR_REL_PATH = "docs/adr/0001-static-first-site-stack.md";
const ADR_ROUTE = "/adr/0001-static-first-site-stack/";
/** A route the publishes below never touch — the reviewer's loop was
 * measured here, because the `build.*` reload trigger is
 * unconditional across routes. */
const UNRELATED_ROUTE = "/designs/design-0001-revkit-architecture/";
const PLOT_REL_PATH = "plots/e2e-series/data.json";
const PLOT_SPEC_PATH = "plots/e2e-series/spec.vl.json";
const MARKER = "REVKIT-SETTLES-E2E-MARKER";

/** A doc the fast path REFUSES: a fenced code block diverges from
 * Starlight's expressive-code frame, so the publish schedules a build. */
const REFUSED_BODY = `# ADR-0001: Static-first site stack: Astro, Starlight, Bun

- Status: Accepted
- Date: 2026-09-30

## Context

${MARKER}

\`\`\`ts
const x: number = 1;
\`\`\`
`;

const FAST_BODY = `# ADR-0001: Static-first site stack: Astro, Starlight, Bun

- Status: Accepted
- Date: 2026-09-30

## Context

${MARKER}
`;

interface DaemonCtx {
  child: ChildProcess;
  readonly root: string;
  readonly url: string;
  readonly launchUrl: string;
  readonly agentToken: string;
  readonly port: number;
}

async function bootDaemon(): Promise<DaemonCtx> {
  if (!existsSync(DIST)) {
    throw new Error(`site/dist does not exist at ${DIST}; run \`just build\` first.`);
  }
  const root = mkdtempSync(join(tmpdir(), "revkit-settles-e2e-"));
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(root, ADR_REL_PATH),
    readFileSync(resolve(REPO_ROOT, ADR_REL_PATH), "utf8"),
    "utf8",
  );
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    readFileSync(resolve(REPO_ROOT, "vocab/terms.yaml"), "utf8"),
    "utf8",
  );
  // A publishable plot: `plots/<name>/` with a spec + data sibling, so
  // a data-only publish has a real parent to land in.
  mkdirSync(join(root, "plots", "e2e-series"), { recursive: true });
  writeFileSync(
    join(root, PLOT_SPEC_PATH),
    JSON.stringify({
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { url: "data.json" },
      mark: "point",
      encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
    }),
    "utf8",
  );
  writeFileSync(join(root, PLOT_REL_PATH), JSON.stringify([{ x: 1, y: 2 }]), "utf8");

  const child = spawn("bun", [REVKIT_BIN, "serve", "--dir", DIST], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: process.env,
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));
  child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
  const deadline = Date.now() + 15_000;
  let state: { readonly url: string; readonly port: number; readonly agentToken: string } | undefined;
  while (Date.now() < deadline) {
    const path = join(root, ".revkit", "serve.json");
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf8"));
        break;
      } catch {
        /* mid-write */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state === undefined) {
    child.kill("SIGTERM");
    throw new Error(
      `daemon did not write serve.json within 15s\nstderr: ${stderrChunks.join("")}\nstdout: ${stdoutChunks.join("")}`,
    );
  }
  const deadline2 = Date.now() + 3_000;
  while (Date.now() < deadline2) {
    if (stdoutChunks.join("").match(/launch:\s+(\S+)/)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const launchUrl = stdoutChunks.join("").match(/launch:\s+(\S+)/)?.[1];
  if (launchUrl === undefined) {
    child.kill("SIGTERM");
    throw new Error(`daemon started but never printed 'launch:': ${stdoutChunks.join("")}`);
  }
  return { child, root, url: state.url, launchUrl, agentToken: state.agentToken, port: state.port };
}

/** Restart the daemon on the SAME port with the SAME sqlite file, so
 * the log continues rather than restarting at seq 1 — which is the
 * realistic "daemon died and came back" case and the one that would
 * expose a resume point of 0. */
async function restartDaemon(ctx: DaemonCtx): Promise<void> {
  ctx.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 700));
  const child = spawn("bun", [REVKIT_BIN, "serve", "--dir", DIST, "--port", String(ctx.port)], {
    cwd: ctx.root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: process.env,
  });
  // Mutate the handle so `shutdown` kills the right process.
  (ctx as { child: ChildProcess }).child = child;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(join(ctx.root, ".revkit", "serve.json"))) {
      await new Promise((r) => setTimeout(r, 250));
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("restarted daemon never wrote serve.json");
}

/** Plant a sibling file the consumer-tree `revkit check` inside
 * `revkit build` refuses, so every build this daemon schedules fails
 * at the PRE-BUILD CHECK instead of reaching astro.
 *
 * It is deliberately NOT part of any publish batch: `runPublish` checks
 * only the batch, so the publish still succeeds and the daemon still
 * schedules its build. The build then walks the whole tree, finds this,
 * and exits — a real `build.failed` with a real diagnostic, produced by
 * the real shared primitive. */
function plantCheckFailingSibling(root: string): void {
  writeFileSync(
    join(root, "docs", "adr", "0997-broken-sibling.md"),
    "# ADR-0997: Broken sibling\n\n- Status: Proposed\n- Date: 2026-10-02\n\n## Context\n\nA term the vocabulary does not define: [[no-such-term-anywhere]].\n",
    "utf8",
  );
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try {
    ctx.child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Count MAIN-FRAME navigations. `window.location.reload()` produces
 * one of these per cycle, which is exactly the quantity that went
 * unbounded. */
function countNavigations(page: import("@playwright/test").Page): { count: () => number } {
  let count = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) count++;
  });
  return { count: () => count };
}

/** Observe every `/events` URL the page's EventSource opens.
 *
 * This is what makes the cold-tab resume point ASSERTABLE rather than
 * assumed. The rejected head shipped `/api/events-head` without a
 * dispatcher branch, so the rail's probe 404'd, `since` fell back to
 * 0, and every cold tab replayed the whole log — a behaviour no
 * navigation-count assertion could distinguish from "the fix works".
 * Reading the actual URL settles it. */
async function observeEventStreamUrls(page: import("@playwright/test").Page): Promise<string[]> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __revkitEventUrls?: string[];
      EventSource: typeof EventSource;
    };
    w.__revkitEventUrls = [];
    const Native = w.EventSource;
    w.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        w.__revkitEventUrls?.push(String(url));
        super(url, init);
      }
    } as unknown as typeof EventSource;
  });
  return page.evaluate(() => (window as unknown as { __revkitEventUrls?: string[] }).__revkitEventUrls ?? []);
}

/** Budget for the settle window. One publish reloads at most once per
 * genuinely new event; a data-only / refused publish additionally
 * sees `build.requested` + `build.started` (neither of which
 * reloads) and ONE terminal build event. So the ceiling is small and
 * the assertion has real slack while still failing hard on the
 * unbounded case (212 navigations in 8 s). */
const SETTLE_BUDGET = 6;
const QUIESCENCE_WINDOW_MS = 4_000;

async function settle(
  page: import("@playwright/test").Page,
  nav: { count: () => number },
  label: string,
  settleMs = 2_500,
  budget = SETTLE_BUDGET,
): Promise<void> {
  // Let the publish's events arrive and any legitimate reload happen.
  const before = nav.count();
  await page.waitForTimeout(settleMs);
  const afterSettle = nav.count();
  // `process.stdout.write`, not `console.log`: the repo's
  // no-debug-leftovers gate treats console output in checked-in code
  // as a leftover probe, and this measurement is the point of the
  // spec rather than a debugging aid.
  process.stdout.write(
    `SETTLES[${label}] navigations: at-open=${before} after-settle=${afterSettle} budget=${budget}\n`,
  );
  expect(
    afterSettle,
    `${label}: the page must reach a fixed point within the settle budget (navigations=${afterSettle}, budget=${SETTLE_BUDGET})`,
  ).toBeLessThanOrEqual(budget);

  // Quiescence: no further navigations at all while nothing else is
  // happening. This is the assertion the old spec could not make.
  await page.waitForTimeout(QUIESCENCE_WINDOW_MS);
  const afterQuiet = nav.count();
  process.stdout.write(
    `SETTLES[${label}] navigations after +${QUIESCENCE_WINDOW_MS}ms quiet: ${afterQuiet} (delta ${afterQuiet - afterSettle})\n`,
  );
  expect(
    afterQuiet,
    `${label}: the page kept navigating after it settled (${afterSettle} → ${afterQuiet}) — replay is re-triggering the reload`,
  ).toBe(afterSettle);
}

test.describe("revkit publish — the page SETTLES (no reload loop)", () => {
  let ctx: DaemonCtx;

  test.beforeEach(async () => {
    ctx = await bootDaemon();
  });

  test.afterEach(async () => {
    await shutdown(ctx);
  });

  test("accepted publish: the open route reloads once and stops", async ({ page }) => {
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${ctx.url}${ADR_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);
    const before = nav.count();

    const response = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { docs: [{ path: ADR_REL_PATH, content: FAST_BODY }] },
    });
    expect(response.status(), await response.text()).toBe(201);
    // The intended behaviour is preserved: a genuinely new publish on
    // the open route refreshes it.
    await page.waitForFunction((marker) => document.body.innerText.includes(marker), MARKER, { timeout: 5_000 });
    expect(nav.count(), "a genuinely new publish must still refresh the open page").toBeGreaterThan(before);

    await settle(page, nav, "accepted publish");
  });

  test("data-only publish: an UNRELATED route reloads at most once for the build and stops", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    // Open a route the publish below never touches — this is where
    // the reviewer measured 212 navigations in 8 s.
    await page.goto(`${ctx.url}${UNRELATED_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);

    const response = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { data: [{ path: PLOT_REL_PATH, content: JSON.stringify([{ x: 1, y: 2 }, { x: 2, y: 4 }]) }] },
    });
    expect(response.status(), await response.text()).toBe(201);
    // A data-only file has no route of its own; the build it schedules
    // is the only thing that could reload an unrelated page.
    const outcome = (await response.json()) as { build?: { status?: string }; rendering?: { reason?: string }[] };
    expect(outcome.rendering?.[0]?.reason).toBe("data-only");
    expect(outcome.build?.status).toBe("pending");

    await settle(page, nav, "data-only publish");
  });

  test("refused publish: the banner appears and the page stops reloading", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${ctx.url}${UNRELATED_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);

    const response = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { docs: [{ path: ADR_REL_PATH, content: REFUSED_BODY }] },
    });
    expect(response.status(), await response.text()).toBe(201);
    const outcome = (await response.json()) as { refused?: { reason?: string }[] };
    expect(outcome.refused?.[0]?.reason).toBe("code-fence");

    await settle(page, nav, "refused publish");
  });

  test("COLD TAB requests `/events?since=<head>`, not `since=0`", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    // The whole point of `/api/events-head`. A cold tab has just
    // loaded current server state, so replaying the log can only
    // re-fire actions — it must start at the tip. `since=0` here would
    // mean the probe 404'd (as it did on the rejected head) or the
    // head read 0, and the reload-loop risk is back.
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    // Put durable events on the log FIRST. On a daemon with an empty
    // log the head IS 0, and `since=0` is then correct rather than a
    // broken probe — so a test that opens a virgin daemon cannot tell
    // the two apart. A data-only publish appends `doc.published` plus
    // the build lifecycle, which is what makes head > 0.
    const seeded = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { data: [{ path: PLOT_REL_PATH, content: JSON.stringify([{ x: 1, y: 2 }, { x: 2, y: 4 }]) }] },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);

    const urls = await observeEventStreamUrls(page);
    await page.goto(`${ctx.url}${ADR_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(600);
    const all = [...urls, ...(await page.evaluate(() => (window as unknown as { __revkitEventUrls?: string[] }).__revkitEventUrls ?? []))];
    const eventsUrls = all.filter((u) => u.includes("/events"));
    process.stdout.write(`SETTLES[cold tab] /events URLs: ${JSON.stringify(eventsUrls)}\n`);
    expect(eventsUrls.length).toBeGreaterThan(0);
    for (const url of eventsUrls) {
      expect(url, "a cold tab must resume from the log head, never from 0").toMatch(/[?&]since=[1-9]\d*$/);
      expect(url).not.toMatch(/[?&]since=0($|&)/);
    }
    // And the head the rail used is the daemon's real tip.
    // `page.request` sends neither Origin nor Sec-Fetch-Site, and the
    // daemon's Origin discipline refuses a cookie call with neither —
    // so send Origin explicitly, exactly as the rail's own fetch does.
    const headResp = await page.request.get(`${ctx.url}/api/events-head`, {
      headers: { origin: ctx.url, accept: "application/json" },
    });
    expect(headResp.status()).toBe(200);
    const head = (await headResp.json()) as { head: number };
    const sinceValues = eventsUrls.map((u) => Number.parseInt(new URL(u, ctx.url).searchParams.get("since") ?? "0", 10));
    for (const since of sinceValues) expect(since).toBeLessThanOrEqual(head.head);
    expect(sinceValues.some((v) => v > 0)).toBe(true);

    // And a genuinely new publish still refreshes the open route once.
    const nav = countNavigations(page);
    const before = nav.count();
    await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { docs: [{ path: ADR_REL_PATH, content: FAST_BODY }] },
    });
    await page.waitForFunction((marker) => document.body.innerText.includes(marker), MARKER, { timeout: 5_000 });
    expect(nav.count(), "a new publish on a cold tab must still refresh exactly once").toBe(before + 1);
    await settle(page, nav, "cold tab");
  });

  test("a publish landing BETWEEN the HTML GET and the stream attach is not lost", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    // The lost-update window, made deterministic.
    //
    // A working resume point TRADES unconditional replay for
    // conditional updates: with `since=<head>` the page only sees
    // frames after its resume point, so anything appended between the
    // page's own HTML GET and the moment the stream attaches is in
    // neither — the page goes stale with no banner and no self-heal.
    // Before the resume point existed, full replay meant it could
    // not miss it.
    //
    // Determinism: `page.route` HOLDS the rail bundle, so the page's
    // HTML has been fetched and rendered but the rail has not even
    // loaded. The publish lands in exactly that window. Releasing the
    // bundle lets the rail mount and attach — with the head stamped
    // into the HTML at RENDER time, which predates the publish, so
    // the stream replays it.
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    // Give the log some history, so the replay range is non-trivial.
    const seed = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { data: [{ path: PLOT_REL_PATH, content: JSON.stringify([{ x: 1, y: 2 }]) }] },
    });
    expect(seed.status(), await seed.text()).toBe(201);

    let releaseBundle: () => void = () => {};
    const bundleHeld = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    let heldOnce = false;
    await page.route("**/-/rail.js", async (route) => {
      heldOnce = true;
      await bundleHeld;
      await route.continue();
    });
    // Force a COLD tab. Without this the test passes for the wrong
    // reason: the launch-code page earlier in the same tab already
    // wrote a persisted resume point, and resuming from THAT also
    // covers the window — so the assertion would hold even if the
    // page-render stamp did nothing. Clearing sessionStorage makes the
    // stamp the only mechanism that can close the window, which is
    // what makes this a regression test rather than a tautology.
    await page.addInitScript(() => {
      try {
        window.sessionStorage.clear();
      } catch {
        /* nothing to clear */
      }
    });

    // `waitUntil: "commit"` — NOT "load". The rail bundle is held, so
    // the load event never fires and a load-waiting goto would time
    // out. "commit" returns as soon as the navigation is committed,
    // which is exactly the state we want: the response has been
    // fetched, and we then wait for the parse ourselves.
    await page.goto(`${ctx.url}${ADR_ROUTE}`, { waitUntil: "commit" });
    // The stamp proves the daemon captured a head AT RENDER TIME.
    // `state: "attached"` — a `<meta>` is never "visible", so the
    // default wait would time out against a tag that is right there.
    await page.waitForSelector('meta[name="revkit-log-head"]', { state: "attached", timeout: 10_000 });
    const stamped = await page.evaluate(() =>
      document.querySelector('meta[name="revkit-log-head"]')?.getAttribute("content") ?? null,
    );
    process.stdout.write(`SETTLES[window] page-render head stamp = ${stamped}\n`);
    expect(Number.parseInt(stamped ?? "0", 10)).toBeGreaterThan(0);

    // Wait until the bundle request is actually intercepted — the
    // window is only open once the rail is blocked on load.
    for (let i = 0; i < 150 && !heldOnce; i++) {
      await page.waitForTimeout(20);
    }
    expect(heldOnce, "the rail bundle was never held, so the window was never open").toBe(true);

    const nav = countNavigations(page);
    const before = nav.count();
    // THE EVENT IN THE WINDOW: the page HTML is already rendered, the
    // rail is not loaded, and this publish must still reach the page.
    const inWindow = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { docs: [{ path: ADR_REL_PATH, content: FAST_BODY }] },
    });
    expect(inWindow.status(), await inWindow.text()).toBe(201);

    releaseBundle();
    // The rail mounts, attaches from the page-render head, replays
    // the in-window publish, and refreshes the open route — exactly
    // once.
    await page.waitForFunction((marker) => document.body.innerText.includes(marker), MARKER, { timeout: 8_000 });
    expect(nav.count(), "the in-window publish must still refresh the open route").toBe(before + 1);
    await page.unroute("**/-/rail.js");

    // And the seq gate means the replay did not turn into a loop.
    await settle(page, nav, "in-window publish");
  });

  test("RAPID publishes settle: a burst does not multiply reloads", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    // Five publishes back to back, each with a distinct body so the
    // check gate cannot collapse them. The rail reloads once per
    // genuinely new publish, but the pages it reloads AWAY from are
    // gone by the next event, so the observable requirement is a
    // bounded total and then silence — not "one reload each".
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${ctx.url}${UNRELATED_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);
    for (let i = 0; i < 5; i++) {
      const response = await page.request.post(`${ctx.url}/api/publish`, {
        headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
        data: {
          docs: [
            {
              path: ADR_REL_PATH,
              content: FAST_BODY.replace(MARKER, `${MARKER}-BURST-${i}`),
            },
          ],
        },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    // The burst coalesces into one build; a build terminal reloads
    // once. Budget covers the handful of genuinely new events.
    await settle(page, nav, "rapid publishes", 4_000, 8);
  });

  test("a DAEMON RESTART settles: the new daemon's log replays nothing into a loop", async ({ page }) => {
    // Every scheduled build fails fast at the pre-build check — no astro spawn.
    plantCheckFailingSibling(ctx.root);
    // The rail holds a session cookie and an EventSource. When the
    // daemon restarts on the SAME port the stream drops and the rail
    // reconnects with `Last-Event-ID` — the resume path that has to
    // keep working, since a reconnect that resumed from 0 would replay
    // the build events and reload again.
    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${ctx.url}${UNRELATED_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);
    // Produce a build so there ARE durable build events to replay.
    await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { data: [{ path: PLOT_REL_PATH, content: JSON.stringify([{ x: 3, y: 4 }]) }] },
    });
    await page.waitForTimeout(1_500);
    const beforeRestart = nav.count();
    // Restart the daemon in place on the same port, keeping the same
    // sqlite so seqs continue rather than restarting at 1.
    await restartDaemon(ctx);
    // Let the rail's backoff reconnect fire.
    await page.waitForTimeout(4_000);
    const afterReconnect = nav.count();
    process.stdout.write(
      `SETTLES[daemon restart] navigations: before=${beforeRestart} after-reconnect=${afterReconnect}\n`,
    );
    await settle(page, nav, "daemon restart", 2_500, SETTLE_BUDGET + 2);
  });

  test("failed build: the terminal banner appears and the page stops reloading", async ({ page }) => {
    plantCheckFailingSibling(ctx.root);

    await page.goto(ctx.launchUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${ctx.url}${UNRELATED_ROUTE}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const nav = countNavigations(page);

    const response = await page.request.post(`${ctx.url}/api/publish`, {
      headers: { authorization: `Bearer ${ctx.agentToken}`, "content-type": "application/json" },
      data: { docs: [{ path: ADR_REL_PATH, content: REFUSED_BODY }] },
    });
    expect(response.status(), await response.text()).toBe(201);

    // Either terminal is acceptable here — the point is that whichever
    // one lands, the rail's response to it is ONE reload, not a loop.
    // The build runs the real `revkit build` primitive against this
    // temp consumer, so give it room to reach a terminal before
    // measuring quiescence.
    await settle(page, nav, "failed build", 8_000);
  });
});
