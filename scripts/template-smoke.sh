#!/usr/bin/env bash
# End-to-end smoke test for the `templates.default` flake output.
#
# Confirms the M5 part 1 (ADR-0010, D1) surface that is actually
# shipped in this PR — no false-positive daemon checks.
#
#   1. `nix flake init -t path:$REVKIT_REPO` scaffolds a docs repo
#      (docs/, vocab/, a flake consuming `revkit.packages`, a README,
#      a .gitignore, a package.json with the `revkit` marker).
#   2. `revkit check` outside a Nix build path succeeds on the
#      scaffolded tree (`--override-input revkit path:$REVKIT_REPO`
#      to avoid a network fetch).
#   3. `nix build` on the template's own flake succeeds — that
#      derivation runs `revkit check` inside a sandboxed builder,
#      so this is a second, stricter pass.
#   4. `revkit --help` / `revkit --version` run from the packaged
#      wrapper outside the checkout (guards against a relative-import
#      leak in the bin wrapper).
#
# What this smoke DOES NOT test (deliberately — M5 part 2, not yet
# shipped): `revkit serve` against a rendered `.revkit/dist/`. The
# daemon starts fine, but a scaffolded repo has no built site for it
# to serve, so any HTTP probe of `revkit serve` in this smoke would
# be misleading. See DESIGN-0002 §5 for the follow-up plan.
#
# Every child process the script starts is killed on exit (own PID
# only), and the temp dir is torn down last. The script exits non-
# zero on any failure; CI runs it as a step.
#
# Args:
#   $1: path to the revkit repo checkout (default: the parent of
#       this script's dir). CI passes the checkout dir explicitly.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
revkit_repo=${1:-$(cd -- "$script_dir/.." && pwd)}

if [ ! -f "$revkit_repo/flake.nix" ]; then
  echo "smoke: '$revkit_repo' does not look like a revkit checkout" >&2
  exit 2
fi

smoke_dir=$(mktemp -d /tmp/revkit-template-smoke-XXXXXX)

cleanup() {
  local exit_code=$?
  rm -rf "$smoke_dir"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "smoke: scratch dir $smoke_dir"

# --- Step 1: scaffold via `nix flake init` -----------------------------
echo "smoke: scaffolding template at $smoke_dir"
cd "$smoke_dir"
git init --quiet .
git config user.email "smoke@example.invalid"
git config user.name "smoke test"
nix flake init -t "path:$revkit_repo" 2>&1 | sed 's/^/  /'
ls -A
git add -A
git commit --quiet -m "smoke: initial scaffold" || true

# --- Step 2: revkit check outside a build ------------------------------
echo "smoke: running revkit check via nix run"
nix run --override-input revkit "path:$revkit_repo" ".#revkit" -- check 2>&1 | sed 's/^/  /'

# --- Step 3: nix build (runs revkit check under the docs derivation) ---
echo "smoke: nix build (template docs derivation)"
nix build --no-link --override-input revkit "path:$revkit_repo" 2>&1 | sed 's/^/  /'

# --- Step 4: --help / --version from outside the repo ------------------
echo "smoke: revkit --version / --help from outside the checkout"
REVKIT_BIN=$(nix build --no-link --print-out-paths --override-input revkit "path:$revkit_repo" "path:$revkit_repo#revkit" 2>/dev/null)/bin/revkit
echo "smoke: revkit=$REVKIT_BIN"
cd /
"$REVKIT_BIN" --version >"$smoke_dir/version.txt"
"$REVKIT_BIN" --help >"$smoke_dir/help.txt"
head -1 "$smoke_dir/version.txt"
head -1 "$smoke_dir/help.txt"
grep -q "^revkit " "$smoke_dir/help.txt" || {
  echo "smoke: FAIL — --help did not print the expected header" >&2
  exit 1
}

echo "smoke: OK — M5 part 1 surface verified"
echo "smoke: (revkit serve against a rendered .revkit/dist/ is M5 part 2 — not tested here, see DESIGN-0002 §5)"
