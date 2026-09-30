---
name: revkit_dogfood
description: >-
  End-to-end dogfood of the revkit agent-channel loop: builds the site, starts
  the daemon, spawns a disposable test Claude Code session in a flock pane, and
  uses Playwright to post a comment through the rail UI. Waits for the test
  agent to reply through the `revkit` MCP channel and resolve the thread.
  Proves M2 item 4 (issue #7, ADR-0007). Use after a change to the daemon,
  the MCP server, the rail, or the channel notification format — or before a
  release that touches the agent bridge.
---

# revkit dogfood — live channel loop

## What it proves

The full round trip from ADR-0007:

1. **Human → daemon.** A reviewer selects text on a real built page and posts
   a comment through the rail's own composer (no API shortcut).
2. **Daemon → channel.** The daemon appends the comment event and fans it out
   over `/events?for=agent`.
3. **`revkit mcp` → Claude.** The MCP server converts the event into a
   `notifications/claude/channel` frame (declared under
   `capabilities.experimental["claude/channel"]`).
4. **Agent replies.** The test Claude session calls the `reply` MCP tool, then
   `resolve`.
5. **Daemon → human.** The reply flows back over SSE and the rail updates
   without a reload.

Anything that breaks this loop (a channel schema drift, an env allowlist
regression, a rail regression, an origin-check tightening that locks out the
daemon-client) will fail this script well before it fails a user.

## When to run it

- Before merging any PR that touches
  `packages/cli/src/{mcp,serve,rail}`.
- Before a release that promotes ADR-0007 through the train.
- When investigating a channel bug that reproduces only against a real Claude
  Code session (auto-start, MCP consent, notification framing).

## Prerequisites

- The nix dev shell (`direnv allow` or `nix develop -c just dogfood`). The
  script refuses to run outside it.
- A running `flk` server (the terminal manager we spawn the test pane in).
  `flk agent list` should return a JSON object; if not, start `flk` first.
- A logged-in Claude (`claude auth login`). The test pane cannot handle an
  interactive OAuth prompt.
- No stale `.revkit/serve.json` pointing at a dead daemon. The script reuses
  an existing daemon when its pid is alive; otherwise it starts one.

## Run it

```bash
just dogfood
```

Typical wall-clock: **1–3 minutes** end-to-end (site build cached: ~15 s;
`nix develop --command` overhead + first-run prompts: ~40 s; model + channel:
~15–20 s depending on load). Reported latency (comment posted → agent reply
visible in the rail without reload) is printed to `stdout` as
`reply_latency_ms=…`. Observed on the initial impl runs: **13 s to 19 s** on
Haiku 4.5 under Claude Max.

## What it does, step by step

1. Builds `site/dist` (skipped if `site/dist/index.html` exists — delete it
   for a clean build).
2. Starts `revkit serve` in the background against `site/dist`, or reuses an
   existing daemon if one is already up.
3. Mints a per-run 12-char hex **nonce** — the comment body embeds it and the
   test agent is told to echo it in the reply. The nonce keeps concurrent
   runs from confusing each other.
4. Runs `flk agent start revkit-dogfood-<nonce> --cwd <worktree> --no-focus
   --wait-ready -- claude --model haiku --dangerously-skip-permissions
   --dangerously-load-development-channels server:revkit "<instructions>"`.
5. Waits for the test agent to reach the `ready` state (means Claude has
   painted a status frame — MCP servers are connected and the model is
   receiving turns).
6. Drives a headless chromium page:
   - `POST /-/launch-code` with the agent bearer → single-use launch URL.
   - Navigates the launch URL → cookie lands.
   - Opens `/adr/0007-agent-bridge-mcp-channel/`.
   - Selects text in a `data-src`'d block, clicks the floating "Comment"
     affordance, types the nonce comment, submits.
7. Polls `GET /api/threads` until:
   - the thread carries our nonce (created); then
   - the thread has an agent-authored comment whose body matches
     `ack <nonce>` (agent replied); then
   - the thread's `status` is `resolved`.
8. Captures a screenshot of the rail showing the reply as
   `.revkit/dogfood/reply-visible.png`.
9. Teardown: closes the flock pane, kills any daemon it started, drops temp
   artefacts. Runs even on failure (trap-based).

## Exit codes

- `0` — the full loop completed and the agent replied + resolved.
- `1` — a step failed. See `.revkit/dogfood/last.log` for the transcript;
  the last `[dogfood pane]` block is the test pane's final state, which is
  usually enough to diagnose an MCP-connect failure or a channel notification
  that never fired.
- `2` — Playwright argument error (bug in the helper — file it).

## Failure playbook

- **`daemon never wrote serve.json`** — usually a build issue. Look for
  `[dogfood serve.stdout]` in the log for a bun error.
- **`agent never became ready`** — Claude Code failed to reach the daemon or
  is stuck on a first-run consent prompt. Read the pane content in the log
  (`[dogfood pane]` block). If it's `Trust this workspace? (y/N)`, add
  `.claude/settings.json` `"trust": true` for this repo and rerun. If it's the
  channel consent prompt, the `--dangerously-load-development-channels` flag
  is either missing or the server name is wrong.
- **`timeout waiting for 'agent reply visible on daemon'`** — the model
  didn't reply within 180 s. Read the pane content; often the model asked a
  clarifying question instead of using the tool. The instructions in
  `scripts/dogfood-channel.sh` are strict — tweak them here, not by editing
  the pane, so the next run reproduces.
- **`reply text did not appear in the rail without reload`** — the SSE path
  is broken (or the rail's `data-testid`s changed and the wait selector is
  stale).

## Cost

One haiku session with a handful of turns (≈ 3–5). One cached site build.
No GitHub or Cloudflare traffic. The test pane is disposable — no state
persists beyond the run.

## What NOT to trust

- The screenshot alone. A visual reply doesn't prove the resolve landed.
  The script's exit code is the assertion; the screenshot is evidence for
  a PR body.
- A previous `last.log`. Every run overwrites it.
- A previous `serve.json`. The script rewrites the daemon's port + bearer
  on start; a stale value from a killed daemon is normal.
