// Rail: an agent-authored draft is badged and promotable (issue #70).
//
// Drives the review-mode rail against the STRICT fake GitHub
// (packages/cli/test/review/helpers/fake-github.ts) through the same
// boot fixture the other review-mode specs use, so "reached GitHub"
// means "the fake recorded the mutation" and nothing else.
//
// One arc:
//   1. the reviewer's own comment mirrors immediately and carries NO
//      badge (the badge is for agent drafts only);
//   2. an agent-bearer comment lands locally and is badged "agent
//      draft · not on GitHub" in the thread and in the review panel,
//      with a "Promote to my review" action beside it;
//   3. clicking it POSTs /api/review/promote under the session cookie
//      and the fake records exactly one new draft in the reviewer's
//      pending review; the badge disappears.
//   Axe gate at every phase.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const BOOT_SCRIPT = resolve(__dirname, "fixtures", "review-mode-daemon", "boot.ts");

const FIXTURE_REL_PATH = "docs/rail-promote-agent-drafts.md";
const FIXTURE_HEADER = "# Rail promote fixture";
const FIXTURE_PARAGRAPH = "The agent drafts a reply that only a reviewer may promote.";
const FIXTURE_TAIL = "tail line";
const FIXTURE_SOURCE = `${FIXTURE_HEADER}\n\n${FIXTURE_PARAGRAPH}\n${FIXTURE_TAIL}\n`;
const FIXTURE_HEAD = "1234567890abcdef1234567890abcdef12345678";

interface BootInfo {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchUrl: string;
  readonly controlUrl: string;
}

interface DaemonCtx extends BootInfo {
  readonly child: ChildProcess;
  readonly root: string;
}

async function bootDaemon(lifecycleTarget?: "resolve" | "reopen"): Promise<DaemonCtx> {
  if (!existsSync(DIST)) {
    throw new Error(`site/dist does not exist at ${DIST}; run 'just build' first.`);
  }
  const root = mkdtempSync(join(tmpdir(), "revkit-p70-rail-"));
  mkdirSync(join(root, ".revkit"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
  mkdirSync(join(root, dirname(FIXTURE_REL_PATH)), { recursive: true });
  writeFileSync(join(root, FIXTURE_REL_PATH), FIXTURE_SOURCE, "utf8");
  const child = spawn(
    "bun",
    [
      BOOT_SCRIPT,
      "--dir", DIST,
      "--repo-root", root,
      "--fixture-path", FIXTURE_REL_PATH,
      "--head-a", FIXTURE_HEAD,
      "--control-port", "0",
      ...(lifecycleTarget === undefined ? [] : ["--lifecycle-thread", lifecycleTarget]),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    stderrChunks.push(s);
    if (process.env.REVKIT_E2E_LOG === "1") process.stderr.write(`[boot.stderr] ${s}`);
  });
  child.stdout?.on("data", (b: Buffer) => stdoutChunks.push(b.toString("utf8")));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(
        `[rail-p70] daemon exited ${code}\nstderr:\n${stderrChunks.join("")}\nstdout:\n${stdoutChunks.join("")}\n`,
      );
    }
  });
  const deadline = Date.now() + 30_000;
  let info: BootInfo | undefined;
  while (Date.now() < deadline) {
    const joined = stdoutChunks.join("");
    const line = joined.split("\n").find((l) => l.trim().startsWith("{"));
    if (line !== undefined) {
      try {
        info = JSON.parse(line) as BootInfo;
        break;
      } catch { /* mid-write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (info === undefined) {
    try { child.kill("SIGTERM"); } catch { /* fine */ }
    throw new Error(
      `boot did not print a JSON info line within 30s\nstderr: ${stderrChunks.join("")}\nstdout: ${stdoutChunks.join("")}`,
    );
  }
  return { ...info, child, root };
}

async function shutdown(ctx: DaemonCtx): Promise<void> {
  try { ctx.child.kill("SIGTERM"); } catch { /* fine */ }
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* fine */ }
}

function writeFixtureHtml(): { relPath: string; cleanup: () => void } {
  const relPath = "rail-promote-fixture.html";
  const abs = join(DIST, relPath);
  writeFileSync(
    abs,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rail promote fixture</title></head>
     <body>
      <main>
        <h1 data-src="${FIXTURE_REL_PATH}:1-1">${FIXTURE_HEADER}</h1>
        <p id="target" data-src="${FIXTURE_REL_PATH}:3-3">${FIXTURE_PARAGRAPH}</p>
        <p id="target2" data-src="${FIXTURE_REL_PATH}:4-4">${FIXTURE_TAIL}</p>
      </main>
    </body></html>`,
    "utf8",
  );
  return {
    relPath,
    cleanup: (): void => {
      try { rmSync(abs, { force: true }); } catch { /* fine */ }
    },
  };
}

interface PendingSnapshot {
  reviewNodeId: string | null;
  drafts: ReadonlyArray<{ readonly body: string; readonly path: string }>;
  replies: readonly unknown[];
  resolutions: readonly unknown[];
}

async function readPending(controlUrl: string): Promise<PendingSnapshot> {
  const r = await fetch(`${controlUrl}/control/pending`);
  return (await r.json()) as PendingSnapshot;
}

async function assertAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function cookieHeader(page: Page): Promise<string> {
  return (await page.context().cookies())
    .filter((c) => c.domain.includes("127.0.0.1") || c.domain.includes("localhost"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** The daemon's anchor authority is the file's own bytes, so the
 * revision the client sends has to be `sha256(LF-normalised source)`
 * — the same value `revisionOf` computes server-side. */
function revisionOfSource(): string {
  return createHash("sha256").update(FIXTURE_SOURCE.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function anchorFor(line: number): Record<string, unknown> {
  return {
    path: FIXTURE_REL_PATH,
    startLine: line,
    endLine: line,
    quote: {
      exact: line === 3 ? FIXTURE_PARAGRAPH : FIXTURE_TAIL,
      prefix: line === 3 ? `${FIXTURE_HEADER}\n\n` : `${FIXTURE_HEADER}\n\n${FIXTURE_PARAGRAPH}\n`,
      suffix: line === 3 ? `\n${FIXTURE_TAIL}` : "",
    },
    revision: revisionOfSource(),
  };
}

/** Post a top-level comment under the given authority: the session
 * cookie (the reviewer) or the agent bearer (the agent). */
async function postComment(
  ctx: DaemonCtx,
  body: { readonly threadId: string; readonly commentId: string; readonly line: number; readonly text: string },
  as: "cookie" | "agent",
  cookie: string,
): Promise<Response> {
  return await fetch(`${ctx.url}/api/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.url,
      "sec-fetch-site": "same-origin",
      ...(as === "cookie" ? { cookie } : { authorization: `Bearer ${ctx.agentToken}` }),
    },
    body: JSON.stringify({
      threadId: body.threadId,
      commentId: body.commentId,
      anchor: anchorFor(body.line),
      body: body.text,
    }),
  });
}

test.describe("rail agent-draft promotion @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);

  test("an agent draft is badged, promote posts one draft under the reviewer, and the badge clears", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      const nav = await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      expect(nav?.status()).toBeLessThan(400);
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      const cookie = await cookieHeader(page);

      // ── The reviewer's own comment mirrors immediately, unbadged ─
      const own = await postComment(daemon, { threadId: "th-reviewer", commentId: "c-reviewer", line: 3, text: "reviewer comment" }, "cookie", cookie);
      expect(own.status).toBe(201);
      await expect.poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 }).toBe(1);

      // ── The agent drafts a comment: local only, zero writes ────
      const agent = await postComment(daemon, { threadId: "th-agent", commentId: "c-agent", line: 4, text: "agent drafted comment" }, "agent", cookie);
      expect(agent.status).toBe(201);
      expect((await readPending(daemon.controlUrl)).drafts).toHaveLength(1);

      await page.reload();
      await expect(page.getByTestId("revkit-rail")).toBeVisible();

      // The badge rides the AGENT's comment only.
      const commentBadges = page.getByTestId("revkit-rail-comment-agent-draft-badge");
      await expect(commentBadges).toHaveCount(1);
      await expect(page.locator("[data-testid=\"revkit-rail-comment\"][data-author-kind=\"agent\"] [data-testid=\"revkit-rail-comment-agent-draft-badge\"]")).toHaveCount(1);
      await expect(page.locator("[data-testid=\"revkit-rail-comment\"][data-author-kind=\"local\"] [data-testid=\"revkit-rail-comment-agent-draft-badge\"]")).toHaveCount(0);

      // The review panel lists it with the promote action.
      const panel = page.getByTestId("revkit-rail-agent-drafts");
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("revkit-rail-agent-draft-badge")).toHaveCount(1);
      const promote = page.getByTestId("revkit-rail-agent-draft-promote");
      await expect(promote).toHaveCount(1);
      await assertAxeClean(page);

      // ── Promote: the route is called, one draft is posted ─────
      const [request] = await Promise.all([
        page.waitForRequest(
          (candidate) => candidate.url().includes("/api/review/promote") && candidate.method() === "POST",
          { timeout: 15_000 },
        ),
        promote.click(),
      ]);
      const payload = JSON.parse(request.postData() ?? "{}") as {
        threadId?: string;
        target?: string;
        commentId?: string;
      };
      expect(payload).toEqual({ threadId: "th-agent", target: "comment", commentId: "c-agent" });
      // Same-origin cookie auth: the rail never sends the bearer here.
      expect(request.headers().authorization).toBeUndefined();

      await expect
        .poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 })
        .toBe(2);
      const pending = await readPending(daemon.controlUrl);
      expect(pending.drafts[1]?.body).toContain("agent drafted comment");
      expect(pending.drafts[1]?.path).toBe(FIXTURE_REL_PATH);
      expect(pending.replies).toHaveLength(0);
      expect(pending.resolutions).toHaveLength(0);

      // The draft is now part of the reviewer's pending review, so it
      // is no longer a draft awaiting promotion.
      await expect(page.getByTestId("revkit-rail-agent-drafts")).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("revkit-rail-comment-agent-draft-badge")).toHaveCount(0);
      await expect(page.getByTestId("revkit-rail-review-count")).toContainText("2 pending comments");
      await assertAxeClean(page);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });

  test("a failed promotion from discarded A needs a new click naming B", async ({ page }) => {
    const daemon = await bootDaemon();
    const fixture = writeFixtureHtml();
    try {
      await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
      await page.goto(`${daemon.url}/${fixture.relPath}`);
      await expect(page.getByTestId("revkit-rail")).toBeVisible();
      const cookie = await cookieHeader(page);
      expect((await postComment(daemon, { threadId: "th-own-A", commentId: "c-own-A", line: 3, text: "review A" }, "cookie", cookie)).status).toBe(201);
      expect((await postComment(daemon, { threadId: "th-fresh", commentId: "c-fresh", line: 4, text: "agent needs fresh promotion" }, "agent", cookie)).status).toBe(201);
      const headers = { "content-type": "application/json", origin: daemon.url, "sec-fetch-site": "same-origin", cookie };
      const reviewA = (await readPending(daemon.controlUrl)).reviewNodeId;
      await fetch(`${daemon.controlUrl}/control/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mutation: "AddThread" }) });
      const first = await fetch(`${daemon.url}/api/review/promote`, { method: "POST", headers,
        body: JSON.stringify({ threadId: "th-fresh", target: "comment", commentId: "c-fresh" }) });
      expect(first.status).toBe(201);
      expect((await readPending(daemon.controlUrl)).drafts).toHaveLength(1);
      expect((await fetch(`${daemon.url}/api/review/discard`, { method: "POST", headers, body: JSON.stringify({ reason: "user-discarded" }) })).status).toBe(201);
      expect((await postComment(daemon, { threadId: "th-own-B", commentId: "c-own-B", line: 3, text: "review B" }, "cookie", cookie)).status).toBe(201);
      const pendingB = await readPending(daemon.controlUrl);
      expect(pendingB.reviewNodeId).not.toBe(reviewA);
      expect(pendingB.drafts).toHaveLength(1);
      expect(pendingB.drafts.some((entry) => entry.body.includes("agent needs fresh promotion"))).toBe(false);

      await page.reload();
      const row = page.getByTestId("revkit-rail-review-unsynced-item").filter({ has: page.locator('code', { hasText: "c-fresh" }) });
      await expect(row).toContainText("This agent draft needs a fresh promotion into your current review.");
      const fresh = row.getByTestId("revkit-rail-review-fresh-promote");
      await expect(fresh).toBeEnabled();
      await assertAxeClean(page);
      const [request] = await Promise.all([
        page.waitForRequest((candidate) => candidate.url().includes("/api/review/promote") && candidate.method() === "POST", { timeout: 15_000 }),
        fresh.click(),
      ]);
      expect(JSON.parse(request.postData() ?? "{}")).toEqual({ threadId: "th-fresh", target: "comment", commentId: "c-fresh", reviewNodeId: pendingB.reviewNodeId });
      expect(request.headers().authorization).toBeUndefined();
      await expect.poll(async () => (await readPending(daemon.controlUrl)).drafts.length, { timeout: 15_000 }).toBe(2);
      await expect(page.getByTestId("revkit-rail-review-unsynced")).toBeHidden();
      expect((await readPending(daemon.controlUrl)).reviewNodeId).toBe(pendingB.reviewNodeId);
      await assertAxeClean(page);
    } finally {
      fixture.cleanup();
      await shutdown(daemon);
    }
  });
});


test.describe("#155 lifecycle refusal rail @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");
  test.setTimeout(120_000);
  for (const target of ["resolve", "reopen"] as const) {
    test(`${target} refusal offers a fresh promotion into B`, async ({ page }) => {
      const daemon = await bootDaemon(target);
      try {
        await page.goto(daemon.launchUrl, { waitUntil: "commit", timeout: 15_000 });
        // Use the built site's registered components, with the daemon's rail.
        await page.goto(daemon.url);
        await expect(page.getByTestId("revkit-rail")).toBeVisible();
        const cookie = await cookieHeader(page);
        const headers = { "content-type": "application/json", origin: daemon.url, "sec-fetch-site": "same-origin", cookie };
        expect((await fetch(`${daemon.url}/api/review/refresh`, { method: "POST", headers, body: "{}" })).status).toBe(200);
        const threads = await (await fetch(`${daemon.url}/api/threads`, { headers })).json() as { threads: { id: string; external?: { threadId: string } }[] };
        const threadId = threads.threads.find((thread) => thread.external?.threadId === "PRT_lifecycle")!.id;
        expect((await postComment(daemon, { threadId: "th-lifecycle-own-A", commentId: "c-lifecycle-own-A", line: 3, text: "open A" }, "cookie", cookie)).status).toBe(201);
        const reviewA = (await readPending(daemon.controlUrl)).reviewNodeId;
        expect((await fetch(`${daemon.url}/api/threads/${threadId}/${target}`, { method: "POST",
          headers: { ...headers, cookie: "", authorization: `Bearer ${daemon.agentToken}` }, body: "{}" })).status).toBe(201);
        await fetch(`${daemon.controlUrl}/control/inject`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mutation: target === "resolve" ? "ResolveReviewThread" : "UnresolveReviewThread" }) });
        expect((await fetch(`${daemon.url}/api/review/promote`, { method: "POST", headers, body: JSON.stringify({ threadId, target }) })).status).toBe(500);
        expect((await readPending(daemon.controlUrl)).resolutions).toHaveLength(0);
        expect((await fetch(`${daemon.url}/api/review/discard`, { method: "POST", headers, body: JSON.stringify({ reason: "user-discarded" }) })).status).toBe(201);
        expect((await fetch(`${daemon.url}/api/review/reconcile`, { method: "POST", headers, body: "{}" })).status).toBe(201);
        expect((await readPending(daemon.controlUrl)).resolutions).toHaveLength(0);
        await page.reload();
        const row = page.getByTestId("revkit-rail-lifecycle-failure");
        await expect(row).toContainText("This agent draft needs a fresh promotion into your current review.");
        await expect(row).toHaveAttribute("data-target", target);
        const fresh = row.getByRole("button", { name: "Promote to this review" });
        await expect(fresh).toBeDisabled();
        await assertAxeClean(page);
        expect((await postComment(daemon, { threadId: "th-lifecycle-own-B", commentId: "c-lifecycle-own-B", line: 3, text: "open B" }, "cookie", cookie)).status).toBe(201);
        expect((await fetch(`${daemon.url}/api/review/reconcile`, { method: "POST", headers, body: "{}" })).status).toBe(201);
        const reviewB = (await readPending(daemon.controlUrl)).reviewNodeId;
        expect(reviewB).not.toBe(reviewA);
        expect((await readPending(daemon.controlUrl)).resolutions).toHaveLength(0);
        await expect(fresh).toBeEnabled();
        const [request] = await Promise.all([
          page.waitForRequest((candidate) => candidate.url().includes("/api/review/promote") && candidate.method() === "POST", { timeout: 15_000 }),
          fresh.click(),
        ]);
        expect(JSON.parse(request.postData() ?? "{}")).toEqual({ threadId, target, reviewNodeId: reviewB });
        expect(request.headers().authorization).toBeUndefined();
        await expect.poll(async () => (await readPending(daemon.controlUrl)).resolutions.length, { timeout: 15_000 }).toBe(1);
        await expect(row).toBeHidden();
        await assertAxeClean(page);
        expect((await fetch(`${daemon.url}/api/review/reconcile`, { method: "POST", headers, body: "{}" })).status).toBe(201);
        expect((await readPending(daemon.controlUrl)).resolutions).toHaveLength(1);
      } finally {
        await shutdown(daemon);
      }
    });
  }
});
