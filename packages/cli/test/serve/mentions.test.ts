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
