// Extract quote-free short phrases from the owner's CLAUDE.md, for the
// transcript leak check.
//
// PR #42 round-6 tightened the check: match SEVERAL short quote-free
// phrases rather than one long line. A single-line match could be an
// accident of prose; two or more matches from the owner's CLAUDE.md is
// a strong signal that the owner's memory landed in the test session's
// transcript.
//
// The extraction rules are:
//   - skip Markdown headings (lines starting with #)
//   - strip a leading list marker (`- ` or `* `) and leading whitespace
//   - take the first 60 chars of the content
//   - reject any candidate containing shell-escape-hostile characters:
//     `'`, `"`, backtick, backslash, `/`, `=`, `$`, `<`, `>`
//   - keep only candidates with at least 30 grep-safe chars
//   - stop at 6 phrases
//
// The bash version implemented this with parameter expansion; the TS
// version is a pure function so tests can pin its behaviour.

/** Extract up to `max` quote-free short phrases from a CLAUDE.md string. */
export function extractFingerprintPhrases(source: string, max = 6): string[] {
  const out: string[] = [];
  const hostile = /['"`\\/=$<>]/;
  for (const raw of source.split("\n")) {
    if (raw === "") continue;
    if (raw.startsWith("#")) continue;
    // Strip a leading list marker.
    let content = raw;
    if (content.startsWith("- ") || content.startsWith("* ")) {
      content = content.slice(2);
    }
    content = content.replace(/^\s+/, "");
    const prefix = content.slice(0, 60);
    if (hostile.test(prefix)) continue;
    if (prefix.length < 30) continue;
    out.push(prefix);
    if (out.length >= max) break;
  }
  return out;
}
