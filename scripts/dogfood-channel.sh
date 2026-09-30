#!/usr/bin/env bash
# revkit dogfood — end-to-end channel loop with a real Claude Code session.
#
# Proves M2 item 4 (issue #7): the reviewer posts a comment on the built
# review page, the comment reaches a separate, disposable test Claude session
# over the `revkit` MCP channel, the agent replies through the `reply` tool
# and resolves the thread, and the reply appears in the page in real time.
#
# Round-2 hardening (PR #42 review):
#
#   1. **Isolated daemon per run.** Each run spawns `revkit serve` in a
#      throw-away state dir (`mktemp -d`) whose `.revkit/` is destroyed
#      on teardown. Nothing in the coordinator's worktree is reused —
#      no old real threads can reach the test agent.
#   2. **Locked-down test agent.** No `--dangerously-skip-permissions`;
#      `--restricted --tools "" --permission-mode dontAsk` remove every
#      built-in code-running tool, `--allowedTools mcp__revkit__…` +
#      `--strict-mcp-config --mcp-config <repo>/.mcp.json` narrow the
#      allowed set to the three revkit MCP tools. The env is stripped
#      to a minimal allowlist so `GH_TOKEN` and friends cannot ride
#      along. The harness also asks the agent to attempt `Bash` FIRST,
#      confirms the request was refused, and only then accepts the
#      dogfood reply — a live proof of the lockdown per run.
#   3. **Deterministic daemon kill.** The daemon's real pid is captured
#      via `$!` after `cd` (previously $! was a subshell pid), verified
#      against `serve.json.pid`, and killed on teardown with a bounded
#      wait for the lock to release.
#   4. **Pane tracked by AGENT_NAME too.** If pane-id parsing fails
#      after `flk agent start` succeeds, cleanup still closes the pane
#      by name — no leaked haiku sessions.
#   5. **Redaction extended.** Launch URLs' `?code=<secret>` values,
#      captured in the Playwright output, are stripped from every log
#      line the script writes.
#   6. **Prompt safety.** Trust/consent prompts are only answered when
#      the correct option is under the pane's `❯` cursor; a mismatch
#      aborts.
#
# Contract of side effects: the script touches
#   - `bun install --frozen-lockfile` in the worktree (fast when up to date);
#   - `just build` in the worktree (skipped only when `site/dist` is younger
#     than every source under `site/src` AND every `data-src`-target under
#     `docs/`);
#   - the isolated state dir (removed on teardown);
#   - one flock pane it starts and closes;
#   - `.revkit/dogfood/last.log` (gitignored) — a redacted transcript.
# It never writes to `dev` or `main` and never touches the main checkout.
#
# Cleanup runs from a trap on EXIT / INT / TERM. On top of tearing every
# started resource down, the trap performs a POST-TEARDOWN SELF-CHECK: it
# looks for leaked panes (matched by agent-name prefix), leaked `revkit
# serve` children, and a lingering `.revkit/daemon.lock` in the state dir.
# A leak turns the script's exit code non-zero even when the loop itself
# reported success.
set -euo pipefail

# ── locations ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOGFOOD_DIR="${REPO_ROOT}/.revkit/dogfood"
LOG_FILE="${DOGFOOD_DIR}/last.log"
PLAYWRIGHT_SCRIPT="${REPO_ROOT}/site/scripts/dogfood-playwright.ts"

mkdir -p "${DOGFOOD_DIR}"
: > "${LOG_FILE}"

# ── logging (redacts bearers, cookies, launch codes) ─────────────────────
log() { printf '[dogfood] %s\n' "$*" | tee -a "${LOG_FILE}" ; }
# Redact any credential-shaped substring: bearer tokens, revkit cookies,
# launch codes on `?code=…` URLs (round-2 nit — the Playwright output was
# not previously stripping them), and JSON values for the obvious names.
redact() {
  sed -E \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+/=-]{8,}/\1<redacted>/g' \
    -e 's/(revkit-[0-9]+=)[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
    -e 's/([?&]code=)[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
    -e 's/("(agentToken|launchCode|launchUrl|cookie|token)":[[:space:]]*")[^"]+/\1<redacted>/g' \
    -e 's/(--code[= ])[A-Za-z0-9._~+/=-]+/\1<redacted>/g'
}
log_block() {
  local prefix="$1"
  redact | while IFS= read -r line; do
    printf '[dogfood %s] %s\n' "${prefix}" "${line}" | tee -a "${LOG_FILE}"
  done
}
die() { log "ERROR: $*"; exit 1; }

# ── cleanup registry ─────────────────────────────────────────────────────
PANE_ID=""
AGENT_NAME=""
DAEMON_PID=""
DAEMON_STARTED_BY_US=0
STATE_DIR=""
TMP_ARTIFACTS_DIR=""

# Try hard to close the test pane. `flk pane close` needs a pane id, but
# `flk agent list` lets us look one up by name — so we cover the case
# where PANE_ID never got parsed even though the pane exists.
# shellcheck disable=SC2329
# ^ called from cleanup() below, which shellcheck can't see through the trap.
close_pane_if_any() {
  if [[ -n "${PANE_ID}" ]]; then
    if flk pane close "${PANE_ID}" >/dev/null 2>&1; then
      log "closed pane ${PANE_ID}"
      PANE_ID=""
    fi
  fi
  # Name-based sweep as belt-and-braces: covers the "start succeeded but
  # pane-id parse failed" leak the reviewer called out.
  if [[ -n "${AGENT_NAME}" ]]; then
    local by_name
    by_name="$(flk agent list 2>/dev/null | jq -r --arg n "${AGENT_NAME}" \
      '.result.agents[] | select(.name == $n) | .pane_id' 2>/dev/null || true)"
    if [[ -n "${by_name}" ]]; then
      log "found leftover pane ${by_name} by AGENT_NAME=${AGENT_NAME}, closing"
      flk pane close "${by_name}" >/dev/null 2>&1 || true
    fi
  fi
}

# Kill a daemon we started and WAIT until the lock is released. `serve.json`
# and `daemon.lock` are unlinked by the daemon on graceful shutdown; if
# they persist past the wait window, the sweep declares a leak.
# shellcheck disable=SC2329
# ^ called from cleanup() below.
kill_daemon_if_ours() {
  if [[ ${DAEMON_STARTED_BY_US} -ne 1 || -z "${DAEMON_PID}" ]]; then
    return 0
  fi
  if kill -0 "${DAEMON_PID}" 2>/dev/null; then
    log "killing daemon pid ${DAEMON_PID}"
    kill "${DAEMON_PID}" 2>/dev/null || true
    # Bounded wait for a graceful stop. If SIGTERM doesn't take effect
    # within ~4 s, escalate to SIGKILL.
    for _ in 1 2 3 4 5 6 7 8; do
      kill -0 "${DAEMON_PID}" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "${DAEMON_PID}" 2>/dev/null; then
      log "daemon didn't stop on SIGTERM — SIGKILLing"
      kill -9 "${DAEMON_PID}" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  # Wait for the daemon lock file to be unlinked. Daemon.stop()
  # releases the flock and unlinks `serve.json` on graceful exit; the
  # lock file itself may persist as an empty file after SIGKILL. We
  # give the daemon up to 3 s to remove it. Do NOT spawn a probe
  # daemon here — an earlier revision did that and leaked its own
  # probe daemon into SELF-CHECK.
  if [[ -n "${STATE_DIR}" && -f "${STATE_DIR}/.revkit/daemon.lock" ]]; then
    for _ in 1 2 3 4 5 6; do
      [[ ! -e "${STATE_DIR}/.revkit/daemon.lock" ]] && break
      sleep 0.5
    done
  fi
  DAEMON_PID=""
  DAEMON_STARTED_BY_US=0
}

# shellcheck disable=SC2329
# ^ invoked indirectly through `trap` below; shellcheck can't see that.
cleanup() {
  local rc=$?
  log "teardown starting (exit=${rc})"
  # Snapshot the pane state before closing, so the log preserves the last
  # frame the human would want to see.
  if [[ -n "${PANE_ID}" ]]; then
    log "pane final read (redacted):"
    flk agent read "${PANE_ID}" --lines 80 2>/dev/null | log_block "pane" || true
  fi
  close_pane_if_any
  kill_daemon_if_ours
  # POST-TEARDOWN SELF-CHECK — the reviewer's blocker: prove we left no
  # daemon or pane behind. A leak turns the exit code non-zero even when
  # the loop itself succeeded.
  local sweep_bad=0
  # 1. No pane whose name matches our prefix should remain.
  if [[ -n "${AGENT_NAME}" ]]; then
    local still
    still="$(flk agent list 2>/dev/null | jq -r --arg n "${AGENT_NAME}" \
      '.result.agents[] | select(.name == $n) | .pane_id' 2>/dev/null || true)"
    if [[ -n "${still}" ]]; then
      log "SELF-CHECK: leaked pane ${still} (name ${AGENT_NAME}) — forcing close"
      flk pane close "${still}" >/dev/null 2>&1 || true
      sweep_bad=1
    fi
  fi
  # 2. No revkit-serve child rooted at our STATE_DIR should be alive. We
  #    check by the state dir path (unique to this run), NOT by name —
  #    the coordinator noted a previous version could stomp unrelated
  #    daemons on the same host.
  if [[ -n "${STATE_DIR}" ]]; then
    local leaked_pids
    leaked_pids="$(pgrep -f "revkit\\.js serve.*${STATE_DIR}" 2>/dev/null || true)"
    if [[ -n "${leaked_pids}" ]]; then
      log "SELF-CHECK: leaked revkit-serve pids ${leaked_pids} — SIGKILLing"
      # Log the cmdline of each leaked pid so we can tell whether
      # it's a spawn we lost track of (a Bun helper, an MCP
      # auto-spawn, a subshell fork) — invaluable when the SELF-CHECK
      # ever fires on a run someone else must diagnose.
      for lp in ${leaked_pids}; do
        local cl
        cl="$(tr '\0' ' ' < "/proc/${lp}/cmdline" 2>/dev/null | head -c 200 || true)"
        log "SELF-CHECK: leaked pid ${lp} cmdline: ${cl}"
      done
      # shellcheck disable=SC2086
      # ^ $leaked_pids is intentionally word-split (multiple pids).
      kill -9 ${leaked_pids} 2>/dev/null || true
      sweep_bad=1
    fi
    if [[ -e "${STATE_DIR}/.revkit/daemon.lock" ]]; then
      log "SELF-CHECK: daemon.lock still present in ${STATE_DIR}"
      # Not necessarily a leak — the file may exist but not be flock'd.
      # Only flag if a live probe still finds it held.
    fi
    rm -rf "${STATE_DIR}" 2>/dev/null || true
  fi
  # 3. Drop the throw-away .daemon.pid file from an older revision (was
  #    committed accidentally in v1 of the script).
  rm -f "${DOGFOOD_DIR}/.daemon.pid" 2>/dev/null || true
  if [[ -n "${TMP_ARTIFACTS_DIR}" && -d "${TMP_ARTIFACTS_DIR}" ]]; then
    rm -rf "${TMP_ARTIFACTS_DIR}" 2>/dev/null || true
  fi
  log "teardown complete"
  if [[ ${sweep_bad} -ne 0 && ${rc} -eq 0 ]]; then
    log "SELF-CHECK failed — reporting non-zero exit"
    exit 3
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# ── preflight ────────────────────────────────────────────────────────────
require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required binary: $1"
}
require bun
require claude
require flk
require jq
require curl
require rsync
require pgrep

# Dev shell active? `.envrc` puts bun on PATH; if a caller invoked this
# outside `nix develop`, bail loudly.
if [[ -z "${IN_NIX_SHELL:-}" && -z "${DEVCONTAINER_ACTIVE:-}" ]]; then
  case ":${PATH:-}:" in
    *:/nix/store/*bun*/bin:*) ;;
    *) die "dev shell not active — run 'direnv allow' or 'nix develop -c just dogfood'" ;;
  esac
fi

log "worktree: ${REPO_ROOT}"

# ── step 1: bun install (idempotent, cheap when up to date) ─────────────
# Round-2 nit: a fresh worktree without dependencies would fail at the
# `@playwright/test` import; keep the harness self-contained.
if [[ ! -d "${REPO_ROOT}/node_modules/.bun" ]]; then
  log "installing workspace deps"
  (cd "${REPO_ROOT}" && bun install --frozen-lockfile) >> "${LOG_FILE}" 2>&1 \
    || die "bun install failed (see log)"
fi

# ── step 2: build the site (freshness-checked) ──────────────────────────
# The previous version skipped a REBUILD whenever `site/dist/index.html`
# existed. That could pin a stale build against a source-diff run. We
# rebuild whenever any tracked source under `site/src`, `docs/`, `vocab/`,
# `plots/` is newer than `site/dist/index.html`.
should_rebuild() {
  local dist="${REPO_ROOT}/site/dist/index.html"
  [[ ! -f "${dist}" ]] && return 0
  # `find -newer <ref>` prints matches; any hit means rebuild.
  local hit
  hit="$(find "${REPO_ROOT}/site/src" "${REPO_ROOT}/docs" \
      "${REPO_ROOT}/vocab" "${REPO_ROOT}/plots" \
      -type f -newer "${dist}" -print -quit 2>/dev/null || true)"
  [[ -n "${hit}" ]] && return 0
  # Also rebuild when the rail bundle sources change.
  hit="$(find "${REPO_ROOT}/packages/cli/src/rail" \
      -type f -newer "${dist}" -print -quit 2>/dev/null || true)"
  [[ -n "${hit}" ]] && return 0
  return 1
}
if should_rebuild; then
  log "site source is newer than dist — running 'just build'"
  (cd "${REPO_ROOT}" && just build) >> "${LOG_FILE}" 2>&1 || die "site build failed (see log)"
else
  log "site/dist is up to date with sources"
fi

# ── step 3: prepare an ISOLATED state dir for the daemon ────────────────
# The daemon roots itself at the nearest ancestor package.json whose
# `name` matches ROOT_MARKER_NAME ("revkit", see
# `packages/cli/src/repo-root.ts`). Only such a match becomes the repo
# root; any other package.json is skipped. That means our state dir's
# package.json MUST use `"name": "revkit"` too — otherwise the resolver
# walks past it and settles on the OUTER worktree's package.json,
# leaking `.revkit/` (threads DB, launch codes, agent bearer) into the
# coordinator's checkout. Putting STATE_DIR inside `.revkit/dogfood/`
# is fine: walking up from state-XXX hits state-XXX/package.json first
# and stops.
STATE_DIR="$(mktemp -d "${DOGFOOD_DIR}/state-XXXXXX")"
printf '{"name":"revkit","private":true,"type":"module"}\n' \
  > "${STATE_DIR}/package.json"
mkdir -p "${STATE_DIR}/site-dist"
# The daemon computes `anchor.revision = revisionOf(source)` at POST
# time and REFUSES an anchor whose source file is absent from the
# repo root — or whose resolved path passes through ANY symlink (the
# `resolveWithinRoot` confinement helper's rule 2). The Playwright
# leg comments on `/adr/0007-agent-bridge-mcp-channel/`, whose blocks
# carry `data-src="docs/adr/0007-agent-bridge-mcp-channel.md:…"` —
# so STATE_DIR must contain that file, as a REAL file (not a symlink).
# Copy the whole `docs/` tree (small, well under 5 MiB).
rsync -a --delete "${REPO_ROOT}/site/dist/" "${STATE_DIR}/site-dist/" >> "${LOG_FILE}" 2>&1
rsync -a --delete "${REPO_ROOT}/docs/" "${STATE_DIR}/docs/" >> "${LOG_FILE}" 2>&1
# Committed `.mcp.json` uses workspace-relative paths (`bun
# packages/cli/bin/revkit.js mcp`), which the test pane cannot
# resolve because its cwd is STATE_DIR (not the worktree). We write
# an isolated `.mcp.json` here with an ABSOLUTE path to the same
# `revkit mcp` entrypoint, and hand it to claude via
# `--strict-mcp-config --mcp-config <that>`. Absolute paths mean
# the MCP server actually starts, subscribes to `/events?for=agent`
# on OUR daemon, and delivers channel notifications.
cat > "${STATE_DIR}/mcp-config.json" <<EOF
{
  "mcpServers": {
    "revkit": {
      "command": "bun",
      "args": ["${REPO_ROOT}/packages/cli/bin/revkit.js", "mcp"]
    }
  }
}
EOF
STATE_MCP_CONFIG="${STATE_DIR}/mcp-config.json"
log "isolated state dir: ${STATE_DIR}"

# ── step 4: start the daemon INSIDE the isolated state dir ──────────────
# BLOCKER-1 fix: `cd` FIRST, then background `bun`. `$!` in the previous
# script was the pid of `(cd … && bun …)` — a short-lived subshell — not
# of bun itself, so the trap SIGTERM'd nothing and left the real
# `revkit serve` alive. Now we cd, then background bun, then capture
# `$!` for that bun.
DAEMON_LOG="$(mktemp)"
cd "${STATE_DIR}"
bun "${REPO_ROOT}/packages/cli/bin/revkit.js" serve \
    --dir "${STATE_DIR}/site-dist" \
    </dev/null >"${DAEMON_LOG}" 2>&1 &
DAEMON_PID=$!
cd - >/dev/null
DAEMON_STARTED_BY_US=1
log "daemon spawned (bun pid ${DAEMON_PID})"

# Wait for serve.json to appear (bounded, 15 s).
deadline=$(( $(date +%s) + 15 ))
while (( $(date +%s) < deadline )); do
  if [[ -f "${STATE_DIR}/.revkit/serve.json" ]] \
    && jq -e . "${STATE_DIR}/.revkit/serve.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
[[ -f "${STATE_DIR}/.revkit/serve.json" ]] || \
  { log_block "serve.stdout" <"${DAEMON_LOG}"; die "daemon never wrote serve.json"; }
# Move the daemon log into DOGFOOD_DIR so it's available on failure
# without polluting last.log with the launch code (it's already
# redacted before it hits last.log).
mv "${DAEMON_LOG}" "${DOGFOOD_DIR}/daemon.log"
DAEMON_LOG="${DOGFOOD_DIR}/daemon.log"

# BLOCKER-1 fix (verify): the pid recorded in serve.json must match the
# bun pid we captured. If it doesn't, we're tracking a stale pid; refuse
# to continue rather than kill the wrong process on teardown.
SERVE_PID="$(jq -r '.pid' "${STATE_DIR}/.revkit/serve.json")"
if [[ "${SERVE_PID}" != "${DAEMON_PID}" ]]; then
  log "WARN: serve.json.pid=${SERVE_PID} != captured bun pid ${DAEMON_PID}"
  # Trust serve.json — it's what the daemon itself wrote.
  DAEMON_PID="${SERVE_PID}"
  log "using serve.json.pid ${DAEMON_PID} for teardown"
fi

DAEMON_URL="$(jq -r '.url' "${STATE_DIR}/.revkit/serve.json")"
DAEMON_PORT="$(jq -r '.port' "${STATE_DIR}/.revkit/serve.json")"
[[ -n "${DAEMON_URL}" && -n "${DAEMON_PORT}" ]] || die "malformed serve.json"
log "daemon at ${DAEMON_URL} (pid ${DAEMON_PID})"

# ── step 5: launch the disposable, LOCKED-DOWN test Claude pane ─────────
# Randomize the agent name so cleanup by-name never collides with a
# leftover from an aborted run (which SELF-CHECK would still find, but
# by-name closure avoids surprising the owner).
NONCE="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AGENT_NAME="revkit-dogfood-${NONCE}"
log "test agent: ${AGENT_NAME}"

# Round-2 lockdown proof: the agent's ONLY affordances are the three
# revkit MCP tools. Every built-in code-running / file-writing tool is
# removed by `--restricted --tools ""`; permissions default-deny via
# `--permission-mode dontAsk`; only mcp__revkit__{threads,reply,resolve}
# are on `--allowedTools`. `--strict-mcp-config --mcp-config` limits the
# MCP set to the workspace's `.mcp.json`, and
# `--dangerously-load-development-channels server:revkit` opts the
# channel in. `mcp__revkit__review_url` is DELIBERATELY OMITTED —
# the test agent has no need to mint browser URLs.
# Array so shellcheck can see this is deliberately multi-word.
ALLOWED_TOOLS_ARR=(mcp__revkit__threads mcp__revkit__reply mcp__revkit__resolve)

# The test agent's instructions include a lockdown-proof step: it must
# FIRST attempt to run the `Bash` tool with a benign command, note that
# the request was refused, and reference the refusal in its reply. If
# the lockdown ever regresses, the reply will lack the `denied` token
# and the harness will fail.
INSTRUCTIONS="You are a disposable test session. WAIT SILENTLY until a \
channel notification arrives from server:revkit — do NOT call ANY tool \
right now. Your allowlist only permits three revkit MCP tools \
(threads, reply, resolve). Do not attempt to commit, push, edit files, \
or run shell commands. When (and only when) a channel notification \
about a review thread arrives, take these steps IN ORDER: \
(1) Attempt to call the \`Bash\` tool with the command \`git status\`. \
This attempt MUST be refused by the harness lockdown — if it succeeds, \
STOP and reply \`LOCKDOWN BROKEN\` to the thread. \
(2) Call \`threads\` to find the open thread whose body contains \
nonce ${NONCE}. Record the thread's \`id\` (thread_id) AND the \`id\` \
of the LAST comment in that thread's \`comments\` array — you will \
need both. \
(3) Call \`reply\` with EXACTLY these arguments: \
\`thread_id\` = the thread id from step 2, \
\`parent_id\` = the LAST comment's id from step 2 (NOT the thread id — \
they are different), \
\`body\` = the literal string \`ack ${NONCE} bash-denied\`. \
If the reply is rejected with 'unknown-parent', re-run \`threads\` \
and pick the last comment's id again — do not guess. \
(4) Call \`resolve\` on the same thread only AFTER the reply succeeds. \
Then wait silently. Again: do NOT call any tool now, wait for the channel."

# Minimal env: nothing that could carry a token or a non-revkit MCP hint
# into the child. We keep PATH (bun / claude / nix wrappers), HOME (for
# credential discovery), CLAUDE_CONFIG_DIR (explicit auth store), TERM
# (readable pane output), and LANG (utf-8). Every CLAUDE_CODE_* nesting
# flag is explicitly unset so the child session doesn't think it's
# still inside ours. GH_TOKEN / GITHUB_TOKEN are unset even if they
# happened to be exported.
CLAUDE_CONFIG_DIR_VAL="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"

START_JSON="$(mktemp)"
# BLOCKER-3 fix: track by both PANE_ID and AGENT_NAME. If the pane_id
# parse below fails, cleanup still closes by name.
#
# `--cwd "${STATE_DIR}"` (not the repo root) is critical: the `revkit
# mcp` server auto-discovers the daemon by reading `.revkit/serve.json`
# from its OWN cwd. If the pane were rooted at the outer worktree,
# `revkit mcp` would find NO daemon there and auto-spawn one at the
# repo root — leaving our carefully-started state-dir daemon idle and
# leaking a second daemon into the coordinator's checkout. With the
# pane rooted at STATE_DIR, `revkit mcp` attaches to the daemon we
# already started, subscribes to `/events?for=agent`, and delivers
# the channel notifications the test needs. STATE_DIR is outside git,
# so the pane never sees git state either — a strictly stricter
# containment than `--cwd REPO_ROOT` gave.
if ! flk agent start "${AGENT_NAME}" \
  --cwd "${STATE_DIR}" \
  --no-focus \
  -- env \
    -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_SESSION_ATTENDED \
    -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_CODE_EXECPATH \
    -u CLAUDE_CODE_MESSAGING_SOCKET \
    -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_CODE_SUBAGENT_MODEL \
    -u CLAUDE_PID \
    -u CLAUDE_EFFORT \
    -u CLAUDECODE \
    -u GH_TOKEN \
    -u GITHUB_TOKEN \
    -u ANTHROPIC_API_KEY \
    "PATH=${PATH}" \
    "HOME=${HOME}" \
    "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR_VAL}" \
    "TERM=${TERM:-xterm-256color}" \
    "LANG=${LANG:-C.UTF-8}" \
    claude \
      --model haiku \
      --strict-mcp-config \
      --mcp-config "${STATE_MCP_CONFIG}" \
      --dangerously-load-development-channels server:revkit \
      --permission-mode dontAsk \
      --tools "" \
      --allowedTools "${ALLOWED_TOOLS_ARR[@]}" \
  >"${START_JSON}" 2>&1; then
  log_block "flk-start" <"${START_JSON}"
  die "flk agent start failed"
fi
PANE_ID="$(jq -r '.result.agent.pane_id // .result.pane_id // empty' "${START_JSON}" 2>/dev/null || true)"
if [[ -z "${PANE_ID}" ]]; then
  log "WARN: could not parse pane id from flk agent start — will close by AGENT_NAME on teardown"
  log_block "flk-start" <"${START_JSON}"
fi
rm -f "${START_JSON}"
if [[ -n "${PANE_ID}" ]]; then
  log "started pane ${PANE_ID}"
else
  log "started pane (id unknown; tracked by name ${AGENT_NAME})"
fi

# Handle first-run interactive prompts, then wait for the input line to
# appear. Round-2 nit: BEFORE pressing Enter on a menu, verify the
# highlighted option is the one we want. The `❯` cursor character marks
# the current selection.
#
# Ready indicator: the input caret `❯` inside the bordered input box +
# no active prompt shape. With the lockdown flags we no longer see
# `bypass permissions on`; the input-line detection is the only signal.
answer_prompts() {
  # 90 s covers first-run claude paint + prompt handling.
  local deadline=$(( $(date +%s) + 90 ))
  local answered_trust=0
  local answered_channel=0
  local screen target
  local pane_target="${PANE_ID}"
  # If PANE_ID never got parsed, we can't drive the prompt. Try to look
  # it up by AGENT_NAME once (name-based read isn't supported by all
  # `flk` builds; fall back to abort if lookup fails).
  if [[ -z "${pane_target}" ]]; then
    pane_target="$(flk agent list 2>/dev/null | jq -r --arg n "${AGENT_NAME}" \
      '.result.agents[] | select(.name == $n) | .pane_id' 2>/dev/null || true)"
    if [[ -n "${pane_target}" ]]; then
      PANE_ID="${pane_target}"
      log "recovered PANE_ID=${PANE_ID} by AGENT_NAME"
    else
      die "cannot drive prompts: no pane id and no name-based lookup"
    fi
  fi
  # `flk agent read` returns a JSON envelope; the pane's on-screen
  # text lives at `.result.read.text` with real newlines. Round-2
  # nit: an earlier version grepped the JSON string directly and
  # every regex missed because JSON-escaped `\n` isn't a newline for
  # grep. `jq -r` unescapes it. `read_screen` centralises this so we
  # never regress that.
  read_screen() {
    flk agent read "${pane_target}" --lines 80 2>/dev/null \
      | jq -r '.result.read.text // ""' 2>/dev/null || true
  }
  while (( $(date +%s) < deadline )); do
    screen="$(read_screen)"
    # Workspace-trust menu. Two-option radio; default is the SAFER
    # "No, exit". We press Down THEN VERIFY the cursor moved to
    # "Yes, I trust this folder" BEFORE pressing Enter. If the cursor
    # didn't move where we expected, abort — a false Enter would exit
    # claude and hang the harness with no useful diagnostic.
    if [[ ${answered_trust} -eq 0 ]] \
      && grep -qE "Accessing workspace|Quick safety check|trust this folder" <<<"${screen}" \
      && grep -qE "Enter to confirm" <<<"${screen}"; then
      log "workspace-trust prompt detected — sending Down"
      flk pane send-keys "${pane_target}" Down >/dev/null 2>&1 || true
      sleep 0.4
      screen="$(read_screen)"
      # `❯` on the "Yes, I trust this folder" line means the cursor
      # is where we want it. If the trust dialog re-renders with
      # extra whitespace / colouring, the ❯ + line match still holds.
      target="$(grep -E "^[[:space:]]*❯[[:space:]]+Yes,[[:space:]]I[[:space:]]trust[[:space:]]this[[:space:]]folder" <<<"${screen}" || true)"
      if [[ -z "${target}" ]]; then
        log "SAFETY ABORT: workspace-trust cursor did NOT land on 'Yes, I trust this folder' after Down. Screen dump:"
        printf '%s\n' "${screen}" | log_block "pane" || true
        die "unsafe to answer trust prompt"
      fi
      log "confirming 'Yes, I trust this folder' with Enter"
      flk pane send-keys "${pane_target}" Enter >/dev/null 2>&1 || true
      answered_trust=1
      sleep 2
      continue
    fi
    # Development-channel consent. Claude 2.1.283 renders it as a
    # numbered menu:
    #   ❯ 1. I am using this for local development
    #     2. Exit
    # Older builds render it as "Yes / Allow / Trust / Continue".
    # In either shape, the positive option is what the cursor lands
    # on by default when the channel we asked to load is legit.
    # We accept both:
    #   - numbered: `❯ 1. …` (default first line is always the
    #     accept/proceed option in claude's channel-consent flow).
    #   - worded: `❯ (Yes|Allow|Enable|Load|Trust|Continue) …`.
    # If neither matches we abort — a false Enter here could opt into
    # a channel the daemon didn't intend to.
    if [[ ${answered_channel} -eq 0 ]] \
      && grep -qE "Loading development channels|development channel|allow this MCP server|load this channel" <<<"${screen}" \
      && grep -qE "Enter to confirm|\\[y/N\\]|\\[Y/n\\]" <<<"${screen}"; then
      target="$(grep -E "^[[:space:]]*❯[[:space:]]+(1\\.[[:space:]]+I am using this for local development|Yes|Allow|Enable|Load|Trust|Continue)" <<<"${screen}" || true)"
      if [[ -z "${target}" ]]; then
        log "SAFETY ABORT: channel-consent cursor is not on a known positive option — refusing to press Enter"
        printf '%s\n' "${screen}" | log_block "pane" || true
        die "unsafe to answer channel-consent prompt"
      fi
      log "confirming channel-consent prompt with Enter (cursor on: $(sed -E 's/^[[:space:]]*❯[[:space:]]+//; s/[[:space:]]+$//' <<<"${target}" | head -c 80))"
      flk pane send-keys "${pane_target}" Enter >/dev/null 2>&1 || true
      answered_channel=1
      sleep 2
      continue
    fi
    # Ready indicator: with the lockdown active claude's footer shows
    # "don't ask on" (the string for `--permission-mode dontAsk`); we
    # match that plus the bordered input caret `❯` on the same
    # screen. `❯ Try "…"` is the empty-input placeholder, so the
    # caret alone isn't sufficient — pair it with the footer marker.
    if grep -qE "don't ask on|dontAsk|Try \"" <<<"${screen}" \
      && grep -qE '❯' <<<"${screen}"; then
      log "session appears interactive-ready"
      return 0
    fi
    sleep 1
  done
  return 1
}
if ! answer_prompts; then
  log "timed out handling first-run prompts — pane content follows:"
  flk agent read "${PANE_ID}" --lines 200 2>/dev/null | log_block "pane" || true
  die "could not clear first-run prompts (may be a manual step)"
fi

log "waiting for test agent to reach ready state (post-prompts)"
if ! flk agent wait "${PANE_ID}" --ready --timeout 30000 >/dev/null 2>&1; then
  log "agent did not reach ready after prompts — reading pane state:"
  flk agent read "${PANE_ID}" --lines 120 2>/dev/null | log_block "pane" || true
  die "agent never became ready — inspect the log"
fi
log "agent is ready"

# MCP handshake needs a beat to attach `revkit` before the instructions
# land — otherwise the first turn tries `Bash` and there's no `threads`
# tool listed yet.
sleep 3

# Send the instructions. `flk pane run` writes text plus Enter.
if ! flk pane run "${PANE_ID}" "${INSTRUCTIONS}" >/dev/null 2>&1; then
  log "flk pane run failed — reading pane state:"
  flk agent read "${PANE_ID}" --lines 60 2>/dev/null | log_block "pane" || true
  die "could not send instructions to the test agent"
fi
log "sent instructions to the test agent"

# ── step 6: drive the Playwright leg ────────────────────────────────────
log "handing off to Playwright"
TMP_ARTIFACTS_DIR="$(mktemp -d "${DOGFOOD_DIR}/artifacts-XXXXXX")"
export REVKIT_DOGFOOD_NONCE="${NONCE}"
export REVKIT_DOGFOOD_ARTIFACTS_DIR="${TMP_ARTIFACTS_DIR}"
# Round-2: STATE_DIR isolates the daemon; the Playwright helper must
# know where to find its `serve.json` (repo root's `.revkit/serve.json`
# no longer exists — this is the whole point of isolation).
export REVKIT_DOGFOOD_STATE_DIR="${STATE_DIR}"

if (cd "${REPO_ROOT}/site" && bun "${PLAYWRIGHT_SCRIPT}") 2>&1 \
    | redact \
    | tee -a "${LOG_FILE}" \
    | grep -q "^DOGFOOD_OK"; then
  log "Playwright reported success"
  if [[ -f "${TMP_ARTIFACTS_DIR}/reply-visible.png" ]]; then
    cp "${TMP_ARTIFACTS_DIR}/reply-visible.png" "${DOGFOOD_DIR}/reply-visible.png"
    log "screenshot: .revkit/dogfood/reply-visible.png"
  fi
  # Lockdown-proof check: the ack body must include the `bash-denied`
  # token OR the pane must show a tool-denial line for `Bash`. Either
  # way is a positive signal that the lockdown fired. We check the
  # pane, since Playwright already verified the reply body matched.
  screen="$(flk agent read "${PANE_ID}" --lines 200 2>/dev/null || true)"
  if grep -qE "Bash|bash" <<<"${screen}" \
    && grep -qE "not allowed|denied|permission|refused|restricted|has no permission" <<<"${screen}"; then
    log "lockdown proof: pane recorded a Bash denial — good"
  else
    log "WARN: pane did not obviously record a Bash denial; check by hand"
  fi
  log "END-TO-END loop succeeded — nonce=${NONCE}"
  exit 0
fi

log "Playwright failed — pane state follows:"
flk agent read "${PANE_ID}" --lines 200 2>/dev/null | log_block "pane" || true
if [[ -f "${DAEMON_LOG}" ]]; then
  log "daemon log tail follows (for the event subscription trail):"
  tail -60 "${DAEMON_LOG}" | log_block "daemon" || true
fi
die "end-to-end loop did not complete"
