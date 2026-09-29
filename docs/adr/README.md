# Architecture decision records

One file per decision, `NNNN-slug.md`, each carrying its own `- Status:` line (the source of truth). The table below
is **derived** from those files by `scripts/adr-index.sh` and checked by the guardrails `derived-docs` gate; the
`adr-matrix` gate requires every Accepted ADR to be cited in [`FEATURE-MATRIX.md`](../FEATURE-MATRIX.md).

<!-- guardrails:derived cmd="scripts/adr-index.sh" -->
| ADR | Decision | Status |
|---|---|---|
| [0001](0001-static-first-site-stack.md) | Static-first site stack: Astro, Starlight, Bun | **Proposed** |
| [0002](0002-solid-islands-component-registry.md) | Solid islands and a single component registry | **Proposed** |
| [0003](0003-content-model-mdx-typed-data.md) | Content model: MDX prose plus typed data files | **Proposed** |
| [0004](0004-plots-vega-lite-build-time-svg.md) | Plots: Vega-Lite spec plus side data, rendered to SVG at build | **Proposed** |
| [0005](0005-authoring-guards-revkit-check.md) | Authoring guards: `revkit check` with an escalation path | **Proposed** |
| [0006](0006-comments-anchoring-event-log.md) | Comments: dual anchors, revision re-anchoring, append-only log | **Proposed** |
| [0007](0007-agent-bridge-mcp-channel.md) | Agent bridge: MCP server as a channel, Monitor fallback, delivery modes | **Proposed** |
| [0008](0008-hosting-one-worker-per-org.md) | Hosting: one Cloudflare Worker per org, `revkit deploy` | **Proposed** |
| [0009](0009-auth-github-app-invite-links.md) | Auth: GitHub App user-to-server, invite links, Authentik later | **Proposed** |
| [0010](0010-distribution-flake-opt-in.md) | Distribution: revkit as an opt-in flake | **Proposed** |
| [0011](0011-mentions-typed-sigils.md) | Mentions and references: typed actors and sigils | **Proposed** |
<!-- guardrails:derived:end -->
