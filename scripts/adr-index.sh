#!/usr/bin/env sh
# Emit the ADR index table from the ADR files themselves (the source of truth):
# a header plus one `| [NNNN](file) | title | **Status** |` row per
# docs/adr/NNNN-*.md. The whole table is generated so the guardrails
# derived-docs markers sit outside it (an HTML comment inside a GFM table ends
# the table). Consumed by docs/adr/README.md.
set -eu
printf '| ADR | Decision | Status |\n|---|---|---|\n'
for f in docs/adr/[0-9][0-9][0-9][0-9]-*.md; do
  [ -e "$f" ] || continue # no ADRs yet: the glob stays literal
  num=$(basename "$f" | cut -c1-4)
  title=$(sed -n 's/^# ADR-[0-9]\{4\}: //p' "$f" | head -n 1 | sed 's/|/\\|/g')
  status=$(sed -n 's/^- Status: //p' "$f" | head -n 1)
  [ -n "$title" ] && [ -n "$status" ] || { echo "adr-index: $f lacks '# ADR-NNNN: title' or '- Status:'" >&2; exit 1; }
  printf '| [%s](%s) | %s | **%s** |\n' "$num" "$(basename "$f")" "$title" "$status"
done
