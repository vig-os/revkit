// vocabulary (C2, ADR-0005): every `<Term id="…"/>` and `[[term-id]]`
// sigil in content resolves to an entry in `vocab/terms.yaml`, and a
// bold-defined phrase (`**X** is|means|refers to …`) whose X matches a
// listed term or alias is flagged as a redefinition of the one place
// that term is defined (DESIGN-0001 §3, ADR-0011 for the sigil).
//
// The vocabulary itself is validated by `vocabFileSchema` (from the site
// package); this rule reuses that schema so a change to the YAML shape
// stays in one place.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Code, InlineCode, Nodes, Parent, Strong, Text } from "mdast";
import type { Diagnostic } from "../diagnostics.ts";
import { lineOf, parseSourceFor, walkMdast } from "../mdx-parse.ts";
// Reuses the site's vocab schema (relative path — the site package has no
// `exports` field, so a bare specifier would not resolve). Keeps one YAML
// shape between the loader, the site content collection and this rule.
import { vocabFileSchema } from "../../../../site/src/content/schemas/vocab.ts";

/** One entry as consumed here — the schema returns richer types, but the
 * rule only reads `id`, `term` and `aliases`. */
export interface LoadedVocabEntry {
  readonly id: string;
  readonly term: string;
  readonly aliases: readonly string[];
}

/** Parse + validate the vocabulary YAML itself. Split out of
 * `loadVocab` so a caller holding the RAW bytes — the publish
 * orchestrator, which stages the batch's own `vocab/terms.yaml`
 * before committing it — validates the same schema without first
 * writing the file to disk. Throws when the YAML is unparsable or
 * does not satisfy the schema; the check should not silently pass
 * when the vocabulary itself is broken. */
export function parseVocabYaml(raw: string): LoadedVocabEntry[] {
  const parsedYaml: unknown = parseYaml(raw);
  const file = vocabFileSchema.parse(parsedYaml);
  return file.entries.map((entry) => ({
    id: entry.id,
    term: entry.term,
    aliases: entry.aliases,
  }));
}

/** Load and validate `vocab/terms.yaml`. Throws if the file is missing,
 * unparsable or does not satisfy the schema — the check should not
 * silently pass when the vocabulary itself is broken. */
export function loadVocab(vocabYamlPath: string): LoadedVocabEntry[] {
  return parseVocabYaml(readFileSync(vocabYamlPath, "utf8"));
}

/** Build a lookup by id for `<Term id>` and `[[id]]` checks. */
export function indexById(vocab: readonly LoadedVocabEntry[]): Set<string> {
  return new Set(vocab.map((entry) => entry.id));
}

/** Case-insensitive lookup: for every term-or-alias, remember which id
 * defines it. Used by the redefinition check — a bold-defined phrase like
 * `**anchor** is …` points back at the id `anchor`. */
export function indexByTermOrAlias(vocab: readonly LoadedVocabEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of vocab) {
    map.set(entry.term.toLowerCase(), entry.id);
    for (const alias of entry.aliases) {
      map.set(alias.toLowerCase(), entry.id);
    }
  }
  return map;
}

/** Regex for the `[[term-id]]` sigil (ADR-0011). The inside is an id —
 * lowercase letters, digits and hyphens — so we do not match a wiki-style
 * `[[Page Title]]` link that would exercise different validation. */
const TERM_SIGIL = /\[\[([a-z0-9-]+)\]\]/g;

/** Regex for the redefinition pattern: `**X** is|means|refers to|denotes …`.
 * X is captured verbatim so we can look it up in the alias index. */
const REDEFINITION_PATTERN = /^([^*]+?)\s+(?:is|means|refers to|denotes)\b/i;

/** Attribute lookup on a JSX element — returns the string value of the
 * first attribute with the given name, or `null` when the attribute is
 * absent or its value is a JSX expression (which we cannot statically
 * resolve to an id). */
function readStringAttr(
  attributes: readonly { type: string; name: string; value: unknown }[],
  name: string,
): string | null {
  for (const attribute of attributes) {
    if (attribute.type !== "mdxJsxAttribute" || attribute.name !== name) continue;
    if (typeof attribute.value === "string") return attribute.value;
  }
  return null;
}

/** Walk one MDX / MD file for vocabulary findings. `preparsedRoot`
 * lets the caller share ONE parse per file across rules (the
 * orchestrator does this so a `.mdx` with math is not parsed twice
 * — the second parse would fail with the same message and, worse,
 * would let a parse error surface as an unhandled throw from the
 * second rule). */
export function checkVocabularyFile(
  source: string,
  file: string,
  vocab: readonly LoadedVocabEntry[],
  preparsedRoot?: Parent,
): Diagnostic[] {
  const idIndex = indexById(vocab);
  const termIndex = indexByTermOrAlias(vocab);
  let root: Parent;
  try {
    root = preparsedRoot ?? parseSourceFor(file, source);
  } catch {
    // Parse errors are reported by component-registry (which owns the
    // MDX-shape rule); vocabulary skips the file quietly rather than
    // double-reporting the same syntax error.
    return [];
  }
  const diagnostics: Diagnostic[] = [];

  walkMdast(root as unknown as Nodes, (node, ancestors) => {
    // 1) `<Term id="…"/>` — id must be a known vocab entry.
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      const jsx = node as unknown as {
        name: string | null;
        attributes: readonly { type: string; name: string; value: unknown }[];
      };
      if (jsx.name === "Term") {
        const id = readStringAttr(jsx.attributes, "id");
        if (id === null) {
          diagnostics.push({
            file,
            line: lineOf(node),
            rule: "vocabulary",
            message: "<Term> is missing an `id=\"…\"` attribute (or the id is a JSX expression the guard cannot resolve statically).",
          });
        } else if (!idIndex.has(id)) {
          diagnostics.push({
            file,
            line: lineOf(node),
            rule: "vocabulary",
            message: `<Term id="${id}"/> — unknown term. Add an entry to vocab/terms.yaml (ADR-0005, C2).`,
          });
        }
      }
      return;
    }

    // 2) `[[term-id]]` sigil in text — must resolve. Skip `code`/`inlineCode`
    //    nodes so a documentation snippet like `` `[[term]]` `` (the docs
    //    referencing the sigil) does not count.
    if (node.type === "text") {
      const text = (node as Text).value;
      const parent = ancestors[ancestors.length - 1];
      // Skip text sitting inside an inlineCode / code (though remark
      // wouldn't nest that way, defense in depth).
      if (parent && (parent.type === "inlineCode" || parent.type === "code")) return;
      let match: RegExpExecArray | null;
      TERM_SIGIL.lastIndex = 0;
      while ((match = TERM_SIGIL.exec(text)) !== null) {
        const id = match[1] as string;
        if (!idIndex.has(id)) {
          diagnostics.push({
            file,
            line: lineOf(node),
            rule: "vocabulary",
            message: `[[${id}]] — unknown term. Add an entry to vocab/terms.yaml or fix the id (ADR-0005, ADR-0011).`,
          });
        }
      }
      return;
    }

    // 3) Bold-defined phrase whose X matches a listed term or alias.
    //    A redefinition looks like `**X** is|means|refers to …` inside a
    //    paragraph. mdast represents `**X**` as a `strong` node followed by
    //    a text sibling; find X in the strong node and check the next
    //    sibling's leading text for the defining verb.
    if (node.type === "strong") {
      const strong = node as Strong;
      const boldText = strong.children
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("");
      if (boldText.length === 0) return;
      const parent = ancestors[ancestors.length - 1] as Parent | undefined;
      if (!parent || !Array.isArray(parent.children)) return;
      const index = parent.children.indexOf(strong as unknown as (typeof parent.children)[number]);
      if (index === -1 || index + 1 >= parent.children.length) return;
      const next = parent.children[index + 1];
      if (!next || next.type !== "text") return;
      const following = (next as Text).value;
      const combined = `${boldText.trim()} ${following.trimStart()}`;
      const match = REDEFINITION_PATTERN.exec(combined);
      if (!match) return;
      const phrase = (match[1] ?? "").trim().toLowerCase();
      const definedId = termIndex.get(phrase);
      if (definedId !== undefined) {
        diagnostics.push({
          file,
          line: lineOf(node),
          rule: "vocabulary",
          message: `bold-defined phrase '${boldText}' matches vocab id '${definedId}'. Refer to it with <Term id="${definedId}"/> or [[${definedId}]] instead of redefining it (ADR-0005, C2).`,
        });
      }
    }
  });

  // Report unreferenced inline-code false-positive-suppression by NOT
  // walking through `inlineCode` (walkMdast still visits it, but its
  // internal value is not a `text` node, so TERM_SIGIL never sees it).
  // Kept as a comment for future maintainers who may add a walker option.
  void (undefined as unknown as InlineCode | Code | undefined);

  return diagnostics;
}
