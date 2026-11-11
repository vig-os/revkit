// Port of the architect's #157 falsifier. Source intervals are constructed
// while generating syntax, independently of all production provenance maps.
export interface OraclePart {
  readonly s: string;
  readonly v: string;
  readonly m: readonly (readonly [number, number])[];
}
export interface OracleDocument {
  readonly source: string;
  readonly raw: string;
  readonly visible: string;
  readonly expected: OraclePart["m"];
  readonly ranges: readonly (readonly [number, number])[];
}
const literal = (s: string): OraclePart => ({ s, v: s, m: Array.from({ length: s.length }, (_, i) => [i, i + 1] as const) });
const token = (s: string, v: string): OraclePart => ({ s, v, m: Array.from({ length: v.length }, () => [0, s.length] as const) });
const join = (...parts: OraclePart[]): OraclePart => {
  let s = "";
  let v = "";
  const m: [number, number][] = [];
  for (const part of parts) {
    for (const [a, b] of part.m) m.push([a + s.length, b + s.length]);
    s += part.s;
    v += part.v;
  }
  return { s, v, m };
};
const wrap = (left: string, part: OraclePart, right: string): OraclePart => ({ s: left + part.s + right, v: part.v, m: part.m.map(([a, b]) => [a + left.length, b + left.length]) });
const L = literal, T = token, J = join, W = wrap;
const atoms: readonly OraclePart[] = [
  L("echo"), W("*", L("echo"), "*"), W("**", L("echo"), "**"), W("***", L("echo"), "***"),
  W("*", J(L("one "), W("**", L("two"), "**"), L(" end")), "*"),
  W("**", J(L("one "), W("*", L("two"), "*"), L(" end")), "**"),
  W("`", L("**kwargs"), "`"), W("``", L("a`b"), "``"), W("` ", L("x  y"), " `"),
  T("&amp;", "&"), T("&#x2014;", "—"), J(T("\\*", "*"), L("x"), T("\\*", "*")),
  J(L("He said "), T('"', "“"), L("hi"), T('"', "”")), J(L("don"), T("'", "’"), L("t")),
  J(T("'", "‘"), L("tis")), J(L("("), T('"', "“"), L("hi"), T('"', "”"), L(")")),
  J(L("a"), T("--", "—"), L("b")), L("---"),
  ...Array.from({ length: 6 }, (_, i) => T(".".repeat(i + 3), "…")),
  W("[", L("echo"), "](https://example.test)"), W("[", L("echo"), "][r]"),
  W("<", L("https://example.test"), ">"), W("<em>", L("html"), "</em>"), L("😀"),
  J(L("a."), T("&#46;", "."), L("b")), J(L("a-"), T("&#45;", "-"), L("-b")),
  J(L("a"), T("&#39;", "'"), L("''b")), J(L("a"), T("&#46;", "."), L(".b")),
  J(L("a"), T("&#46;", "."), T("&#46;", "."), L("b")),
];
const standalone = [L("release/*"), L("*.md"), L("__Host-"), L("_id"), L("f(*args)"), W("`", J(L("x"), T("\n", " "), L("y")), "`"), J(L("before "), W("<span>", L("raw"), "</span>"), L(" after"))];

export function oracleDocuments(seed: number, count: number, rangesPerDocument: number): OracleDocument[] {
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const result: OracleDocument[] = [];
  for (let d = 0; d < count; d++) {
    const part = d < standalone.length ? standalone[d]! : J(...Array.from({ length: 6 }, (_, i) => J(i ? L(" / ") : L(""), atoms[Math.floor(random() * atoms.length)]!)));
    // A multiline code span cannot inhabit a table cell. The original
    // falsifier skipped that oracle mismatch; generate valid syntax instead.
    const mode = part.s.includes("\n") ? 0 : d % 3;
    const prefix = mode === 0 ? "" : mode === 1 ? "## " : "| Heading |\n| --- |\n| ";
    const suffix = (mode === 2 ? " |" : "") + "\n\n[r]: https://example.test\n";
    const source = prefix + part.s + suffix;
    const ranges = Array.from({ length: rangesPerDocument }, (): readonly [number, number] => {
      const a = Math.floor(random() * part.v.length);
      return [a, a + 1 + Math.floor(random() * (part.v.length - a))];
    });
    result.push({ source, raw: d % 2 ? source.replaceAll("\n", "\r\n") : source, visible: part.v, expected: part.m.map(([a, b]) => [a + prefix.length, b + prefix.length]), ranges });
  }
  return result;
}
