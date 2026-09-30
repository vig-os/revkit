// Extract quote-free short phrases from CLAUDE.md.

import { describe, expect, test } from "bun:test";
import { extractFingerprintPhrases } from "../../src/dogfood/fingerprint.ts";

describe("extractFingerprintPhrases", () => {
  test("skips headings and short lines, keeps quote-free content", () => {
    const source = `# heading
This paragraph is nice and safe as a fingerprint.
Short.
- A list item with plenty of clean characters here.
This one has a "quote" so it should be skipped by hostile-char rule.
Another safe line, at least thirty characters long.
And yet another perfectly safe line for the harness.
`;
    const phrases = extractFingerprintPhrases(source, 6);
    expect(phrases.length).toBeGreaterThanOrEqual(3);
    for (const p of phrases) {
      expect(p.length).toBeGreaterThanOrEqual(30);
      expect(p).not.toContain('"');
      expect(p).not.toContain("'");
      expect(p).not.toContain("`");
    }
  });

  test("caps at the requested max", () => {
    const source = Array.from({ length: 20 }, (_, i) => `A safe line number ${i} that is definitely long enough for the check.`).join("\n");
    const phrases = extractFingerprintPhrases(source, 3);
    expect(phrases.length).toEqual(3);
  });

  test("empty source yields no phrases", () => {
    // The isolation check treats a zero-phrase result as a hard fail
    // (fail closed). Consumers that want a permissive default must
    // widen the extraction rules, not rely on an empty output.
    expect(extractFingerprintPhrases("", 6)).toEqual([]);
  });

  test("only rejects prefixes containing hostile chars", () => {
    // Exactly 60 clean chars followed by a hostile char at pos 60 → the
    // prefix (first 60) has no hostile char, so it is accepted.
    const prefix60 = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee fffff";
    expect(prefix60.length).toEqual(60);
    const clean = prefix60 + '"quoted"';
    const phrases = extractFingerprintPhrases(clean, 6);
    expect(phrases.length).toEqual(1);
    expect(phrases[0]?.length).toEqual(60);
  });
});
