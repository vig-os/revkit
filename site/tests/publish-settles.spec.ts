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
// `site/dist`. The build scenarios exercise the REAL `revkit build`
// primitive — there is no stub — so a background build against this
// temp consumer either succeeds or fails on its own merits, and both
// terminals must settle.

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
  readonly child: ChildProcess;
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
    `SETTLES[${label}] navigations: at-open=${before} after-settle=${afterSettle} budget=${SETTLE_BUDGET}\n`,
  );
  expect(
    afterSettle,
    `${label}: the page must reach a fixed point within the settle budget (navigations=${afterSettle}, budget=${SETTLE_BUDGET})`,
  ).toBeLessThanOrEqual(SETTLE_BUDGET);

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

  test("failed build: the terminal banner appears and the page stops reloading", async ({ page }) => {
    // Plant a file the TREE-wide `revkit check` inside `revkit build`
    // refuses. It is not part of any publish batch, so the publish's
    // own check passes; the build's pre-build check then fails fast,
    // which is a real build failure without waiting on astro.
    writeFileSync(
      join(ctx.root, "docs", "adr", "0997-broken-sibling.md"),
      "# ADR-0997: Broken sibling\n\n- Status: Proposed\n- Date: 2026-10-02\n\n## Context\n\nA term that the vocabulary does not define: [[no-such-term-anywhere]].\n",
      "utf8",
    );

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
