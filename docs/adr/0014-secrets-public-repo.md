# ADR-0014: Secrets and configuration in a public repository

- Status: Accepted
- Date: 2026-09-29
- Stories: B1, B5, D2
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

revkit is public; deploys need Cloudflare and GitHub App credentials, and PRs (including forks) build previews.

## Decision

- **Deploy token** (Cloudflare: Workers Scripts, R2, D1 edit; DNS + Workers Routes edit on `exoma.org`; zone read)
  lives only in the GitHub **`production` environment** of vig-os/revkit, with all vig-os org owners as required
  reviewers.
- **Preview upload token** (R2 write on the previews bucket only) is an org secret declared **sops-encrypted in
  vig-os/org-config** (its ADR-0003), granted to revkit via an org-config PR.
- **GitHub App key, webhook secret, OAuth client secret, session and invite keys** exist only as **Worker secrets**
  (`wrangler secret put`), set by `revkit deploy init`; never in the repo or Actions.
- **Local development** uses `wrangler login` or a scoped token in `~/.config/revkit/` (mode 600), never in the repo.
- **No `pull_request_target`.** `pull_request` builds previews with **no secrets** and uploads the build as an
  artifact; a `workflow_run` job in the base-repo context publishes it with the upload token. That publisher treats
  the artifact as **untrusted data**: it never executes or sources anything from it; it takes the PR number from the
  API by `head_sha` (not from the artifact; `workflow_run.pull_requests` is empty for forks); it builds every R2 key
  itself under `<repo>/pr-<n>/`, rejecting `..`, absolute paths, symlinks and non-allowlisted file types (ADR-0012);
  and for **fork PRs it runs only after a maintainer approves** the `preview-fork` environment.
- The deploy token needs **DNS edit** only while `revkit deploy init` creates the custom domain; routine deploys use a
  narrower token without it (rotate after init).
- Guards: secret scanning + push protection (org-config ADR-0008), `gitleaks` pre-commit (ADR-0005 acceptance), zizmor
  on workflows; `revkit deploy` never writes a secret to a tracked file.
- Cloudflare has no native OIDC federation for API tokens, so tokens are long-lived but scoped and expire (deploy 90
  d, upload 180 d, App key 180 d); rotation is a human step.

## Consequences

Blocks M3/M4.

## Amendment — 2026-10-08: local credentials and the development account (#160)

Local Cloudflare tooling now prefers an encrypted dotenv selected by `REVKIT_CF_SOPS`, decrypted separately for
each invocation through `sops exec-env`. If that variable is unset, `just cf` loads
`REVKIT_CF_ENV` or `~/.config/revkit/cf.env`, requiring mode 600. Credentials exist only in the command's process
tree, never in the parent dev shell or a tracked file. A configured encrypted file that is missing or cannot
decrypt fails closed; it does not fall back to plaintext. `scripts/cf-credentials.sh` prompts silently, preserves
values on Enter, writes a private backup, and can produce an age-encrypted dotenv copy. Cloudflare and R2 S3
credentials use `CLOUDFLARE_*` and standard `AWS_*` names. Recipe output redacts credential values and generated
Worker secrets; Wrangler's persistent debug logs go to `/dev/null`.

Account `1ecb6c28f07ad10630be568fcf73a347` is the owner's separate **development account**. Workers Scripts and D1
token permissions cover an entire account, so the account is the blast-radius boundary. The dev recipes pin that
account and the names `revkit-review-dev` (Worker and D1) and `revkit-previews-dev` (R2), validating the credential
account and the non-secret identifiers in `~/.config/revkit/dev.json` before acting. Generated
`packages/worker/wrangler.dev.jsonc` inherits every tracked setting except those identifiers; generation requires
`workers_dev: false`, no routes and empty compatibility flags. The generated file and `.wrangler/` state are ignored.

With explicit owner authorization, agents may use `just cf-dev` to inspect the dev resources, initialize absent
resources, apply pending migrations and deploy the current tree to the dev Worker. Existing resource ids are
preserved; init refuses to recreate a recorded resource that is missing remotely. Existing `INVITE_TOKEN_HMAC_KEY`
is kept by default: `wrangler secret put` **overwrites** a secret, so rotation requires an explicit `--rotate`.
New values come from a CSPRNG and reach Wrangler only on stdin; they are never stored locally. A missing Worker is
deployed with the generated security settings before adding its secret. Init never probes a public endpoint.

Agents must not inspect or copy credential values, run `wrangler login`, create/rotate/delete API tokens, touch
DNS/zones or another account, or flip `workers_dev`/routes. The dev Worker has no public URL; enabling one remains
an owner decision under ADR-0012. Production credentials, owner approvals, the GitHub `production` environment and
the production deployment process above are unchanged. This tooling provisions the current Worker's HMAC secret;
it does not implement the owner-gated GitHub App and production deployment train (#34).

The operator workflow and overrides are documented in [Cloudflare development tooling](../cloudflare-dev.md).

## Amendment — 2026-10-08: dev tooling input and confirmation hardening (#160)

The dev wrapper uses a per-command allowlist for commands, resource arguments and flags, with its generated config
placed before user arguments. Unknown commands/flags, aliases, a bare `--` and security-setting overrides are
refused. File arguments resolve from the repository root. The operator documentation enumerates the supported
workflow; destructive operations remain outside its dev allowlist.

Both `cf` and `cf-dev` require an explicit `--yes-really` plus an independent TTY confirmation before any destructive
verb can reach Wrangler. Piped Wrangler output otherwise causes its own prompts to auto-confirm. Ordinary calls
receive closed stdin; generated secrets are supplied explicitly. These changes do not grant agents permission to
delete resources or change the owner's reachability settings.

Local credential files are parsed as data by a shared dotenv parser, never sourced as shell code. Malformed input
reports only a line number and key, with no value fragments. The credential helper preserves unrelated entries
and keeps the newest five mode-600 backups named `cf.env.bak.<UTC timestamp>.<unique suffix>`. The encrypted copy
uses the same parsed values. Production and the account boundary remain unchanged.

The restore guard recognizes both command words even when Wrangler flags intervene between them.


## Amendment — 2026-10-08: Wrangler environment and mutation boundary (#176)

Wrangler now receives an explicit environment allowlist: basic path/locale/temp/color settings, credentials from
the selected credential file and pinned telemetry/logging settings. Caller transport and target overrides
(`WRANGLER_*`, unapproved `CLOUDFLARE_*` and case-insensitive `*_PROXY`) are refused by name without values;
other inherited variables are dropped. Ambient credentials are cleared before loading the selected file.
Wrangler 4.93's explicit `--env-file` list is pinned to a private empty file, disabling default dotenv and dev-vars
discovery. The Bun wrapper also disables automatic dotenv loading. All dev recipes refuse worker `.env*` and
`.dev.vars*` entries; the repository ignores them.

The confirmation gate allows only reviewed read-only or idempotent-create commands; all other verbs, including
unknown future commands and deploy/SQL/migration/object writes, require `--yes-really` and TTY confirmation.
The dev command allowlist runs before confirmation. `cf-dev-deploy` forwards explicit confirmation or dry-run
arguments. Init's fixed provisioning sequence and explicit secret-rotation authorization are unchanged.
A pseudo-terminal with piped confirmation cannot be distinguished from human input; this gate prevents accidents
and does not establish human identity or grant automation permission.

Both wrappers confine `--file` to the repository and exclude the local credential directory after symlink
resolution, including for new output files. Ambiguous repeated flags are refused. Credential backup retention
matches only the generated timestamp/suffix pattern, migrating the legacy backup once and preserving unrelated
user files. `NO_COLOR` follows the caller's setting. These changes preserve the existing account, reachability
and production boundaries.
