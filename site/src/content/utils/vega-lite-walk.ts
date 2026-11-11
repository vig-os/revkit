// Shared walker for Vega-Lite specs. Both the plot schema (which flags
// inline-data escape hatches at any depth) and the plots loader (which
// resolves each data.url against the filesystem) walk the same tree —
// keeping the traversal here avoids two hand-rolled walks diverging on
// e.g. transform-lookup or a future concat variant (DRY, ADR-0005 spirit).

/** Iterative pre-order walk of every object node in the spec, including
 * the root. The stack keeps recursion out of user-controlled data so a
 * deeply nested spec cannot blow the JS stack. */
export function walkObjects(
  spec: unknown,
  visit: (node: Record<string, unknown>, path: readonly (string | number)[]) => void,
): void {
  const stack: { node: unknown; path: readonly (string | number)[] }[] = [
    { node: spec, path: [] },
  ];
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: readonly (string | number)[] };
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], path: [...path, i] });
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    visit(record, path);
    for (const [key, value] of Object.entries(record)) {
      stack.push({ node: value, path: [...path, key] });
    }
  }
}

/** Narrow a value to a plain object (Vega-Lite `data`/`datasets` blocks are
 * always plain objects — arrays and primitives are grammar errors). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
