// One CSS-URL scanner used by both the build-time SVG sanitiser
// (`sanitizeSvg` in render-plot.ts) and the output gate
// (`revkit check-dist`, packages/cli/src/check-dist.ts) — issue #27
// round 2.
//
// The scanner walks tokens produced by `css-tree`'s CSS Syntax Module
// Level 3 tokenizer (https://www.w3.org/TR/css-syntax-3/), not a
// regex. Round-1 review flagged three regex bypasses that a real
// tokenizer closes structurally:
//
//   1. An unterminated `url(https://evil/x.png` (no closing `)`) is a
//      valid CSS Url token that runs to EOF, not a bad-url — the old
//      regex only matched `url\((.*?)\)`, so nothing fired.
//   2. `url(https://evil/A.png/*)` contains `/* … */`, but CSS's
//      `url()` unquoted-value grammar does NOT strip comments — every
//      character up to the closing `)` is part of the URL. The old
//      pre-pass `cssUnescape` stripped `/* … */` unconditionally,
//      turning `url(x/*);--x:'*/'` into `url(x);--x:'*/'` and
//      accidentally re-classifying the payload as inert.
//   3. `u\rl(...)` and `\75 rl(...)` are treated by css-tree as a
//      Function token whose (unescaped) name is `url` — a URL-shaped
//      call. The tokenizer surfaces this even where css-tree's
//      internal cmpStr short-circuits to Function rather than Url
//      (css-tree 3.2.1 compares the raw source text of the ident to
//      the literal "url", so `u\rl` classifies as Function, not Url).
//      Both classifications are handled below so no escape shape
//      slips past.
//
// The scanner is parameterised by `allowFragmentUrl`. When false
// (the `style=` policy, matching the source sanitiser's decision to
// strip `style=` entirely), every URL-shaped token — Url, BadUrl,
// or a `url()` / `src()` / `image-set()` / `-webkit-image-set()`
// Function call — refuses. When true (SVG presentation attrs where
// Vega legitimately emits `fill="url(#gradient1)"`), the scanner
// keeps a Url or Function URL whose ONLY content is a same-document
// `#ident` fragment; any hyphenated `#Ident.name`-style identifier
// is validated by the same predicate the source sanitiser uses
// (`isSafeFragmentReference` in render-plot.ts), imported below.
//
// `@import`, `expression(`, and bare `javascript:` / `vbscript:`
// idents-followed-by-a-colon are refused regardless — they cannot
// appear in any URL-bearing SVG presentation attribute and
// `image-set(` / `src(` are covered by the URL-function branch
// above.
// The @types/css-tree package (v2.3.10) describes the parser and
// the lexer but does not type the tokenizer subpath export at the
// time of this change; the runtime module is used with a hand-typed
// signature that follows the CSS Syntax Level 3 tokenizer contract
// (issue #27 round 2).
// @ts-expect-error — no types for the tokenizer subpath in @types/css-tree 2.3.10
import * as cssTreeTokenizer from "css-tree/tokenizer";

type TokenizeFn = (
  source: string,
  onToken: (type: number, start: number, end: number) => void,
) => void;

const tokenize = cssTreeTokenizer.tokenize as TokenizeFn;
const tokenTypes = cssTreeTokenizer.tokenTypes as Readonly<Record<string, number>>;

/** Same predicate the source sanitiser uses for `url(#…)` refs. Kept
 * as one function so a change here can't drift between the two
 * scanners. */
export function isSafeCssFragmentIdent(raw: string): boolean {
  return /^#[A-Za-z_][\w.-]*$/.test(raw.trim());
}

/** SVG element `href` / `xlink:href` — only a bare `#ident` fragment
 * reference is allowed. The value is checked RAW (after parse5's
 * HTML entity decoding only): a browser resolves `%23a` as a
 * relative path, not as a fragment, so any percent-encoded character
 * refuses. Returns a finding message or null. Shared between the
 * source sanitiser (`render-plot.ts`) and the output gate
 * (`check-dist.ts`) so a change here can't drift between them. */
export function svgHrefRefusalReason(rawValue: string): string | null {
  if (rawValue.length === 0) return null;
  if (rawValue.includes("%")) {
    return `must be a same-document #fragment reference; percent-encoded characters are refused (a browser resolves \`%23\` as a relative path, not as a fragment)`;
  }
  const trimmed = rawValue.trim();
  if (!isSafeCssFragmentIdent(trimmed)) {
    return `must be a same-document #fragment reference (got ${JSON.stringify(rawValue)})`;
  }
  return null;
}

/** Fold CSS `\<hex>[ws?]` and `\<char>` escape sequences in a NAME
 * (an ident-token or a function-token's name — no CSS block-comment
 * syntax inside a name, so this is safe with no comment step). Used
 * only for the function-name comparison below; the token stream
 * already resolved whitespace / newlines / string boundaries. */
function foldNameEscapes(name: string): string {
  let out = "";
  let i = 0;
  while (i < name.length) {
    const ch = name[i];
    if (ch !== "\\") { out += ch; i += 1; continue; }
    const next = name[i + 1];
    if (next === undefined) { out += "\\"; i += 1; continue; }
    if (/[0-9a-fA-F]/.test(next)) {
      let hex = "";
      let j = i + 1;
      while (j < name.length && hex.length < 6 && /[0-9a-fA-F]/.test(name[j] ?? "")) {
        hex += name[j];
        j += 1;
      }
      if (j < name.length && /[\t\n\r\f ]/.test(name[j] ?? "")) j += 1;
      const cp = Number.parseInt(hex, 16);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF) {
        try { out += String.fromCodePoint(cp); } catch { /* drop */ }
      }
      i = j;
      continue;
    }
    if (next === "\n" || next === "\r" || next === "\f") { i += 2; continue; }
    out += next;
    i += 2;
  }
  return out;
}

/** CSS Function names that carry a URL and must never resolve to an
 * out-of-origin resource. `-webkit-image-set` is the vendor-prefixed
 * variant CSS omitted from its Level 3 recommendation; still shipped
 * by Chromium. */
const URL_BEARING_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "url",
  "src",
  "image-set",
  "-webkit-image-set",
]);

/** Legacy-IE CSS functions that must never appear. `expression(` in
 * particular executes JavaScript in old IE. */
const REFUSED_FUNCTION_NAMES: ReadonlySet<string> = new Set(["expression"]);

/** At-keywords a `style=` value has no legitimate use for and that
 * would carry a URL (`@import "https://…"`). */
const REFUSED_AT_KEYWORDS: ReadonlySet<string> = new Set(["@import"]);

/** Refused URL schemes that appear as `<ident>:<…>` (Ident + Colon
 * token pair) inside a CSS value. */
const REFUSED_SCHEME_IDENTS: ReadonlySet<string> = new Set(["javascript", "vbscript"]);

const T = tokenTypes;

interface Token {
  readonly type: number;
  readonly start: number;
  readonly end: number;
}

/** Extract the argument of a `Url` token (`url(  content  )` or
 * `url(  content` for an unterminated one) — content is what appears
 * between the opening `(` and the closing `)` (or EOF), whitespace
 * stripped. */
function urlTokenContent(source: string, start: number, end: number): string {
  const slice = source.slice(start, end);
  const openParen = slice.indexOf("(");
  if (openParen < 0) return slice.trim();
  const closeParen = slice.lastIndexOf(")");
  const inner = closeParen > openParen ? slice.slice(openParen + 1, closeParen) : slice.slice(openParen + 1);
  return inner.trim();
}

/** Given a Function token whose name (after escape fold) is a URL-
 * bearing name (`url`, `src`, `image-set`, `-webkit-image-set`), walk
 * the following tokens looking for `<whitespace>* <String> <whitespace>* ')'`
 * exactly, and return the string content stripped of its surrounding
 * quotes. Returns null when the shape does not match — the caller
 * refuses. */
function collectSingleStringArg(
  source: string,
  tokens: readonly Token[],
  functionIndex: number,
): { inner: string; endIndex: number } | null {
  let j = functionIndex + 1;
  while (j < tokens.length && tokens[j]?.type === T.WhiteSpace) j += 1;
  const stringTok = tokens[j];
  if (!stringTok || stringTok.type !== T.String) return null;
  const raw = source.slice(stringTok.start, stringTok.end);
  if (raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) return null; // unterminated string
  const inner = raw.slice(1, -1);
  let k = j + 1;
  while (k < tokens.length && tokens[k]?.type === T.WhiteSpace) k += 1;
  const closeTok = tokens[k];
  if (!closeTok || closeTok.type !== T.RightParenthesis) return null;
  return { inner, endIndex: k };
}

/** Human-readable options for the finding messages so tests read as
 * intent, not as slice offsets. */
export interface CssScanOptions {
  /** When true, allow a Url or url()/src()/image-set() function whose
   * SOLE argument is a same-document `#ident` fragment. When false,
   * every URL-shaped construct is refused. */
  readonly allowFragmentUrl: boolean;
}

/** One finding per refused token in `source`. Empty array means the
 * value passes both callers' policies. */
export function scanCssForUrlRefs(source: string, options: CssScanOptions): string[] {
  const findings: string[] = [];
  const tokens: Token[] = [];
  tokenize(source, (type, start, end) => {
    tokens.push({ type, start, end });
  });

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok.type === T.Url) {
      const raw = source.slice(tok.start, tok.end);
      if (!options.allowFragmentUrl) {
        findings.push(`refused CSS url-token ${JSON.stringify(raw)}`);
        continue;
      }
      const content = urlTokenContent(source, tok.start, tok.end);
      if (!isSafeCssFragmentIdent(content)) {
        findings.push(`refused url(${JSON.stringify(content)}) — only same-document url(#id) refs are allowed`);
      }
      continue;
    }

    if (tok.type === T.BadUrl) {
      const raw = source.slice(tok.start, tok.end);
      findings.push(`refused CSS bad-url token ${JSON.stringify(raw)}`);
      continue;
    }

    if (tok.type === T.Function) {
      const raw = source.slice(tok.start, tok.end);
      const nameRaw = raw.endsWith("(") ? raw.slice(0, -1) : raw;
      const name = foldNameEscapes(nameRaw).toLowerCase();
      if (URL_BEARING_FUNCTION_NAMES.has(name)) {
        if (!options.allowFragmentUrl) {
          findings.push(`refused CSS URL-shaped function ${JSON.stringify(`${name}(`)}`);
          continue;
        }
        const arg = collectSingleStringArg(source, tokens, i);
        if (arg !== null && isSafeCssFragmentIdent(arg.inner)) {
          i = arg.endIndex;
          continue;
        }
        findings.push(`refused CSS URL-shaped function ${JSON.stringify(`${name}(`)} — only ${JSON.stringify(`${name}("#id")`)} passes`);
        continue;
      }
      if (REFUSED_FUNCTION_NAMES.has(name)) {
        findings.push(`refused CSS function ${JSON.stringify(`${name}(`)}`);
        continue;
      }
      continue;
    }

    if (tok.type === T.AtKeyword) {
      const raw = source.slice(tok.start, tok.end).toLowerCase();
      if (REFUSED_AT_KEYWORDS.has(raw)) {
        findings.push(`refused CSS at-keyword ${JSON.stringify(raw)}`);
      }
      continue;
    }

    if (tok.type === T.Ident) {
      const raw = source.slice(tok.start, tok.end);
      const folded = foldNameEscapes(raw).toLowerCase();
      if (REFUSED_SCHEME_IDENTS.has(folded)) {
        // Refuse only when the next non-whitespace token is a Colon
        // (an actual `scheme:` shape, not just the identifier by
        // itself in `content: "javascript"`).
        let k = i + 1;
        while (k < tokens.length && tokens[k]?.type === T.WhiteSpace) k += 1;
        if (tokens[k]?.type === T.Colon) {
          findings.push(`refused CSS scheme ${JSON.stringify(`${folded}:`)}`);
        }
      }
      continue;
    }
  }

  return findings;
}
