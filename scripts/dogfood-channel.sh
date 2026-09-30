#!/usr/bin/env bash
# revkit dogfood — end-to-end channel loop with a real Claude Code session.
#
# Proves M2 item 4 (issue #7): the reviewer posts a comment on the built
# review page, the comment reaches a separate, disposable test Claude session
# over the `revkit` MCP channel (declared `experimental["claude/channel"]`),
# the agent replies through the `reply` tool, and the reply appears in the
# page in real time. The test session runs in an isolated flock pane so
# nothing collides with the coordinator's own session.
#
# Non-goals: NOT part of `just test` or CI. This needs a logged-in Claude and
# a running flock server (`flk`). Run it manually when you want to prove the
# loop or when the agent bridge changes (ADR-0007).
#
# Contract of side effects: the script only touches
#   - the worktree it was invoked from (site build + `.revkit/`);
#   - one flock pane it starts and closes;
#   - `.revkit/dogfood/last.log` (gitignored) — a redacted transcript.
# It never writes to `dev` or `main` and never touches the main checkout.
#
# Cleanup is aggressive. On exit (success, failure, ^C, SIGTERM) the trap:
#   - closes the test pane (if it made one);
#   - kills any `revkit serve` child this run started, matching by pid;
#   - drops the temporary Playwright artefacts.
# The trap runs even when a step aborts early; add new state only via the
# resource registration helpers below.
set -euo pipefail

# ── locations ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOGFOOD_DIR="${REPO_ROOT}/.revkit/dogfood"
LOG_FILE="${DOGFOOD_DIR}/last.log"
STATE_JSON="${REPO_ROOT}/.revkit/serve.json"
# The Playwright leg lives under `site/scripts/` because Bun resolves module
# imports from the script FILE's directory (not cwd), and only `site/`
# depends on `@playwright/test`.
PLAYWRIGHT_SCRIPT="${REPO_ROOT}/site/scripts/dogfood-playwright.ts"

mkdir -p "${DOGFOOD_DIR}"
: > "${LOG_FILE}"

# ── logging (redacts bearers and cookies) ────────────────────────────────
log() { printf '[dogfood] %s\n' "$*" | tee -a "${LOG_FILE}" ; }
# Log a block of text (e.g. captured pane content) with each line prefixed,
# so a mixed log is scannable. Redacts anything that looks like a bearer or a
# revkit cookie so a leaked transcript never carries credentials.
log_block() {
  local prefix="$1"
  # Bearer <token> → Bearer <redacted>
  # revkit-<port>=<cookie> → revkit-<port>=<redacted>
  # agent_token / launchCode / cookie values in JSON blobs → <redacted>
  sed -E \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+/=-]{8,}/\1<redacted>/g' \
    -e 's/(revkit-[0-9]+=)[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
    -e 's/("(agentToken|launchCode|cookie|token)":[[:space:]]*")[^"]+/\1<redacted>/g' \
    -e 's/(--code[= ])[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
    | while IFS= read -r line; do
        printf '[dogfood %s] %s\n' "${prefix}" "${line}" | tee -a "${LOG_FILE}"
      done
}
die() { log "ERROR: $*"; exit 1; }

# ── cleanup registry ─────────────────────────────────────────────────────
PANE_ID=""
AGENT_NAME=""
DAEMON_PID=""
DAEMON_STARTED_BY_US=0
TMP_ARTIFACTS_DIR=""

# shellcheck disable=SC2329
# ^ invoked indirectly through `trap` below; shellcheck can't see that.
cleanup() {
  local rc=$?
  log "teardown starting (exit=${rc})"
  if [[ -n "${PANE_ID}" ]]; then
    # Capture a final read before closing so the log holds the last state.
    log "pane final read (redacted):"
    flk agent read "${PANE_ID}" --lines 80 2>/dev/null | log_block "pane" || true
    if flk pane close "${PANE_ID}" >/dev/null 2>&1; then
      log "closed pane ${PANE_ID}"
    else
      log "flk pane close ${PANE_ID} failed (already gone?)"
    fi
  fi
  if [[ ${DAEMON_STARTED_BY_US} -eq 1 && -n "${DAEMON_PID}" ]]; then
    if kill -0 "${DAEMON_PID}" 2>/dev/null; then
      log "killing daemon pid ${DAEMON_PID}"
      kill "${DAEMON_PID}" 2>/dev/null || true
      # A tick for graceful shutdown, then SIGKILL if still alive.
      sleep 1
      kill -0 "${DAEMON_PID}" 2>/dev/null && kill -9 "${DAEMON_PID}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${TMP_ARTIFACTS_DIR}" && -d "${TMP_ARTIFACTS_DIR}" ]]; then
    rm -rf "${TMP_ARTIFACTS_DIR}" 2>/dev/null || true
  fi
  log "teardown complete"
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

# The Bun static/build tooling depends on the dev shell being active. The
# `.envrc` puts them on PATH; if a caller invoked this outside `nix develop`,
# bail loudly so the user runs `direnv allow` or `nix develop -c just dogfood`.
if [[ -z "${IN_NIX_SHELL:-}" && -z "${DEVCONTAINER_ACTIVE:-}" ]]; then
  # Best-effort: try to detect the nix dev shell via a marker in PATH.
  case ":${PATH:-}:" in
    *:/nix/store/*bun*/bin:*) ;;
    *) die "dev shell not active — run 'direnv allow' or 'nix develop -c just dogfood'" ;;
  esac
fi

log "worktree: ${REPO_ROOT}"

# ── step 1: build the site ───────────────────────────────────────────────
if [[ ! -f "${REPO_ROOT}/site/dist/index.html" ]]; then
  log "site/dist missing — running 'just build'"
  (cd "${REPO_ROOT}" && just build) >> "${LOG_FILE}" 2>&1 || die "site build failed (see log)"
fi
log "site build ok"

# ── step 2: start (or reuse) the daemon ─────────────────────────────────
# The MCP server auto-starts the daemon when the test agent connects, but
# starting it here first gives us a stable port + agent bearer to feed
# Playwright. Reuse an already-running daemon if serve.json is fresh AND
# the lock is held (findRunningDaemon rule).
start_daemon() {
  if [[ -f "${STATE_JSON}" ]]; then
    local pid
    pid=$(jq -r '.pid // empty' "${STATE_JSON}" 2>/dev/null || true)
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      log "reusing existing daemon (pid ${pid})"
      DAEMON_PID="${pid}"
      DAEMON_STARTED_BY_US=0
      return 0
    fi
  fi

  log "starting revkit serve (background)"
  # Detached so signals to this script never propagate to the daemon; the
  # trap explicitly kills the pid we capture.
  local out
  out="$(mktemp)"
  (cd "${REPO_ROOT}" && bun packages/cli/bin/revkit.js serve --dir site/dist >"${out}" 2>&1 &
    echo $! > "${DOGFOOD_DIR}/.daemon.pid")
  DAEMON_PID="$(cat "${DOGFOOD_DIR}/.daemon.pid")"
  DAEMON_STARTED_BY_US=1
  # Wait for serve.json to appear (bounded).
  local deadline=$(( $(date +%s) + 15 ))
  while (( $(date +%s) < deadline )); do
    if [[ -f "${STATE_JSON}" ]] && jq -e . "${STATE_JSON}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  [[ -f "${STATE_JSON}" ]] || { log_block "serve.stdout" <"${out}"; die "daemon never wrote serve.json"; }
  rm -f "${out}"
  log "daemon up (pid ${DAEMON_PID})"
}
start_daemon

DAEMON_URL="$(jq -r '.url' "${STATE_JSON}")"
DAEMON_PORT="$(jq -r '.port' "${STATE_JSON}")"
# Bearer is loaded on-demand inside the Playwright helper, never printed.
[[ -n "${DAEMON_URL}" && -n "${DAEMON_PORT}" ]] || die "malformed serve.json"
log "daemon at ${DAEMON_URL}"

# ── step 3: launch the disposable test Claude pane ──────────────────────
NONCE="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AGENT_NAME="revkit-dogfood-${NONCE}"
log "test agent: ${AGENT_NAME}"

# The comment we'll post carries a nonce so the reply is verifiable and the
# instructions to the test agent are BOUNDED (no commit, no push, one reply +
# one resolve). The agent runs with `--dangerously-skip-permissions` because
# the pane is disposable and offline in terms of long-lived state.
INSTRUCTIONS="You are a disposable dogfood test session. Your ONLY job is to \
answer the human's review comment. Do NOT commit, push, edit files, or run \
any tool other than the revkit MCP tools. When you receive a channel \
notification about a review thread waiting on the agent, call \`threads\` to \
find the open thread whose body contains nonce ${NONCE}, then \`reply\` to \
it with the body \`ack ${NONCE}\`, then call \`resolve\` on the same thread. \
Then wait silently. Stop after resolving."

# Read `flk agent start`'s JSON output to capture the pane id. `--no-focus`
# keeps the coordinator's cursor put; `--wait-ready` blocks until claude has
# painted at least one status frame so the first `flk agent read` sees the
# session's initial prompt (workspace trust, MCP consent).
#
# The claude arg order matters. `--dangerously-load-development-channels`
# takes `<servers...>` (variadic in commander.js), so if we put the prompt
# after it commander eats the prompt as another channel entry. We therefore
# start claude WITHOUT a prompt and inject the instructions with `flk agent
# send` once the session is ready.
START_JSON="$(mktemp)"
# Start WITHOUT --wait-ready: the first paint from claude on a new project
# is a workspace-trust confirmation ("Enter to confirm · Esc to cancel"),
# and wait-ready would time out waiting for a status that never arrives
# until we answer it. We handle the prompt ourselves below.
#
# The flock server does NOT inherit our nix dev shell — a pane spawned by
# `flk agent start` runs under the flock server's own PATH, and
# `.mcp.json` points at `bun` (no absolute path, since flake pins move).
# We propagate the current shell's PATH via `env PATH=... claude …` so
# `bun` resolves inside the pane and the `revkit` MCP server auto-starts.
# We use `env` rather than `nix develop --command claude` because the
# latter re-enters the dev shell inside the pane — which can pick up a
# different claude binary from a different PATH ordering and lose the
# outer session's OAuth (we saw "API Usage Billing" instead of "Claude
# Max" when going through nix develop).
# Auth is stored under `CLAUDE_CONFIG_DIR` (or `~/.claude` when unset).
# We forward that variable explicitly so the child pane reads the SAME
# credentials this session uses; otherwise a subscription-authed
# coordinator can end up launching an API-key session whose key has
# expired ("Login expired · Please run /login"). We also `env -u` the
# CLAUDE_CODE_* nesting flags (CHILD_SESSION, SESSION_ID, ENTRYPOINT,
# EXECPATH, PID) — those are set FOR US and would confuse the child
# session's own bookkeeping if inherited.
CLAUDE_CONFIG_DIR_VAL="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"

if ! flk agent start "${AGENT_NAME}" \
  --cwd "${REPO_ROOT}" \
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
    "PATH=${PATH}" \
    "HOME=${HOME}" \
    "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR_VAL}" \
    claude \
      --model haiku \
      --dangerously-skip-permissions \
      --dangerously-load-development-channels server:revkit \
  >"${START_JSON}" 2>&1; then
  log_block "flk-start" <"${START_JSON}"
  die "flk agent start failed"
fi
PANE_ID="$(jq -r '.result.agent.pane_id // .result.pane_id // empty' "${START_JSON}" 2>/dev/null || true)"
[[ -n "${PANE_ID}" ]] || { log_block "flk-start" <"${START_JSON}"; die "no pane_id in flk start output"; }
rm -f "${START_JSON}"
log "started pane ${PANE_ID}"

# Handle first-run interactive prompts, then wait for the input line to
# appear. Claude Code's ready indicator on this build is the `❯` prompt
# character at the start of a bordered line, plus the `bypass permissions
# on` status footer.
#
# The prompt-answer regexes require BOTH a keyword AND an "Enter to
# confirm"-style hint on the same screen, so a stray mention in claude's
# greeting doesn't trigger a false Enter press. Each answered prompt is
# recorded so we don't press the same key twice in a row.
answer_prompts() {
  # 90 s covers `nix develop --command` overhead on a cold cache PLUS the
  # first-run claude paint.
  local deadline=$(( $(date +%s) + 90 ))
  local answered_trust=0
  local answered_channel=0
  local screen
  while (( $(date +%s) < deadline )); do
    screen="$(flk agent read "${PANE_ID}" --lines 80 2>/dev/null || true)"
    # Workspace-trust menu. Two-item radio; the default is the SAFER
    # "No, exit" option, so we must move the cursor Down before Enter.
    # We match the specific prompt shape and only fire when it's live.
    if [[ ${answered_trust} -eq 0 ]] \
      && grep -qE "Accessing workspace|Quick safety check|trust this folder" <<<"${screen}" \
      && grep -qE "Enter to confirm" <<<"${screen}"; then
      log "answering workspace-trust prompt (Down, Enter → 'Yes, I trust this folder')"
      flk pane send-keys "${PANE_ID}" Down >/dev/null 2>&1 || true
      sleep 0.3
      flk pane send-keys "${PANE_ID}" Enter >/dev/null 2>&1 || true
      answered_trust=1
      sleep 2
      continue
    fi
    # Development-channel consent (if any surfaces): same guard.
    if [[ ${answered_channel} -eq 0 ]] \
      && grep -qE "development channel|allow this MCP server|load this channel" <<<"${screen}" \
      && grep -qE "Enter to confirm|\\[y/N\\]|\\[Y/n\\]" <<<"${screen}"; then
      log "answering channel/consent prompt with Enter"
      flk pane send-keys "${PANE_ID}" Enter >/dev/null 2>&1 || true
      answered_channel=1
      sleep 2
      continue
    fi
    # Ready indicator: the input caret ❯ inside the bordered prompt box.
    # Checked last so a screen that BOTH has the caret AND still shows a
    # prompt (unlikely, but possible) still answers first.
    if grep -qE '^❯|❯[[:space:]]*$|bypass permissions on|Type a message' <<<"${screen}"; then
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

# ── step 4: wait for the test agent's MCP session to be online ──────────
# `revkit mcp` auto-starts a daemon if one isn't running; we started one
# first, so the MCP server should find and attach to our daemon. Ready
# signal: the pane leaves the "starting" state AND the daemon reports a
# subscriber on the agent event stream.
log "waiting for test agent to reach ready state (post-prompts)"
if ! flk agent wait "${PANE_ID}" --ready --timeout 30000 >/dev/null 2>&1; then
  log "agent did not reach ready after prompts — reading pane state:"
  flk agent read "${PANE_ID}" --lines 120 2>/dev/null | log_block "pane" || true
  die "agent never became ready — inspect the log"
fi
log "agent is ready"

# Give the MCP handshake a beat to finish so `revkit` is present in the
# session's tool list before the instructions land.
sleep 3

# Send the instructions as if the user typed them. `flk pane run` writes
# text + Enter (unlike `flk agent send`, which writes literal text). The
# instructions are already crafted so the agent's next turn calls `threads`
# once the channel notification arrives.
if ! flk pane run "${PANE_ID}" "${INSTRUCTIONS}" >/dev/null 2>&1; then
  log "flk pane run failed — reading pane state:"
  flk agent read "${PANE_ID}" --lines 60 2>/dev/null | log_block "pane" || true
  die "could not send instructions to the test agent"
fi
log "sent instructions to the test agent"

# ── step 5: drive the Playwright leg — post a comment via the rail,     ─
#            then wait for the agent's reply and resolve to arrive.     ─
log "handing off to Playwright"
TMP_ARTIFACTS_DIR="$(mktemp -d "${DOGFOOD_DIR}/artifacts-XXXXXX")"
export REVKIT_DOGFOOD_NONCE="${NONCE}"
export REVKIT_DOGFOOD_ARTIFACTS_DIR="${TMP_ARTIFACTS_DIR}"

# Run the Playwright leg from `site/`, where `@playwright/test` resolves.
# The helper imports it directly (not the bare `playwright` package, which
# is only present transitively). Bun's module resolver walks up from the
# script file, so `--cwd site` is enough.
if (cd "${REPO_ROOT}/site" && bun "${PLAYWRIGHT_SCRIPT}") 2>&1 | tee -a "${LOG_FILE}" | grep -q "^DOGFOOD_OK"; then
  log "Playwright reported success"
  # Copy the screenshot into the dogfood dir as a stable artefact.
  if [[ -f "${TMP_ARTIFACTS_DIR}/reply-visible.png" ]]; then
    cp "${TMP_ARTIFACTS_DIR}/reply-visible.png" "${DOGFOOD_DIR}/reply-visible.png"
    log "screenshot: .revkit/dogfood/reply-visible.png"
  fi
  log "END-TO-END loop succeeded — nonce=${NONCE}"
  # The cleanup trap does the rest.
  exit 0
fi

log "Playwright failed — pane state follows:"
flk agent read "${PANE_ID}" --lines 200 2>/dev/null | log_block "pane" || true
die "end-to-end loop did not complete"
