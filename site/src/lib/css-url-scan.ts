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

/** Legacy-IE CSS functions that must never appear. `expression(`
 * executes JavaScript in old IE — refused by NAME because its
 * argument is a JS call (`alert(1)`), not a String token, so the
 * structural String-in-function rule below would miss it. */
const REFUSED_FUNCTION_NAMES: ReadonlySet<string> = new Set(["expression"]);

/** At-keywords a `style=` value has no legitimate use for. `@import`
 * takes an unquoted URL or a String; the URL form is caught by the
 * Url branch, but a String form (`@import "https://…"`) is only
 * caught here because `@import` isn't a Function token. */
const REFUSED_AT_KEYWORDS: ReadonlySet<string> = new Set(["@import"]);

/** Refused URL schemes that appear as `<ident>:<…>` (Ident + Colon
 * token pair) inside a CSS value. `javascript:` and `vbscript:` are
 * NEVER inside a function (they'd tokenize as Ident + Colon +
 * whatever), so the structural rule wouldn't catch them; refused
 * explicitly. Nit 1 (round 3) — the reviewer flagged `fill=
 * "javascript:alert(1)"` as untested; fixtures now assert both. */
const REFUSED_SCHEME_IDENTS: ReadonlySet<string> = new Set(["javascript", "vbscript"]);

/** URL-bearing function names — a Function token whose escape-
 * folded name is one of these is refused outright, UNLESS it is
 * exactly the `url("#ident")` shape and `allowFragmentUrl` is true.
 *
 * The round-3 structural rule (refuse any String inside any
 * function) closes `image('https://…')`, `cross-fade('https://…'
 * 50%, red)`, and any made-up future URL-shaped function that
 * takes a String argument. This list keeps safety for two shapes
 * the structural rule alone would miss:
 *
 *   1. `u\rl(https://evil)` — CSS Syntax Level 3 says an identifier
 *      whose escape-resolved value is `url` should tokenise as a
 *      Url token. css-tree 3.2.1 short-circuits on the RAW source
 *      text (`cmpStr(source, ..., "url")`) and emits a Function
 *      token instead. The Ident+Colon+Delim… args carry the URL
 *      but never form a String, so the structural rule wouldn't
 *      fire. Refuse the whole call by name.
 *   2. `url(https://evil)` where args happen to tokenise as
 *      Ident+Delim+Ident (a URL without a scheme colon) — same
 *      escape-classification hazard.
 *
 * `src(…)` and `image-set(…)` are on the list because they carry
 * URL fetches structurally the same way; keeping them named makes
 * the finding message clearer than the generic "String in function"
 * text the structural rule would produce. */
const URL_BEARING_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "url",
  "src",
  "image-set",
  "-webkit-image-set",
]);

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

/** Extract the (escape-folded, lowercased) name of a Function token
 * (the token spans `<name>(`; the trailing `(` is stripped). */
function functionName(source: string, start: number, end: number): string {
  const raw = source.slice(start, end);
  const nameRaw = raw.endsWith("(") ? raw.slice(0, -1) : raw;
  return foldNameEscapes(nameRaw).toLowerCase();
}

/** For a `url(` Function token at `functionIndex`, verify the args
 * are EXACTLY `<ws?> <String("#ident")> <ws?> )` and return the
 * `RightParenthesis` token index so the caller can skip past. Any
 * deviation (extra tokens, missing paren, unterminated / non-
 * fragment String, BadString) returns null and the caller refuses.
 * This is the ONE allowed shape for a URL-bearing function under
 * `allowFragmentUrl=true`. */
function tryUrlFragmentStringArg(
  source: string,
  tokens: readonly Token[],
  functionIndex: number,
): { endIndex: number } | null {
  let j = functionIndex + 1;
  while (j < tokens.length && tokens[j]?.type === T.WhiteSpace) j += 1;
  const stringTok = tokens[j];
  if (!stringTok || stringTok.type !== T.String) return null;
  const raw = source.slice(stringTok.start, stringTok.end);
  if (raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) return null;
  const inner = raw.slice(1, -1);
  if (!isSafeCssFragmentIdent(inner)) return null;
  let k = j + 1;
  while (k < tokens.length && tokens[k]?.type === T.WhiteSpace) k += 1;
  const closeTok = tokens[k];
  if (!closeTok || closeTok.type !== T.RightParenthesis) return null;
  return { endIndex: k };
}

/** Human-readable options for the finding messages so tests read as
 * intent, not as slice offsets. */
export interface CssScanOptions {
  /** When true, allow a Url or a `url("#ident")` function-call shape
   * (same-document fragments only). When false, every URL-shaped
   * construct — including any String token inside any function — is
   * refused. */
  readonly allowFragmentUrl: boolean;
}

/** One finding per refused token in `source`. Empty array means the
 * value passes both callers' policies.
 *
 * Round-3 rewrite (issue #27): the scanner walks the CSS token
 * stream with a stack of enclosing function names, and the safety
 * rule is STRUCTURAL — any `<String>` token inside any function is
 * refused UNLESS the enclosing function is exactly `url(` AND the
 * String's content is a same-document `#ident` fragment AND the
 * following non-whitespace token is `)`. The reviewer's round-3 note
 * called out that a function-NAME denylist (round 2) let
 * `image('https://…')`, `cross-fade('https://…' 50%, red)` and any
 * made-up future URL-shaped function through; the structural rule
 * closes the class.
 *
 * The tokenizer follows CSS Syntax Level 3
 * (https://www.w3.org/TR/css-syntax-3/) — a Url token is an
 * `url(…)` with an unquoted argument; a quoted-arg call (`url("…")`)
 * is a Function+String pair; `BadUrl` and `BadString` are the
 * tokenizer's malformed classifications and both refuse. */
export function scanCssForUrlRefs(source: string, options: CssScanOptions): string[] {
  const findings: string[] = [];
  const tokens: Token[] = [];
  tokenize(source, (type, start, end) => {
    tokens.push({ type, start, end });
  });

  /** Stack of enclosing function names (escape-folded, lowercased).
   * Bare parens push "" so paren nesting stays balanced without a
   * function name. Empty stack means "top-level" (bare style value
   * with no enclosing function). */
  const functionStack: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok.type === T.Function) {
      const name = functionName(source, tok.start, tok.end);
      if (REFUSED_FUNCTION_NAMES.has(name)) {
        findings.push(`refused CSS function ${JSON.stringify(`${name}(`)}`);
        functionStack.push(name);
        continue;
      }
      if (URL_BEARING_FUNCTION_NAMES.has(name)) {
        // Only ALLOWED shape (and only when the caller opts into
        // fragment refs) is `url("#ident")` — everything else on
        // this named list refuses even if its args look benign.
        // Handles the `u\rl(https://…)` css-tree misclassification
        // (Function-name with escape) that the structural
        // String-in-function rule would miss because the args are
        // Ident+Colon+Delim tokens, not a String.
        const stringArg =
          options.allowFragmentUrl && name === "url"
            ? tryUrlFragmentStringArg(source, tokens, i)
            : null;
        if (stringArg !== null) {
          i = stringArg.endIndex;
          continue;
        }
        findings.push(`refused URL-shaped function ${JSON.stringify(`${name}(`)}`);
        functionStack.push(name);
        continue;
      }
      functionStack.push(name);
      continue;
    }

    if (tok.type === T.LeftParenthesis) {
      functionStack.push("");
      continue;
    }

    if (tok.type === T.RightParenthesis) {
      functionStack.pop();
      continue;
    }

    if (tok.type === T.String || tok.type === T.BadString) {
      // Top-level strings (outside any function) are legitimate CSS
      // values (e.g. `content: "hello"`) and cannot fetch by
      // themselves, so allow them. Inside a function they either
      // (a) form the ONE allowed `url("#ident")` shape or (b)
      // structural-refuse.
      if (functionStack.length === 0) continue;
      const enclosing = functionStack[functionStack.length - 1] ?? "";

      // BadString is a malformed String token (unterminated by
      // newline or EOF); refuse regardless of enclosing function.
      // A well-formed url("#ident") never produces a BadString.
      if (tok.type === T.BadString) {
        const raw = source.slice(tok.start, tok.end);
        findings.push(`refused CSS bad-string token ${JSON.stringify(raw)} inside ${JSON.stringify(`${enclosing}(`)}`);
        continue;
      }

      const raw = source.slice(tok.start, tok.end);
      const first = raw[0];
      const last = raw[raw.length - 1];
      // Properly-terminated string: raw is `"..."` or `'...'`. An
      // unterminated String at EOF is emitted as a String token
      // whose last character is not a matching quote; the closing-
      // paren check below would already refuse (unterminated
      // Strings consume the rest of the source, so no `)` token
      // follows), but the explicit terminated-check keeps the
      // finding message honest.
      const isTerminated =
        raw.length >= 2 && (first === '"' || first === "'") && first === last;

      if (options.allowFragmentUrl && enclosing === "url" && isTerminated) {
        const inner = raw.slice(1, -1);
        if (isSafeCssFragmentIdent(inner)) {
          // Verify the very next non-whitespace token is a closing
          // `)`. This is what makes the shape EXACTLY `url("#id")`
          // — anything after the String (Ident, another arg, a
          // comma) refuses.
          let k = i + 1;
          while (k < tokens.length && tokens[k]?.type === T.WhiteSpace) k += 1;
          const closeTok = tokens[k];
          if (closeTok && closeTok.type === T.RightParenthesis) {
            // Consume through the closing paren so the stack pop
            // and the loop counter stay in sync.
            functionStack.pop();
            i = k;
            continue;
          }
        }
      }

      // Structural refusal: a String appears inside a function that
      // is not `url("#ident")…)`. Message names the enclosing
      // function so the finding reads clearly for legacy /
      // extension names too (image-set, cross-fade, foo).
      const label = URL_BEARING_FUNCTION_NAMES.has(enclosing)
        ? `URL-shaped function ${JSON.stringify(`${enclosing}(`)}`
        : `function ${JSON.stringify(`${enclosing}(`)}`;
      findings.push(`refused string ${JSON.stringify(raw)} inside ${label} — only \`url("#id")\` is allowed`);
      continue;
    }

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
