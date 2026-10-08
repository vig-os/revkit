#!/usr/bin/env bash
# Silent local credential setup. Run manually in a TTY; never give secrets as arguments.
set +x
set -euo pipefail
umask 077
ENV_FILE="${REVKIT_CF_ENV:-$HOME/.config/revkit/cf.env}"
AGE_RECIPIENT="${REVKIT_CF_AGE_RECIPIENT:-age17ueacw8hpda37r0j3ed8sh7z0k7rcrjuztc22krk7eth030t5u8q0jfm87}"
ACCOUNT="" SOPS_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sops) [[ $# -ge 2 ]] || { echo 'cf-credentials: --sops requires a path' >&2; exit 2; }; SOPS_OUT="$2"; shift 2 ;;
    -h|--help) echo 'Usage: scripts/cf-credentials.sh [account-id] [--sops encrypted.env.sops]'; exit 0 ;;
    --*) echo 'cf-credentials: unknown option' >&2; exit 2 ;;
    *) [[ -z "$ACCOUNT" ]] || { echo 'cf-credentials: only one account ID is accepted' >&2; exit 2; }; ACCOUNT="$1"; shift ;;
  esac
done
[[ -t 0 ]] || { echo 'cf-credentials: run this in an interactive terminal' >&2; exit 2; }
[[ -n "$ACCOUNT" ]] || read -rp 'Cloudflare account ID: ' ACCOUNT
[[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo 'cf-credentials: account ID must be 32 hex chars' >&2; exit 2; }
secret() {
  local value
  read -rsp "$2 (Enter = keep current): " value; echo >&2
  printf -v "$1" '%s' "$value"
}
secret TOKEN 'Cloudflare API token'
secret R2_KEY 'R2 S3 Access Key ID'
secret R2_SEC 'R2 S3 Secret Access Key'
CF_ENV_FILE="$ENV_FILE" CF_ACCOUNT="$ACCOUNT" CF_TOKEN="$TOKEN" CF_R2_KEY="$R2_KEY" CF_R2_SEC="$R2_SEC" \
  bun "$(dirname "${BASH_SOURCE[0]}")/cf-credentials-write.ts"
unset TOKEN R2_KEY R2_SEC
if [[ -n "$SOPS_OUT" ]]; then
  mkdir -p "$(dirname "$SOPS_OUT")"
  sops_tmp="$(mktemp "${SOPS_OUT}.XXXXXX")"
  trap 'rm -f "$sops_tmp"' EXIT
  # The fallback file is shell-quoted; SOPS dotenv values are literal strings.
  # Load the quoted file and encrypt canonical dotenv values privately on stdin.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  CF_ENV_FILE="$ENV_FILE" CF_AGE_RECIPIENT="$AGE_RECIPIENT" \
    bun "$(dirname "${BASH_SOURCE[0]}")/cf-credentials-write.ts" encrypt > "$sops_tmp"
  mv "$sops_tmp" "$SOPS_OUT"
  echo 'cf-credentials: wrote encrypted dotenv copy'
fi
echo 'cf-credentials: verify with nix develop -c just cf whoami (see docs/cloudflare-dev.md)'
