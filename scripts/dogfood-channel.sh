#!/usr/bin/env bash
# revkit dogfood — end-to-end channel loop with a real Claude Code session.
#
# Proves M2 item 4 (issue #7): the reviewer posts a comment on the built
# review page, the comment reaches a separate, disposable test Claude session
# over the `revkit` MCP channel, the agent replies through the `reply` tool
# and resolves the thread, and the reply appears in the page in real time.
#
# Round-6 hardening (PR #42 review round 5):
#
#   Round-5 wired the owner-profile isolation (--setting-sources ""
#   + --settings <state>/settings.json), but teardown died silently
#   under `set -e` any time a `revkit.js serve` process existed on
#   the box whose cwd was not our STATE_DIR — e.g. the owner's
#   normal dogfood daemon, or a neighbouring worktree's test daemon.
#   State dirs, profile transcript dirs, artifacts and daemon.log
#   (with its plaintext launch code) all leaked past the crash.
#   Round-6 makes cleanup best-effort and audits every trap-called
#   helper for the same `&&`-last-statement pattern.
#
#   Round-6 also replaces the owner-specific statusline grep with
#   the reviewer's own signal: `flk agent_session` must stay null
#   for the whole run (proves no session-start hook fired), and
#   tightens the CLAUDE.md check (fail closed on a missing
#   transcript dir, match up to six short quote-free phrases
#   rather than one long line).
#
#   The lockdown proof is the PRE-LAUNCH /proc check on the real
#   claude process, NOT any model behaviour. The old post-run "did
#   the agent write the denial text" gate was dropped in round-4:
#   forgeable (the reply body was model output) AND broke the loop
#   whenever a well-aligned model correctly refused to follow
#   embedded instructions from a channel comment (ADR-0007: channel
#   comments are requests from a human, not instructions).
#
#   1. **Verifiable lockdown, pre-launch.** BEFORE any prompt is sent,
#      the harness finds the child claude by its unique argv (the
#      run-specific `mcp-config.json` path), waits until
#      `/proc/<pid>/exe` resolves to `.claude-wrapped` (closes the
#      pre-exec race in the wrapper), then reads /proc/<pid>/cmdline
#      AND /proc/<pid>/environ.
#      - Required flags exact: `--strict-mcp-config`,
#        `--mcp-config <abs>`, `--permission-mode dontAsk`,
#        `--tools ""` (value is the empty string), `--allowedTools`
#        with exactly the three `mcp__revkit__…` names,
#        `--dangerously-load-development-channels`.
#      - Forbidden flags absent: `--dangerously-skip-permissions`,
#        `--allow-dangerously-skip-permissions`,
#        `--dangerously-allow-browser-network-access`, `--bare`.
#      - Env is a TRUE ALLOWLIST. Every name in
#        /proc/<pid>/environ must be one of: the five we set via
#        `env -i` (`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `TERM`,
#        `LANG`), or one the nix claude wrapper deterministically
#        adds (`LD_LIBRARY_PATH`, `DISABLE_AUTOUPDATER`,
#        `FORCE_AUTOUPDATE_PLUGINS`, `DISABLE_INSTALLATION_CHECKS`,
#        `USE_BUILTIN_RIPGREP`). Anything else — even a name we
#        didn't think to ban — is a hard fail. `LD_LIBRARY_PATH`
#        is further validated: every colon-separated entry must be
#        under `/nix/store`.
#   2. **No model-driven lockdown assertion.** The nonce reply
#      (`ack <nonce>`) remains as a LIVENESS check. If the agent
#      declines a channel comment for any reason (prompt-injection
#      refusal, quota, disagreement with the request), the run fails
#      cleanly and the log makes the reason obvious.
#   3. **Natural, non-coercive dogfood comment.** The comment on the
#      built page is what a real reviewer would write — a short note
#      asking the agent to ack. There is no embedded imperative
#      chain, no coerced tool call.
#   4. **Isolated daemon per run, OUTSIDE the git worktree.**
#      `STATE_DIR` is a `mktemp -d` under `$XDG_RUNTIME_DIR` (or
#      `/tmp` if unset), never inside the repo. The daemon's
#      `.revkit/` state, isolated `mcp-config.json`, and copies of
#      `site/dist` and `docs/` live there. `rm -rf`'d on teardown.
#   5. **`env -i` at pane launch.**
#   6. **Owner-profile isolation (round-5 blocker).** `CLAUDE_CONFIG_DIR`
#      still points at the owner's `~/.claude` (that's where OAuth
#      lives; copying it is out of bounds), but the child claude
#      launches with `--setting-sources ""` (blocks owner user /
#      project / local settings from loading) AND `--settings
#      <state-dir>/settings.json` (loads OUR isolated file with no
#      hooks, no statusLine, no env block, no plugins,
#      `instructionFiles: "managed-only"` — drops the owner's
#      CLAUDE.md — and `permissions.defaultMode: "dontAsk"` +
#      an `allow` list of only the three revkit MCP tools). Verified
#      per run via three EMPIRICAL post-run checks (statusline
#      markers absent from pane, hook markers absent from pane,
#      owner-CLAUDE.md fingerprint absent from
#      `${CLAUDE_CONFIG_DIR}/projects/<slug>/*.jsonl`). At teardown
#      the harness removes ONLY this run's profile dir (containment-
#      checked), leaving prior leftovers for a coordinator decision.
#   7. **Self-test mode.** `DOGFOOD_SELFTEST_BAD_FLAGS=1` injects a
#      forbidden argv value (`--tools default`) and asserts the
#      pre-launch verify aborts BEFORE any prompt is sent. Success
#      prints `SELFTEST OK` and exits 0 (distinct from a real
#      failure). `--dangerously-skip-permissions` is NEVER injected —
#      no rogue session ever runs.
#   8. **Deterministic daemon kill + leak-by-cwd sweep.**
#   9. **daemon.log holds a plaintext launch code — treated
#      accordingly.** Unlinked on teardown unless
#      `REVKIT_DOGFOOD_KEEP_DAEMON_LOG=1`; then `?code=…` is
#      redacted in place.
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
SELFTEST_DECOY_PID=""
# Round-6-nit idempotency guard: cleanup is registered on EXIT, INT
# and TERM. A SIGINT can trigger the trap once, and the interrupted
# script then exits, firing the trap AGAIN. The second run would try
# to close a pane that's already closed, unlink files already gone,
# and log confusing "SELF-CHECK failed" lines against a partial run.
# The guard makes cleanup a one-shot.
CLEANUP_RAN=0

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
  # Round-6 audit: return 0 explicitly so callers under `set -e` do not
  # bail when the last executed command was a false `[[ -n … ]]`.
  return 0
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
  # Round-6 blocker: the loop body used to be `[[ … ]] && printf …`
  # — the last iteration whose pid was NOT rooted at STATE_DIR
  # returned 1, and under `set -e` that killed the trap partway
  # through cleanup. Use an explicit `if`; end with `return 0` so
  # a false final condition can never propagate a non-zero exit.
  pids="$(pgrep -f 'revkit\.js serve' 2>/dev/null || true)"
  for p in ${pids}; do
    cwd="$(readlink "/proc/${p}/cwd" 2>/dev/null || true)"
    if [[ "${cwd}" == "${STATE_DIR}"* ]]; then
      printf '%s\n' "${p}"
    fi
  done
  return 0
}

# shellcheck disable=SC2329
# ^ invoked indirectly through `trap` below; shellcheck can't see that.
cleanup() {
  local rc=$?
  # Round-6-nit idempotency guard: bash runs the EXIT trap after
  # SIGINT/SIGTERM traps as well, so a `^C` can drive cleanup twice.
  # A second pass would confuse the SELF-CHECK ("still HELD" against
  # a lock file we already unlinked, phantom "leaked pane" reports).
  # Return early on the second entry — the first pass wins.
  if [[ "${CLEANUP_RAN}" == "1" ]]; then
    return 0
  fi
  CLEANUP_RAN=1
  # Round-6 blocker: `set -e` was tearing this function apart. Any
  # helper whose last statement was a false `[[ … ]] && …` returned
  # 1 and killed the trap partway through — leaving state dirs,
  # profile transcripts, artifacts and (worst) daemon.log with its
  # plaintext launch code on disk. Cleanup is a "do the best we can
  # in any order" contract; a single failing helper must not stop
  # the rest. Every step below is guarded independently.
  set +e
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
  # NOTE: the self-test decoy is killed AT THE END of cleanup, AFTER
  # the sweep runs. Killing it here would leave `daemons_rooted_at_state`
  # with nothing to scan — the whole regression test would be vacuous.
  # See the DOGFOOD_SELFTEST_TEARDOWN_WITH_DECOY block below.
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
  # 4. Round-5 blocker: this run's profile dir under
  #    `${CLAUDE_CONFIG_DIR}/projects/` holds the transcript and
  #    memory for the test agent. Delete ONLY this run's dir; do
  #    NOT touch older leftovers (the reviewer wants those left in
  #    place for a coordinator decision). The dir name is claude's
  #    slugified STATE_DIR path: `/` → `-`. Belt-and-braces: refuse
  #    to `rm` unless the resolved path is under
  #    `${CLAUDE_CONFIG_DIR_VAL}/projects/` AND contains the
  #    literal `revkit-dogfood` marker AND matches the STATE_DIR
  #    slug for THIS run.
  if [[ -n "${STATE_DIR}" && -n "${CLAUDE_CONFIG_DIR_VAL:-}" ]]; then
    # Slugify: replace every `/` with `-`. `/run/user/1004/revkit-dogfood-XYZ`
    # → `-run-user-1004-revkit-dogfood-XYZ`.
    local run_slug="${STATE_DIR//\//-}"
    local projects_root="${CLAUDE_CONFIG_DIR_VAL}/projects"
    local project_dir="${projects_root}/${run_slug}"
    if [[ -d "${project_dir}" \
      && "${project_dir}" == "${projects_root}/"* \
      && "${project_dir}" == *"revkit-dogfood"* \
      && "${project_dir}" == *"${STATE_DIR##*/}"* ]]; then
      log "removing this run's profile dir: ${project_dir}"
      rm -rf "${project_dir}" 2>/dev/null || true
    elif [[ -d "${project_dir}" ]]; then
      log "SAFETY: profile dir '${project_dir}' failed containment check; NOT removing"
    fi
  fi
  # 5. Drop the throw-away `.daemon.pid` file from an older revision.
  rm -f "${DOGFOOD_DIR}/.daemon.pid" 2>/dev/null || true
  # 6. `daemon.log` holds a plaintext launch code (`?code=…`). By
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
  # Kill any self-test decoy AT THE END, AFTER the sweep has had a
  # chance to observe it via pgrep + /proc/<pid>/cwd. If we killed
  # earlier (round-6 self-test v1) the sweep saw nothing and the
  # regression test was vacuous.
  if [[ -n "${SELFTEST_DECOY_PID}" ]]; then
    kill -9 "${SELFTEST_DECOY_PID}" 2>/dev/null || true
    log "SELFTEST-TEARDOWN: killed decoy pid ${SELFTEST_DECOY_PID} (after sweep)"
    SELFTEST_DECOY_PID=""
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

# ── SELF-TEST: teardown must survive an unrelated `revkit.js serve` ─────
# Round-6 blocker regression test. On PR #42 head 6b90ac9, a decoy
# process whose argv matched `revkit.js serve` — even one belonging to
# a completely unrelated codebase, or one someone started for a
# neighbouring worktree — killed this script's cleanup partway
# through. The last statement of `daemons_rooted_at_state` was a
# `[[ … ]] && printf …`, which returned 1 on the final non-matching
# pid, and under `set -e` that propagated up and terminated the trap.
# Fix: `cleanup` does `set +e`; `daemons_rooted_at_state` uses an
# explicit `if` and ends with `return 0`.
#
# The self-test starts a real decoy (a harmless `sleep` with argv[0]
# rewritten to look like `bun /somewhere/revkit.js serve`), then
# triggers an immediate `exit 0` so the trap runs. Cleanup must
# reach `teardown complete` in the log; the self-test verifies that
# from OUTSIDE (or a reviewer greps the log by hand).
if [[ "${DOGFOOD_SELFTEST_TEARDOWN_WITH_DECOY:-0}" == "1" ]]; then
  # Some minimal state so cleanup has something to look at.
  STATE_DIR="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/revkit-dogfood-selftest-XXXXXX")"

  # Start a decoy whose argv matches the pgrep pattern in
  # daemons_rooted_at_state (`revkit\.js serve`) but whose cwd is NOT
  # STATE_DIR (pattern-match hits, cwd filter misses; the round-5
  # loop body's `[[ … ]] && printf` returns 1 on that iteration and
  # under `set -e` kills cleanup — that's the RED case). Two
  # subtleties matter here (round-7 nit from the reviewer):
  #
  #   1. nix coreutils `sleep` is a MULTI-CALL binary: it inspects
  #      argv[0] and dies with "unknown program 'bun'" the moment we
  #      rewrite it via `exec -a`. `/usr/bin/sleep` on this host is
  #      a standalone ELF (verified `file /usr/bin/sleep`), so the
  #      exec -a is safe. If `/usr/bin/sleep` isn't a standalone
  #      binary we bail before ever trusting the decoy — a self-test
  #      that starts nothing but claims success is worse than no
  #      test at all.
  #   2. `bash -c 'sleep 30'` gets optimised into an execve straight
  #      to `sleep`, so argv[0] rewrite via the outer bash's exec -a
  #      is lost. We use a compound command (`sleep 60 ; :`) to
  #      force bash to stay in the process image, so its argv
  #      (which exec -a rewrote) survives — visible in
  #      /proc/<pid>/cmdline.
  #
  # The self-test verifies BOTH (`kill -0` before proceeding, and a
  # /proc/cmdline sanity check).

  # Prefer /usr/bin/sleep if it is a proper standalone binary
  # (i.e. not a nix multi-call wrapper). We detect the multi-call
  # shape by running it with a bogus argv[0] and seeing whether it
  # emits "unknown program" — a real sleep just fails on the bad
  # duration argument.
  selftest_sleep_bin=""
  if [[ -x "/usr/bin/sleep" ]]; then
    if ! bash -c 'exec -a decoy_probe /usr/bin/sleep 0' 2>&1 | grep -qE "unknown program|multi-call"; then
      selftest_sleep_bin="/usr/bin/sleep"
    fi
  fi
  if [[ -z "${selftest_sleep_bin}" ]]; then
    log "SELFTEST-TEARDOWN: skipping — no standalone sleep binary usable with 'exec -a' (nix coreutils multi-call would die on the argv rewrite)."
    log "SELFTEST-TEARDOWN: on a NixOS host without /usr/bin/sleep, install coreutils-standalone or run on a Linux distro that ships it."
    exit 0
  fi

  # Start the decoy. The compound `; :` forces bash to stay in the
  # image (single-command mode would execve to sleep and lose
  # argv). Redirect stdio to /dev/null so a possible SIGPIPE on
  # our own log doesn't kick the decoy.
  bash -c "exec -a \"bun /nonexistent/packages/cli/bin/revkit.js serve --dir /nonexistent/dist\" bash -c \"${selftest_sleep_bin} 60 ; :\"" \
    >/dev/null 2>&1 &
  SELFTEST_DECOY_PID=$!
  disown "${SELFTEST_DECOY_PID}" 2>/dev/null || true
  sleep 0.5

  # Verify the decoy actually came up (round-7 nit: "verify the
  # decoy is alive before cleanup runs"). If exec-a failed, or the
  # sleep died on argv, we would silently pass an empty test.
  if ! kill -0 "${SELFTEST_DECOY_PID}" 2>/dev/null; then
    log "SELFTEST-TEARDOWN: decoy pid ${SELFTEST_DECOY_PID} died at startup — cannot run the regression test"
    SELFTEST_DECOY_PID=""
    exit 2
  fi
  # Confirm the decoy is visible with the intended cmdline shape.
  decoy_cmdline="$(tr '\0' ' ' < "/proc/${SELFTEST_DECOY_PID}/cmdline" 2>/dev/null || true)"
  if [[ "${decoy_cmdline}" != *"revkit.js serve"* ]]; then
    log "SELFTEST-TEARDOWN: decoy pid ${SELFTEST_DECOY_PID} did not preserve 'revkit.js serve' in cmdline (was: '${decoy_cmdline}')"
    kill -9 "${SELFTEST_DECOY_PID}" 2>/dev/null || true
    SELFTEST_DECOY_PID=""
    exit 2
  fi
  # Also confirm pgrep picks it up (the same tool the sweep uses).
  if ! pgrep -f 'revkit\.js serve' | grep -qxF "${SELFTEST_DECOY_PID}"; then
    log "SELFTEST-TEARDOWN: decoy pid ${SELFTEST_DECOY_PID} not visible via pgrep -f 'revkit\.js serve'"
    kill -9 "${SELFTEST_DECOY_PID}" 2>/dev/null || true
    SELFTEST_DECOY_PID=""
    exit 2
  fi

  log "SELFTEST-TEARDOWN: decoy alive (pid ${SELFTEST_DECOY_PID}, sleep=${selftest_sleep_bin}, cwd=${PWD}, matches pgrep 'revkit.js serve')"
  log "SELFTEST-TEARDOWN: triggering exit — the EXIT trap must run all of cleanup and reach 'teardown complete'"
  log "SELFTEST-TEARDOWN: on 6b90ac9 (round-5 shape of cleanup + daemons_rooted_at_state), 'teardown complete' will NOT appear"
  exit 0
fi

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

# Round-5 blocker: without `--setting-sources ""` + `--settings <file>`,
# the test agent inherits the OWNER's user / project / local settings
# — which means the owner's SessionStart / UserPromptSubmit hooks,
# statusLine command, env block, and plugins all run inside the test
# pane, AND the owner's global CLAUDE.md lands in the test agent's
# context. Hooks are shell commands that run regardless of --tools,
# and the settings `env` block is applied AFTER our /proc environ
# check, so the pre-launch lockdown claim was false without this.
#
# The isolated settings.json:
#   - no hooks (drops SessionStart / UserPromptSubmit / etc.)
#   - no statusLine (drops the owner's flk statusline)
#   - no env (blocks the settings env-injection path around /proc)
#   - no plugins
#   - `permissions.defaultMode: "dontAsk"` and an `allow` list of
#     ONLY the three revkit MCP tools (belt to the --allowedTools braces)
#   - `instructionFiles: "managed-only"` — the ONE claude-side flag
#     that stops the user's / project's CLAUDE.md from loading into
#     the session context (per the wrapper's own help text: "the
#     project's and your own instruction files are dropped; the
#     organization's managed CLAUDE.md and memory stay"). Verified
#     empirically per run — see require_no_owner_claudemd below.
cat > "${STATE_DIR}/settings.json" <<'EOF'
{
  "$note": "Isolated per-run settings for the revkit dogfood test session. Loaded via --settings; --setting-sources '' blocks user/project/local settings from also loading. See scripts/dogfood-channel.sh.",
  "hooks": {},
  "env": {},
  "instructionFiles": "managed-only",
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": [
      "mcp__revkit__threads",
      "mcp__revkit__reply",
      "mcp__revkit__resolve"
    ]
  }
}
EOF
STATE_SETTINGS="${STATE_DIR}/settings.json"
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
  # Round-5 blocker fix: block the owner's user/project/local
  # settings from loading (SessionStart/UserPromptSubmit hooks,
  # statusLine command, env block, plugins), then load OUR
  # per-run settings.json instead. Verified via /proc cmdline
  # (both flags on the required list below).
  --setting-sources ""
  --settings "${STATE_SETTINGS}"
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

  # Round-4 nit: close the pre-exec race. The `claude` wrapper is a
  # small C binary that setenv's a handful of variables, then execs
  # the actual `.claude-wrapped` binary. If we read /proc/<pid>/
  # cmdline / environ BEFORE the exec, we see the wrapper's state,
  # not the real claude's. Wait until /proc/<pid>/exe resolves to a
  # path ending in `.claude-wrapped` — that means the wrapper has
  # finished exec'ing and the process image we're inspecting is the
  # real one.
  local exe_deadline=$(( $(date +%s) + 30 ))
  local exe_link=""
  while (( $(date +%s) < exe_deadline )); do
    exe_link="$(readlink "/proc/${claude_pid}/exe" 2>/dev/null || true)"
    if [[ "${exe_link}" == *".claude-wrapped" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ "${exe_link}" != *".claude-wrapped" ]]; then
    log "verify_claude_lockdown: /proc/${claude_pid}/exe did not resolve to .claude-wrapped within 30 s (last: '${exe_link:-<unreadable>}')"
    die "lockdown verification failed"
  fi

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
    "--setting-sources"
    "--settings"
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

  # 5b. --setting-sources VALUE is exactly the empty string, so
  # no user / project / local settings load. `--restricted` also
  # sets it to `""` internally; we want the same effect without
  # needing --restricted's other consequences.
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--setting-sources" ]]; then
      if [[ -n "${cmd_arr[i+1]:-}" ]]; then
        log "LOCKDOWN-VERIFY: --setting-sources != '' (was: '${cmd_arr[i+1]:-<missing>}')"
        die "lockdown verification failed"
      fi
    fi
  done

  # 5c. --settings VALUE is our absolute path.
  for ((i=0; i<${#cmd_arr[@]}; i++)); do
    if [[ "${cmd_arr[i]}" == "--settings" ]]; then
      if [[ "${cmd_arr[i+1]:-}" != "${STATE_SETTINGS}" ]]; then
        log "LOCKDOWN-VERIFY: --settings value != ${STATE_SETTINGS} (was: '${cmd_arr[i+1]:-<missing>}')"
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

  # 7. /proc/<pid>/environ MUST contain ONLY names on our explicit
  #    allowlist. Round-4 change: this used to be a denylist ("no
  #    SSH_AUTH_SOCK, no GH_TOKEN, …") which shipped a false comfort —
  #    any name we DIDN'T think to ban was allowed through. A true
  #    allowlist means an unknown var is a hard fail, which is the
  #    correct default for a locked-down process.
  #
  #    The allowlist has two parts:
  #      A. The five names we set explicitly via `env -i`.
  #      B. The names the nix claude wrapper (a `makeCWrapper`
  #         C binary) deterministically setenv's before exec'ing
  #         `.claude-wrapped`: LD_LIBRARY_PATH (a /nix/store prefix)
  #         plus four boolean-ish flags. See `head -30` of
  #         /nix/store/…-claude-code-…/bin/claude for the wrapper's
  #         embedded makeCWrapper invocation.
  #
  #    Anything outside the union is a leak.
  local environ_file="/proc/${claude_pid}/environ"
  [[ -r "${environ_file}" ]] || die "verify_claude_lockdown: cannot read ${environ_file}"
  local env_pairs
  env_pairs="$(tr '\0' '\n' < "${environ_file}")"
  local env_names
  env_names="$(printf '%s\n' "${env_pairs}" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/' | sort -u | grep -v '^$' || true)"

  # ── set A: what we pass via `env -i` ──
  local allowed_ours=(
    PATH
    HOME
    CLAUDE_CONFIG_DIR
    TERM
    LANG
  )
  # ── set B: what the nix claude wrapper adds ──
  local allowed_wrapper=(
    LD_LIBRARY_PATH
    DISABLE_AUTOUPDATER
    FORCE_AUTOUPDATE_PLUGINS
    DISABLE_INSTALLATION_CHECKS
    USE_BUILTIN_RIPGREP
  )

  local name
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    local ok=0
    local a
    for a in "${allowed_ours[@]}" "${allowed_wrapper[@]}"; do
      if [[ "${name}" == "${a}" ]]; then
        ok=1
        break
      fi
    done
    if [[ ${ok} -eq 0 ]]; then
      log "LOCKDOWN-VERIFY: env var not on the allowlist: '${name}'"
      log "Allowlist (what we set via env -i): ${allowed_ours[*]}"
      log "Allowlist (what the nix claude wrapper adds): ${allowed_wrapper[*]}"
      die "lockdown verification failed"
    fi
  done <<<"${env_names}"

  # `LD_LIBRARY_PATH`, if present, must ONLY hold /nix/store entries.
  # The nix wrapper's makeCWrapper always prepends store paths; any
  # non-store entry means a host lib dir leaked in.
  local ld_line
  ld_line="$(printf '%s\n' "${env_pairs}" | grep -E '^LD_LIBRARY_PATH=' || true)"
  if [[ -n "${ld_line}" ]]; then
    local ld_value="${ld_line#LD_LIBRARY_PATH=}"
    local entry
    while IFS= read -r entry; do
      [[ -z "${entry}" ]] && continue
      if [[ "${entry}" != /nix/store/* ]]; then
        log "LOCKDOWN-VERIFY: LD_LIBRARY_PATH contains non-/nix/store entry: '${entry}'"
        die "lockdown verification failed"
      fi
    done < <(tr ':' '\n' <<<"${ld_value}")
  fi

  log "lockdown verified OK for claude pid ${claude_pid} (exe=${exe_link}): 8 required flags present with correct values, 4 forbidden flags absent, env is the explicit allowlist (5 ours + 5 wrapper-added)"
}

# In self-test mode we EXPECT verify_claude_lockdown to `die`. The
# `die` handler calls `exit 1` inside a trap, which the outer shell
# then observes. We wrap the verify call in a subshell so we can
# catch its non-zero exit and turn it into a distinct SELFTEST OK
# result (round-4 nit: a successful self-test used to exit 1, which
# was indistinguishable from a real failure).
if [[ "${DOGFOOD_SELFTEST_BAD_FLAGS:-0}" == "1" ]]; then
  # Run verify in a subshell that we can catch. Suppress its own log
  # noise by redirecting to a captured buffer we replay if things go
  # wrong.
  set +e
  ( verify_claude_lockdown )
  verify_rc=$?
  set -e
  if [[ ${verify_rc} -ne 0 ]]; then
    log "SELFTEST OK: lockdown check aborted as expected on the injected forbidden flag (verify exit code ${verify_rc})"
    exit 0
  fi
  die "SELFTEST FAIL: harness did not catch the injected forbidden flag — this is a real regression"
fi

# Not in self-test mode: verify BEFORE sending instructions.
verify_claude_lockdown

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
      # Try `flk pane send-keys Down` first (semantic key name).
      # If that doesn't move the cursor within ~2 s, fall back to
      # `flk pane send-text` with the raw ESC[B sequence — some
      # claude builds only respond to that shape. Both are equally
      # safe: we still verify the cursor moved BEFORE pressing Enter.
      flk pane send-keys "${pane_target}" Down >/dev/null 2>&1 || true
      target=""
      for _ in 1 2 3 4 5; do
        sleep 0.4
        screen="$(read_screen)"
        target="$(grep -E "^[[:space:]]*❯[[:space:]]+Yes,[[:space:]]I[[:space:]]trust[[:space:]]this[[:space:]]folder" <<<"${screen}" || true)"
        [[ -n "${target}" ]] && break
      done
      if [[ -z "${target}" ]]; then
        log "'Down' key did not move the cursor; trying raw ESC[B via send-text"
        flk pane send-text "${pane_target}" "$(printf '\x1b\x5b\x42')" >/dev/null 2>&1 || true
        for _ in 1 2 3 4 5; do
          sleep 0.4
          screen="$(read_screen)"
          target="$(grep -E "^[[:space:]]*❯[[:space:]]+Yes,[[:space:]]I[[:space:]]trust[[:space:]]this[[:space:]]folder" <<<"${screen}" || true)"
          [[ -n "${target}" ]] && break
        done
      fi
      if [[ -z "${target}" ]]; then
        log "SAFETY ABORT: workspace-trust cursor did NOT land on 'Yes, I trust this folder' after Down + ESC[B fallback + polls. Screen dump:"
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

# Instructions to the agent. Round-4 change: no coercive Bash step,
# no tool the agent should refuse, no crafted-injection shape. The
# harness's job is only to prove the loop plumbing works end-to-end;
# the lockdown itself is verified above via /proc inspection of the
# real claude process, not by any model behaviour. These instructions
# stay high-signal and short: WHAT to do (reply through the MCP
# channel), NOT how the runtime is configured.
INSTRUCTIONS="This is a disposable local test session for revkit's \
review loop. You are connected to a running revkit daemon via the \
\`revkit\` MCP server. Please wait for a channel notification from \
server:revkit — it may be a per-comment event OR a hand-over frame \
(the reviewer batches under the default handover mode; either shape \
signals there is a review thread to read). When it arrives: call \
\`threads\` to find the open thread whose comment body contains the \
token ${NONCE}; call \`reply\` on that thread with body \
\`ack ${NONCE}\` (use the last comment's id as parent_id); then call \
\`resolve\`. That's it. No file changes, no git, nothing else."

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

# The lockdown was proven pre-launch by `verify_claude_lockdown`
# against the real process image. There is no post-run "did the
# agent write the denial text" check any more — that check was
# forgeable through the reply body and it broke the loop whenever a
# well-aligned model correctly refused to follow embedded
# instructions from a channel comment (which is the behaviour
# ADR-0007 wants: channel content is untrusted).

# ── step 10: EMPIRICAL isolation checks ─────────────────────────────────
# Round-5 established the checks; round-6 tightened them per the reviewer:
#
#   - Statusline marker grep DROPPED. It was owner-specific (targeted
#     the reviewer's own statusLine template) and duplicated what
#     the /proc cmdline check already guarantees. The pre-launch
#     verification of `--setting-sources ""` + `--settings <ours>`
#     already proves that no settings-driven statusLine can fire.
#
#   - Hook-marker pane grep REPLACED with `flk`-authoritative evidence:
#     the test agent's `agent_session` field must stay null for the
#     whole run. flk sets `agent_session` when a claude session-start
#     hook reports its session id back through the flock socket; a
#     null value across `flk agent list` for our test agent means no
#     such hook fired. This is the exact signal the reviewer verified
#     manually — codifying it turns their observation into a per-run
#     assertion.
#
#   - CLAUDE.md fingerprint check now:
#     - HARD FAILS when the transcript dir is missing (a run that
#       posted a comment and got a reply MUST have a transcript;
#       missing dir means we cannot verify no leak, and "cannot
#       verify" fails closed);
#     - matches SEVERAL short, quote-free phrases from the owner's
#       CLAUDE.md instead of one long line (long lines often carry
#       apostrophes and dashes that trip grep, or match by accident
#       in unrelated prose).

# 10a. `agent_session` for our test agent must stay null.
require_agent_session_null() {
  local agent_json session
  agent_json="$(flk agent list 2>/dev/null | jq -c --arg n "${AGENT_NAME}" \
    '.result.agents[] | select(.name == $n)' 2>/dev/null || true)"
  if [[ -z "${agent_json}" ]]; then
    # Fallback: pane-id lookup (in case name matching lost the row).
    if [[ -n "${PANE_ID}" ]]; then
      agent_json="$(flk agent list 2>/dev/null | jq -c --arg p "${PANE_ID}" \
        '.result.agents[] | select(.pane_id == $p)' 2>/dev/null || true)"
    fi
  fi
  if [[ -z "${agent_json}" ]]; then
    log "ISOLATION FAIL: could not read the test agent's flk state; agent_session unknown, treating as fail"
    return 1
  fi
  session="$(printf '%s' "${agent_json}" | jq -r '.agent_session // "null"' 2>/dev/null || echo "null")"
  if [[ "${session}" != "null" ]]; then
    log "ISOLATION FAIL: flk agent_session is set for the test agent (value: ${session}) — a session-start hook fired, so owner hooks leaked"
    return 1
  fi
  log "isolation proof (hooks): flk agent_session is null for the test agent — no owner hook fired"
  return 0
}

# 10b. Owner's global CLAUDE.md must not be in the transcript.
#      Matches SEVERAL short, quote-free phrases from CLAUDE.md;
#      requires the transcript dir to exist (fail closed if missing).
require_no_owner_claudemd_in_transcript() {
  local owner_claudemd="${CLAUDE_CONFIG_DIR_VAL}/CLAUDE.md"
  if [[ ! -s "${owner_claudemd}" ]]; then
    log "isolation proof (CLAUDE.md): owner has no global CLAUDE.md at ${owner_claudemd} — nothing to leak"
    return 0
  fi
  # Extract UP TO 6 quote-free, ASCII-safe fingerprint phrases from
  # the owner's CLAUDE.md. We look at the first 60 chars of each
  # non-heading line that has at least 30 chars of grep-safe content
  # in that prefix — quote-free (no `'`, `"`, backtick, `\`, `/`, `=`,
  # `$`) so the fixed-string grep sees clean text and no shell
  # escapes trip over anything. Six independent short phrases beat
  # one long line: a single-line hit could be an accident of prose;
  # matching two or more from CLAUDE.md is a strong signal.
  local phrases=()
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    [[ "${line}" =~ ^\# ]] && continue          # skip Markdown headings
    # Trim leading list markers so the phrase starts on the content.
    local content="${line#[-*] }"
    content="${content#[[:space:]]*}"
    # Take first 60 characters as the candidate.
    local prefix="${content:0:60}"
    # Reject any prefix that contains a shell-escape-hostile character.
    if [[ "${prefix}" =~ [\'\"\`\\/=$\<\>] ]]; then continue; fi
    # Length of the safe prefix.
    (( ${#prefix} >= 30 )) || continue
    phrases+=("${prefix}")
    (( ${#phrases[@]} >= 6 )) && break
  done < "${owner_claudemd}"
  if (( ${#phrases[@]} == 0 )); then
    log "isolation proof (CLAUDE.md): could not extract any quote-free short phrases from ${owner_claudemd}; skipping transcript check"
    return 0
  fi
  local run_slug="${STATE_DIR//\//-}"
  local project_dir="${CLAUDE_CONFIG_DIR_VAL}/projects/${run_slug}"
  # Round-6 nit: FAIL closed if the transcript dir is missing. A run
  # that got as far as the isolation-check step must have written a
  # transcript; a missing dir means we cannot verify no leak.
  if [[ ! -d "${project_dir}" ]]; then
    log "ISOLATION FAIL: profile dir ${project_dir} does not exist post-run; cannot verify no owner-CLAUDE.md leak"
    return 1
  fi
  local matches
  matches="$(find "${project_dir}" -maxdepth 1 -type f -name '*.jsonl' 2>/dev/null | head -5 || true)"
  if [[ -z "${matches}" ]]; then
    log "ISOLATION FAIL: no *.jsonl transcript under ${project_dir}; cannot verify no owner-CLAUDE.md leak"
    return 1
  fi
  local phrase
  for phrase in "${phrases[@]}"; do
    local hits
    hits="$(grep -lF "${phrase}" "${project_dir}"/*.jsonl 2>/dev/null || true)"
    if [[ -n "${hits}" ]]; then
      log "ISOLATION FAIL: owner CLAUDE.md phrase '${phrase}' present in transcript file(s):"
      printf '%s\n' "${hits}" | log_block "transcript-hit" || true
      return 1
    fi
  done
  log "isolation proof (CLAUDE.md): ${#phrases[@]} distinct phrases from ${owner_claudemd} — none found in ${project_dir}/*.jsonl — good"
  return 0
}

isolation_bad=0
require_agent_session_null              || isolation_bad=1
require_no_owner_claudemd_in_transcript || isolation_bad=1
if [[ ${isolation_bad} -ne 0 ]]; then
  die "isolation proof failed — the test agent inherited some part of the owner's Claude profile despite --setting-sources '' + --settings <state>/settings.json"
fi

log "END-TO-END loop succeeded — nonce=${NONCE}"
exit 0
