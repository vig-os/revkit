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
