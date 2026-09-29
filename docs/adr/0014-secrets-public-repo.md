# ADR-0014: Secrets and configuration in a public repository

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

revkit is public; deploys need Cloudflare and GitHub App credentials, and PRs (including forks) build previews.

## Decision

- **Deploy token** (Cloudflare: Workers Scripts, R2, D1 edit; DNS + Workers Routes edit on `exoma.org`; zone read) lives
  only in the GitHub **`production` environment** of vig-os/revkit, with all vig-os org owners as required reviewers.
- **Preview upload token** (R2 write on the previews bucket only) is an org secret declared **sops-encrypted in
  vig-os/org-config** (its ADR-0003), granted to revkit via an org-config PR.
- **GitHub App key, webhook secret, OAuth client secret, session and invite keys** exist only as **Worker secrets**
  (`wrangler secret put`), set by `revkit deploy init`; never in the repo or Actions.
- **Local development** uses `wrangler login` or a scoped token in `~/.config/revkit/` (mode 600), never in the repo.
- **No `pull_request_target`.** `pull_request` builds previews with **no secrets** and uploads the build as an
  artifact; a
  `workflow_run` job in the base-repo context publishes it with the upload token.
- Guards: secret scanning + push protection (org-config ADR-0008), `gitleaks` pre-commit (ADR-0005 acceptance), zizmor
  on workflows; `revkit deploy` never writes a secret to a tracked file.
- Cloudflare has no native OIDC federation for API tokens, so tokens are long-lived but scoped and expire (deploy 90 d,
  upload 180 d, App key 180 d); rotation is a human step.

## Consequences

Stories: B1, B5, D2. Blocks M3/M4.
