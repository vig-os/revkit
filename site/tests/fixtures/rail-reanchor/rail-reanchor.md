# Rail re-anchor fixture

This frozen test document preserves the Context paragraph from ADR-0006.
It is test input, independent of the living architecture decision.

## Before the anchor

The rail opens beside rendered Markdown blocks.

Each block receives a source path and line range during the build.

The daemon reads the same document that produced those stamps.

A reviewer can scroll through the document before selecting text.

The selection may begin below the initial viewport.

The floating comment button follows the selected range.

The composer records a quote and its surrounding source text.

Source edits can move the paragraph while preserving that quote.

The refresh action asks the daemon to re-anchor the thread.

An atomic save replaces the file while retaining its path.

A deleted quote leaves the thread visible in the orphan panel.

The paragraphs above keep the target below the fold to exercise scrolling.

## Context

<!-- Keep the next sentence verbatim: rail-reanchor.spec.ts selects and replaces it. -->

Comments must survive edits and rebuilds (A8), map to PR lines (B2) and never be lost.

## After the anchor

This trailing paragraph keeps surrounding content after the quoted block.
