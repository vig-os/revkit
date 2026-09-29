// Vocabulary rule tests (C2, ADR-0005). Uses an inline vocab fixture so
// the test is hermetic and does not depend on the state of
// vocab/terms.yaml.
import { describe, expect, test } from "bun:test";
import { checkVocabularyFile } from "../src/rules/vocabulary.ts";
import type { LoadedVocabEntry } from "../src/rules/vocabulary.ts";

const vocab: LoadedVocabEntry[] = [
  { id: "anchor", term: "anchor", aliases: ["dual anchor"] },
  { id: "handover", term: "handover", aliases: [] },
  { id: "doc-set", term: "doc set", aliases: ["set"] },
];

describe("vocabulary", () => {
  test("<Term id> for a known id passes", () => {
    const source = `# hello

Try <Term id="anchor"/> for details.
`;
    expect(checkVocabularyFile(source, "docs/x.mdx", vocab)).toEqual([]);
  });

  test("<Term id> for an unknown id is reported at its line", () => {
    const source = `# hello

Try <Term id="unknown"/> here.
`;
    const diagnostics = checkVocabularyFile(source, "docs/x.mdx", vocab);
    expect(diagnostics).toHaveLength(1);
    const first = diagnostics[0];
    expect(first?.rule).toBe("vocabulary");
    expect(first?.line).toBe(3);
    expect(first?.message).toContain("unknown");
  });

  test("[[term-id]] sigil for a known id passes", () => {
    const source = `See [[handover]] for delivery modes.
`;
    expect(checkVocabularyFile(source, "docs/x.mdx", vocab)).toEqual([]);
  });

  test("[[term-id]] sigil for an unknown id is reported", () => {
    const source = `See [[does-not-exist]] here.
`;
    const diagnostics = checkVocabularyFile(source, "docs/x.mdx", vocab);
    expect(diagnostics.some((d) => d.message.includes("does-not-exist"))).toBe(true);
  });

  test("[[term-id]] inside inline code does NOT trigger the rule", () => {
    const source = "Use `[[unknown]]` as example syntax.\n";
    expect(checkVocabularyFile(source, "docs/x.mdx", vocab)).toEqual([]);
  });

  test("bold redefinition of a vocab term is reported", () => {
    const source = `An **anchor** is a dual reference.
`;
    const diagnostics = checkVocabularyFile(source, "docs/x.mdx", vocab);
    expect(diagnostics).toHaveLength(1);
    const first = diagnostics[0];
    expect(first?.rule).toBe("vocabulary");
    expect(first?.message).toContain("anchor");
  });

  test("bold redefinition via an alias is reported and blames the id", () => {
    const source = `A **dual anchor** means a paired reference.
`;
    const diagnostics = checkVocabularyFile(source, "docs/x.mdx", vocab);
    expect(diagnostics).toHaveLength(1);
    const message = diagnostics[0]?.message ?? "";
    expect(message).toContain("anchor");
    expect(message).toContain("dual anchor");
  });

  test("bold phrase without a defining verb is not a redefinition", () => {
    const source = `The **anchor** appears in every rendered block.
`;
    expect(checkVocabularyFile(source, "docs/x.mdx", vocab)).toEqual([]);
  });

  test("bold phrase whose text is not a vocab term is ignored", () => {
    const source = `The **foobar** is unrelated.
`;
    expect(checkVocabularyFile(source, "docs/x.mdx", vocab)).toEqual([]);
  });
});
