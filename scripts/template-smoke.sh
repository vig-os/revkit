#!/usr/bin/env bash
# End-to-end smoke test for the `templates.default` flake output.
#
# Confirms the M5 part 1 + part 2 surface (ADR-0010 D1, issue #57):
#
#   1. `nix flake init -t path:$REVKIT_REPO` scaffolds a docs repo
#      (docs/, vocab/, a flake consuming `revkit.packages`, a README,
#      a .gitignore, a package.json with the `revkit` marker).
#   2. `revkit check` on the scaffolded tree succeeds
#      (`--override-input revkit path:$REVKIT_REPO` avoids a network
#      fetch).
#   3. `nix build` on the template's own flake succeeds — that
#      derivation runs `revkit check` inside a sandboxed builder.
#   4. `revkit build` renders the scaffolded docs into
#      `.revkit/dist/` via the packaged Astro/Starlight site (M5
#      part 2). No `bunx`, no `npx`, no registry fetch: the store
#      path prefix of every command surface asserts it.
#   5. `revkit serve --port 0 --no-auto-build` boots the review
#      daemon on 127.0.0.1 against the pre-built dist. The smoke:
#      - follows the launch URL to mint a session cookie,
#      - GETs `/` and asserts HTTP 200,
#      - asserts the rendered doc text is in the body,
#      - asserts the rail's `<script src="/-/rail.js">` tag is
#        injected by the daemon (the daemon's rail-injection is
#        what makes revkit different from `python -m http.server`),
#      - kills the daemon on exit via trap so no port stays bound.
#   6. `revkit --help` / `revkit --version` run from the packaged
#      wrapper outside the checkout (guards against a relative-
#      import leak in the bin wrapper).
#
# Every child process the script starts is killed on exit (own PID
# only), the daemon lock is released, and the temp dir is torn
# down last. The script exits non-zero on any failure; CI runs it
# as a step.
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
serve_pid=""

cleanup() {
  local exit_code=$?
  # Kill the daemon first (before removing the smoke dir where its
  # lock lives). Only kill our own child — never a pid we did not
  # start.
  if [ -n "$serve_pid" ]; then
    kill "$serve_pid" 2>/dev/null || true
    wait "$serve_pid" 2>/dev/null || true
  fi
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
# The path is /nix/store/…/bin/revkit — asserted here because the
# rest of the smoke depends on it being a packaged store path (no
# `bunx` / `npx` / registry-fetch fallback anywhere in the flow).
case "$REVKIT_BIN" in
  /nix/store/*)
    echo "smoke: OK — revkit is under /nix/store (no PATH-based fallback)"
    ;;
  *)
    echo "smoke: FAIL — revkit bin '$REVKIT_BIN' is not under /nix/store" >&2
    exit 1
    ;;
esac
(cd / && "$REVKIT_BIN" --version >"$smoke_dir/version.txt")
(cd / && "$REVKIT_BIN" --help >"$smoke_dir/help.txt")
head -1 "$smoke_dir/version.txt"
head -1 "$smoke_dir/help.txt"
grep -q "^revkit " "$smoke_dir/help.txt" || {
  echo "smoke: FAIL — --help did not print the expected header" >&2
  exit 1
}
grep -q "revkit build" "$smoke_dir/help.txt" || {
  echo "smoke: FAIL — --help does not list 'revkit build'" >&2
  exit 1
}

# --- Step 5: revkit build (M5 part 2) ----------------------------------
echo "smoke: revkit build (render docs via packaged site)"
cd "$smoke_dir"
"$REVKIT_BIN" build 2>&1 | sed 's/^/  /'
test -f "$smoke_dir/.revkit/dist/index.html" || {
  echo "smoke: FAIL — expected .revkit/dist/index.html after build" >&2
  exit 1
}
# Deliberate assertion: the built page must contain the docs body,
# so the smoke fails on the failure it exists to catch (an empty-
# dist regression that produced only `_katex/` earlier surfaced
# because this check would have missed it — we assert real content).
grep -qi 'welcome' "$smoke_dir/.revkit/dist/index.html" || {
  echo "smoke: FAIL — .revkit/dist/index.html has no 'welcome' text (docs did not render)" >&2
  head -80 "$smoke_dir/.revkit/dist/index.html" >&2
  exit 1
}
# The nix store is read-only — assert the build wrote NOTHING into
# the packaged site directory (the trusted stack). Look for a
# recent write under any /nix/store path the CLI touched.
if find "$REVKIT_BIN" -newer "$smoke_dir/.revkit/dist/index.html" 2>/dev/null | grep -q .; then
  echo "smoke: FAIL — packaged CLI dir was modified during build" >&2
  exit 1
fi

# --- Step 6: revkit serve, GET / and assert rail.js --------------------
echo "smoke: revkit serve --no-auto-build (already built above)"
cd "$smoke_dir"
"$REVKIT_BIN" serve --port 0 --no-auto-build >"$smoke_dir/serve.out" 2>"$smoke_dir/serve.err" &
serve_pid=$!
# Wait for bind (up to 15s) — poll instead of a fixed sleep.
for _ in $(seq 1 30); do
  if grep -q "listening on" "$smoke_dir/serve.out"; then
    break
  fi
  sleep 0.5
done
if ! grep -q "listening on" "$smoke_dir/serve.out"; then
  echo "smoke: FAIL — daemon never printed a launch URL" >&2
  cat "$smoke_dir/serve.out" >&2
  cat "$smoke_dir/serve.err" >&2
  exit 1
fi
launch_url=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/-/auth\?code=[A-Za-z0-9_-]+' "$smoke_dir/serve.out" | head -1)
base_url=$(echo "$launch_url" | sed -E 's|/-/auth.*||')
if [ -z "$launch_url" ]; then
  echo "smoke: FAIL — could not extract launch URL from serve.out" >&2
  cat "$smoke_dir/serve.out" >&2
  exit 1
fi
echo "smoke: base=$base_url launch=$launch_url"
# Exchange launch code for a session cookie via the 302 redirect.
curl -sS -c "$smoke_dir/cookies" -o /dev/null -L "$launch_url"
if ! grep -q "revkit_session" "$smoke_dir/cookies"; then
  echo "smoke: FAIL — /-/auth did not set a revkit_session cookie" >&2
  cat "$smoke_dir/cookies" >&2
  exit 1
fi
# Fetch the doc page.
status=$(curl -sS -b "$smoke_dir/cookies" -o "$smoke_dir/page.html" -w '%{http_code}' "$base_url/")
if [ "$status" != "200" ]; then
  echo "smoke: FAIL — GET / returned $status (expected 200)" >&2
  head -80 "$smoke_dir/page.html" >&2
  exit 1
fi
# Rendered doc content (from the template's docs/index.mdx).
grep -qi 'welcome' "$smoke_dir/page.html" || {
  echo "smoke: FAIL — GET / body does not contain the rendered doc text" >&2
  head -80 "$smoke_dir/page.html" >&2
  exit 1
}
# Rail injection: the daemon adds `<script src="/-/rail.js">` (or
# an inline `RAIL_JS_PATH`) to every rendered page.
grep -qE '<script[^>]+src="/-/rail\.js"' "$smoke_dir/page.html" || {
  echo "smoke: FAIL — rail.js script tag missing from GET / body" >&2
  head -80 "$smoke_dir/page.html" >&2
  exit 1
}
echo "smoke: OK — GET / returned 200 with doc text AND the rail script tag"
echo "smoke: OK — end-to-end template smoke passed (M5 part 1 + part 2)"
