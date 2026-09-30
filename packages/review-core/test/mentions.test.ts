// Mention parser tests (ADR-0011).
//
// Cover: happy paths for every actor kind, `@agent now` detection,
// word-boundary rules, code-mask (fenced + inline), non-overlap.

import { describe, expect, test } from "bun:test";
import { addressesAgent, hasAgentNow, parseMentions } from "../src/mentions.ts";

describe("parseMentions", () => {
  test("classifies each ADR-0011 actor kind", () => {
    const scan = parseMentions(
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

  test("`@agent now` fires the extra marker AND the bare agent mention", () => {
    const scan = parseMentions("Please @agent now — take this over.");
    const kinds = scan.mentions.map((m) => m.kind);
    expect(kinds).toEqual(["agent", "agent-now"]);
    expect(scan.hasAgentNow).toBe(true);
    expect(scan.addressesAgent).toBe(true);
  });

  test("`@claude now` also fires @agent now (hosted alias)", () => {
    expect(hasAgentNow("hey @claude now, ack this")).toBe(true);
  });

  test("`@agent:web now` still fires the marker for named agents", () => {
    const scan = parseMentions("Reroute to @agent:web now.");
    expect(scan.hasAgentNow).toBe(true);
    expect(scan.mentions.find((m) => m.kind === "agent")?.id).toBe("agent:web");
  });

  test("bare `now` (no @agent) is not a marker", () => {
    const scan = parseMentions("Please look now, no rush.");
    expect(scan.hasAgentNow).toBe(false);
    expect(scan.addressesAgent).toBe(false);
    expect(scan.mentions).toEqual([]);
  });

  test("email-shaped `foo@bar` is not a mention", () => {
    const scan = parseMentions("Reach me at foo@bar for that.");
    expect(scan.mentions).toEqual([]);
  });

  test("`@` inside inline code does NOT match", () => {
    const scan = parseMentions("The token `@agent` is not a mention here.");
    expect(scan.mentions).toEqual([]);
  });

  test("`@` inside a fenced code block does NOT match", () => {
    const body = [
      "example:",
      "```",
      "route by @agent now",
      "```",
      "outside: @agent now",
    ].join("\n");
    const scan = parseMentions(body);
    // Exactly one @agent + one agent-now marker (outside the fence).
    expect(scan.mentions.map((m) => m.kind)).toEqual(["agent", "agent-now"]);
  });

  test("triple backticks with info string are still masked", () => {
    const body = "```ts\n@agent now\n```";
    const scan = parseMentions(body);
    expect(scan.mentions).toEqual([]);
  });

  test("mixed backticks: N opening backticks close on N matching backticks", () => {
    const body = "`` @agent `` cannot use `` inside ``";
    const scan = parseMentions(body);
    // The `` @agent `` span is code; no @agent match.
    expect(scan.mentions).toEqual([]);
  });

  test("range on the mention covers the exact `@…` slice", () => {
    const body = "cc @octo!";
    const scan = parseMentions(body);
    const mention = scan.mentions[0]!;
    expect(body.slice(mention.range[0], mention.range[1])).toBe("@octo");
  });

  test("multiple `@agent` mentions each fire once", () => {
    const scan = parseMentions("@agent one, @agent two");
    expect(scan.mentions.filter((m) => m.kind === "agent")).toHaveLength(2);
  });

  test("trailing `-` on a login is trimmed off (matches GitHub rules)", () => {
    const scan = parseMentions("Ping @octo-!");
    // The `-` is not part of the id.
    expect(scan.mentions[0]?.id).toBe("octo");
  });

  test("id runs over 39 chars are refused (not a mention)", () => {
    const long = "a".repeat(40);
    const scan = parseMentions(`Hi @${long}.`);
    expect(scan.mentions).toEqual([]);
  });

  test("`@` at start of body is a word boundary", () => {
    const scan = parseMentions("@octo start");
    expect(scan.mentions[0]?.id).toBe("octo");
  });

  test("addressesAgent convenience matches parseMentions result", () => {
    expect(addressesAgent("hey @agent")).toBe(true);
    expect(addressesAgent("hey there")).toBe(false);
    expect(addressesAgent("`@agent`")).toBe(false);
  });

  test("mention ranges advance monotonically", () => {
    // Every mention starts at or after the previous mention's start.
    // The `agent-now` marker shares its start with the preceding
    // `agent` mention (both cover the `@agent` fragment plus the
    // trailing ` now`), so we assert on start-order, not on strict
    // non-overlap.
    const scan = parseMentions("@a @b @agent now @c");
    let previousStart = -1;
    for (const mention of scan.mentions) {
      expect(mention.range[0]).toBeGreaterThanOrEqual(previousStart);
      previousStart = mention.range[0];
    }
    // Sanity: `@a` and `@c` are `gh-user` (the parser does not
    // require a valid GitHub login — one-char logins are permitted
    // by our shape). The `@agent now` fires two entries: the bare
    // `@agent` mention + the `agent-now` marker.
    expect(scan.mentions.map((m) => m.kind)).toEqual([
      "gh-user",
      "gh-user",
      "agent",
      "agent-now",
      "gh-user",
    ]);
  });

  test("agent-now bypass: an `@agent now` in the body is enough to route", () => {
    // The parser proves the routing token exists; the daemon uses
    // `hasAgentNow` to decide whether to flush the batch. This test
    // is the routing-side regression: any change that stops the
    // parser from firing on `@agent now` fails here AND breaks the
    // handover bypass in `daemon.ts:appendAndReturn`.
    expect(hasAgentNow("Please @agent now")).toBe(true);
    expect(hasAgentNow("Please @agent later")).toBe(false);
    expect(hasAgentNow("Please `@agent now`")).toBe(false);
  });
});
