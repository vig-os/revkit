---
name: revkit_run
description: >-
  Unattended "ralph" loop that works through revkit's accepted plan (milestones M1…, DESIGN-0001, ADRs) one chunk at a
  time inside an interactive agent session in a flock pane: build via subagent, fresh-context review, fix, merge into
  dev, tick the tracking issue, update .revkit/run/HANDOFF.md, then self-compact through flock and resume. Use when
  asked to run, continue or resume the revkit plan unattended, or when a resume prompt names this skill.
---

# revkit run: unattended plan loop

State lives in **`.revkit/run/HANDOFF.md`** (gitignored) and on GitHub (milestone tracking issues and their
checklists). Never in conversation memory alone: every chunk ends with a self-compaction, so write down what the next
iteration needs. The coordinator supports Claude Code (`idle` after a turn) and OpenCode (`done` after a turn); both
states are treated as quiescent before the helper types into the pane.

## Starting a run

From the repo root. The lock makes a second start a no-op, so this block is safe on every resume. Clearing a
leftover `STOP`/`DONE` (`rm -f .revkit/run/STOP .revkit/run/DONE`) is the **owner's** step when starting a new run;
an agent never deletes them.

```bash
pane=$(flk agent get "$FLOCK_PANE_ID" | jq -er '.result.agent.pane_id // .result.pane_id')
setsid nohup .claude/skills/revkit_run/watchdog.sh "$pane" \
  "Watchdog: the revkit run looks stalled. Use the revkit_run skill: check running subagents and open PRs (no duplicates), then continue from .revkit/run/HANDOFF.md." \
  >/dev/null 2>&1 &
```

Both scripts log to `.revkit/run/run.log`.

## One iteration = one chunk

A chunk is one checklist item of the current milestone's tracking issue (e.g. #6 for M1), delivered as one PR into
`dev`.

1. **Orient:** read `.revkit/run/HANDOFF.md`, then the tracking issue checklist. If `.revkit/run/STOP` or `.revkit/run/DONE`
   exists, stop and report.
2. **Build:** hand the chunk to a background subagent with a self-contained brief: binding context (CLAUDE.md, the
   ADRs and matrix rows it implements), the rules (dev shell, never `prek install`, conventional commits with
   `Refs:`, branch from up-to-date `dev`, exact pins, guardrails clean), the lessons in HANDOFF.md, and "do not
   merge". Record the agent id and branch in HANDOFF.md.
3. **Review:** once CI is green, a fresh-context `code-reviewer` subagent reviews the PR against the ADRs; security
   claims are tested, not trusted. Send findings back to the builder; repeat until approved.
4. **Land:** merge with `--merge --delete-branch` into `dev` only; tick the checklist item; add new lessons to
   HANDOFF.md.
5. **Hand off and compact:** rewrite HANDOFF.md (done, in flight, next chunk, lessons), then launch the self-compact
   helper **detached** and end the turn:

   ```bash
   pane=$(flk agent get "$FLOCK_PANE_ID" | jq -er '.result.agent.pane_id // .result.pane_id')
   setsid nohup .claude/skills/revkit_run/self-compact.sh "$pane" \
     "Keep: revkit unattended run state is in .revkit/run/HANDOFF.md; follow the revkit_run skill." \
     "Continue the revkit run: use the revkit_run skill and .revkit/run/HANDOFF.md for the next chunk." \
     >/dev/null 2>&1 &
   ```

   It waits until this pane is quiescent, types `/compact …`, waits again, then types the resume prompt.

## Boundaries (unattended)

- Merge only into `dev`, only with green CI and an approving fresh review. Never push to `main`, never deploy
  production, never create or read credentials, never approve org-config applies.
- A chunk that needs a human (tokens, GitHub App, an ADR change) is **not** worked around: open or update an issue,
  note it in HANDOFF.md as blocked, and move to the next unblocked chunk. If none is left, stop and send
  `flk notification` so the owner sees it.
- Three failed attempts at one chunk: park it as blocked with the evidence, move on.
- A change that contradicts an accepted ADR needs a superseding ADR from the owner: park it.

## Watchdog

`watchdog.sh` (started above, one instance per run dir) types a nudge when the pane has been quiescent for
45 min (hung subagent, lost notification, usage limit). On a nudge: check running subagents (never spawn a duplicate),
their branches and PRs, then continue from HANDOFF.md. When the goal is reached or nothing unblocked is left,
`touch .revkit/run/DONE` so the watchdog exits, then `flk notification`.

## Stopping

`touch .revkit/run/STOP` stops the loop at the next check, including a pending self-compaction and the watchdog.
