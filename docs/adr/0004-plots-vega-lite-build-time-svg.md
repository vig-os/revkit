# ADR-0004: Plots: Vega-Lite spec plus side data, rendered to SVG at build

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: C4, E1

## Context

Plots must be structured (spec and data in side files, C4), lean (E1) and agent-safe.

## Decision

A plot is `spec.vl.json` (Vega-Lite, schema-validated, `data.url` to a sibling file, no inline `data.values`) and its
data file, rendered to **static SVG at build** (measured 53 ms, 0 KB client JS). Interactivity is an opt-in lazy
island (vega-embed); uPlot is reserved for large time series.

## Consequences

Observable Plot (82 KB gz, also SSR-capable) was rejected because its spec is code, not data.

## Acceptance (2026-09-29)

- uPlot is **not shipped** until a Vega-Lite build-time render exceeds a measured budget (> 500 ms per plot or
  > 200 KB SVG) on real content; adding it then is an amendment here.
