# Architecture decision records

One file per decision, `NNNN-slug.md`, each carrying its own `- Status:` line (the source of truth). The table below
is **derived** from those files by `scripts/adr-index.sh` and checked by the guardrails `derived-docs` gate; the
`adr-matrix` gate requires every Accepted ADR to be cited in [`FEATURE-MATRIX.md`](../FEATURE-MATRIX.md).

<!-- guardrails:derived cmd="scripts/adr-index.sh" -->
| ADR | Decision | Status |
|---|---|---|
| [0001](0001-static-first-site-stack.md) | Static-first site stack: Astro, Starlight, Bun | **Accepted** |
| [0002](0002-solid-islands-component-registry.md) | Solid islands and a single component registry | **Accepted** |
| [0003](0003-content-model-mdx-typed-data.md) | Content model: MDX prose plus typed data files | **Accepted** |
| [0004](0004-plots-vega-lite-build-time-svg.md) | Plots: Vega-Lite spec plus side data, rendered to SVG at build | **Accepted** |
| [0005](0005-authoring-guards-revkit-check.md) | Authoring guards: `revkit check` with an escalation path | **Accepted** |
| [0006](0006-comments-anchoring-event-log.md) | Comments: dual anchors, revision re-anchoring, append-only log | **Accepted** |
| [0007](0007-agent-bridge-mcp-channel.md) | Agent bridge: MCP server as a channel, Monitor fallback, delivery modes | **Accepted** |
| [0008](0008-hosting-one-worker-per-org.md) | Hosting: one Cloudflare Worker per org, `revkit deploy` | **Accepted** |
| [0009](0009-auth-github-app-invite-links.md) | Auth: GitHub App user-to-server, invite links, Authentik later | **Accepted** |
| [0010](0010-distribution-flake-opt-in.md) | Distribution: revkit as an opt-in flake | **Accepted** |
| [0011](0011-mentions-typed-sigils.md) | Mentions and references: typed actors and sigils | **Accepted** |
| [0012](0012-hosted-security-threat-model.md) | Hosted security: threat model, CSP and isolation | **Accepted** |
| [0013](0013-local-daemon-security.md) | Local daemon security | **Accepted** |
| [0014](0014-secrets-public-repo.md) | Secrets and configuration in a public repository | **Accepted** |
| [0015](0015-data-retention-privacy.md) | Data retention and privacy | **Accepted** |
| [0016](0016-testing-strategy.md) | Testing strategy | **Accepted** |
| [0017](0017-accessibility.md) | Accessibility: WCAG 2.2 AA | **Accepted** |
| [0018](0018-browser-support.md) | Browser support | **Accepted** |
| [0019](0019-i18n.md) | UI languages: English v1, i18n-ready | **Accepted** |
| [0020](0020-observability.md) | Observability and logging | **Accepted** |
| [0021](0021-versioning-release.md) | Versioning and release | **Accepted** |
| [0022](0022-vendored-code-licenses.md) | Vendored code and licenses | **Accepted** |
| [0023](0023-co-editing-crdt.md) | Co-editing with a CRDT (deferred) | **Proposed** |
| [0024](0024-scope-docs-then-code.md) | Scope: docs first, code diffs in M8 | **Accepted** |
<!-- guardrails:derived:end -->
