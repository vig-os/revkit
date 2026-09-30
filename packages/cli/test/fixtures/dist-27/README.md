# dist-27 — issue #27 round-2 bypass fixtures

Every `.html.txt` file in this directory is the byte-for-byte shape a
real `astro build` would emit for one of the round-2 bypasses the
reviewer flagged, if the source content guards were escaped
(`{/* revkit-allow: #NN */}`) or bypassed. The `.txt` suffix keeps
the `no-hand-rolled-ui` gate out of a `packages/cli/test/fixtures/`
tree it would otherwise refuse; the test (`check-dist-dir.test.ts`)
copies each `.html.txt` into a temp `.html` file and runs
`checkDistDirectory` on the temp directory, so the walker /
file-read / diagnostic-aggregation path is exercised end-to-end.

`check-dist` on the temp directory must be non-empty; a green run
means the scan regressed. Astro's raw-HTML pass-through is
well-documented (an MDX `<div style="…">` copied verbatim into the
emitted page), so authoring these fixtures as static HTML bytes
skips only astro's own transforms — parse5 sees the same bytes
either way.
