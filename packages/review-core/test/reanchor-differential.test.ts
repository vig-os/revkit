import { expect, test } from "bun:test";
import { prepareReanchor, reanchorWith, revisionOf, type Anchor } from "../src/index.ts";

const SEED = 172146;
const SCRIPTS = [
  ["latin", ["value", "data", "review", "here", "gamma", "beta", "comment", "word", "great", "brown", "fine", "wrong", "release"]],
  ["cyrillic", ["слово", "данные", "обзор", "здесь", "правка", "текст", "цитата", "новый"]],
  ["arabic", ["كلمة", "بيانات", "مراجعة", "هنا", "تغيير", "نص", "اقتباس", "جديد"]],
  ["devanagari", ["शब्द", "डेटा", "समीक्षा", "यहाँ", "बदलाव", "पाठ", "उद्धरण", "नया"]],
  ["cjk", ["内容", "数据", "评论", "这里", "修改", "文字", "引用", "新的"]],
  ["emoji", ["👩‍💻", "👨‍👩‍👧‍👦", "🇨🇭", "👍🏽", "🧑‍🚀", "🏳️‍🌈", "🙂", "🚀"]],
  ["combining", ["café", "naïve", "résumé", "école", "ångström", "coöperate", "fiancé", "façade"]],
] as const;
const KINDS = ["replace", "insert", "delete", "punctuation", "whitespace", "multi-word"] as const;
type Span = { start: number; end: number };
type Edit = { start: number; end: number; text: string; before?: string; edgeWord?: boolean };
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("und", { granularity: "word" });

function randomGenerator(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) % limit;
  };
}

// The oracle tracks the generator's literal splice, not a production diff.
// Replacements overlapping an edge belong to the selection in full. A
// standalone insertion exactly at a partial edge may belong to either side.
// carry both possibilities forward through later edits (at most 16 variants).
// At a partial edge, punctuation and whitespace are outside the half-open
// quote; a whole-block quote includes them, then trims outer whitespace.
function editSpan(span: Span, edit: Edit, whole: boolean): Span[] {
  const delta = edit.text.length - (edit.end - edit.start);
  if (edit.start === edit.end) {
    if (edit.start < span.start) return [{ start: span.start + delta, end: span.end + delta }];
    if (edit.start > span.end) return [span];
    if (edit.start === span.start) {
      const included = { start: span.start, end: span.end + delta };
      const excluded = { start: span.start + delta, end: span.end + delta };
      return whole ? [included] : edit.edgeWord ? [included, excluded] : [excluded];
    }
    if (edit.start === span.end) return whole ? [{ start: span.start, end: span.end + delta }] : edit.edgeWord ? [{ start: span.start, end: span.end + delta }, span] : [span];
    return [{ start: span.start, end: span.end + delta }];
  }
  if (edit.end <= span.start) return [{ start: span.start + delta, end: span.end + delta }];
  if (edit.start >= span.end) return [span];
  const included = { start: Math.min(span.start, edit.start), end: edit.end >= span.end ? edit.start + edit.text.length : span.end + delta };
  // A replacement which preserves its old edge word and only adds another
  // word is textually an edge insertion, regardless of its generator label.
  if (!whole && edit.before && edit.end === span.end && edit.text.startsWith(edit.before + " ")) return [included, { ...included, end: edit.start + edit.before.length }];
  if (!whole && edit.before && edit.start === span.start && edit.text.endsWith(" " + edit.before)) return [included, { ...included, start: edit.start + edit.text.length - edit.before.length }];
  return [included];
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return { start, end };
}

function tokens(text: string, cjk = false): Span[] {
  if (cjk) return [...words.segment(text)].filter((word) => word.isWordLike).map((word) => ({ start: word.index, end: word.index + word.segment.length }));
  return [...text.matchAll(/\S+/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

test("#146-r1 seeded splice oracle: Unicode and chained edits produce zero WRONG spans", async () => {
  const cases = Number(process.env.REVKIT_ANCHOR_ORACLE_CASES ?? 2_000);
  if (!Number.isSafeInteger(cases) || cases < 2_000) throw new Error("REVKIT_ANCHOR_ORACLE_CASES must be an integer >= 2000");
  const counts = { correct: 0, orphan: 0, WRONG: 0, edgeInsert: 0, steps: 0, wordCut: 0, graphemeCut: 0, blockCrossing: 0, otherBounds: 0 };
  const failures: unknown[] = [];
  const coverage = new Set<string>();
  for (let caseIndex = 0; caseIndex < cases; caseIndex++) {
    // Each case has its own stream: an early orphan cannot change any later
    // case, so baseline and PR always receive the same splice records.
    const random = randomGenerator(SEED ^ Math.imul(caseIndex + 1, 0x9e3779b1));
    const [script, scriptWords] = SCRIPTS[caseIndex % SCRIPTS.length]!;
    const vocabulary: readonly string[] = scriptWords;
    const kind = KINDS[Math.floor(caseIndex / SCRIPTS.length) % KINDS.length]!;
    const position = Math.floor(caseIndex / (SCRIPTS.length * KINDS.length)) % 3;
    const whole = random(2) === 0;
    const context = random(2) === 0;
    const following = random(3); // absent, append, or rewrite the old tail
    const chain = 1 + random(4);
    coverage.add(`${script}/${kind}/${position}`);
    const separator = script === "cjk" && random(2) === 0 ? "" : " ";
    let block = Array.from({ length: 9 + random(7) }, () => vocabulary[random(vocabulary.length)]!).join(separator);
    const initialTokens = tokens(block, script === "cjk");
    const first = whole ? 0 : 1 + random(3);
    const last = whole ? initialTokens.length - 1 : initialTokens.length - 2 - random(3);
    let expected: Span[] = [{ start: initialTokens[first]!.start, end: initialTokens[last]!.end }];
    let canonical = expected[0]!;
    let tail = following === 0 ? "" : "\n\nTail paragraph.";
    let source = "# Title\n\n" + block + tail;
    const base = "# Title\n\n".length;
    let anchor: Anchor = {
      path: "docs/oracle.md", startLine: 3, endLine: 3, revision: await revisionOf(source),
      quote: { exact: block.slice(expected[0]!.start, expected[0]!.end), prefix: context ? source.slice(0, base + expected[0]!.start).slice(-32) : "", suffix: context ? source.slice(base + expected[0]!.end, base + expected[0]!.end + 32) : "" },
    };
    let outcome: "correct" | "orphan" | "WRONG" = "correct";
    let edgeInsert = false;
    const records: Edit[] = [];
    for (let step = 0; step < chain; step++) {
      counts.steps++;
      const selected = canonical;
      const available = tokens(block, script === "cjk").filter((token) => token.end > selected.start && token.start < selected.end);
      if (available.length === 0) { outcome = "orphan"; break; }
      const target = available[position === 0 ? 0 : position === 2 ? available.length - 1 : Math.floor(available.length / 2)]!;
      const replacement = vocabulary[random(vocabulary.length)]!;
      let edit: Edit;
      switch (kind) {
        case "replace": edit = { ...target, text: replacement === block.slice(target.start, target.end) ? vocabulary[(vocabulary.indexOf(replacement) + 1) % vocabulary.length]! : replacement }; break;
        case "insert": edit = { start: position === 2 ? target.end : target.start, end: position === 2 ? target.end : target.start, text: position === 2 ? ` ${replacement}` : `${replacement} `, edgeWord: true }; break;
        case "delete": edit = { ...target, text: "" }; break;
        case "punctuation": edit = { start: target.end, end: target.end, text: ["!", ".", "…", ",", "—"][random(5)]! }; break;
        case "whitespace": edit = { start: target.end, end: target.end, text: ["  ", "\t", "\n"][random(3)]! }; break;
        case "multi-word": {
          const index = available.indexOf(target);
          const end = available[Math.min(available.length - 1, index + 1)]!.end;
          edit = { start: target.start, end, text: `${replacement} ${vocabulary[random(vocabulary.length)]!}` };
          break;
        }
      }
      edit.before = block.slice(edit.start, edit.end);
      records.push(edit);
      canonical = editSpan(canonical, edit, whole)[0]!;
      expected = expected.flatMap((span) => editSpan(span, edit, whole));
      const nextBlock = block.slice(0, edit.start) + edit.text + block.slice(edit.end);
      canonical = trimSpan(nextBlock, canonical);
      expected = expected.map((span) => trimSpan(nextBlock, span));
      if (following === 1) tail += `\n\nAppended unrelated paragraph ${step}.`;
      if (following === 2) tail = `\n\nCompletely rewritten following paragraph ${step}: other text.`;
      const next = "# Title\n\n" + nextBlock + tail;
      const result = await reanchorWith(await prepareReanchor(source, next), anchor);
      if (result.kind === "orphaned") { outcome = "orphan"; break; }
      const pattern = result.anchor.quote.prefix + result.anchor.quote.exact + result.anchor.quote.suffix;
      const at = next.indexOf(pattern);
      const start = at + result.anchor.quote.prefix.length;
      const end = start + result.anchor.quote.exact.length;
      const matched = expected.findIndex((span) => start === base + span.start && end === base + span.end);
      const wordSafe = [...words.segment(next)].every((token) => !token.isWordLike || [start, end].every((offset) => offset <= token.index || offset >= token.index + token.segment.length));
      const graphemeBounds = new Set([...graphemes.segment(next)].map((cluster) => cluster.index));
      graphemeBounds.add(next.length);
      const graphemeSafe = graphemeBounds.has(start) && graphemeBounds.has(end);
      const blockSafe = start >= base && end <= base + nextBlock.length && !result.anchor.quote.exact.includes("\n\n");
      if (at < 0 || matched < 0 || !wordSafe || !graphemeSafe || !blockSafe || result.anchor.startLine !== next.slice(0, start).split("\n").length || result.anchor.endLine !== next.slice(0, end - 1).split("\n").length) {
        outcome = "WRONG";
        if (!wordSafe) counts.wordCut++;
        if (!graphemeSafe) counts.graphemeCut++;
        if (!blockSafe) counts.blockCrossing++;
        if (matched < 0 && wordSafe && graphemeSafe && blockSafe) counts.otherBounds++;
        if (failures.length < 8) failures.push({ seed: SEED, caseIndex, script, kind, position, whole, context, following, step, source, next, records, expected, received: result.anchor });
        break;
      }
      edgeInsert ||= matched > 0;
      // Follow the actual permitted edge choice; subsequent expected spans
      // still come solely from splice records, never from reanchor offsets.
      expected = [expected[matched]!];
      anchor = result.anchor;
      source = next;
      block = nextBlock;
    }
    counts[outcome]++;
    if (outcome === "correct" && edgeInsert) counts.edgeInsert++;
  }
  console.log(`ANCHOR_ORACLE seed=${SEED} cases=${cases} ${JSON.stringify(counts)}`);
  if (failures.length > 0) console.log(`ANCHOR_ORACLE_FAILURES ${JSON.stringify(failures)}`);
  expect(coverage.size).toBe(SCRIPTS.length * KINDS.length * 3);
  expect(counts.correct + counts.orphan + counts.WRONG).toBe(cases);
  expect(counts.correct).toBeGreaterThan(0);
  expect(counts.WRONG).toBe(0);
});
