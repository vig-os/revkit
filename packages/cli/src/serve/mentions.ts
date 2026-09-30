// Typed mention extraction — daemon-side (M2 item 6 review round 2).
//
// The reviewer's comment body is Markdown. Mentions are only valid
// in PROSE — never inside code spans, fenced code blocks, HTML
// comments, indented code blocks, or inline `<code>…</code>` HTML.
// We parse the body with `remark-parse` (a real CommonMark parser
// already in the CLI's deps for MDX handling) and walk the AST to
// pick text nodes only where prose applies. The regex step over
// text nodes is bounded and structure-aware — never touches raw
// backtick or backslash bytes in code.
//
// Runs on the DAEMON at `POST /api/threads` and reply time; the
// parsed `Mention[]` rides on the `comment.created` /
// `comment.replied` event, so the rail renders chips WITHOUT
// bundling a parser (removes Zod's `new Function` feature probe
// hazard AND keeps a single source of truth for what counts as a
// mention).
//
// Escape support:
//   - A backslash before `@` (`\@agent`) suppresses the mention.
//     CommonMark treats `\@` as a literal `@`; `remark-parse` emits
//     the text node's `value` with the backslash already consumed,
//     so we detect the escape by comparing the RAW slice from the
//     original body against the text-node value.
//   - Any `@` inside a code / html node is out of scope because
//     we do not walk those AST subtrees.
//
// Bounded: we cap the number of mentions emitted per body at
// `MAX_MENTIONS_PER_BODY` so a pathologically long comment cannot
// balloon the event's `mentions` field.

import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Text } from "mdast";
import type { HandoverTrigger } from "@revkit/review-core";

/** One parsed mention. Same shape as the review-core Zod schema
 * (`commentMentionSchema`); kept here as a typed record for clarity
 * at the daemon side. `range` is the [start, end) offset in the
 * ORIGINAL body, so the rail can highlight the exact substring. */
export interface Mention {
  readonly kind: "agent" | "agent-now" | "gh-user" | "team" | "role";
  readonly id: string;
  readonly label: string;
  readonly name?: string;
  readonly range: readonly [number, number];
}

/** Result of `extractMentions`. `hasAgentNow` and `addressesAgent`
 * are the routing bits the daemon reads to gate fan-out. */
export interface MentionScan {
  readonly mentions: readonly Mention[];
  readonly hasAgentNow: boolean;
  readonly addressesAgent: boolean;
}

/** Reserved role names (ADR-0011). */
const ROLES = new Set<string>(["author", "reviewers", "owners"]);
/** Reserved agent aliases. `agent` is the generic id; `claude` is
 * the hosted alias ADR-0011 calls out. */
const AGENT_ALIASES = new Set<string>(["agent", "claude"]);

/** Hard cap on emitted mentions per body. A comment with more than
 * this many mentions is either an attack or a bug in the author's
 * template — we truncate the list rather than drop the whole thing.
 * 64 is comfortably above any real usage. */
export const MAX_MENTIONS_PER_BODY = 64;

/** Parse a comment body and return every actor mention plus routing
 * bits. Uses `remark-parse` to walk the Markdown AST, and a
 * bounded regex scan on prose TEXT nodes only. */
export function extractMentions(body: string): MentionScan {
  if (body.length === 0) return { mentions: [], hasAgentNow: false, addressesAgent: false };
  // Pre-pass (round-2 nit): remark-parse treats inline HTML `<code>`
  // and comment tags as `html` nodes but keeps the text between them
  // as a normal `text` sibling — so a naive AST walk still fires on
  // `<code>@agent</code>`. Mask those two shapes (and `<pre>` for
  // symmetry) with spaces BEFORE parsing so the masked region is
  // text-node whitespace and never matches an identifier. Offsets
  // stay 1:1 because we only substitute spaces.
  const masked = maskInlineHtmlCode(body);
  const tree = unified().use(remarkParse).parse(masked) as Root;
  const mentions: Mention[] = [];
  let hasAgentNow = false;
  let addressesAgent = false;
  // The AST offsets align with `masked`. The masked buffer has
  // the same length as the original body — only inline-HTML
  // `<code>` and comment content became spaces. Pass `masked` as
  // the source for offset math and the escape-check.
  walk(tree, masked, (mention) => {
    if (mention.kind === "agent-now") hasAgentNow = true;
    if (mention.kind === "agent" || mention.kind === "agent-now") addressesAgent = true;
    mentions.push(mention);
    return mentions.length < MAX_MENTIONS_PER_BODY;
  });
  return { mentions, hasAgentNow, addressesAgent };
}

/** Whether the body carries `@agent now` in prose. Convenience
 * wrapper. Runs the full parser but never keeps state — a caller
 * that also needs the chip list should call `extractMentions`
 * once and read `.hasAgentNow`. */
export function hasAgentNow(body: string): boolean {
  return extractMentions(body).hasAgentNow;
}

/** True when the body addresses `@agent` / `@claude` /
 * `@agent:<name>` at all. Used by the daemon for a future routing
 * bit (chip highlight even without `now`). */
export function addressesAgent(body: string): boolean {
  return extractMentions(body).addressesAgent;
}

/** Trigger derived from the mention scan. Used by the daemon's
 * `handleAppendComment` to pick the delivery-event trigger:
 * `agent-now` when the body carries the marker, else undefined
 * (let the caller pick the trigger). Exported for tests. */
export function triggerFromMentions(scan: MentionScan): HandoverTrigger | undefined {
  return scan.hasAgentNow ? "agent-now" : undefined;
}

// ── AST walking ────────────────────────────────────────────────

interface MdastNode {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly value?: string;
  readonly children?: readonly MdastNode[];
}

/** Node kinds where mentions live. Every other AST kind (code,
 * inlineCode, html — CommonMark's inline HTML including comments
 * and `<code>` tags — and structural containers) is skipped or
 * walked recursively without extracting from it. */
const PROSE_TEXT_KINDS = new Set<string>(["text"]);
/** Container kinds we recurse INTO. */
const CONTAINER_KINDS = new Set<string>([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
  "tableRow",
  "tableCell",
  "table",
]);

function walk(node: MdastNode, source: string, emit: (mention: Mention) => boolean): boolean {
  if (PROSE_TEXT_KINDS.has(node.type)) {
    return extractFromTextNode(node as Text, source, emit);
  }
  if (CONTAINER_KINDS.has(node.type) && node.children !== undefined) {
    for (const child of node.children) {
      if (!walk(child, source, emit)) return false;
    }
  }
  // Any other kind (code, inlineCode, html, thematicBreak, image,
  // imageReference, yaml, toml, math, mdxFlowExpression, …) is
  // skipped — mentions in those contexts are literal text, not
  // routing tokens.
  return true;
}

/** Extract mentions from ONE text node. The node's `value` is the
 * Markdown parser's cooked text (backslash-escapes already
 * consumed); `position.start.offset` and `position.end.offset`
 * give the byte offsets into the ORIGINAL body. We map matches on
 * `value` back to the original body via those offsets AND we check
 * the raw body slice for a leading `\` before `@` so `\@agent`
 * suppresses the mention. */
function extractFromTextNode(node: Text, source: string, emit: (mention: Mention) => boolean): boolean {
  const value = node.value;
  const startOffset = node.position?.start?.offset;
  if (startOffset === undefined) return true;
  // The mapping "value index → source index" is not always 1:1
  // when backslash-escapes are present. `remark-parse` collapses
  // `\@` in the source to `@` in the value. To recover an exact
  // range in the ORIGINAL body, we walk source[startOffset..] and
  // value in lock-step, tracking the raw offset for each value
  // index. A backslash-escape steps two source chars for one
  // value char; that alignment plus the raw-char inspection is
  // enough to reject `\@agent`.
  const sourceStart = startOffset;
  const sourceEnd = node.position?.end?.offset ?? sourceStart + value.length;
  const valueToSource = alignValueToSource(value, source, sourceStart, sourceEnd);
  // Scan `value` for `@`-starting identifier runs and classify each.
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) !== 0x40 /* @ */) {
      i++;
      continue;
    }
    // Pre-boundary check on VALUE (letters / digits / _ before @ ⇒ not a mention).
    if (i > 0) {
      const prev = value.charCodeAt(i - 1);
      if (
        (prev >= 0x30 && prev <= 0x39) ||
        (prev >= 0x41 && prev <= 0x5a) ||
        (prev >= 0x61 && prev <= 0x7a) ||
        prev === 0x5f
      ) {
        i++;
        continue;
      }
    }
    // Escape check on SOURCE: the raw char just before the `@`
    // in the original body. When the mapping shows a backslash
    // was consumed (source char just BEFORE the `@`'s source
    // position is `\`), suppress the mention.
    const at = valueToSource[i];
    if (at !== undefined && at > 0 && source.charCodeAt(at - 1) === 0x5c /* \ */) {
      i++;
      continue;
    }
    // First identifier token.
    const idStart = i + 1;
    if (idStart >= value.length || !isFirstIdChar(value.charCodeAt(idStart))) {
      i++;
      continue;
    }
    let j = idStart + 1;
    while (j < value.length && isIdChar(value.charCodeAt(j))) j++;
    // Trim trailing `-`.
    let end = j;
    while (end > idStart + 1 && value.charCodeAt(end - 1) === 0x2d) end--;
    const firstToken = value.slice(idStart, end);
    if (firstToken.length === 0 || firstToken.length > 39) {
      i = j;
      continue;
    }
    // Optional `:<name>`.
    let cursor = end;
    let agentName: string | undefined;
    if (
      firstToken === "agent" &&
      cursor < value.length &&
      value.charCodeAt(cursor) === 0x3a
    ) {
      const nameStart = cursor + 1;
      if (nameStart < value.length && isFirstIdChar(value.charCodeAt(nameStart))) {
        let k = nameStart + 1;
        while (k < value.length && isIdChar(value.charCodeAt(k))) k++;
        let nameEnd = k;
        while (nameEnd > nameStart + 1 && value.charCodeAt(nameEnd - 1) === 0x2d) nameEnd--;
        const name = value.slice(nameStart, nameEnd);
        if (name.length > 0 && name.length <= 39) {
          agentName = name;
          cursor = nameEnd;
        }
      }
    }
    // Optional `/<team>`.
    let teamPart: string | undefined;
    if (
      agentName === undefined &&
      !ROLES.has(firstToken) &&
      !AGENT_ALIASES.has(firstToken) &&
      cursor < value.length &&
      value.charCodeAt(cursor) === 0x2f
    ) {
      const teamStart = cursor + 1;
      if (teamStart < value.length && isFirstIdChar(value.charCodeAt(teamStart))) {
        let k = teamStart + 1;
        while (k < value.length && isTeamChar(value.charCodeAt(k))) k++;
        let teamEnd = k;
        while (teamEnd > teamStart + 1 && value.charCodeAt(teamEnd - 1) === 0x2d) teamEnd--;
        const team = value.slice(teamStart, teamEnd);
        if (team.length > 0 && team.length <= 39) {
          teamPart = team;
          cursor = teamEnd;
        }
      }
    }
    // Map value range [i, cursor) → source range.
    const valueStart = i;
    const rangeStart = valueToSource[valueStart] ?? sourceStart + valueStart;
    const rangeEnd = valueToSource[cursor - 1] !== undefined ? (valueToSource[cursor - 1] as number) + 1 : sourceStart + cursor;
    // Classify.
    let mention: Mention;
    if (agentName !== undefined) {
      mention = { kind: "agent", id: `agent:${agentName}`, label: `@agent:${agentName}`, name: agentName, range: [rangeStart, rangeEnd] };
    } else if (teamPart !== undefined) {
      mention = { kind: "team", id: `${firstToken}/${teamPart}`, label: `@${firstToken}/${teamPart}`, range: [rangeStart, rangeEnd] };
    } else if (AGENT_ALIASES.has(firstToken)) {
      mention = { kind: "agent", id: firstToken, label: `@${firstToken}`, range: [rangeStart, rangeEnd] };
    } else if (ROLES.has(firstToken)) {
      mention = { kind: "role", id: firstToken, label: `@${firstToken}`, range: [rangeStart, rangeEnd] };
    } else {
      mention = { kind: "gh-user", id: firstToken, label: `@${firstToken}`, range: [rangeStart, rangeEnd] };
    }
    // Check for adjacent ` now`.
    if (mention.kind === "agent") {
      const nowEndInValue = readAgentNow(value, cursor);
      if (nowEndInValue !== undefined) {
        const nowRangeEnd = valueToSource[nowEndInValue - 1] !== undefined
          ? (valueToSource[nowEndInValue - 1] as number) + 1
          : sourceStart + nowEndInValue;
        if (!emit(mention)) return false;
        if (!emit({ kind: "agent-now", id: "", label: "@agent now", range: [rangeStart, nowRangeEnd] })) return false;
        i = nowEndInValue;
        continue;
      }
    }
    if (!emit(mention)) return false;
    i = cursor;
  }
  return true;
}

/** Build an index mapping value char index → original body char
 * index for one text node. Walks source[start..end) and value in
 * lock-step, incrementing the source offset by 2 for each
 * backslash-escape. Returns an array of source offsets per value
 * index; entries may be undefined if the mapping cannot be
 * determined (fallback: use start + valueIndex). */
function alignValueToSource(
  value: string,
  source: string,
  sourceStart: number,
  sourceEnd: number,
): Array<number | undefined> {
  const map: Array<number | undefined> = new Array(value.length).fill(undefined);
  let src = sourceStart;
  let val = 0;
  while (val < value.length && src < sourceEnd) {
    const sc = source.charCodeAt(src);
    const vc = value.charCodeAt(val);
    if (sc === 0x5c /* \ */ && src + 1 < sourceEnd) {
      const nextSc = source.charCodeAt(src + 1);
      // `\<ASCII punctuation>` → the punctuation lands in value.
      // CommonMark's escape set is a fixed table; we approximate
      // with ASCII punctuation, which covers every case the
      // mention parser cares about (`\@`, `\_`, `\*`, `\` before
      // any punct). If nextSc equals vc, the escape consumed one
      // source char; otherwise fall through to a normal step.
      if (nextSc === vc) {
        map[val] = src + 1;
        val++;
        src += 2;
        continue;
      }
    }
    if (sc === vc) {
      map[val] = src;
      val++;
      src++;
      continue;
    }
    // Mismatch — e.g. entity decoding or line-ending normalisation
    // rewrites CRLF → LF, or an entity was decoded. Advance both
    // conservatively; the map entry falls back to undefined.
    val++;
    src++;
  }
  return map;
}

// ── shared identifier helpers ─────────────────────────────────

function isIdChar(cc: number): boolean {
  return (
    (cc >= 0x30 && cc <= 0x39) ||
    (cc >= 0x41 && cc <= 0x5a) ||
    (cc >= 0x61 && cc <= 0x7a) ||
    cc === 0x2d
  );
}
function isTeamChar(cc: number): boolean {
  return isIdChar(cc) || cc === 0x5f;
}
function isFirstIdChar(cc: number): boolean {
  return (
    (cc >= 0x30 && cc <= 0x39) ||
    (cc >= 0x41 && cc <= 0x5a) ||
    (cc >= 0x61 && cc <= 0x7a)
  );
}

/** Replace `<code>…</code>`, `<pre>…</pre>` and `<!-- … -->`
 * regions with spaces of the same length. Preserves offsets so
 * downstream AST positions still map to the original body. Case-
 * insensitive tag match; every other HTML tag is left alone (remark
 * emits it as an `html` node the walker already skips). */
function maskInlineHtmlCode(body: string): string {
  const out = body.split("");
  const len = body.length;
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) out[i] = " ";
  };
  let i = 0;
  while (i < len) {
    // HTML comment `<!-- … -->`.
    if (body.startsWith("<!--", i)) {
      const close = body.indexOf("-->", i + 4);
      if (close === -1) {
        mask(i, len);
        i = len;
      } else {
        mask(i, close + 3);
        i = close + 3;
      }
      continue;
    }
    // Case-insensitive `<code…>` or `<pre…>` opening tag.
    const lower4 = body.slice(i, i + 5).toLowerCase();
    if (lower4 === "<code") {
      const gt = body.indexOf(">", i);
      if (gt === -1) {
        mask(i, len);
        i = len;
        continue;
      }
      // Find matching `</code>` (case-insensitive).
      const close = indexOfCaseInsensitive(body, "</code>", gt + 1);
      if (close === -1) {
        mask(i, len);
        i = len;
      } else {
        mask(i, close + "</code>".length);
        i = close + "</code>".length;
      }
      continue;
    }
    if (body.slice(i, i + 4).toLowerCase() === "<pre") {
      const gt = body.indexOf(">", i);
      if (gt === -1) {
        mask(i, len);
        i = len;
        continue;
      }
      const close = indexOfCaseInsensitive(body, "</pre>", gt + 1);
      if (close === -1) {
        mask(i, len);
        i = len;
      } else {
        mask(i, close + "</pre>".length);
        i = close + "</pre>".length;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

function indexOfCaseInsensitive(haystack: string, needle: string, from: number): number {
  const lower = haystack.toLowerCase();
  return lower.indexOf(needle.toLowerCase(), from);
}

/** Detect an adjacent ` now` (with a case-insensitive `now` and a
 * word-boundary after) — the routing marker for `@agent now`. */
function readAgentNow(value: string, p: number): number | undefined {
  if (p >= value.length) return undefined;
  const cc = value.charCodeAt(p);
  if (cc !== 0x20 && cc !== 0x09) return undefined;
  let q = p + 1;
  while (q < value.length) {
    const c = value.charCodeAt(q);
    if (c !== 0x20 && c !== 0x09) break;
    q++;
  }
  if (q + 3 > value.length) return undefined;
  if (value.slice(q, q + 3).toLowerCase() !== "now") return undefined;
  const after = q + 3;
  if (after === value.length) return after;
  const acc = value.charCodeAt(after);
  if (
    (acc >= 0x30 && acc <= 0x39) ||
    (acc >= 0x41 && acc <= 0x5a) ||
    (acc >= 0x61 && acc <= 0x7a) ||
    acc === 0x5f
  ) {
    return undefined;
  }
  return after;
}
