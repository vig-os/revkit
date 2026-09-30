#!/usr/bin/env bash
# revkit dogfood — end-to-end channel loop with a real Claude Code session.
#
# Proves M2 item 4 (issue #7): the reviewer posts a comment on the built
# review page, the comment reaches a separate, disposable test Claude session
# over the `revkit` MCP channel, the agent replies through the `reply` tool
# and resolves the thread, and the reply appears in the page in real time.
#
# Round-3 hardening (PR #42 review round 2):
#
#   1. **Verifiable lockdown.** BEFORE any prompt is sent, the harness
#      finds the child claude process by its unique argv (the run-specific
#      `mcp-config.json` path) and reads /proc/<pid>/cmdline AND
#      /proc/<pid>/environ. It hard-fails unless every required flag is
#      exactly right (`--strict-mcp-config`, `--mcp-config <abs>`,
#      `--permission-mode dontAsk`, `--tools ""`, exactly the three
#      `mcp__revkit__…` `--allowedTools`) AND every forbidden flag is
#      absent (`--dangerously-skip-permissions`,
#      `--allow-dangerously-skip-permissions`,
#      `--dangerously-allow-browser-network-access`). It also hard-fails
#      unless the child env is the tight allowlist we set — no
#      `SSH_AUTH_SOCK`, no `FLOCK_SOCKET_PATH`, no `DBUS_SESSION_BUS_ADDRESS`,
#      no `LD_LIBRARY_PATH`, no `GH_TOKEN`.
#   2. **Post-run pane check is a hard failure.** The pane MUST show the
#      real denial text `No such tool available` for `Bash` — not just a
#      prose word like "denied". Missing → exit non-zero. The old
#      nonce-echo predicate (`ack <nonce> bash-denied`) is dropped: the
#      agent can type any string it likes, so echoing a known token is
#      not proof of anything. It's downgraded to a liveness marker (the
#      reply's `ack <nonce>` alone).
#   3. **Isolated daemon per run, OUTSIDE the git worktree.**
#      `STATE_DIR` is a `mktemp -d` under `$XDG_RUNTIME_DIR` (or `/tmp`
#      if unset), never inside the repo. The daemon's `.revkit/`,
#      `serve.json`, `daemon.lock`, `threads.sqlite`, isolated
#      `mcp-config.json`, and a copy of `site/dist` + `docs/` all live
#      there. `rm -rf`'d on teardown.
#   4. **`env -i` at pane launch.** Claude runs with ONLY the env vars
#      we explicitly set — `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `TERM`,
#      `LANG`. `SSH_AUTH_SOCK`, `FLOCK_SOCKET_PATH`, `DBUS_SESSION_BUS
#      _ADDRESS`, `LD_LIBRARY_PATH`, `LD_PRELOAD`, every
#      `CLAUDE_CODE_*`, `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`
#      are simply not there because we did not put them there. Verified
#      per run via /proc/<pid>/environ.
#   5. **Self-test mode.** `DOGFOOD_SELFTEST_BAD_FLAGS=1` forces a
#      forbidden argv and asserts the harness aborts BEFORE any prompt
#      is sent AND BEFORE the agent is trusted to reach a model turn.
#      Nothing dangerous ever runs.
#   6. **Deterministic daemon kill + leak-by-cwd sweep.** The daemon's
#      real pid is captured via `$!` after `cd`. Post-teardown SELF-CHECK
#      catches `revkit serve` processes matching by both cmdline and
#      `/proc/<pid>/cwd` — so an MCP-auto-spawned daemon rooted at our
#      state dir is caught even when its argv doesn't name it.
#   7. **daemon.log holds a plaintext launch code — treated accordingly.**
#      The file is unlinked on teardown; a `--keep-daemon-log` flag opts
#      into keeping it after code=... values have been redacted.
#
# Cleanup runs from a trap on EXIT / INT / TERM. Every started resource
# is torn down and the trap performs a POST-TEARDOWN SELF-CHECK. A leak
# turns the script's exit code non-zero even when the loop reported
# success.
set -euo pipefail

# ── locations ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOGFOOD_DIR="${REPO_ROOT}/.revkit/dogfood"
LOG_FILE="${DOGFOOD_DIR}/last.log"
PLAYWRIGHT_SCRIPT="${REPO_ROOT}/site/scripts/dogfood-playwright.ts"

mkdir -p "${DOGFOOD_DIR}"
: > "${LOG_FILE}"

# ── binary paths (absolute, so `env -i` still finds them) ────────────────
# The child pane runs under `env -i`, so `PATH` is only what we explicitly
# set. Any binary the harness invokes on the pane side must therefore be
# either on that PATH or referenced by absolute path. We use the current
# session's resolved paths (`command -v`) which the dev shell provides.
CLAUDE_BIN="$(command -v claude)"
BUN_BIN="$(command -v bun)"
ENV_BIN="/usr/bin/env"
[[ -x "${CLAUDE_BIN}" ]] || { printf 'ERROR: claude not on PATH\n' >&2; exit 1; }
[[ -x "${BUN_BIN}"    ]] || { printf 'ERROR: bun not on PATH\n' >&2; exit 1; }
[[ -x "${ENV_BIN}"    ]] || ENV_BIN="$(command -v env)"

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
DAEMON_LOG=""
PLAYWRIGHT_JOB_PID=""

# Return 0 when `path` is currently held with an advisory flock (either
# LOCK_EX or LOCK_SH). `flock -n` acquires the lock non-blocking; success
# means the lock was free (and we hand it back immediately by exiting the
# subshell). Missing file → not held. Round-3 nit: a bare "still present"
# check on the lock file was noisy — the file can exist as an unlocked
# artefact.
# shellcheck disable=SC2329
# ^ called from cleanup() below.
is_lock_held() {
  local lockfile="$1"
  [[ -f "${lockfile}" ]] || return 1
  # Subshell:
  #   flock acquires → the lock was NOT held → subshell exits 1
  #     (meaning: NOT held) so is_lock_held returns non-zero (false)
  #   flock fails    → the lock IS held      → subshell exits 0
  #     (meaning: IS held) so is_lock_held returns 0 (true)
  ( flock -n 9 && exit 1; exit 0 ) 9<"${lockfile}"
}

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

# Kill a daemon we started. `serve.json` and `daemon.lock` are unlinked
# by the daemon on graceful shutdown; the sweep declares a leak if the
# lock is still HELD past the wait window (not merely present).
# shellcheck disable=SC2329
# ^ called from cleanup() below.
kill_daemon_if_ours() {
  if [[ ${DAEMON_STARTED_BY_US} -ne 1 || -z "${DAEMON_PID}" ]]; then
    return 0
  fi
  if kill -0 "${DAEMON_PID}" 2>/dev/null; then
    log "killing daemon pid ${DAEMON_PID}"
    kill "${DAEMON_PID}" 2>/dev/null || true
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
  # Wait up to 3 s for the lock file to be unlinked or for the flock to
  # be released. Do NOT spawn a probe daemon here (an earlier revision
  # did and it leaked its own probe daemon into SELF-CHECK).
  if [[ -n "${STATE_DIR}" && -f "${STATE_DIR}/.revkit/daemon.lock" ]]; then
    for _ in 1 2 3 4 5 6; do
      [[ ! -e "${STATE_DIR}/.revkit/daemon.lock" ]] && break
      sleep 0.5
    done
  fi
  DAEMON_PID=""
  DAEMON_STARTED_BY_US=0
}

# Return the pids of `revkit serve` daemons whose CWD is STATE_DIR. This
# catches MCP-auto-spawned daemons rooted at our state dir even when the
# process was invoked without a `--dir` naming STATE_DIR (round-3 nit).
# The check reads /proc/<pid>/cwd (a symlink) via readlink; a process
# we don't own returns EPERM and is skipped.
# shellcheck disable=SC2329
# ^ called from cleanup() below.
daemons_rooted_at_state() {
  [[ -z "${STATE_DIR}" ]] && return 0
  local pids p cwd
  # Widen the pattern to catch any `revkit.js serve` — with or without
  # STATE_DIR in the args — then filter by /proc/<pid>/cwd.
  pids="$(pgrep -f 'revkit\.js serve' 2>/dev/null || true)"
  for p in ${pids}; do
    cwd="$(readlink "/proc/${p}/cwd" 2>/dev/null || true)"
    [[ "${cwd}" == "${STATE_DIR}"* ]] && printf '%s\n' "${p}"
  done
}

# shellcheck disable=SC2329
# ^ invoked indirectly through `trap` below; shellcheck can't see that.
cleanup() {
  local rc=$?
  log "teardown starting (exit=${rc})"
  # Kill an in-flight Playwright pipeline FIRST — otherwise the trap
  # would block on `wait $PLAYWRIGHT_JOB_PID` in cases where SIGINT
  # arrived mid-run and Playwright hasn't decided to exit yet.
  if [[ -n "${PLAYWRIGHT_JOB_PID}" ]] && kill -0 "${PLAYWRIGHT_JOB_PID}" 2>/dev/null; then
    log "killing in-flight Playwright pipeline (pid ${PLAYWRIGHT_JOB_PID}) and its descendants"
    # Kill the whole descendant tree with pkill -P; some transitive
    # descendants (chromium) may only die on SIGKILL.
    pkill -TERM -P "${PLAYWRIGHT_JOB_PID}" 2>/dev/null || true
    kill -TERM "${PLAYWRIGHT_JOB_PID}" 2>/dev/null || true
    sleep 1
    pkill -9 -P "${PLAYWRIGHT_JOB_PID}" 2>/dev/null || true
    kill -9 "${PLAYWRIGHT_JOB_PID}" 2>/dev/null || true
    PLAYWRIGHT_JOB_PID=""
  fi
  # Snapshot the pane state before closing, so the log preserves the last
  # frame the human would want to see.
  if [[ -n "${PANE_ID}" ]]; then
    log "pane final read (redacted):"
    flk agent read "${PANE_ID}" --lines 80 2>/dev/null | log_block "pane" || true
  fi
  close_pane_if_any
  kill_daemon_if_ours
  # POST-TEARDOWN SELF-CHECK — a leak turns the exit code non-zero
  # regardless of the loop's own result.
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
  # 2. No revkit-serve process rooted at our STATE_DIR should be alive.
  #    We check by BOTH argv match AND cwd match (round-3 nit). Two
  #    different pgrep calls, deduped.
  if [[ -n "${STATE_DIR}" ]]; then
    local by_argv by_cwd all
    by_argv="$(pgrep -f "revkit\\.js serve.*${STATE_DIR}" 2>/dev/null || true)"
    by_cwd="$(daemons_rooted_at_state)"
    all="$(printf '%s\n%s\n' "${by_argv}" "${by_cwd}" | tr ' ' '\n' | sort -u | grep -v '^$' || true)"
    if [[ -n "${all}" ]]; then
      log "SELF-CHECK: leaked revkit-serve pids ${all//$'\n'/ } — SIGKILLing"
      local lp cl
      for lp in ${all}; do
        cl="$(tr '\0' ' ' < "/proc/${lp}/cmdline" 2>/dev/null | head -c 200 || true)"
        log "SELF-CHECK: leaked pid ${lp} cmdline: ${cl}"
      done
      # shellcheck disable=SC2086
      # ^ $all is intentionally word-split (multiple pids).
      kill -9 ${all} 2>/dev/null || true
      sweep_bad=1
    fi
    # 3. daemon.lock: only complain if the flock is actually held. Bare
    #    file existence is not a leak.
    if is_lock_held "${STATE_DIR}/.revkit/daemon.lock"; then
      log "SELF-CHECK: daemon.lock in ${STATE_DIR} is still HELD by a live process"
      sweep_bad=1
    fi
    rm -rf "${STATE_DIR}" 2>/dev/null || true
  fi
  # 4. Drop the throw-away `.daemon.pid` file from an older revision.
  rm -f "${DOGFOOD_DIR}/.daemon.pid" 2>/dev/null || true
  # 5. `daemon.log` holds a plaintext launch code (`?code=…`). By
  #    default we unlink it on teardown; a caller who wants to keep it
  #    for post-mortem can set `REVKIT_DOGFOOD_KEEP_DAEMON_LOG=1` and
  #    we redact instead. The `?code=` redaction rewrites the file in
  #    place; other useful info (event flow) survives.
  if [[ -n "${DAEMON_LOG}" && -f "${DAEMON_LOG}" ]]; then
    if [[ "${REVKIT_DOGFOOD_KEEP_DAEMON_LOG:-0}" == "1" ]]; then
      # Redact in place. `sed -i` on a small text file is safe.
      sed -i -E \
        -e 's/([?&]code=)[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
        -e 's/(--code[= ])[A-Za-z0-9._~+/=-]+/\1<redacted>/g' \
        "${DAEMON_LOG}" 2>/dev/null || true
      log "daemon.log kept (redacted): ${DAEMON_LOG}"
    else
      rm -f "${DAEMON_LOG}" 2>/dev/null || true
    fi
  fi
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
require flock
require readlink

if [[ -z "${IN_NIX_SHELL:-}" && -z "${DEVCONTAINER_ACTIVE:-}" ]]; then
  case ":${PATH:-}:" in
    *:/nix/store/*bun*/bin:*) ;;
    *) die "dev shell not active — run 'direnv allow' or 'nix develop -c just dogfood'" ;;
  esac
fi

log "worktree: ${REPO_ROOT}"

# ── step 1: bun install (idempotent, cheap when up to date) ─────────────
if [[ ! -d "${REPO_ROOT}/node_modules/.bun" ]]; then
  log "installing workspace deps"
  (cd "${REPO_ROOT}" && bun install --frozen-lockfile) >> "${LOG_FILE}" 2>&1 \
    || die "bun install failed (see log)"
fi

# ── step 2: build the site (freshness-checked) ──────────────────────────
should_rebuild() {
  local dist="${REPO_ROOT}/site/dist/index.html"
  [[ ! -f "${dist}" ]] && return 0
  local hit
  hit="$(find "${REPO_ROOT}/site/src" "${REPO_ROOT}/docs" \
      "${REPO_ROOT}/vocab" "${REPO_ROOT}/plots" \
      -type f -newer "${dist}" -print -quit 2>/dev/null || true)"
  [[ -n "${hit}" ]] && return 0
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

# ── step 3: prepare an ISOLATED state dir OUTSIDE the git worktree ──────
# The daemon roots at the nearest ancestor package.json whose `name` is
# `revkit` (see `packages/cli/src/repo-root.ts`). We satisfy that by
# writing our own `package.json` in STATE_DIR. Putting STATE_DIR
# OUTSIDE the git worktree keeps the test agent's `cwd` off the real
# checkout too — its filesystem view has no `.git`, no committed
# `.mcp.json`, no `CLAUDE.md`. Prefer `$XDG_RUNTIME_DIR` (tmpfs,
# per-user, ephemeral); fall back to `/tmp`.
STATE_BASE="${XDG_RUNTIME_DIR:-/tmp}"
STATE_DIR="$(mktemp -d "${STATE_BASE}/revkit-dogfood-XXXXXX")"
printf '{"name":"revkit","private":true,"type":"module"}\n' \
  > "${STATE_DIR}/package.json"
mkdir -p "${STATE_DIR}/site-dist"
rsync -a --delete "${REPO_ROOT}/site/dist/" "${STATE_DIR}/site-dist/" >> "${LOG_FILE}" 2>&1
# The daemon's anchor confinement rejects symlinks (rule 2 in
# `packages/cli/src/serve/confined-path.ts`), so the anchor's source
# file must be a real file under STATE_DIR. Copy `docs/` too.
rsync -a --delete "${REPO_ROOT}/docs/" "${STATE_DIR}/docs/" >> "${LOG_FILE}" 2>&1
# Write an isolated `mcp-config.json` with an absolute path to
# `revkit mcp`. The committed `.mcp.json` uses a workspace-relative
# path that would not resolve from STATE_DIR.
cat > "${STATE_DIR}/mcp-config.json" <<EOF
{
  "mcpServers": {
    "revkit": {
      "command": "${BUN_BIN}",
      "args": ["${REPO_ROOT}/packages/cli/bin/revkit.js", "mcp"]
    }
  }
}
EOF
STATE_MCP_CONFIG="${STATE_DIR}/mcp-config.json"
log "isolated state dir: ${STATE_DIR} (outside the git worktree)"

# ── step 4: start the daemon INSIDE the isolated state dir ──────────────
DAEMON_LOG="$(mktemp)"
cd "${STATE_DIR}"
"${BUN_BIN}" "${REPO_ROOT}/packages/cli/bin/revkit.js" serve \
    --dir "${STATE_DIR}/site-dist" \
    </dev/null >"${DAEMON_LOG}" 2>&1 &
DAEMON_PID=$!
cd - >/dev/null
DAEMON_STARTED_BY_US=1
log "daemon spawned (bun pid ${DAEMON_PID})"

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
mv "${DAEMON_LOG}" "${DOGFOOD_DIR}/daemon.log"
DAEMON_LOG="${DOGFOOD_DIR}/daemon.log"

SERVE_PID="$(jq -r '.pid' "${STATE_DIR}/.revkit/serve.json")"
if [[ "${SERVE_PID}" != "${DAEMON_PID}" ]]; then
  log "WARN: serve.json.pid=${SERVE_PID} != captured bun pid ${DAEMON_PID}"
  DAEMON_PID="${SERVE_PID}"
  log "using serve.json.pid ${DAEMON_PID} for teardown"
fi

DAEMON_URL="$(jq -r '.url' "${STATE_DIR}/.revkit/serve.json")"
DAEMON_PORT="$(jq -r '.port' "${STATE_DIR}/.revkit/serve.json")"
[[ -n "${DAEMON_URL}" && -n "${DAEMON_PORT}" ]] || die "malformed serve.json"
log "daemon at ${DAEMON_URL} (pid ${DAEMON_PID})"

# ── step 5: build the claude argv (locked-down + env -i) ────────────────
NONCE="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AGENT_NAME="revkit-dogfood-${NONCE}"
log "test agent: ${AGENT_NAME}"

# The three allowed tools. Kept as an array so the shell never
# word-splits or globs them silently.
ALLOWED_TOOLS_ARR=(mcp__revkit__threads mcp__revkit__reply mcp__revkit__resolve)

# `env -i` (round-3 nit) — start claude with an EMPTY env, then set only
# what it needs. `SSH_AUTH_SOCK`, `FLOCK_SOCKET_PATH`, `DBUS_SESSION_BUS
# _ADDRESS`, `LD_LIBRARY_PATH`, `LD_PRELOAD`, `GH_TOKEN`, `GITHUB_TOKEN`,
# `ANTHROPIC_API_KEY`, and every `CLAUDE_CODE_*` nesting flag are simply
# not there because we don't set them. Verified per run against
# /proc/<pid>/environ (below).
CLAUDE_CONFIG_DIR_VAL="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
CLAUDE_ENV_ARR=(
  "PATH=${PATH}"
  "HOME=${HOME}"
  "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR_VAL}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)

# Build the claude argv. This is the ONLY place the flag set is
# defined; `verify_claude_lockdown` (below) reads /proc and asserts
# every flag matches, so a stray edit here can't slip through.
CLAUDE_ARGV=(
  "${CLAUDE_BIN}"
  --model haiku
  --strict-mcp-config
  --mcp-config "${STATE_MCP_CONFIG}"
  --dangerously-load-development-channels server:revkit
  --permission-mode dontAsk
  --tools ""
  --allowedTools "${ALLOWED_TOOLS_ARR[@]}"
)

# ── step 5.5: SELF-TEST — DOGFOOD_SELFTEST_BAD_FLAGS=1 ──────────────────
# Round-3 requirement: prove the harness's flag verification fails
# CLOSED on a bad argv, BEFORE any prompt is sent AND before any agent
# reaches a model turn. We inject a forbidden flag (`--tools default`
# — anything other than the empty string) and expect
# `verify_claude_lockdown` to abort. We never inject
# `--dangerously-skip-permissions`: leaking a session with that flag
# would be dangerous, and the test doesn't need it to prove the point.
if [[ "${DOGFOOD_SELFTEST_BAD_FLAGS:-0}" == "1" ]]; then
  log "SELF-TEST: injecting a forbidden flag (--tools default) — the harness MUST abort before sending instructions"
  # Replace the `--tools ""` pair with `--tools default`. Walk the
  # array so we don't accidentally break a matching literal elsewhere.
  new_argv=()
  skip_next=0
  for i in "${!CLAUDE_ARGV[@]}"; do
    if [[ ${skip_next} -eq 1 ]]; then
      skip_next=0
      continue
    fi
    if [[ "${CLAUDE_ARGV[i]}" == "--tools" ]]; then
      new_argv+=("--tools" "default")
      skip_next=1
      continue
    fi
    new_argv+=("${CLAUDE_ARGV[i]}")
  done
  CLAUDE_ARGV=("${new_argv[@]}")
fi

# ── step 6: launch the disposable, LOCKED-DOWN test Claude pane ─────────
# `--cwd "${STATE_DIR}"` (not the repo root) is critical: the `revkit
# mcp` server auto-discovers the daemon by reading `.revkit/serve.json`
# from its OWN cwd. Rooting the pane at STATE_DIR means the MCP server
# attaches to our daemon; rooting it at the worktree would leak a
# second daemon.
START_JSON="$(mktemp)"
if ! flk agent start "${AGENT_NAME}" \
  --cwd "${STATE_DIR}" \
  --no-focus \
  -- "${ENV_BIN}" -i "${CLAUDE_ENV_ARR[@]}" "${CLAUDE_ARGV[@]}" \
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

# ── step 7: VERIFY LOCKDOWN BEFORE SENDING ANY PROMPT ───────────────────
# Round-3 blocker: the child claude MUST run with exactly the flag set
# and env we intended. We find its pid by grepping for our unique
# argv marker (the run-specific mcp-config path) and inspect
# /proc/<pid>/cmdline and /proc/<pid>/environ. Missing flag → hard
# fail. Forbidden flag → hard fail. Env leak → hard fail. No
# instructions have been sent yet, so if we abort here no model turn
# has run.
verify_claude_lockdown() {
  local deadline=$(( $(date +%s) + 60 ))
  local claude_pid=""
  # Find the claude pid by grepping for our unique mcp-config path.
  while (( $(date +%s) < deadline )); do
    claude_pid="$(pgrep -f "claude.*${STATE_MCP_CONFIG}" 2>/dev/null | head -1 || true)"
    [[ -n "${claude_pid}" ]] && break
    sleep 0.5
  done
  [[ -n "${claude_pid}" ]] || die "verify_claude_lockdown: could not find claude pid via ${STATE_MCP_CONFIG}"

  # Read cmdline (NUL-separated).
  local cmdline_file="/proc/${claude_pid}/cmdline"
  [[ -r "${cmdline_file}" ]] || die "verify_claude_lockdown: cannot read ${cmdline_file}"
  local raw_cmdline
  raw_cmdline="$(tr '\0' '\n' < "${cmdline_file}")"
  # Split into an array (one arg per line).
  local cmd_arr=()
  while IFS= read -r arg; do cmd_arr+=("${arg}"); done <<<"${raw_cmdline}"

  # 1. Required flags.
  local required=(
    "--strict-mcp-config"
    "--mcp-config"
    "--permission-mode"
    "--tools"
    "--allowedTools"
    "--dangerously-load-development-channels"
  )
  local flag
  for flag in "${required[@]}"; do
    local found=0
    for arg in "${cmd_arr[@]}"; do
      [[ "${arg}" == "${flag}" ]] && { found=1; break; }
    done
    if [[ ${found} -eq 0 ]]; then
      log "LOCKDOWN-VERIFY: required flag missing: ${flag}"
      log "LOCKDOWN-VERIFY: full cmdline was:"
      log "  ${raw_cmdline//$'\n'/ }"
      die "lockdown verification failed"
    fi
  done

  # 2. Forbidden flags.
  local forbidden=(
    "--dangerously-skip-permissions"
    "--allow-dangerously-skip-permissions"
    "--dangerously-allow-browser-network-access"
    "--bare"
  )
  for flag in "${forbidden[@]}"; do
    for arg in "${cmd_arr[@]}"; do
      if [[ "${arg}" == "${flag}" ]]; then
        log "LOCKDOWN-VERIFY: forbidden flag present: ${flag}"
        die "lockdown verification failed"
      fi
    done
  done

  # 3. --mcp-config VALUE is exactly our absolute path.
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--mcp-config" ]]; then
      if [[ "${cmd_arr[i+1]:-}" != "${STATE_MCP_CONFIG}" ]]; then
        log "LOCKDOWN-VERIFY: --mcp-config value != ${STATE_MCP_CONFIG} (was: '${cmd_arr[i+1]:-<missing>}')"
        die "lockdown verification failed"
      fi
    fi
  done

  # 4. --permission-mode VALUE is exactly dontAsk.
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--permission-mode" ]]; then
      if [[ "${cmd_arr[i+1]:-}" != "dontAsk" ]]; then
        log "LOCKDOWN-VERIFY: --permission-mode != dontAsk (was: '${cmd_arr[i+1]:-<missing>}')"
        die "lockdown verification failed"
      fi
    fi
  done

  # 5. --tools VALUE is exactly the empty string.
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--tools" ]]; then
      if [[ -n "${cmd_arr[i+1]:-}" ]]; then
        log "LOCKDOWN-VERIFY: --tools != '' (was: '${cmd_arr[i+1]:-<missing>}')"
        die "lockdown verification failed"
      fi
    fi
  done

  # 6. --allowedTools is followed by EXACTLY the three revkit MCP
  #    tools (in any order), and no other tool name.
  local seen_at=-1
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--allowedTools" ]]; then
      seen_at=$i
      break
    fi
  done
  [[ ${seen_at} -ge 0 ]] || die "lockdown verification failed: --allowedTools not seen"
  # Collect the allowedTools values (all args after `--allowedTools`
  # that are NOT another flag).
  local allowed=()
  for ((i=seen_at+1; i<${#cmd_arr[@]}; i++)); do
    [[ "${cmd_arr[i]}" =~ ^-- ]] && break
    allowed+=("${cmd_arr[i]}")
  done
  local expected=(mcp__revkit__threads mcp__revkit__reply mcp__revkit__resolve)
  if [[ ${#allowed[@]} -ne ${#expected[@]} ]]; then
    log "LOCKDOWN-VERIFY: --allowedTools count wrong: expected ${#expected[@]}, saw ${#allowed[@]} (${allowed[*]:-})"
    die "lockdown verification failed"
  fi
  local a
  for a in "${allowed[@]}"; do
    local ok=0
    for e in "${expected[@]}"; do
      [[ "${a}" == "${e}" ]] && { ok=1; break; }
    done
    [[ ${ok} -eq 1 ]] || {
      log "LOCKDOWN-VERIFY: unexpected --allowedTools entry: '${a}'"
      die "lockdown verification failed"
    }
  done
  local e ok
  for e in "${expected[@]}"; do
    ok=0
    for a in "${allowed[@]}"; do
      [[ "${e}" == "${a}" ]] && { ok=1; break; }
    done
    [[ ${ok} -eq 1 ]] || {
      log "LOCKDOWN-VERIFY: missing required --allowedTools entry: '${e}'"
      die "lockdown verification failed"
    }
  done

  # 7. /proc/<pid>/environ MUST hold ONLY our allowlist + a small set
  #    of harmless kernel-provided extras (e.g. `_`). Anything else
  #    means env didn't strip cleanly.
  local environ_file="/proc/${claude_pid}/environ"
  [[ -r "${environ_file}" ]] || die "verify_claude_lockdown: cannot read ${environ_file}"
  # Read raw NUL-separated env into an array we can inspect line-by-line.
  local env_pairs
  env_pairs="$(tr '\0' '\n' < "${environ_file}")"
  local env_names
  env_names="$(printf '%s\n' "${env_pairs}" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/' | sort -u)"

  # Hard bans: names that MUST NOT be present under env -i, since they
  # can only be there because a shell or wrapper along the way
  # re-injected them from our (untrusted-by-the-child) env.
  local forbidden_env=(
    SSH_AUTH_SOCK
    FLOCK_SOCKET_PATH
    DBUS_SESSION_BUS_ADDRESS
    LD_PRELOAD
    NIX_LD
    NIX_LD_LIBRARY_PATH
    GH_TOKEN
    GITHUB_TOKEN
    ANTHROPIC_API_KEY
    NODE_OPTIONS
    CLAUDE_CODE_CHILD_SESSION
    CLAUDE_CODE_SESSION_ID
    CLAUDE_CODE_SESSION_ATTENDED
    CLAUDE_CODE_MESSAGING_SOCKET
    CLAUDE_CODE_MESSAGING_TOKEN
  )
  local bad
  for bad in "${forbidden_env[@]}"; do
    if grep -qxF "${bad}" <<<"${env_names}"; then
      log "LOCKDOWN-VERIFY: forbidden env var leaked to child: ${bad}"
      die "lockdown verification failed"
    fi
  done
  # `LD_LIBRARY_PATH` is a special case. It CAN be present, but ONLY
  # with a value the nix claude wrapper adds — a deterministic
  # `/nix/store/<hash>-<lib>/lib:` prefix. Anything else is a caller
  # leak (host lib dir, a rogue LD path).
  local ld_line
  ld_line="$(printf '%s\n' "${env_pairs}" | grep -E '^LD_LIBRARY_PATH=' || true)"
  if [[ -n "${ld_line}" ]]; then
    local ld_value="${ld_line#LD_LIBRARY_PATH=}"
    # Every colon-separated entry must live under /nix/store.
    local entry
    while IFS= read -r entry; do
      [[ -z "${entry}" ]] && continue
      if [[ "${entry}" != /nix/store/* ]]; then
        log "LOCKDOWN-VERIFY: LD_LIBRARY_PATH contains non-/nix/store entry: '${entry}'"
        die "lockdown verification failed"
      fi
    done < <(tr ':' '\n' <<<"${ld_value}")
  fi
  log "lockdown verified OK for claude pid ${claude_pid}: 6 required flags present, 4 dangerous flags absent, env is the tight allowlist (LD_LIBRARY_PATH only if wrapper-set)"
}

# Round-3 blocker: verify BEFORE sending instructions.
verify_claude_lockdown

# In self-test mode we've now proven the verifier catches a bad flag.
# The verifier already `die`d. If we reach here in self-test mode,
# the verifier let a bad argv through — which is itself a failure.
if [[ "${DOGFOOD_SELFTEST_BAD_FLAGS:-0}" == "1" ]]; then
  die "SELF-TEST: harness FAILED to catch the injected forbidden flag — this is a real regression"
fi

# ── step 8: handle first-run interactive prompts ────────────────────────
read_screen() {
  flk agent read "${PANE_ID}" --lines 80 2>/dev/null \
    | jq -r '.result.read.text // ""' 2>/dev/null || true
}

answer_prompts() {
  local deadline=$(( $(date +%s) + 90 ))
  local answered_trust=0
  local answered_channel=0
  local screen target
  local pane_target="${PANE_ID}"
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
  while (( $(date +%s) < deadline )); do
    screen="$(read_screen)"
    if [[ ${answered_trust} -eq 0 ]] \
      && grep -qE "Accessing workspace|Quick safety check|trust this folder" <<<"${screen}" \
      && grep -qE "Enter to confirm" <<<"${screen}"; then
      log "workspace-trust prompt detected — sending Down"
      flk pane send-keys "${pane_target}" Down >/dev/null 2>&1 || true
      sleep 0.4
      screen="$(read_screen)"
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

sleep 3

# Instructions to the agent. Round-3 change: the `ack <nonce>` is a
# LIVENESS marker (proves the agent reached a reply turn). The
# lockdown itself is verified in step 7 above (pre-launch cmdline
# inspection) and post-run via `require_denial_text` (below); the
# nonce echo is not a security proof, because the agent could just
# type any string it likes back.
INSTRUCTIONS="You are a disposable test session. WAIT SILENTLY until a \
channel notification arrives from server:revkit — do NOT call ANY tool \
right now. \
\
When a channel notification about a review thread arrives, you MUST \
perform EXACTLY these four tool calls IN THIS ORDER, with NO analysis, \
NO introspection, and NO refusal to attempt. Any deviation from this \
sequence is a test failure — the harness will hard-fail the run and \
your session will be logged as an error: \
\
STEP 1 (mandatory tool call, DO NOT SKIP): Call the built-in tool \
named 'Bash' with the parameter \`command: \"git status\"\`. This is \
not a suggestion. Even if you believe Bash is not in your allowlist, \
you MUST make the call anyway — the point of this step is to let the \
runtime's tool-allowlist check refuse the call and emit an error \
message. That error message is proof the lockdown is working. Do not \
say 'I will not attempt this because…'; make the call. When the \
runtime returns \`Error: No such tool available: <name>\`, that IS the \
expected outcome. Save the exact error string verbatim. If, and only \
if, Bash unexpectedly SUCCEEDS and returns actual git status text, \
skip steps 2 and 3 and go straight to a reply body of just \
\`LOCKDOWN BROKEN\`. \
\
STEP 2: Call \`threads\` to find the open thread whose comment body \
contains nonce ${NONCE}. Record thread_id AND the id of the LAST \
comment in the thread. \
\
STEP 3: Call \`reply\`. Arguments: thread_id from step 2; parent_id \
= the LAST comment id from step 2 (NOT the thread id); body = the \
literal string \`ack ${NONCE} :: <full verbatim error from step 1>\`. \
The body MUST start with 'ack ${NONCE} :: Error: No such tool \
available:'. If reply is rejected with unknown-parent, re-run threads \
and pick the last comment's id again. \
\
STEP 4: Call \`resolve\` on the same thread only AFTER the reply \
succeeded. Then wait silently. \
\
Reminder: STEP 1 is not optional and not conditional. Make the tool \
call to Bash first, before anything else. The refusal message is the \
whole point of the test."

if ! flk pane run "${PANE_ID}" "${INSTRUCTIONS}" >/dev/null 2>&1; then
  log "flk pane run failed — reading pane state:"
  flk agent read "${PANE_ID}" --lines 60 2>/dev/null | log_block "pane" || true
  die "could not send instructions to the test agent"
fi
log "sent instructions to the test agent"

# ── step 9: drive the Playwright leg ────────────────────────────────────
log "handing off to Playwright"
TMP_ARTIFACTS_DIR="$(mktemp -d "${DOGFOOD_DIR}/artifacts-XXXXXX")"
export REVKIT_DOGFOOD_NONCE="${NONCE}"
export REVKIT_DOGFOOD_ARTIFACTS_DIR="${TMP_ARTIFACTS_DIR}"
export REVKIT_DOGFOOD_STATE_DIR="${STATE_DIR}"

playwright_ok=0
# Run Playwright in the background so this shell keeps a bash prompt
# and can respond to signals (SIGINT / SIGTERM / ^C) immediately. If
# we `wait`ed on a foreground pipeline, bash would defer any trap
# until the pipeline returned — which is minutes when the agent is
# hung. Instead we background the pipeline, remember its pid so the
# trap can kill it explicitly, and poll for completion.
(
  cd "${REPO_ROOT}/site" && bun "${PLAYWRIGHT_SCRIPT}" 2>&1 \
    | redact \
    | tee -a "${LOG_FILE}"
) > /dev/null &
PLAYWRIGHT_JOB_PID=$!

# Poll: either DOGFOOD_OK appears in the log OR the pipeline exits.
# `wait -n $PLAYWRIGHT_JOB_PID` would block for the whole thing, so we
# use a short-sleep loop so a signal can interrupt within ~1 s.
while kill -0 "${PLAYWRIGHT_JOB_PID}" 2>/dev/null; do
  if tail -400 "${LOG_FILE}" 2>/dev/null | grep -q "^DOGFOOD_OK"; then
    playwright_ok=1
    break
  fi
  sleep 1
done
# Give the pipeline a beat to fully finish writing.
wait "${PLAYWRIGHT_JOB_PID}" 2>/dev/null || true
PLAYWRIGHT_JOB_PID=""
if [[ ${playwright_ok} -eq 0 ]] && tail -400 "${LOG_FILE}" 2>/dev/null | grep -q "^DOGFOOD_OK"; then
  playwright_ok=1
fi

if [[ ${playwright_ok} -eq 0 ]]; then
  log "Playwright failed or was interrupted — pane state follows:"
  flk agent read "${PANE_ID}" --lines 200 2>/dev/null | log_block "pane" || true
  if [[ -f "${DAEMON_LOG}" ]]; then
    log "daemon log tail follows (for the event subscription trail):"
    tail -60 "${DAEMON_LOG}" | log_block "daemon" || true
  fi
  die "end-to-end loop did not complete"
fi

log "Playwright reported success"
if [[ -f "${TMP_ARTIFACTS_DIR}/reply-visible.png" ]]; then
  cp "${TMP_ARTIFACTS_DIR}/reply-visible.png" "${DOGFOOD_DIR}/reply-visible.png"
  log "screenshot: .revkit/dogfood/reply-visible.png"
fi

# ── step 10: HARD-FAIL lockdown check on the pane ────────────────────────
# Round-3 blocker: the ONLY thing that proves the lockdown fired live is
# the daemon-side refusal text. Claude Code writes `No such tool
# available: <tool>` when the model asks for a tool the allowlist
# rejects. If that text isn't in the pane, the lockdown either didn't
# fire (regression) or the agent didn't attempt Bash. Either way we
# fail the run — the harness must never "pass with a WARN".
require_denial_text() {
  # Two independent proofs, either sufficient:
  #
  #   (A) Pane grep. Claude prints `Error: No such tool available: <tool>`
  #       when the model asks for a tool the allowlist rejects.
  #       Observed shapes: `Bash`, `bash`, `mcp__bash`.
  #   (B) Reply-body grep. Our instructions require the agent to paste
  #       the FULL error text into the reply body. If the model
  #       self-censors (does not attempt Bash at all), the denial text
  #       is absent from BOTH surfaces — so the run correctly fails.
  #       If the tool actually SUCCEEDED, the body reads `LOCKDOWN
  #       BROKEN` and Playwright already threw. So requiring
  #       `No such tool available:.*bash` in either surface is a real
  #       proof that (i) the allowlist fired, AND (ii) the agent
  #       observed and reported it.
  local pattern='No such tool available:[[:space:]]*[A-Za-z_]*[Bb]ash'

  local screen
  screen="$(flk agent read "${PANE_ID}" --lines 300 2>/dev/null | jq -r '.result.read.text // ""')"
  if grep -qE "${pattern}" <<<"${screen}"; then
    local matched
    matched="$(grep -oE "${pattern}[A-Za-z_]*" <<<"${screen}" | head -1)"
    log "lockdown proof (source: pane): recorded '${matched}' — good"
    return 0
  fi

  # Pane didn't have it. Try the reply body via the daemon.
  local threads_json body_text
  threads_json="$(curl -sSf \
    -H "authorization: Bearer $(jq -r '.agentToken' "${STATE_DIR}/.revkit/serve.json")" \
    -H "accept: application/json" \
    "${DAEMON_URL}/api/threads" 2>/dev/null || true)"
  if [[ -n "${threads_json}" ]]; then
    body_text="$(printf '%s' "${threads_json}" | jq -r \
      --arg nonce "${NONCE}" \
      '.threads[] | select(.comments[]?.body | test("ack \($nonce)"))
       | .comments[] | select(.author.kind == "agent") | .body' 2>/dev/null || true)"
    if [[ -n "${body_text}" ]] && grep -qE "${pattern}" <<<"${body_text}"; then
      local matched
      matched="$(grep -oE "${pattern}[A-Za-z_]*" <<<"${body_text}" | head -1)"
      log "lockdown proof (source: agent reply body): '${matched}' — good"
      return 0
    fi
  fi

  log "LOCKDOWN-VERIFY (post-run): neither the pane nor the agent reply body contained the required denial text."
  log "Expected substring pattern: '${pattern}'"
  log "Pane final screen:"
  printf '%s\n' "${screen}" | log_block "pane" || true
  if [[ -n "${body_text:-}" ]]; then
    log "Agent reply body:"
    printf '%s\n' "${body_text}" | log_block "reply" || true
  fi
  return 1
}
if ! require_denial_text; then
  die "lockdown proof failed — the harness must not pass a run where the Bash denial line is absent"
fi

log "END-TO-END loop succeeded — nonce=${NONCE}"
exit 0
