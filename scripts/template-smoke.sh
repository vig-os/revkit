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
grep -q "^  revkit skill install" "$smoke_dir/help.txt" || {
  echo "smoke: FAIL — --help did not advertise 'revkit skill install' (PR-56 blocker 3)" >&2
  exit 1
}

# --- Step 5: `revkit skill install` from a fresh cwd -----------------
#
# The scaffolded template does NOT ship the consumer skill on its
# own — a fresh docs repo shouldn't have a Claude-skill directory
# committed by default. Instead, the packaged CLI now writes the
# SKILL.md the human's `revkit skill install` command asks for.
# This step exercises that end-to-end: cwd is the scratch template
# tree, and after install the file must be present with the
# expected `name: revkit` frontmatter.
echo "smoke: revkit skill install"
cd "$smoke_dir"
"$REVKIT_BIN" skill install >"$smoke_dir/skill.txt"
cat "$smoke_dir/skill.txt" | sed 's/^/  /'
target="$smoke_dir/.claude/skills/revkit/SKILL.md"
if [ ! -f "$target" ]; then
  echo "smoke: FAIL — 'revkit skill install' did not write $target" >&2
  exit 1
fi
head -2 "$target" | grep -q "^name: revkit$" || {
  echo "smoke: FAIL — installed SKILL.md missing 'name: revkit' frontmatter" >&2
  exit 1
}
# A second install without --force must refuse (idempotent contract).
if "$REVKIT_BIN" skill install >/dev/null 2>"$smoke_dir/skill-refuse.txt"; then
  echo "smoke: FAIL — second 'revkit skill install' should have refused (no --force)" >&2
  exit 1
fi
grep -q "already exists" "$smoke_dir/skill-refuse.txt" || {
  echo "smoke: FAIL — refusal message missing 'already exists'" >&2
  exit 1
}
# --force replaces the file AND backs up the prior copy.
"$REVKIT_BIN" skill install --force >/dev/null
shopt -s nullglob
backups=("$smoke_dir"/.claude/skills/revkit/SKILL.md.backup-*)
shopt -u nullglob
if [ "${#backups[@]}" -eq 0 ]; then
  echo "smoke: FAIL — --force did not leave a SKILL.md.backup-<ts> file" >&2
  exit 1
fi

echo "smoke: OK — M5 part 1 surface + skill install verified"
echo "smoke: (revkit serve against a rendered .revkit/dist/ is M5 part 2 — not tested here, see DESIGN-0002 §5)"
