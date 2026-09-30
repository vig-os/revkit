// Shared Markdown / MDX parser used by every content-shaped rule.
//
// Two flavours, keyed by file extension:
//
// - `.mdx`: remark-parse + remark-mdx + remark-math. The MDX extension
//   surfaces JSX (MdxJsxFlowElement / MdxJsxTextElement), imports
//   (MdxjsEsm) and comments (MdxFlowExpression / MdxTextExpression); the
//   math extension keeps `$…$` and `$$…$$` regions opaque so the JSX
//   parser does not choke on `{1 + \sqrt{5}}` in a LaTeX formula.
//
// - `.md`: plain remark-parse (CommonMark + setext headings). Plain
//   markdown carries HTML comments like `<!-- guardrails:derived -->`
//   which remark-mdx would refuse as an "expected identifier after
//   `<`". Any raw HTML in the source lands as an `html` mdast node, so
//   the component-registry rule still catches `<script>` or
//   `<iframe>` in a .md file.
//
// Each parser instance is cached — building a unified pipeline is not
// cheap and the rules parse the same file from at most one rule (the
// orchestrator hands the mdast root back so a future refactor can share
// the parse across rules; right now they call this per-rule for simple
// wiring and the parse cost is dwarfed by I/O).

import { extname } from "node:path";
import { unified } from "unified";
import type { Processor } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkMath from "remark-math";
import type { Nodes, Parent, RootContent } from "mdast";

type CachedProcessor = Processor;

let mdxParser: CachedProcessor | null = null;
let mdParser: CachedProcessor | null = null;

function buildMdxParser(): CachedProcessor {
  return unified().use(remarkParse).use(remarkMdx).use(remarkMath) as unknown as CachedProcessor;
}

function buildMdParser(): CachedProcessor {
  return unified().use(remarkParse) as unknown as CachedProcessor;
}

/** Pick the right parser for `filePath`. `.mdx` files go through the
 * MDX-aware pipeline; everything else (`.md`, and any oddity a caller
 * hands in) goes through plain remark-parse so an inline HTML comment
 * does not fail the parse. */
export function parseSourceFor(filePath: string, source: string): Parent {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mdx") {
    if (mdxParser === null) mdxParser = buildMdxParser();
    return mdxParser.parse(source) as unknown as Parent;
  }
  if (mdParser === null) mdParser = buildMdParser();
  return mdParser.parse(source) as unknown as Parent;
}

/** Back-compat name: some tests and rules still refer to
 * `parseMdxSource(source)` where the caller has already chosen the MDX
 * flavour (fixture inputs). Kept as an alias so a test author who wants
 * to exercise the full pipeline can skip the extension hop. */
export function parseMdxSource(source: string): Parent {
  if (mdxParser === null) mdxParser = buildMdxParser();
  return mdxParser.parse(source) as unknown as Parent;
}

/** Iterative pre-order walk over an mdast tree. Stack-based to keep a
 * recursion cap out of user-controlled content (a deeply nested list
 * that would otherwise blow the JS call stack). */
export function walkMdast(
  root: Nodes,
  visit: (node: Nodes, ancestors: readonly Parent[]) => void,
): void {
  interface Frame {
    node: Nodes;
    ancestors: readonly Parent[];
  }
  const stack: Frame[] = [{ node: root, ancestors: [] }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    visit(frame.node, frame.ancestors);
    const children = (frame.node as Parent).children as readonly RootContent[] | undefined;
    if (Array.isArray(children)) {
      const nextAncestors = [...frame.ancestors, frame.node as Parent];
      // Push in reverse so pre-order visits left-to-right.
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ node: children[i] as Nodes, ancestors: nextAncestors });
      }
    }
  }
}

/** Read the 1-based start line for a node whose position was set by the
 * parser; falls back to 1 for hand-built nodes without position. */
export function lineOf(node: Nodes): number {
  const start = node.position?.start;
  return start?.line ?? 1;
}
