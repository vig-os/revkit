// Typed mention extraction — daemon-side (M2 item 6 review round 3).
//
// The reviewer's comment body is Markdown. Mentions are only valid
// in PROSE — never inside code spans, fenced code blocks, HTML
// comments, indented code blocks, or inline `<code>…</code>` HTML.
// We parse the body with `remark-parse` (a real CommonMark parser
// already in the CLI's deps for MDX handling) and walk the AST,
// tracking the state "am I inside a `<code>` or `<pre>` HTML pair"
// via sibling `html` open/close nodes. Text between the two open
// and close tags is skipped. Every other AST kind (code, inlineCode,
// html, indented code blocks, HTML comments, images, thematicBreak,
// yaml, math, mdx*) is skipped by the walker.
//
// Round 3 change: the round-2 pre-mask pass has been removed. It
// missed several cases (case-sensitive tag match, prefix matches
// like `<codebase>`, unclosed backticks in a masked span, unclosed
// `<!--`, indented-code contamination from replacement spaces).
// The round-3 walker relies on the AST for structure — the Markdown
// parser already handles indented code blocks, fenced code, inline
// code, and HTML comments. The only thing left to do is sibling
// tracking for inline `<code>...</code>` HTML tag pairs, which is
// exactly what `htmlStackDepth` below does.
//
// Escape support:
//   - A backslash before `@` (`\@agent`) suppresses the mention.
//     CommonMark treats `\@` as a literal `@`; `remark-parse` emits
//     the text node's `value` with the backslash already consumed,
//     so we detect the escape by walking `value` and the source in
//     lock-step (`alignValueToSource`) and checking the raw byte
//     before each `@`.
//   - Any `@` inside a code / html node is out of scope because
//     the walker does not enter those AST subtrees.
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
 * bits. Uses `remark-parse` to walk the Markdown AST, and a bounded
 * regex scan on prose TEXT nodes only. */
export function extractMentions(body: string): MentionScan {
  if (body.length === 0) return { mentions: [], hasAgentNow: false, addressesAgent: false };
  const tree = unified().use(remarkParse).parse(body) as Root;
  const mentions: Mention[] = [];
  let hasAgentNow = false;
  let addressesAgent = false;
  walk(tree, body, (mention) => {
    if (mention.kind === "agent-now") hasAgentNow = true;
    if (mention.kind === "agent" || mention.kind === "agent-now") addressesAgent = true;
    mentions.push(mention);
    return mentions.length < MAX_MENTIONS_PER_BODY;
  });
  return { mentions, hasAgentNow, addressesAgent };
}

/** Whether the body carries `@agent now` in prose. */
export function hasAgentNow(body: string): boolean {
  return extractMentions(body).hasAgentNow;
}

/** True when the body addresses `@agent` / `@claude` /
 * `@agent:<name>` at all. */
export function addressesAgent(body: string): boolean {
  return extractMentions(body).addressesAgent;
}

/** Trigger derived from the mention scan. */
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

/** Node kinds where mentions live. */
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

/** State the walker threads through nested containers so a nested
 * `<code>` opens the same suppression as a top-level one. */
interface WalkState {
  /** Depth of the "we are inside an inline `<code>` or `<pre>`
   * HTML block" stack. Text nodes are suppressed while > 0. */
  codeDepth: number;
}

/** Block-level containers within which inline `<code>` / `<pre>`
 * sibling tracking resets. An unclosed `<code>` at the end of one
 * paragraph MUST NOT swallow mentions in the next paragraph. */
const INLINE_SCOPE_RESETS = new Set<string>([
  "paragraph",
  "heading",
  "tableCell",
  "footnoteDefinition",
]);

function walk(node: MdastNode, source: string, emit: (mention: Mention) => boolean): boolean {
  return walkChildren(node, source, emit, { codeDepth: 0 });
}

/** Walk one container's children, tracking `<code>`/`<pre>` open-close
 * pairs across siblings so text between them is suppressed. The
 * `codeDepth` state resets at every INLINE_SCOPE_RESETS boundary —
 * an unclosed `<code>` in one paragraph does not leak into the
 * next. */
function walkChildren(node: MdastNode, source: string, emit: (mention: Mention) => boolean, state: WalkState): boolean {
  if (!CONTAINER_KINDS.has(node.type)) return true;
  const children = node.children;
  if (children === undefined) return true;
  for (const child of children) {
    if (child.type === "html") {
      const raw = child.value ?? "";
      const kind = classifyHtml(raw);
      if (kind === "code-open" || kind === "pre-open") state.codeDepth++;
      else if (kind === "code-close" || kind === "pre-close") state.codeDepth = Math.max(0, state.codeDepth - 1);
      continue;
    }
    if (PROSE_TEXT_KINDS.has(child.type)) {
      if (state.codeDepth > 0) continue;
      if (!extractFromTextNode(child as Text, source, emit)) return false;
      continue;
    }
    if (CONTAINER_KINDS.has(child.type)) {
      // Round-3 fix: inline-scope resets. A new paragraph starts
      // with codeDepth=0 regardless of what a previous paragraph
      // left dangling.
      const nested: WalkState = INLINE_SCOPE_RESETS.has(child.type) ? { codeDepth: 0 } : state;
      if (!walkChildren(child, source, emit, nested)) return false;
      continue;
    }
    // code (fenced OR indented) / inlineCode / image / imageReference /
    // thematicBreak / yaml / toml / math / mdx* / definition-target
    // — all skipped: content is not prose.
  }
  return true;
}

/** Classify an inline `html` node's raw value. Only recognises the
 * tag NAMES `code` and `pre` — matches are case-insensitive AND
 * word-anchored, so `<CODE>` fires but `<codebase>` and `<preview>`
 * do NOT. Anything else (comments, other tags, HTML-shaped junk)
 * returns "other" and is skipped without affecting the code depth. */
export function classifyHtml(raw: string):
  | "code-open"
  | "code-close"
  | "pre-open"
  | "pre-close"
  | "other" {
  // `raw` is a snippet like `<code>`, `<code class="x">`, `</code>`,
  // `<!-- … -->`, `<span>` etc. Match tag NAME exactly with a
  // one-char boundary on the trailing side ( `>`, `/`, space, tab,
  // newline).
  const openTag = /^<\s*([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/;
  const closeTag = /^<\s*\/\s*([A-Za-z][A-Za-z0-9]*)\s*>/;
  const closeMatch = closeTag.exec(raw);
  if (closeMatch !== null) {
    const name = closeMatch[1]!.toLowerCase();
    if (name === "code") return "code-close";
    if (name === "pre") return "pre-close";
    return "other";
  }
  const openMatch = openTag.exec(raw);
  if (openMatch !== null) {
    const name = openMatch[1]!.toLowerCase();
    if (name === "code") return "code-open";
    if (name === "pre") return "pre-open";
    return "other";
  }
  return "other";
}

/** Extract mentions from ONE text node. See file header for how
 * offsets are mapped back to the original body. */
function extractFromTextNode(node: Text, source: string, emit: (mention: Mention) => boolean): boolean {
  const value = node.value;
  const startOffset = node.position?.start?.offset;
  if (startOffset === undefined) return true;
  const sourceStart = startOffset;
  const sourceEnd = node.position?.end?.offset ?? sourceStart + value.length;
  const valueToSource = alignValueToSource(value, source, sourceStart, sourceEnd);
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) !== 0x40 /* @ */) {
      i++;
      continue;
    }
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
    // Escape check on SOURCE.
    const at = valueToSource[i];
    if (at !== undefined && at > 0 && source.charCodeAt(at - 1) === 0x5c /* \ */) {
      i++;
      continue;
    }
    const idStart = i + 1;
    if (idStart >= value.length || !isFirstIdChar(value.charCodeAt(idStart))) {
      i++;
      continue;
    }
    let j = idStart + 1;
    while (j < value.length && isIdChar(value.charCodeAt(j))) j++;
    let end = j;
    while (end > idStart + 1 && value.charCodeAt(end - 1) === 0x2d) end--;
    const firstToken = value.slice(idStart, end);
    if (firstToken.length === 0 || firstToken.length > 39) {
      i = j;
      continue;
    }
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
    const valueStart = i;
    const rangeStart = valueToSource[valueStart] ?? sourceStart + valueStart;
    const rangeEnd = valueToSource[cursor - 1] !== undefined ? (valueToSource[cursor - 1] as number) + 1 : sourceStart + cursor;
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
