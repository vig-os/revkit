#!/usr/bin/env bash
# Local-loop acceptance test (issue #202): exercise the consumer path
# from a scratch temp dir end-to-end.
#
# Flow:
#   1. `nix build .#revkit` and assert `--version` matches the version
#      stamped into packages/cli/package.json (ADR-0021).
#   2. Scaffold `templates.default` into a scratch dir and assert the
#      shipped `.mcp.json` is the one the audit asked for (B2 fixed in
#      #206).
#   3. `revkit check` on the scaffolded tree + `nix build` on its own
#      flake + run the `lib.hooks.mkHooks` entry.
#   4-9. Hand over to `scripts/local-loop-acceptance.py`, which owns the
#      MCP stdio + the browser leg. Every step fails hard with a prefixed
#      `FAIL:` line — no retries, no skipped assertions.
#
# The *server* environment the Python driver hands to `revkit mcp` has
# NO `bun` on its PATH. The harness's own bun + Playwright never reach
# the server env: the Python process controls what gets passed to
# subprocess.Popen, and the driver asserts `/proc/<daemon pid>/environ`
# does not resolve a bun anywhere.
#
# Arguments: $1 is the revkit checkout (default: the repo this script
# lives in). CI passes the checkout dir explicitly, matching the shape
# `scripts/template-smoke.sh` uses.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
revkit_repo=${1:-$(cd -- "$script_dir/.." && pwd)}

if [ ! -f "$revkit_repo/flake.nix" ]; then
  echo "accept: '$revkit_repo' does not look like a revkit checkout" >&2
  exit 2
fi

# TMPDIR lives INSIDE the worktree (per brief): scratch stays under the
# worktree so cleanup is deterministic and the host-shared /tmp (RAM) is
# never touched.
export TMPDIR=${TMPDIR:-"$revkit_repo/.revkit/tmp/local-loop-acceptance"}
mkdir -p "$TMPDIR"
scratch_dir=$(mktemp -d "$TMPDIR/accept-XXXXXX")

# `revkit mcp` auto-starts a detached daemon with Bun.spawn; if the test
# fails before step 8's SIGTERM, `trap cleanup EXIT` is the fallback.
# We only touch PIDs whose serve.json we observed in THIS run.
cleanup() {
  local exit_code=$?
  if [ -n "${consumer_dir:-}" ] && [ -f "$consumer_dir/.revkit/serve.json" ]; then
    local pid
    pid=$(python3 -c "import json,sys; print(json.load(open('$consumer_dir/.revkit/serve.json')).get('pid',''))" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Give the daemon a moment to release its lock before we drop
      # the scratch dir underneath it.
      for _ in $(seq 1 40); do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  if [ "${REVKIT_ACCEPT_KEEP_SCRATCH:-0}" != "1" ]; then
    rm -rf "$scratch_dir"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "accept: scratch dir $scratch_dir"
echo "accept: revkit repo $revkit_repo"

# ---------------------------------------------------------- step 1: build ----
echo "accept: building .#revkit (nix build)"
revkit_store=$(nix build "$revkit_repo#revkit" --no-link --print-out-paths)
case "$revkit_store" in
  /nix/store/*) ;;
  *)
    echo "FAIL: step 1: nix build did not print a /nix/store path, got '$revkit_store'" >&2
    exit 1
    ;;
esac
revkit_bin="$revkit_store/bin/revkit"
if [ ! -x "$revkit_bin" ]; then
  echo "FAIL: step 1: '$revkit_bin' is not executable" >&2
  exit 1
fi
expected_version=$(python3 -c "import json; print(json.load(open('$revkit_repo/packages/cli/package.json'))['version'])")
echo "accept: expected version from packages/cli/package.json = $expected_version"

# ---------------------------------------------------- step 2: scaffold ----
consumer_dir="$scratch_dir/consumer"
mkdir -p "$consumer_dir"
cd "$consumer_dir"
git init --quiet .
git config user.email "accept@example.invalid"
git config user.name "accept"
nix flake init -t "path:$revkit_repo" 2>&1 | sed 's/^/  /'
git add -A
git commit --quiet -m "accept: initial scaffold" || true

# `--override-input` reaches the revkit CLI through the consumer flake
# so we exercise the same discovery path a real consumer does.
override_flag=(--override-input revkit "path:$revkit_repo")

# ------------------------------------------------ step 3: check + hooks ----
echo "accept: step 3 — revkit check (through nix run) + consumer nix build"
# `revkit check` through the just-built packaged binary (no network, no
# dev-shell needed). `--override-input` only applies to flakes that
# declare a `revkit` input, so we skip it here — this invocation runs
# the flake we just built.
"$revkit_bin" check 2>&1 | sed 's/^/  /'
nix build --no-link "${override_flag[@]}" 2>&1 | sed 's/^/  /'

# Evaluate the `lib.hooks.mkHooks` entry and assert it is the packaged
# binary we just built. A consumer wiring `revkit.lib.hooks` into its
# devkit `hooks` block gets exactly this entry string.
echo "accept: step 3 — evaluating lib.hooks.mkHooks{...}.revkit-check.entry"
# shellcheck disable=SC2016  # Nix expression is a single-quoted string
# argument to `nix eval`; `revkit_repo` is interpolated by breaking out
# of the single quotes deliberately, same pattern as scripts/template-smoke.sh.
hook_expr='
  let
    revkit = builtins.getFlake "path:__REPO__";
    system = builtins.currentSystem;
    revkitPkg = revkit.packages.${system}.revkit;
  in
    (revkit.lib.hooks.mkHooks { revkit = revkitPkg; }).revkit-check.entry
'
hook_entry=$(nix eval --raw --impure --expr "${hook_expr//__REPO__/$revkit_repo}")
# The entry is `${revkit}/bin/revkit check`. We don't pin it to
# `$revkit_store` — a second `nix eval` over a dirty tree can land in a
# different store path than the preceding `nix build`, and `lib.hooks`
# goes through an eval, not a build. The assertion that matters is
# shape + runnability, not hash equality.
case "$hook_entry" in
  /nix/store/*-revkit-*/bin/revkit\ check) ;;
  *)
    echo "FAIL: step 3: lib.hooks entry does not look like '/nix/store/*-revkit-*/bin/revkit check': '$hook_entry'" >&2
    exit 1
    ;;
esac
# Run it — the hook's own entry must succeed on the scaffolded tree the
# same way `revkit check` did above (pre-commit calls the entry with no
# filenames since `pass_filenames = false`).
(cd "$consumer_dir" && bash -c "$hook_entry") 2>&1 | sed 's/^/  /'

# Hand over to the Python driver for steps 4-9. The driver controls
# what env the MCP + daemon see; the shell's PATH (which has bun from
# the dev shell) is scrubbed off before the spawn.
echo "accept: handing over to scripts/local-loop-acceptance.py for steps 4-9"
python3 "$script_dir/local-loop-acceptance.py" \
  --revkit-bin "$revkit_bin" \
  --revkit-repo "$revkit_repo" \
  --consumer-dir "$consumer_dir" \
  --expected-version "$expected_version" \
  --scratch-dir "$scratch_dir"

echo "accept: all steps passed"
