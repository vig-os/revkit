---
name: devkit_elevate
description: >-
  Review loop that finds tooling revkit built or worked around locally which belongs upstream in vig-os/devkit
  (capability module, extension, scaffold file, hook, guardrails gate). Inventories the repo's local tooling, mines
  this repo's Claude Code transcripts for repeated workarounds, dedupes against devkit, and appends a dated finding
  to the ledger issue (vig-os/revkit#1). Read-only until the operator confirms filing upstream. Use after a
  milestone, when a PR adds tooling (a custom hook, an extraPackages entry, a script), or when asked what should be
  elevated into devkit.
---

# devkit elevate — review loop

Consumer-side prototype of `/devkit:elevate` (vig-os/devkit#1765). The **ledger is vig-os/revkit#1**: every run
appends one dated comment there, and the issue body checklist tracks each candidate to a disposition. The ledger is
the state. Read it first so a run never re-proposes a settled candidate.

## 1. State lookup

```bash
DEVKIT_VERSION=$(grep -E '^DEVKIT_VERSION=' .vig-os | cut -d= -f2)
gh issue view 1 -R vig-os/revkit --comments          # the ledger: settled + open candidates
git log --since="$(gh issue view 1 -R vig-os/revkit --json comments \
  -q '.comments[-1].createdAt // empty')" --oneline   # what changed since the last run
```

Resolve the devkit checkout at the pinned tag, not a floating branch. The comparison must be against what revkit
actually runs:

```bash
DEVKIT_SRC=$(mktemp -d)
gh api "repos/vig-os/devkit/tarball/${DEVKIT_VERSION}" | tar -xz -C "$DEVKIT_SRC" --strip-components=1
```

## 2. Inventory local tooling

Every one of these is a place where a consumer adds something devkit did not give it. Record each entry with its
file and line:

| Source | Command | Signal |
|---|---|---|
| Flake extras | `grep -n -A20 'extraPackages = pkgs:' flake.nix` | a package every similar consumer would add |
| Flake custom hooks | `grep -n -A30 'hooks =' flake.nix` | a check that is not project-specific |
| Modules vs manifest | compare `modules = [` in `flake.nix` with `DEVKIT_MODULES` in `.vig-os` | drift (they must agree) |
| Project recipes | `just --list` minus the managed recipes; `cat justfile.project` | a recipe that wraps generic tooling |
| Repo scripts | `git ls-files 'scripts/**' 'tools/**'` | guards/generators that are not about revkit's domain |
| Workflows | `.github/workflows/*.yml` lacking the devkit "Managed by" banner | CI lanes devkit could ship |
| Node tooling | `jq '.devDependencies, .scripts' package.json` | linters/checkers wired by hand |

## 3. Mine agent transcripts

Transcripts live under the Claude Code config dir, one directory per working-directory slug. Worktrees get their
own slug, so glob on the repo name:

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
T=$(ls -d "$CFG"/projects/*revkit* 2>/dev/null)
# Commands that failed (tool errors) — the raw friction signal
jq -r 'select(.type=="user") | .message.content[]?
       | select(.type=="tool_result" and .is_error==true) | (.content|tostring)' $T/*.jsonl \
  | cut -c1-240 | sort | uniq -c | sort -rn | head -40
# Shell commands the agent ran, most repeated first — manual steps that want a recipe/module
jq -r 'select(.type=="assistant") | .message.content[]?
       | select(.type=="tool_use" and .name=="Bash") | .input.command' $T/*.jsonl \
  | sed -E 's/[[:space:]]+/ /g' | cut -c1-160 | sort | uniq -c | sort -rn | head -40
# Environment workarounds: explicit flags, env overrides, "workaround" talk
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' $T/*.jsonl \
  | grep -n -i -E 'workaround|not enabled|403|refus|clobber|by hand|hand-(wire|edit)|missing' | head -40
```

Transcripts are raw session data. Quote only the short snippet that proves a finding. Never paste secrets, tokens,
personal data or whole tool outputs into an issue.

## 4. Dedupe against devkit

For each candidate, check before proposing:

```bash
ls "$DEVKIT_SRC/nix/modules/"                         # shipped capability modules
ls "$DEVKIT_SRC/assets/guardrails/gates/"             # shipped gates
grep -n -i '<candidate>' "$DEVKIT_SRC/docs/NIX.md" "$DEVKIT_SRC/docs/MIGRATION.md"
gh issue list -R vig-os/devkit --state all --search '<candidate>' --limit 10
```

If devkit already ships it at the pinned tag, the disposition is **upstream-exists** and the action is to switch
revkit to it. If a newer devkit ships it, the action is an upgrade (`/devkit:upgrade`).

## 5. Classify

| Disposition | Rule |
|---|---|
| **elevate** | Generic: it would serve any consumer of the same archetype (a TS/doc-publishing repo, a Nix-direnv repo), and devkit has a home for it (module, module option, scaffold file, flake hook, guardrails gate, plugin skill) |
| **watch** | Plausibly generic but one data point; name the second consumer that would confirm it |
| **keep-local** | Encodes revkit's domain (its component set, its vocabulary, its review model) |
| **upstream-exists** | Devkit already has it; switch to it |

Name the devkit home for every **elevate**, e.g. "`bun` module" or "`runtime` option on `node`", "gate in
`assets/guardrails/gates/` (new gates are Python in `vig-utils`, per its README)", "`/devkit:init` question".

## 6. Report, then file on confirmation

1. Show the operator the findings table: candidate, evidence (file:line or transcript snippet), disposition,
   devkit home.
2. On confirmation, append one dated comment to the ledger:
   `gh issue comment 1 -R vig-os/revkit --body-file <report.md>`, and update the body checklist for new or settled
   candidates.
3. For each confirmed **elevate**, extend an existing devkit issue if one matches (comment with the new evidence);
   otherwise file one with the `feature` label, linking back to the ledger. Never file a duplicate; step 4 is the
   gate.

Never edit devkit-managed files to "fix" a finding locally. They are regenerated on upgrade. The fix belongs
upstream, and the local workaround stays in a consumer-owned file (`flake.nix` blocks, `justfile.project`,
`.gitignore.project`) until it lands.
