# Feature matrix

Every user story from [DESIGN-0001 §1](designs/DESIGN-0001-revkit-architecture.md#1-user-stories), the ADRs that
decide it, and where it is tracked. The guardrails `adr-matrix` gate fails a commit when an **Accepted** ADR is not
cited here; the ADR index lives in [`adr/README.md`](adr/README.md).

| ID | Story | ADRs | Milestone | Tracking | Status |
|---|---|---|---|---|---|
| A1 | Rich question pages instead of chat prompts, answer to agent < 1 s | ADR-0007, ADR-0002, ADR-0013, ADR-0017 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A2 | Inline comments on any block, persistent, structured to the agent | ADR-0002, ADR-0006, ADR-0013, ADR-0017 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A3 | Threads with the agent anchored on a block | ADR-0007, ADR-0011, ADR-0013, ADR-0017 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A4 | Agent publishes a report; page refreshes < 1 s without a full build | ADR-0001, ADR-0013 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A5 | Live delivery: mid-turn / while away; live, handover, quiet modes | ADR-0006, ADR-0007, ADR-0013 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A6 | Suggested edits on rendered text land in the source | ADR-0006 | M6 | [#11](https://github.com/vig-os/revkit/issues/11) | planned |
| A7 | Co-editing the source beside the rendered view (later) | ADR-0006, ADR-0023 (deferred) | M7 | [#12](https://github.com/vig-os/revkit/issues/12) | planned |
| A8 | Comments survive rebuilds; re-anchor, never lost (orphaned) | ADR-0006, ADR-0013 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| B0 | Review a PR locally with my own gh identity (no App, no Cloudflare) | ADR-0006, ADR-0009, ADR-0013, ADR-0025 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B1 | CI builds a preview and posts the link, pinging requested reviewers | ADR-0008, ADR-0012, ADR-0014, ADR-0025 | M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| B2 | Comments become PR review comments on file + line, as the reviewer | ADR-0003, ADR-0006, ADR-0009, ADR-0011, ADR-0012, ADR-0025 | M3 (local) / M4 (hosted) | [#8](https://github.com/vig-os/revkit/issues/8), [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| B3 | Submit the review (comment / approve / request changes) from the page | ADR-0009, ADR-0012, ADR-0025 | M3 (local) / M4 (hosted) | [#8](https://github.com/vig-os/revkit/issues/8), [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| B4 | Existing PR threads shown on the page, two-way | ADR-0006, ADR-0008, ADR-0009, ADR-0012, ADR-0025 | M3 (local) / M4 (hosted) | [#8](https://github.com/vig-os/revkit/issues/8), [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| B5 | Non-GitHub reviewers via personal invite links (Authentik later) | ADR-0008, ADR-0009, ADR-0011, ADR-0012, ADR-0014, ADR-0015, ADR-0025 | M4 | [#9](https://github.com/vig-os/revkit/issues/9), [#4](https://github.com/vig-os/revkit/issues/4) | planned |
| B6 | Agent picks up the review, fixes, replies, resolves | ADR-0003, ADR-0025 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B7 | Review code diffs with inline comments mapped to PR lines | ADR-0024, ADR-0006, ADR-0009, ADR-0025 | M8 | [#15](https://github.com/vig-os/revkit/issues/15) | planned |
| C1 | Registered components only; hand-rolled UI blocked; escalation | ADR-0002, ADR-0005, ADR-0022 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C2 | Vocabulary defined once; undefined terms and redefinitions flagged | ADR-0003, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C3 | Links and doc sets validated; no orphans | ADR-0001, ADR-0003, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C4 | Plots are spec + data side files, never inline | ADR-0004, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C5 | LaTeX math rendered at build, no client JS | ADR-0001 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C6 | Phone / tablet / desktop layouts, stock Starlight sidebar + prev/next (ADR-0001 amendment) | ADR-0001, ADR-0017, ADR-0018, ADR-0019 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| D1 | Any repo adopts revkit with one flake input + one line | ADR-0010, ADR-0021 | M5 | [#10](https://github.com/vig-os/revkit/issues/10) | planned |
| D2 | Per-org hosting with GitHub-org auth | ADR-0008, ADR-0014, ADR-0015, ADR-0020 | M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| E1 | Static by default, JS only where interaction needs it | ADR-0001, ADR-0002, ADR-0004 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |

## Cross-cutting qualities

| ID | Quality | ADRs | Milestone | Tracking | Status |
|---|---|---|---|---|---|
| Q1 | Tests in CI from M1: unit, e2e, visual regression, MCP contract | ADR-0016 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| Q2 | WCAG 2.2 AA with an axe gate | ADR-0017 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| Q3 | Evergreen browsers (last 2), incl. iOS/iPadOS Safari | ADR-0018 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| Q4 | English UI, i18n-ready | ADR-0019 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| Q5 | Local daemon hardening (loopback, token, origin checks) | ADR-0013 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| Q6 | Hosted threat model: CSP, CSRF, rate limits, fork isolation | ADR-0012 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| Q7 | Secrets layering for a public repo | ADR-0014 | M3/M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| Q8 | Retention and guest privacy | ADR-0015 | M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| Q9 | Structured logs without personal data | ADR-0020 | M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| Q10 | SemVer via the devkit train | ADR-0021 | M5 | [#10](https://github.com/vig-os/revkit/issues/10) | planned |
| Q11 | Vendored code keeps upstream licenses | ADR-0022 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
