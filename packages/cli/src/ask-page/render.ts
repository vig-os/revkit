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

/** Serialise `record` for inlining. The one JSON sequence that could
 * break out of the surrounding `<script>` is `</script` — inside a
 * JSON body the `/` is not special, so JSON.stringify leaves it as
 * a literal slash. We escape it here so the string cannot terminate
 * the block. `<!` / `-->` are HTML-comment starters that some HTML
 * parsers accept inside a `<script>` when preceded by `<!--`; we
 * neutralise them defensively. */
export function encodeBootJson(record: AskRecord): string {
  const raw = JSON.stringify({ id: record.id, initial: record });
  // Guardrails ok: these regex replacements pattern-match specific
  // HTML sequences before embedding a JSON payload. Parsing is not
  // an option here — the input is JSON as text, and the target is
  // an HTML sequence at any position inside the string.
  return raw
    .replace(/<\/(script)/gi, "<\\/$1") // guardrails-ok: HTML sequence guard, not parseable structure
    .replace(/<!--/g, "<\\!--") // guardrails-ok: HTML comment starter
    .replace(/--(>|!>)/g, "--\\$1") // guardrails-ok: HTML comment terminator
    .replace(new RegExp("\u2028", "g"), "\\u2028")
    .replace(new RegExp("\u2029", "g"), "\\u2029");
}

/** Render the HTML skeleton for the `/ask/<id>` page. `title` is
 * fixed to `"revkit — question"`; the record's own title lands
 * inside the island (which escapes it via Solid's text-node path).
 * Kept string-only so the daemon can wrap it with the same
 * hygiene headers it puts on every static HTML response. */
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
