// Boot the revkit daemon in review-mode with the STRICT fake
// GitHub (see packages/cli/test/review/helpers/fake-github.ts).
// Used by site/tests/rail-review-mode.spec.ts — a bun subprocess
// because `bun:sqlite` isn't available under Playwright's node
// loader.
//
// Args: --dir <dist> --repo-root <root> --fixture-path <rel>
//       --head-a <sha> --control-port <port>
//
// Prints one JSON line to stdout with `{ url, port, agentToken,
// launchUrl, controlUrl }` once bound, then keeps running. The
// control server exposes:
//   POST /control/inject { mutation: "AddThread", once: true }
//   POST /control/clear-inject
//   GET  /control/pending    → { reviewNodeId, drafts, submits,
//                                deletes, replies, resolutions }
//   POST /control/set-head { sha }
//   POST /control/register-pr { headSha }
//
// SIGTERM shuts everything down cleanly.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../../packages/cli/src/serve/daemon.ts";
import { makeFakeGithubFetch, makePendingState, type FakePendingState, type FakePr } from "../../../../packages/cli/test/review/helpers/fake-github.ts";
import { GitHubAdapter, type PrFile, type PrRef, type PullRequestSummary, type TokenSource } from "@revkit/review-core";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k === undefined || v === undefined) break;
  args.set(k.replace(/^--/, ""), v);
}
const dir = args.get("dir");
const repoRoot = args.get("repo-root");
const fixturePath = args.get("fixture-path");
const headA = args.get("head-a");
const controlPort = Number(args.get("control-port") ?? "0");
if (dir === undefined || repoRoot === undefined || fixturePath === undefined || headA === undefined) {
  throw new Error("boot.ts: --dir --repo-root --fixture-path --head-a required");
}
void fileURLToPath;
void dirname;

const pending: FakePendingState = makePendingState();
let currentHead = headA;
let injectAddThreadOnce = false;
let injectReplyOnce = false;

const staticToken: TokenSource = { async getToken() { return "ghp_" + "a".repeat(40); } };
const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 42 };

function makeSummary(headSha: string): PullRequestSummary {
  return {
    number: 42,
    nodeId: "PR_42",
    title: "review-mode test PR",
    state: "open",
    draft: false,
    headSha,
    headRef: "test-head",
    baseSha: "b".repeat(40),
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/42",
  };
}

const source = readFileSync(`${repoRoot}/${fixturePath}`, "utf8");
const originalSource = source;
const files: PrFile[] = [
  {
    filename: fixturePath,
    status: "modified",
    patch: `@@ -1,3 +1,4 @@\n # header\n \n-old paragraph\n+${originalSource.split("\n")[2] ?? "paragraph"}\n+tail line`,
  },
];

const prs: FakePr[] = [
  {
    owner: pr.owner,
    repo: pr.repo,
    pullNumber: pr.pullNumber,
    headSha: headA,
    baseSha: "b".repeat(40),
    baseRef: "main",
    headRef: "test-head",
    title: "review-mode test PR",
    nodeId: "PR_42",
    state: "open",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/42",
  },
];

const rawFetch = makeFakeGithubFetch(prs, { pendingState: pending, viewerLogin: "test-reviewer" });
const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const bodyText = init !== undefined && init.body !== undefined ? String(init.body) : "";
  if (url.endsWith("/graphql")) {
    if (injectAddThreadOnce && bodyText.includes("mutation AddThread")) {
      injectAddThreadOnce = false;
      throw new Error("injected AddThread failure");
    }
    if (injectReplyOnce && bodyText.includes("mutation AddReviewThreadReply")) {
      injectReplyOnce = false;
      throw new Error("injected reply failure");
    }
  }
  return rawFetch(input, init);
}) as unknown as typeof fetch;

const adapter = new GitHubAdapter({ token: staticToken, fetch: wrappedFetch });

const handle = await startDaemon({
  dir,
  repoRoot,
  port: 0,
  sqlitePath: `${repoRoot}/.revkit/threads.sqlite`,
  version: "0.0.0-e2e",
  localUserId: "e2e-reviewer",
  installSignalHandlers: false,
  reviewMode: {
    adapter,
    pr,
    summary: makeSummary(currentHead),
    viewerLogin: "test-reviewer",
    files,
  },
});

// Small control server for Playwright to poke.
const control = Bun.serve({
  port: controlPort,
  hostname: "127.0.0.1",
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/control/pending" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          reviewNodeId: pending.reviewNodeId,
          commitOid: pending.commitOid,
          drafts: pending.drafts,
          submits: pending.submits,
          deletes: pending.deletes,
          replies: pending.replies,
          resolutions: pending.resolutions,
          submittedReviewIds: [...pending.submittedReviewIds],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/control/inject" && req.method === "POST") {
      const body = (await req.json()) as { mutation: string };
      if (body.mutation === "AddThread") injectAddThreadOnce = true;
      else if (body.mutation === "AddReviewThreadReply") injectReplyOnce = true;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/control/clear-inject" && req.method === "POST") {
      injectAddThreadOnce = false;
      injectReplyOnce = false;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/control/set-head" && req.method === "POST") {
      const body = (await req.json()) as { sha: string };
      currentHead = body.sha;
      // Update the fake's PR head so `getPullRequest` returns the new
      // sha and the daemon's `refreshPullRequest` sees a stale review.
      const p = prs[0];
      if (p !== undefined) (p as { headSha: string }).headSha = body.sha;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

const info = {
  url: handle.url,
  port: handle.port,
  agentToken: handle.agentToken,
  launchUrl: `${handle.url}/-/auth?code=${handle.launchCode}`,
  controlUrl: `http://127.0.0.1:${control.port}`,
};
process.stdout.write(JSON.stringify(info) + "\n");

process.on("SIGTERM", async () => {
  try { control.stop(true); } catch { /* fine */ }
  try { await handle.stop(); } catch { /* fine */ }
  process.exit(0);
});
process.on("SIGINT", async () => {
  try { control.stop(true); } catch { /* fine */ }
  try { await handle.stop(); } catch { /* fine */ }
  process.exit(0);
});

// Keep alive
setInterval(() => {}, 1 << 30);
