#!/usr/bin/env sh
# Emit the ADR index rows from the ADR files themselves (the source of truth):
# one `| [NNNN](file) | title | **Status** |` row per docs/adr/NNNN-*.md.
# Consumed by the guardrails derived-docs region in docs/adr/README.md.
set -eu
for f in docs/adr/[0-9][0-9][0-9][0-9]-*.md; do
  num=$(basename "$f" | cut -c1-4)
  title=$(sed -n 's/^# ADR-[0-9]\{4\}: //p' "$f" | head -1)
  status=$(sed -n 's/^- Status: //p' "$f" | head -1)
  printf '| [%s](%s) | %s | **%s** |\n' "$num" "$(basename "$f")" "$title" "$status"
done
