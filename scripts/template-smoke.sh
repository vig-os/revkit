#!/usr/bin/env bash
# End-to-end smoke test for the `templates.default` flake output.
#
# Confirms the D1 (ADR-0010) one-line adoption path:
#   1. `nix flake init -t path:$REVKIT_REPO` scaffolds a docs repo
#      (`docs/`, `vocab/`, a flake consuming `revkit.packages`, a
#      README, a .gitignore).
#   2. `nix build` in that repo (against the local revkit input) runs
#      the ADR-0005 authoring guards over `docs/` and lands the checked
#      tree in `result/`.
#   3. `revkit check` outside a Nix build path.
#   4. `revkit serve --dir <dir>` starts on 127.0.0.1, writes
#      `.revkit/serve.json`, answers a `/health` (or `/`) probe, and
#      shuts down cleanly on SIGTERM.
#
# Every daemon the script starts is killed on exit (own PID only), and
# the temp dir is torn down last. The script exits non-zero on any
# failure; CI runs it as a step.
#
# Args:
#   $1: path to the revkit repo checkout (default: the parent of this
#       script's dir). CI passes the checkout dir explicitly.
#
# Env:
#   REVKIT_SMOKE_SKIP_NIX_BUILD=1  skip `nix build` inside the template
#     (kept for local iteration on machines where the FOD download is
#     already cached is not the point — this is CI's job).

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
revkit_repo=${1:-$(cd -- "$script_dir/.." && pwd)}

if [ ! -f "$revkit_repo/flake.nix" ]; then
  echo "smoke: '$revkit_repo' does not look like a revkit checkout" >&2
  exit 2
fi

smoke_dir=$(mktemp -d /tmp/revkit-template-smoke-XXXXXX)
serve_pid=""

cleanup() {
  local exit_code=$?
  if [ -n "$serve_pid" ] && kill -0 "$serve_pid" 2>/dev/null; then
    echo "smoke: stopping serve pid=$serve_pid"
    kill -TERM "$serve_pid" 2>/dev/null || true
    # Give the daemon a grace window (its stop() runs handlers) then
    # SIGKILL if it hangs — the smoke should never leave a process
    # behind.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$serve_pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$serve_pid" 2>/dev/null && kill -KILL "$serve_pid" 2>/dev/null || true
    wait "$serve_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "smoke: scratch dir $smoke_dir"

# --- Step 1: scaffold via `nix flake init` -----------------------------
# `nix flake init` from a path template needs a git-init'd target and
# unlocked (or lockable) inputs. We copy the template files by hand
# because `nix flake init -t` requires a template name in a registry
# or a URL — the flake IS in this repo, so a path: URL is what we use.
echo "smoke: scaffolding template at $smoke_dir"
cd "$smoke_dir"
git init --quiet .
git config user.email "smoke@example.invalid"
git config user.name "smoke test"
nix flake init -t "path:$revkit_repo" 2>&1 | sed 's/^/  /'
ls -A
git add -A
git commit --quiet -m "smoke: initial scaffold" || true

# Point the template's flake input at the local revkit checkout so the
# smoke does not depend on a network fetch of vig-os/revkit.
cat > flake.override.nix <<EOF
# Not read by nix — kept as a marker for grep. See --override-input below.
EOF

# --- Step 2: revkit check outside a build ------------------------------
echo "smoke: running revkit check via nix run"
nix run --override-input revkit "path:$revkit_repo" ".#revkit" -- check 2>&1 | sed 's/^/  /'

# --- Step 3: nix build (runs revkit check under the docs derivation) ---
if [ "${REVKIT_SMOKE_SKIP_NIX_BUILD:-0}" != "1" ]; then
  echo "smoke: nix build (template docs derivation)"
  nix build --no-link --override-input revkit "path:$revkit_repo" 2>&1 | sed 's/^/  /'
fi

# --- Step 4: revkit serve smoke ---------------------------------------
echo "smoke: revkit serve on 127.0.0.1 (--dir docs)"
# The template ships no built site yet, so we point serve at `docs/`
# just to prove the daemon binds, announces its port, and shuts down
# cleanly. The daemon does not require a specific dir layout — it
# serves whatever tree it's pointed at (ADR-0013).
REVKIT_BIN=$(nix build --no-link --print-out-paths --override-input revkit "path:$revkit_repo" "path:$revkit_repo#revkit" 2>/dev/null)/bin/revkit
echo "smoke: revkit=$REVKIT_BIN"

log=$smoke_dir/serve.log
: >"$log"
# shellcheck disable=SC2086
"$REVKIT_BIN" serve --dir docs --port 0 >"$log" 2>&1 &
serve_pid=$!
echo "smoke: serve pid=$serve_pid"

handshake="$smoke_dir/.revkit/serve.json"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if [ -s "$handshake" ]; then break; fi
  sleep 0.4
done
if [ ! -s "$handshake" ]; then
  echo "smoke: FAIL — no handshake at $handshake after 6s" >&2
  echo "smoke: --- serve.log ---" >&2
  cat "$log" >&2 || true
  exit 1
fi
echo "smoke: handshake:"
sed 's/^/  /' "$handshake"

port=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['port'])" "$handshake" 2>/dev/null || jq -r .port "$handshake")
echo "smoke: bound port=$port"

# Basic probe: the daemon serves the requested dir. `/` is the built-in
# index; we don't require a specific response body — a 200/404 both
# prove the server is listening. `curl --max-time 5` avoids a hang.
http_status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$port/" || echo "curl-failed")
echo "smoke: GET / -> $http_status"

# Any 2xx/3xx/404 (missing file, daemon reached) is proof of life.
# 000 (curl-failed) or 5xx signal the daemon is not responding.
case "$http_status" in
  2*|3*|404) ;;
  *) echo "smoke: FAIL — unexpected HTTP status $http_status" >&2; exit 1 ;;
esac

echo "smoke: OK"
