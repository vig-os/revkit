# ADR-0011: Mentions and references: typed actors and sigils

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A3, B2, B5

## Context

`@` must reach GitHub users, invited guests, teams, roles and agents without accidental pings.

## Decision

`@` is only for actors: GitHub users, guests, teams, roles (`@author`, `@reviewers`, `@owners` from CODEOWNERS) and
agents (`@agent[:name]`, hosted `@claude`). Other sigils: `#` for issues/PRs/threads, `[[…]]` for terms/docs/sections.
Mentions are stored typed (`{kind, id}`) and rendered per surface; guests render as plain "Name (guest)" on GitHub;
guest autocomplete is limited to participants; an agent mention with none connected is queued, visibly.

## Consequences

Mentioning someone without access offers an invite (write access only).

## Acceptance (2026-09-29)

- CODEOWNERS is parsed at build time and cached with the site; `@owners` resolves against that snapshot.

## Amendment (2026-09-30)

- The M2 daemon (`revkit serve`, ADR-0013) accepts a human through the launch-code → session-cookie flow with **no
  hosted identity, no invite and no `gh` token yet** (the `gh` `TokenSource` arrives on the M3 local PR review
  surface, ADR-0025 surface a). Extend the actor kinds with `local`: the local loopback session's author. Its `id`
  is an opaque install-scoped tag (written by the CLI to `.revkit/local-user` at mode 600), so a display-name change
  or a machine move never invalidates old comments — the same durability guarantee the other kinds carry.
- On the M3 hosted mirror, a `local`-authored comment is posted under **the reviewer's own `gh` identity** through
  the ADR-0025 GitHub adapter (the daemon holds the `gh auth token` in memory, ADR-0013 / ADR-0014). The mirrored
  comment shows the reviewer's login on GitHub; the `local` kind is only how the local log records the actor for
  events that never leave loopback.
