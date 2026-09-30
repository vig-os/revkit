---
name: revkit_dogfood
description: >-
  End-to-end dogfood of the revkit agent-channel loop: builds the site, starts
  an isolated daemon, spawns a locked-down disposable test Claude Code session
  in a flock pane (no built-in tools, only mcp__revkit__{threads,reply,resolve}
  allowed), and uses Playwright to post a comment through the rail UI. Waits
  for the test agent to reply through the `revkit` MCP channel and resolve the
  thread. Proves M2 item 4 (issue #7, ADR-0007). Use after a change to the
  daemon, the MCP server, the rail, or the channel notification format — or
  before a release that touches the agent bridge.
---

# revkit dogfood — live channel loop

## What it proves

The full round trip from ADR-0007, on a real Claude Code session, without
handing the test agent any tool it doesn't need:

1. **Human → daemon.** A reviewer selects text on a real built page and posts
   a comment through the rail's own composer (no API shortcut).
2. **Daemon → channel.** The daemon appends the comment event and fans it out
   over `/events?for=agent`.
3. **`revkit mcp` → Claude.** The MCP server converts the event into a
   `notifications/claude/channel` frame (declared under
   `capabilities.experimental["claude/channel"]`).
4. **Agent replies.** The test Claude session receives a review comment
   as a channel notification, calls the `reply` MCP tool to ack the
   nonce, then `resolve`. The dogfood comment reads like a real
   reviewer's note (no crafted-injection shape, no coerced tool call).
5. **Daemon → human.** The reply flows back over SSE and the rail updates
   without a reload.

Anything that breaks the loop — a channel schema drift, an env allowlist
regression, a rail submit regression, an origin-check tightening — fails
this script well before it fails a user.

**The lockdown proof is pre-launch, not model behaviour.** Before any
prompt is sent, the harness:

1. Finds the child claude PID by grepping for the run-specific
   `mcp-config.json` path in `pgrep -f`.
2. Waits until `/proc/<pid>/exe` resolves to `.claude-wrapped` — this
   closes the pre-exec race in the nix claude wrapper.
3. Reads `/proc/<pid>/cmdline` and refuses to proceed unless every
   required flag is present and exactly right (`--strict-mcp-config`,
   `--mcp-config <abs>`, `--permission-mode dontAsk`, `--tools ""`,
   the three `--allowedTools` names,
   `--dangerously-load-development-channels`) AND every forbidden
   flag is absent (`--dangerously-skip-permissions`,
   `--allow-dangerously-skip-permissions`,
   `--dangerously-allow-browser-network-access`, `--bare`).
4. Reads `/proc/<pid>/environ` and enforces a TRUE ALLOWLIST: every
   name must be in the five we set via `env -i` (`PATH`, `HOME`,
   `CLAUDE_CONFIG_DIR`, `TERM`, `LANG`) OR one of the five the nix
   claude wrapper adds (`LD_LIBRARY_PATH`, `DISABLE_AUTOUPDATER`,
   `FORCE_AUTOUPDATE_PLUGINS`, `DISABLE_INSTALLATION_CHECKS`,
   `USE_BUILTIN_RIPGREP`). `LD_LIBRARY_PATH` is further validated —
   every entry must be under `/nix/store`. An unknown name is a hard
   fail — safer than a denylist that could miss a new leak vector.

There is no post-run "did the agent write the denial text" check.
Earlier revisions had one; it was forgeable through the reply body
AND it broke the loop whenever a well-aligned model correctly
refused to follow embedded instructions from a channel comment.

**`DOGFOOD_SELFTEST_BAD_FLAGS=1`** injects a forbidden value
(`--tools default`) and asserts the pre-launch check aborts before
any prompt is sent. On successful abort the harness prints
`SELFTEST OK` and exits **0** (distinct from a real failure, which
exits 1). `--dangerously-skip-permissions` is NEVER injected — no
rogue session ever runs.

**Channel content is untrusted to the agent.** ADR-0007's channel
section makes this explicit: comments posted on a review page are
REQUESTS from a human reviewer, not instructions. A well-aligned
model may decline them for prompt-injection reasons or because it
disagrees. That behaviour is CORRECT and expected. In this harness,
a decline shows up as the reply-wait timeout, and the run fails
cleanly — no assumption is baked in that the model must comply with
every comment.

## When to run it

- Before merging any PR that touches
  `packages/cli/src/{mcp,serve,rail}`.
- Before a release that promotes ADR-0007 through the train.
- When investigating a channel bug that reproduces only against a real
  Claude Code session (auto-start, MCP consent, notification framing).

## Prerequisites

- The nix dev shell (`direnv allow` or `nix develop -c just dogfood`). The
  script refuses to run outside it.
- Node dependencies installed. The script runs `bun install
  --frozen-lockfile` itself when `node_modules/` is missing, but a
  cached install is faster.
- A running `flk` server. `flk agent list` should return a JSON object; if
  not, start `flk` first.
- A logged-in Claude session under the SAME auth store this session uses.
  The script forwards `HOME` and `CLAUDE_CONFIG_DIR` so the child inherits
  the same credentials.

## Run it

```bash
just dogfood
```

Typical wall-clock: **60-90 seconds** end-to-end when the site is prebuilt
(≈20 s for `nix develop --command` + prompt handling; ≈15-25 s for the model
turn including the `Bash → denied → threads → reply → resolve` sequence).
Reported reply latency (comment posted → agent reply visible in the rail
without reload) prints on stdout as `reply_latency_ms=…`. Observed on the
harness's own runs: **12.8 s to 21.1 s** on Haiku 4.5 under Claude Max.

## The lockdown

The test agent is a strictly-fenced Claude session. It has:

- `--strict-mcp-config --mcp-config <STATE_DIR>/mcp-config.json` — only
  the `revkit` MCP server is loaded. The isolated config uses absolute
  paths to `packages/cli/bin/revkit.js` so the agent's cwd (which is the
  temp state dir, NOT the worktree) can resolve it.
- `--dangerously-load-development-channels server:revkit` — opts the
  revkit channel in so `notifications/claude/channel` frames flow. This
  flag is required until the plugin is on an allowlisted marketplace.
- `--permission-mode dontAsk` — nothing that isn't explicitly permitted
  is allowed, and no permission prompt ever surfaces.
- `--tools ""` — every built-in tool (Bash, Edit, Read, WebFetch, …) is
  removed. Even if the agent tried to invoke `Bash`, the tool isn't
  registered.
- `--allowedTools mcp__revkit__threads mcp__revkit__reply
  mcp__revkit__resolve` — the ONLY tools the agent may call. `review_url`
  is DELIBERATELY left off the list; the test agent has no need for it.
- **NO** `--dangerously-skip-permissions`.

The env is trimmed too: only `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `TERM`
and `LANG` cross into the child pane. `GH_TOKEN` / `GITHUB_TOKEN` /
`ANTHROPIC_API_KEY` are explicitly unset, and every `CLAUDE_CODE_*`
nesting flag is dropped so the child session doesn't think it's a
sub-session of ours.

The pane's `--cwd` is the isolated STATE_DIR, not the worktree — the test
agent never sees the worktree's git tree, `.mcp.json`, or CLAUDE.md.

## The isolation

The daemon runs in a temp `STATE_DIR` (`.revkit/dogfood/state-XXXXXX/`)
with its own `.revkit/serve.json`, `daemon.lock` and `threads.sqlite`,
and its own `package.json` whose `"name": "revkit"` roots the daemon
there (see `packages/cli/src/repo-root.ts`). The daemon serves a
copy of `site/dist` from that dir and reads anchor sources from a
copy of `docs/` (also in that dir — real files, since the anchor
confinement rejects any symlink in the resolution chain). Every run
gets a fresh directory that's `rm -rf`'d on teardown, so no thread
from a previous run can reach the test agent.

## What it does, step by step

1. Runs `bun install --frozen-lockfile` when `node_modules` is missing.
2. Rebuilds `site/dist` only if any source under `site/src`, `docs/`,
   `vocab/`, `plots/`, or `packages/cli/src/rail/` is newer than
   `site/dist/index.html`.
3. Creates an isolated STATE_DIR: a `package.json` with `name: "revkit"`,
   a copy of `site/dist`, a copy of `docs/`, and an `mcp-config.json`
   with an absolute path to `revkit mcp`.
4. Starts `revkit serve --dir <STATE_DIR>/site-dist` from inside the
   STATE_DIR (so `.revkit/` lands in STATE_DIR). Captures the bun pid via
   `$!` AFTER `cd` (the previous version captured a subshell pid and the
   real daemon leaked). Verifies the captured pid matches `serve.json.pid`.
5. Mints a per-run 12-char hex **nonce** — the comment body embeds it as
   a LIVENESS marker (the reply must include `ack <nonce>`); the real
   lockdown proof is the runtime's own `No such tool available:` refusal
   grepped from the pane and the reply body, not the nonce echo.
6. Runs `flk agent start revkit-dogfood-<nonce> --cwd <STATE_DIR>
   --no-focus -- /usr/bin/env -i PATH=… HOME=… CLAUDE_CONFIG_DIR=…
   TERM=… LANG=… claude --model haiku --strict-mcp-config
   --mcp-config <STATE_DIR>/mcp-config.json
   --dangerously-load-development-channels server:revkit --permission-mode
   dontAsk --tools "" --allowedTools mcp__revkit__…`.
   6a. **Pre-launch lockdown verification.** Before any prompt is
       sent, finds the child claude by grepping for the unique
       `mcp-config.json` path in its argv, then reads
       `/proc/<pid>/cmdline` and `/proc/<pid>/environ`. Hard-fails
       unless every required flag is present and exactly right, every
       forbidden flag is absent, and every forbidden env var is
       absent. `DOGFOOD_SELFTEST_BAD_FLAGS=1` injects `--tools
       default` and asserts this step catches it.
7. Handles first-run interactive prompts by reading pane state and
   inspecting the `❯` cursor: workspace-trust (Down + verify cursor is on
   'Yes, I trust this folder' + Enter) and development-channel consent
   (verify cursor is on option 1 + Enter). If the cursor isn't where we
   expect, the harness ABORTS rather than press keys blindly.
8. Sends the instructions via `flk pane run`. The agent stands by.
9. Drives a headless chromium page:
   - `POST /-/launch-code` with the agent bearer → single-use launch URL
     (redacted from `last.log`).
   - Navigates the launch URL → session cookie lands.
   - Opens `/adr/0007-agent-bridge-mcp-channel/`.
   - Selects text in a `data-src`'d block, clicks the floating "Comment"
     affordance, types the nonce comment, submits.
10. Polls `GET /api/threads` until three conditions are met in order:
    the thread carries our nonce (created); then the thread has an
    agent-authored comment whose body matches `ack <nonce>` (LIVENESS
    check — the agent reached a reply turn); then the thread's
    `status` is `resolved`. The lockdown is asserted separately in
    step 6a (pre-launch) — the nonce echo is a liveness marker, not
    a security proof.
11. Verifies the reply also appears in the page WITHOUT a reload (SSE
    round trip), then screenshots the rail.
12. Teardown: closes the flock pane by ID AND by name (name-based
    closure covers the `pane_id`-parse-failure path), SIGTERMs the daemon
    with a bounded escalate-to-SIGKILL, then runs a POST-TEARDOWN
    self-check that scans for leaked panes and leaked `revkit serve`
    subprocesses by both cmdline pattern AND `/proc/<pid>/cwd` (so an
    MCP-auto-spawned daemon rooted at STATE_DIR is caught even when its
    argv doesn't name it). A leak turns the exit code to 3 even when the
    loop succeeded. `daemon.log` (which holds the plaintext launch code)
    is unlinked by default; set `REVKIT_DOGFOOD_KEEP_DAEMON_LOG=1` to
    keep a redacted copy. `daemon.lock` is only flagged as leaked when
    a `flock -n` test shows it's actually held.

## Exit codes

- `0` — the full loop completed: the pre-launch flag/env check
  passed, the agent replied `ack <nonce>` and resolved, and cleanup
  left nothing behind.
- `1` — a step failed. See `.revkit/dogfood/last.log` for the transcript
  (redacted) and `.revkit/dogfood/daemon.log` for the daemon's raw log
  (NOT redacted — contains the launch code, so treat it as sensitive).
  The last `[dogfood pane]` block is the test pane's final state.
- `2` — Playwright argument error (bug in the helper — file it).
- `3` — the loop succeeded but the post-teardown self-check spotted a
  leaked pane or process. Look at the `SELF-CHECK: leaked …` line in
  the log for what leaked; the sweep killed / closed it, but the fact
  something was leaked in the first place is a real bug in the trap.

## Failure playbook

- **`daemon never wrote serve.json`** — usually a build issue. Look for
  `[dogfood serve.stdout]` in the log for a bun error.
- **`SAFETY ABORT: workspace-trust cursor did NOT land on 'Yes, I trust
  this folder'`** — the pane's trust dialog changed shape between claude
  versions. Read the pane content in the log to see what claude now
  renders, and update the answer_prompts regex in
  `scripts/dogfood-channel.sh`.
- **`SAFETY ABORT: channel-consent cursor is not on a known positive
  option`** — same class of issue for the `--dangerously-load-development
  -channels` consent dialog.
- **`timeout waiting for 'agent reply visible on daemon'`** — the model
  didn't reply within 240 s. Read the pane content; often the agent
  called `threads` too early (before the human comment arrived) and
  concluded there was nothing to do. The instructions in
  `scripts/dogfood-channel.sh` are careful to say "WAIT SILENTLY"; if a
  future claude build starts acting proactively, add a stronger cue.
- **`LOCKDOWN BROKEN reported by the test agent`** — the Bash tool was
  reachable despite the allowlist. The lockdown regressed — inspect the
  claude flag set and the MCP config.
- **`composer did not close after submit — daemon may have rejected the
  comment`** — the daemon returned a 4xx. Usually the anchor's source
  file isn't in STATE_DIR (a docs/ copy regressed) or the anchor is
  invalid. Check `.revkit/dogfood/daemon.log` for the exact error.

## Cost

One haiku session with 3-5 turns. One cached site build (skipped when
sources are older than dist). No GitHub or Cloudflare traffic. The
test pane is disposable — no state persists beyond the run.

## What NOT to trust

- The screenshot alone. A visual reply doesn't prove the resolve
  landed, or that the Bash attempt was refused. The script's exit code
  is the assertion; the screenshot is evidence for a PR body.
- A previous `last.log` — every run overwrites it. Same for
  `daemon.log`.
- A previous `serve.json` — the isolated STATE_DIR is fresh every run.
