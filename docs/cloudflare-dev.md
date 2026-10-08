# Cloudflare development tooling

Run these commands from the repository's Nix shell. The separate development account is
`1ecb6c28f07ad10630be568fcf73a347`; the Worker and D1 are `revkit-review-dev`, and the R2 bucket is
`revkit-previews-dev`. The Worker inherits `workers_dev: false`, no routes and empty compatibility flags from the
tracked config. It has no public URL. Production remains owner-gated (#34; [ADR-0014](adr/0014-secrets-public-repo.md)).

## Local credentials

An operator sets credentials in their own interactive terminal:

```sh
nix develop -c scripts/cf-credentials.sh 1ecb6c28f07ad10630be568fcf73a347 \
 --sops "$HOME/.config/revkit/cf.env.sops"
export REVKIT_CF_SOPS="$HOME/.config/revkit/cf.env.sops"
nix develop -c just cf whoami
```

The helper asks silently for the Cloudflare API token, R2 S3 Access Key ID and R2 S3 Secret Access Key. Enter keeps
an existing value. It writes `~/.config/revkit/cf.env` and its backup with mode 600, preserving unrelated lines.
R2 values use `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` (derived from the account) and
`AWS_REGION=auto`. No secret belongs in a command argument or this repository.

`--sops` writes an encrypted dotenv copy using the owner's age recipient. Another operator can select their own
public recipient with `REVKIT_CF_AGE_RECIPIENT`; configure SOPS's age identity locally for decryption. `just cf`
prefers `REVKIT_CF_SOPS` and decrypts it per call with `sops exec-env`. If unset, it uses `REVKIT_CF_ENV` or
`~/.config/revkit/cf.env` and requires mode 600. A configured SOPS file that cannot decrypt fails without fallback.
Both wrappers redact credential values from output and discard Wrangler's persistent debug logs. Credentials
stay in each invocation's process tree, never in the parent shell.

## Initialize, deploy and inspect

```sh
nix develop -c just cf-dev-init
nix develop -c just cf-dev-deploy
nix develop -c just cf-dev d1 migrations list revkit-review-dev --remote
```

Init discovers the existing D1 and R2 by name, creating them only if absent and not already recorded locally.
It writes non-secret identifiers to `~/.config/revkit/dev.json` when missing. On an existing setup it preserves
that file and ids, applies only pending migrations and skips an existing `INVITE_TOKEN_HMAC_KEY`. An absent
recorded resource or mismatched remote D1 id fails instead of recreating or replacing it. If the Worker is absent,
init deploys the current tree with the generated security settings before putting its secret.

`wrangler secret put` overwrites an existing secret. Only an explicitly requested rotation should run:

```sh
nix develop -c just cf-dev-init --rotate
```

The HMAC key is 32 random bytes encoded as hex, piped to Wrangler on stdin, never printed or stored locally.
Rotation invalidates outstanding invites signed with the old key. Re-running init without `--rotate` keeps it.

`cf-dev` regenerates `packages/worker/wrangler.dev.jsonc` before each call using the tracked config and `dev.json`.
It fails clearly if state is missing, validates the account/resource names and inherited security settings, and
rejects Wrangler target overrides such as `--config`, `--env`, `--name` and `--cwd`. Use
`REVKIT_CF_DEV_CONFIG` to select an alternate local state path with the same authorized identifiers.
`cf-dev-deploy` deploys the current worktree through that config. Local Wrangler state and the generated config
are gitignored. For remote platform testing, an authorized operator may run `just cf-dev dev --remote`; the
production environment and any public dev URL remain separate owner decisions.
