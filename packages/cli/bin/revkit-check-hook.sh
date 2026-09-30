#!/usr/bin/env bash
# Pre-commit shim for `revkit check` (ADR-0005 M1 item 4).
#
# Opts in to `--online` when `gh auth status` succeeds, so the escape-
# hatch annotations are verified against GitHub during a local commit;
# falls back to offline with a visible warning when gh is not
# authenticated (a fresh clone before `gh auth login`, an offline
# machine, CI without a token). The CI workflow at
# `.github/workflows/revkit-guards.yml` runs `--online` unconditionally
# with GITHUB_TOKEN so the enforcement is not just local.

set -euo pipefail

# Redirect stderr AND stdout of the auth probe — an unauthenticated
# `gh auth status` writes to stderr, which would otherwise show up in
# the pre-commit log even on the happy path.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  exec bun packages/cli/bin/revkit.js check --online "$@"
fi

echo "revkit check: gh not authenticated; running offline (escape-hatch shape checks only)." >&2
echo "revkit check: run 'gh auth login' or push the PR to trigger the online workflow." >&2
exec bun packages/cli/bin/revkit.js check "$@"
