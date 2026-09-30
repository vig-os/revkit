// Daemon-side mention parser tests (M2 item 6 round 2).
//
// The round-1 parser scanned characters — it misfired on `\@agent`,
// 4-space indented code, `<code>`, HTML comments and mismatched
// backticks. Round 2 uses `remark-parse` to walk the Markdown AST
// and extract mentions from PROSE ONLY. These tests are the
// regression net for every one of those misfire cases.

import { describe, expect, test } from "bun:test";
import { extractMentions, hasAgentNow, addressesAgent } from "../../src/serve/mentions.ts";

describe("extractMentions — happy path", () => {
  test("classifies each ADR-0011 actor kind", () => {
    const scan = extractMentions(
      "@octo replied. cc @author, @reviewers, @owners. teams: @acme/core. agent: @agent, @agent:web, @claude.",
    );
    const kinds = scan.mentions.map((m) => `${m.kind}:${m.id}`);
    expect(kinds).toEqual([
      "gh-user:octo",
      "role:author",
      "role:reviewers",
      "role:owners",
      "team:acme/core",
      "agent:agent",
      "agent:agent:web",
      "agent:claude",
    ]);
    expect(scan.addressesAgent).toBe(true);
    expect(scan.hasAgentNow).toBe(false);
  });

  test("`@agent now` fires the marker AND the bare agent mention", () => {
    const scan = extractMentions("Please @agent now — take this over.");
    const kinds = scan.mentions.map((m) => m.kind);
    expect(kinds).toEqual(["agent", "agent-now"]);
    expect(scan.hasAgentNow).toBe(true);
  });

  test("`@claude now` also fires (hosted alias)", () => {
    expect(hasAgentNow("hey @claude now, ack this")).toBe(true);
  });
});

describe("extractMentions — misfires prevented (round-2 blockers)", () => {
  test("backslash-escaped `\\@agent` is NOT a mention", () => {
    // CommonMark: `\@` is a literal `@` — the parser sees it as a
    // text char, not a mention start. The old character-scan
    // parser fired on it.
    const scan = extractMentions("literal \\@agent should not fire");
    expect(scan.mentions).toEqual([]);
    expect(scan.addressesAgent).toBe(false);
  });

  test("`\\@agent now` also does not fire the marker", () => {
    expect(hasAgentNow("\\@agent now, please")).toBe(false);
  });

  test("mention inside inline `<code>` HTML is NOT extracted", () => {
    // `<code>...</code>` is inline HTML — remark walks it as an
    // `html` node, and this parser skips html subtrees.
    const scan = extractMentions("The tag <code>@agent now</code> is documentation.");
    expect(scan.mentions).toEqual([]);
  });

  test("mention inside an HTML comment is NOT extracted", () => {
    const scan = extractMentions("<!-- @agent now — hidden note --> visible text");
    // The `@agent now` is inside the comment, not fired.
    expect(scan.mentions).toEqual([]);
  });

  test("mention inside a 4-space indented code block is NOT extracted", () => {
    // In CommonMark, four spaces at the start of a line begin an
    // indented code block — its content is code, not prose.
    const body = ["prose above", "", "    @agent now inside indented code", "", "prose below @user1"].join("\n");
    const scan = extractMentions(body);
    // Only the trailing `@user1` fires.
    expect(scan.mentions.map((m) => m.id)).toEqual(["user1"]);
  });

  test("mention inside a fenced ``` code block is NOT extracted", () => {
    const body = ["prose", "```", "route @agent now", "```", "@octo"].join("\n");
    const scan = extractMentions(body);
    expect(scan.mentions.map((m) => m.id)).toEqual(["octo"]);
  });

  test("mismatched backticks: an unterminated inline code span does NOT swallow the whole rest of the body", () => {
    // Round-1 bug: mismatched backticks pattern was fragile. The
    // real AST handles this: `` ` @agent `` at end of a paragraph
    // is EITHER a valid code span (if closed within the paragraph)
    // or literal text (if not). remark-parse's judgement is what
    // decides.
    //
    // Case A: closed span → the whole content is code and no mention fires.
    const scanA = extractMentions("here is `code with @agent inside` and outside @octo.");
    expect(scanA.mentions.map((m) => m.id)).toEqual(["octo"]);
    // Case B: unterminated backtick (single ` alone) → remark
    // treats it as literal text, so `@agent` after it fires.
    const scanB = extractMentions("stray backtick ` and then @agent now");
    expect(scanB.hasAgentNow).toBe(true);
  });

  test("mention in a link's TEXT still fires; mention in a link's URL does not", () => {
    // The text of a Markdown link IS prose. `[@agent](https://…)`
    // resolves the text node under the link and fires.
    const scanText = extractMentions("[hey @agent now](https://example.org/x)");
    expect(scanText.hasAgentNow).toBe(true);
    // The URL text is not a prose text node — the parser walks
    // link.children (the text), not the destination.
    const scanUrl = extractMentions("see [docs](https://example.org/@agent)");
    expect(scanUrl.mentions).toEqual([]);
  });

  test("mention inside an inline `code` span is NOT extracted", () => {
    const scan = extractMentions("The token `@agent now` is documentation.");
    expect(scan.mentions).toEqual([]);
  });

  test("email-shaped `foo@bar` is NOT a mention", () => {
    const scan = extractMentions("Reach me at foo@bar for that.");
    expect(scan.mentions).toEqual([]);
  });

  // ── Round-3 blockers on the mention parser ──────────────────

  test("ROUND 3: `<CODE>` (case-insensitive tag name) suppresses mentions", () => {
    // Round-2 pre-mask used `body.slice(i, i+5).toLowerCase()` but
    // only matched the literal casings the loop tried; a case-shift
    // could still slip through. Round-3 drops the mask and matches
    // tag names case-insensitively via `classifyHtml`.
    const scan = extractMentions("prose <CODE>@agent now</CODE> after");
    expect(scan.mentions).toEqual([]);
  });

  test("ROUND 3: `<codebase>` is NOT treated as `<code>` (prefix-match fixed)", () => {
    // Round-2 mask fired on any `<code…>`, including `<codebase>`,
    // and swallowed the whole rest of the paragraph. Round-3
    // matches tag NAME exactly (word-anchored).
    const scan = extractMentions("see <codebase>x</codebase> and @octo");
    // remark-parse still emits `<codebase>` as an html node the
    // walker skips, but `@octo` in the surrounding prose fires.
    expect(scan.mentions.map((m) => m.id)).toEqual(["octo"]);
  });

  test("ROUND 3: `<preview>` is NOT treated as `<pre>` (prefix-match fixed)", () => {
    const scan = extractMentions("see <preview>x</preview> and @octo");
    expect(scan.mentions.map((m) => m.id)).toEqual(["octo"]);
  });

  test("ROUND 3: an unclosed `<code>` does not swallow the entire rest of the body", () => {
    // Round-2 mask had a fallback: unterminated `<code>` masked
    // everything to end-of-body. That deleted legitimate later
    // mentions. Round-3 uses AST siblings — an unmatched `<code>`
    // open tag leaves the code-depth pinned at 1 for the rest of
    // that paragraph but the next paragraph is a fresh container
    // and clears it. Even the misclassification is bounded (one
    // paragraph, not the whole body).
    const body =
      "para one has <code>a and @agent should not fire here\n\n" +
      "para two: @octo should still fire";
    const scan = extractMentions(body);
    expect(scan.mentions.map((m) => m.id)).toEqual(["octo"]);
  });

  test("ROUND 3: an unclosed HTML comment does not swallow later mentions across paragraphs", () => {
    // Round-2 mask ate everything up to EOF on an unterminated
    // `<!--`. Round-3 relies on remark's own tokenisation — an
    // unterminated `<!--` in one paragraph is bounded by
    // paragraph structure; the mentions in the next paragraph
    // fire normally.
    const body = "para one: <!-- @agent now not closed here\n\npara two: @octo";
    const scan = extractMentions(body);
    // At MINIMUM `@octo` in the second paragraph fires — the
    // mention parser must not delete every later mention just
    // because a comment was unclosed.
    const ids = scan.mentions.map((m) => m.id);
    expect(ids).toContain("octo");
  });

  test("ROUND 3: nested `<code><code>@agent</code></code>` — text is suppressed", () => {
    // The sibling stack tracks depth, so nested tags close
    // correctly.
    const scan = extractMentions("<code><code>@agent</code></code>");
    expect(scan.mentions).toEqual([]);
  });

  test("ROUND 3: `<code>@agent</code> @octo` — text OUTSIDE the tag pair still fires", () => {
    const scan = extractMentions("<code>@agent</code> @octo");
    // Only @octo fires — @agent is between the sibling code tags.
    expect(scan.mentions.map((m) => m.id)).toEqual(["octo"]);
  });
});

describe("extractMentions — bounds + shapes", () => {
  test("range on the mention covers the exact `@…` slice of the ORIGINAL body", () => {
    const body = "cc @octo!";
    const scan = extractMentions(body);
    const mention = scan.mentions[0]!;
    expect(body.slice(mention.range[0], mention.range[1])).toBe("@octo");
  });

  test("id length cap at 39 chars (matches GitHub)", () => {
    const long = "a".repeat(40);
    const scan = extractMentions(`Hi @${long}.`);
    expect(scan.mentions).toEqual([]);
  });

  test("trailing `-` on an id is trimmed", () => {
    const scan = extractMentions("Ping @octo-!");
    expect(scan.mentions[0]?.id).toBe("octo");
  });

  test("addressesAgent convenience matches extractMentions result", () => {
    expect(addressesAgent("hey @agent")).toBe(true);
    expect(addressesAgent("hey there")).toBe(false);
    expect(addressesAgent("`@agent`")).toBe(false);
  });
});
