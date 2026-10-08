#!/usr/bin/env bash
# Credentials live only in this call's process tree. Never enable tracing here.
set +x
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun --no-env-file "$script_dir/cf-environment.ts"
# Ambient credentials must never substitute for the selected credential file.
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 AWS_REGION
if [[ -n "${REVKIT_CF_SOPS:-}" ]]; then
  [[ -f "$REVKIT_CF_SOPS" ]] || { echo 'cf: missing REVKIT_CF_SOPS file' >&2; exit 1; }
  # exec-env takes a command string. Quote each argument, never interpolate credentials.
  cf_command="exec bun --no-env-file"
  for arg in "$script_dir/cf.ts" "$@"; do
    quoted_arg="${arg//\'/\'\\\'\'}"
    cf_command+=" '$quoted_arg'"
  done
  # exec-env infers its input format from the suffix and has no input-type
  # flag. Alias arbitrary encrypted dotenv paths (including .env.sops) as .env.
  sops_dir="$(mktemp -d)"
  trap 'rm -rf "$sops_dir"' EXIT
  sops_source="$REVKIT_CF_SOPS"
  [[ "$sops_source" == /* ]] || sops_source="$PWD/$sops_source"
  ln -s "$sops_source" "$sops_dir/credentials.env"
  set +e
  sops exec-env "$sops_dir/credentials.env" "$cf_command"
  exit $?
fi
env_file="${REVKIT_CF_ENV:-$HOME/.config/revkit/cf.env}"
[[ -f "$env_file" ]] || { echo 'cf: missing credentials; see docs/cloudflare-dev.md' >&2; exit 1; }
[[ "$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")" == 600 ]] || {
  echo 'cf: plaintext credentials must be mode 600' >&2; exit 1;
}
exec bun --no-env-file "$script_dir/cf-load-env.ts" "$env_file" "$@"
