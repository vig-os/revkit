// HTML skeleton for `/ask/<id>` — the shell the daemon serves. The
// Solid island in `ask-page.tsx` mounts under `#revkit-ask-mount`
// and reads its bootstrap from a JSON `<script>` tag.
//
// **Why inline JSON, not a fetch on load?** The page opens as a
// direct navigation from the launch URL (or from the human clicking
// the link the agent handed them) and the browser then loads the
// bundle. Inlining the record shaves the first `fetch()` and gives
// the page its content on the same GET the browser already made —
// answer-to-agent latency budget is < 1 s, first-render latency
// helps the human's part of that.
//
// **XSS surface.** The AskRecord passed in comes from
// `AsksStore.ask()` (event-log-reduced, so schema-validated). But
// it CAN carry agent-supplied strings (`spec.title`, `spec.prompt`,
// option labels, `spec.target`) that must NEVER land as HTML in
// this shell. Rules:
//
//   - The record is embedded as JSON inside a `<script
//     type="application/json">` — that MIME does not execute (per
//     HTML5 spec 4.12.1) and the browser hands us the raw
//     `textContent`. The only sequence to worry about is `</script`
//     inside the JSON; we escape it to `<\/script` before writing.
//     `<!--` / `--!>` are neutralised for the same reason.
//   - The rest of the shell contains NO user-supplied strings; every
//     visible text lives inside the Solid island the browser
//     compiles from the bundle.

import type { AskRecord } from "@revkit/review-core";

/** Public paths the daemon serves the bundle from. Named as
 * constants so `headers.ts` (CSP) and `daemon.ts` (routing) agree on
 * one spelling. */
export const ASK_JS_PATH = "/-/ask.js";
export const ASK_CSS_PATH = "/-/ask.css";

/** Serialise `record` for inlining. Every character that could take
 * on HTML meaning inside a surrounding `<script>` block is encoded
 * as its standard JSON `\uXXXX` escape — which is VALID JSON, so
 * `JSON.parse` in the client succeeds regardless of what the agent
 * wrote in `spec.title` / `spec.prompt` / option labels. Concretely:
 *
 *   - `<` becomes `\u003c` (blocks `</script>` and `<!--`)
 *   - `>` becomes `\u003e` (blocks `-->` and stray `>` after `<` at close)
 *   - `&` becomes `\u0026` (blocks HTML entity escapes an old parser
 *                          might expand inside a script data block)
 *   - U+2028 becomes `\u2028` (line separator: valid JSON, illegal in
 *                              a JavaScript source string — protects
 *                              a caller that later evaluates the payload)
 *   - U+2029 becomes `\u2029` (paragraph separator, same reason)
 *
 * Rationale for choosing this ruleset over the earlier
 * `<\/script` / `<\!--` / `--\>` shape (PR #52 review): `<\!--` and
 * `--\>` are NOT legal JSON escapes — `JSON.parse` rejected them,
 * and `readBoot` swallowed the error and left the page blank
 * whenever an agent wrote text containing `-->` (e.g.
 * `step 1 --> step 2`). The `\uXXXX` escapes are all valid JSON,
 * so `JSON.parse(encodeBootJson(record))` round-trips losslessly on
 * every input, tested by `test/ask-page/render.test.ts` on a
 * hostile-string fuzz list. */
export function encodeBootJson(record: AskRecord): string {
  const raw = JSON.stringify({ id: record.id, initial: record });
  // Every replace() below matches a single BMP code point with a
  // global flag — linear on input length, no backtracking hazard.
  return raw
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\u2028", "g"), "\\u2028")
    .replace(new RegExp("\u2029", "g"), "\\u2029");
}

export function renderAskPage(record: AskRecord): string {
  const boot = encodeBootJson(record);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>revkit — question</title>",
    `<link rel="stylesheet" href="${ASK_CSS_PATH}">`,
    "</head>",
    "<body>",
    '<div id="revkit-ask-mount"></div>',
    `<script id="revkit-ask-boot" type="application/json">${boot}</script>`,
    `<script type="module" src="${ASK_JS_PATH}"></script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
