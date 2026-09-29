# Feature matrix

Every user story from [DESIGN-0001 §1](designs/DESIGN-0001-revkit-architecture.md#1-user-stories), the ADRs that
decide it, and where it is tracked. The guardrails `adr-matrix` gate fails a commit when an **Accepted** ADR is not
cited here; the ADR index lives in [`adr/README.md`](adr/README.md).

| ID | Story | ADRs | Milestone | Tracking | Status |
|---|---|---|---|---|---|
| A1 | Rich question pages instead of chat prompts, answer to agent < 1 s | ADR-0007, ADR-0002 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A2 | Inline comments on any block, persistent, structured to the agent | ADR-0002, ADR-0006 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A3 | Threads with the agent anchored on a block | ADR-0007, ADR-0011 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A4 | Agent publishes a report; page refreshes < 1 s without a full build | ADR-0001 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A5 | Live delivery: mid-turn / while away; live, handover, quiet modes | ADR-0007 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| A6 | Suggested edits on rendered text land in the source | ADR-0006 | M6 | [#11](https://github.com/vig-os/revkit/issues/11) | planned |
| A7 | Co-editing the source beside the rendered view (later) | ADR-0006 (CRDT ADR to follow) | M7 | [#12](https://github.com/vig-os/revkit/issues/12) | planned |
| A8 | Comments survive rebuilds; re-anchor, never lost (orphaned) | ADR-0006 | M2 | [#7](https://github.com/vig-os/revkit/issues/7) | planned |
| B1 | CI builds a preview and posts the link, pinging requested reviewers | ADR-0008 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B2 | Comments become PR review comments on file + line, as the reviewer | ADR-0003, ADR-0006, ADR-0009, ADR-0011 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B3 | Submit the review (comment / approve / request changes) from the page | ADR-0009 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B4 | Existing PR threads shown on the page, two-way | ADR-0006 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| B5 | Non-GitHub reviewers via personal invite links (Authentik later) | ADR-0008, ADR-0009, ADR-0011 | M4 | [#9](https://github.com/vig-os/revkit/issues/9), [#4](https://github.com/vig-os/revkit/issues/4) | planned |
| B6 | Agent picks up the review, fixes, replies, resolves | ADR-0003 | M3 | [#8](https://github.com/vig-os/revkit/issues/8) | planned |
| C1 | Registered components only; hand-rolled UI blocked; escalation | ADR-0002, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C2 | Vocabulary defined once; undefined terms and redefinitions flagged | ADR-0003, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C3 | Links and doc sets validated; no orphans | ADR-0001, ADR-0003, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C4 | Plots are spec + data side files, never inline | ADR-0004, ADR-0005 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C5 | LaTeX math rendered at build, no client JS | ADR-0001 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| C6 | Phone / tablet / desktop layouts, train-line navigation | ADR-0001 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
| D1 | Any repo adopts revkit with one flake input + one line | ADR-0010 | M5 | [#10](https://github.com/vig-os/revkit/issues/10) | planned |
| D2 | Per-org hosting with GitHub-org auth | ADR-0008 | M4 | [#9](https://github.com/vig-os/revkit/issues/9) | planned |
| E1 | Static by default, JS only where interaction needs it | ADR-0001, ADR-0002, ADR-0004 | M1 | [#6](https://github.com/vig-os/revkit/issues/6) | planned |
