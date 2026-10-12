# Structural Markdown preparation (issue #175, slice 1)

Story A8, [ADR-0006](../adr/0006-comments-anchoring-event-log.md) and
[ADR-0025](../adr/0025-hybrid-review-one-core.md). This slice supplies structural
evidence; `reanchorWith` retains its existing acceptance and exact-move policy.
Endpoint validation, edit ownership and the differential acceptance gate remain
in issue #175's second slice. No anchoring event or wire schema changes.

`@revkit/review-core/markdown-blocks` parses LF-normalized Markdown with the
renderer’s default CommonMark/GFM and math options. Maps use half-open UTF-16
source offsets, snapshot-local node IDs, a revision hash and a grammar version.
`@revkit/review-core/block-map` exposes the pure positioned-mdast extractor and
validation. Paragraphs, headings, individual table cells, code, math and HTML
are units. Containers preserve enclosure; definitions, thematic breaks and
unsupported nodes are barriers. Unknown inline extensions invalidate their
unit. Leading/trailing container syntax is associated with the first/last
child, and coverage grants only syntax actually included in the stored span.

The shared renderer config captures mdast before transformations. Renderer and
standalone parsing both retain raw frontmatter as the Markdown processor sees
it; neither strips source lines or imports Astro frontmatter preprocessing into
core. A caller whose preprocessing changes source coordinates cannot supply
that map for the original revision. CRLF/lone CR input is normalized before
parsing. MDX capture and standalone MDX preparation remain unavailable.

Sparse correspondence sweeps EQUAL runs with ordered units and retains both
forward and reverse payload evidence. Syntax-only matches cannot pair units.
Unique exact source content is verified and only anchors an in-place relation
when it has retained diff evidence. A contradictory exact destination refuses
incidental matching at another position. Splits, merges and crossing pairings
are unresolved. One/one changed regions can nominate compatible pairs when no
barrier intervenes; nomination is not anchor acceptance. Multi-unit coverage
requires a contiguous ordered run without unmatched units. Exact moves still
require the existing anchor context and uniqueness policy; this API adds no
move permission.

`@revkit/review-core/block-preparation` prepares grapheme boundaries, word
interiors and word ends on the entire original LF source using locale `und`.
The instrumentation counter reports UTF-8 input bytes across both Segmenter
passes. It scales with snapshots, independently of distinct anchors and edits.
Raw local alignments are lazy, cached once per corresponding unit pair, with
an aggregate limit of 1,000,000 UTF-16 input units and 10,000 pairs and a 0.05 s
per-diff timeout. Exhaustion returns unavailable evidence. No local semantic
cleanup is applied. The global classification diff retains semantic cleanup.

The daemon prepares new tables once per refresh and old tables once per revision
bucket. Its existing legacy render captures the old map. The publishing render
hands off current maps through a bounded revision cache (16 maps, at most
1,000,000 source units); absent captures use the syntax-only parser. No new HTML
render is introduced. Unavailable preparation cannot change slice 1 acceptance.

Preparation includes parser, character diff and distinct local DMP costs; it is
not an end-to-end linear algorithm. Sparse matching uses ordered sweeps, exact
string indexing and sorting, with no Cartesian fuzzy search. Coverage queries
in this first slice inspect map arrays; a future acceptance consumer needs
indexed interval queries. The local Worker test builds in production mode with
`workerd`/`worker` export conditions: micromark's development debug module and
the browser DOM entity decoder must not enter the Worker bundle. It scans the
artifact and executes parsing and Unicode table probes in local workerd without
`nodejs_compat` or remote services.
