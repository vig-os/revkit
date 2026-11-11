// Strict wrapper around `rehype-katex` that surfaces parse errors as
// thrown build failures instead of the silent red-"\error" fallback.
//
// rehype-katex 7 always calls KaTeX with `throwOnError: true` internally,
// catches the resulting `ParseError`, records a vfile message with rule
// id `parseerror`, and then re-renders with `throwOnError: false` so the
// output tree stays populated. That means the `throwOnError` KaTeX
// option is not exposed at the plugin config level (the plugin's typed
// `Options` explicitly `Omit`s it), and an agent-authored `$\wrong$`
// would otherwise reach production as a `<span class="katex-error">`.
//
// This wrapper is a rehype plugin: it runs rehype-katex against the tree
// as usual, then inspects `file.messages` for entries whose `source` is
// `rehype-katex` and throws with the location + LaTeX excerpt. It also
// scans the produced HAST tree for any leftover `.katex-error` span (a
// second failure mode when KaTeX throws a non-ParseError) so no error
// class reaches the built page.
//
// Usage in `astro.config.mjs`:
//   rehypePlugins: [[rehypeKatexStrict, { trust: false }]],

import type { Element, Root } from "hast";
import type { Plugin } from "unified";
import rehypeKatex from "rehype-katex";

/** Minimal shape of `vfile`'s message object — vfile ships JSDoc types
 * that TypeScript's resolver doesn't pick up here, and we only touch a
 * handful of fields. Kept in sync with vfile-message@4 (`.reason`,
 * `.source`, `.place`, `.cause`, `.ruleId`). */
interface VFileMessageLike {
  reason: string;
  source?: string;
  place?: unknown;
  cause?: unknown;
  ruleId?: string;
}

interface VFileLike {
  messages: readonly VFileMessageLike[];
}

// rehype-katex's own `Options` type; keep as-is so bumps stay type-safe.
type RehypeKatexOptions = Parameters<typeof rehypeKatex>[0];

function findKatexErrorNodes(tree: Root): Element[] {
  const found: Element[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as { type?: string; tagName?: string; properties?: { className?: unknown }; children?: readonly unknown[] };
    if (record.type === "element") {
      const classes = Array.isArray(record.properties?.className)
        ? (record.properties.className as unknown[])
        : [];
      if (classes.some((c) => c === "katex-error")) {
        found.push(node as Element);
      }
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child);
    }
  };
  walk(tree);
  return found;
}

function formatMessage(message: VFileMessageLike): string {
  const location = message.place
    ? ` at ${JSON.stringify(message.place)}`
    : "";
  const cause = message.cause instanceof Error ? `: ${message.cause.message}` : "";
  return `${message.reason}${location}${cause}`;
}

/**
 * Wrap `rehype-katex` so any KaTeX parse error (a vfile message from
 * `rehype-katex`, or a leftover `<span class="katex-error">` in the
 * produced tree) throws instead of shipping.
 */
export const rehypeKatexStrict: Plugin<[RehypeKatexOptions?], Root> = function (options) {
  const runInner = rehypeKatex(options);
  return (tree: Root, file: VFileLike) => {
    // rehype-katex's transformer runs synchronously; call it inline.
    const inner = runInner as (tree: Root, file: VFileLike) => undefined;
    inner(tree, file);

    const katexMessages = file.messages.filter(
      (message) => message.source === "rehype-katex",
    );
    const errorNodes = findKatexErrorNodes(tree);

    if (katexMessages.length === 0 && errorNodes.length === 0) return;

    const parts: string[] = [];
    if (katexMessages.length > 0) {
      parts.push(
        `${katexMessages.length} KaTeX parse error(s): ${katexMessages.map(formatMessage).join(" | ")}`,
      );
    }
    if (errorNodes.length > 0) {
      const excerpts = errorNodes
        .map((node) => (node.properties as { title?: string })?.title ?? "(unknown)")
        .join(" | ");
      parts.push(`${errorNodes.length} leftover .katex-error span(s): ${excerpts}`);
    }
    throw new Error(
      `rehype-katex-strict: math would render with an error placeholder — ${parts.join("; ")}. ` +
        `Fix the LaTeX (astro.config.mjs sets trust: false, so \\href and \\includegraphics are also blocked).`,
    );
  };
};
