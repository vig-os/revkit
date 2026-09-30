// Regression + acceptance test for the skill's tool-call examples
// (PR-56 round-2 blocker 4).
//
// The consumer skill teaches the loop through concrete JSON tool
// calls under `// tool: <name>` fences. The round-2 review caught
// three claims that drifted from the code — `docs[].revision`
// where the API returns `published[].revision`, a `revision`
// field on `reply` that the strict zod schema refuses, and
// prose that promises a background build the daemon never runs.
//
// This test scans the SKILL.md for every `// tool: <name>` code
// block, parses the JSON body, and validates it against the SAME
// zod schema the MCP channel server enforces at runtime. A drift
// on either side (SKILL prose vs. code) turns the test red before
// the SKILL reaches a consumer's repo.
//
// RED on 1b66011e: the round-1 SKILL text advertised an off
// schema field on reply that strict zod parsing rejects — this
// test would have caught it before the SKILL shipped.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ZodSchema } from "zod";
import {
  askArgsSchema,
  awaitAnswerArgsSchema,
  modeArgsSchema,
  presenceArgsSchema,
  publishArgsSchema,
  replyArgsSchema,
  resolveArgsSchema,
  reviewUrlArgsSchema,
  threadsArgsSchema,
} from "../src/mcp/channel-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "templates/skills/revkit/SKILL.md",
);

const SCHEMAS: Record<string, ZodSchema> = {
  publish: publishArgsSchema,
  threads: threadsArgsSchema,
  reply: replyArgsSchema,
  resolve: resolveArgsSchema,
  review_url: reviewUrlArgsSchema,
  ask: askArgsSchema,
  await_answer: awaitAnswerArgsSchema,
  mode: modeArgsSchema,
  presence: presenceArgsSchema,
};

interface Example {
  readonly toolName: string;
  readonly body: unknown;
  readonly lineNumber: number;
}

/** Strip `//` line comments outside JSON string literals. Walks
 * the source with a small state machine so `http://…` inside a
 * `"…"` string does NOT get eaten. `/*…*\/` block comments are
 * also stripped (the SKILL doesn't use them today, but a future
 * annotation might). */
function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      // Skip to end of line, but keep the newline itself so line
      // numbers stay meaningful in error messages.
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Scan the SKILL for `// tool: <name>\n<json>` fenced blocks.
 * The parser tolerates JSONC-style `//` line comments (the SKILL
 * uses them to annotate optional fields). */
function extractExamples(md: string): Example[] {
  const out: Example[] = [];
  const fenceRe = /```jsonc?\n\/\/ tool: (\S+)\n([\s\S]*?)```/g;
  const lines = md.split("\n");
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(md)) !== null) {
    const toolName = match[1]!;
    const jsonc = match[2]!;
    // Line number of the opening fence — used in error messages.
    const upTo = md.slice(0, match.index);
    const lineNumber = upTo.split("\n").length;
    // Strip `//`-style line comments outside strings. Walk the
    // string with a tiny state machine so an `http://` in a JSON
    // string value doesn't get eaten.
    const stripped = stripJsoncComments(jsonc)
      // Remove trailing commas — JSONC allows them, JSON does not.
      .replace(/,\s*(\}|\])/g, "$1");
    let body: unknown;
    try {
      body = JSON.parse(stripped);
    } catch (error) {
      throw new Error(
        `SKILL.md:${lineNumber}: '${toolName}' example is not valid JSON after comment strip: ${(error as Error).message}\n${stripped}`,
      );
    }
    out.push({ toolName, body, lineNumber });
  }
  // Sanity check: the loop above must find at least the tools we
  // know are documented. A regression that drops all fences would
  // otherwise silently pass.
  if (out.length === 0) {
    throw new Error("SKILL.md: no `// tool:` fenced examples found — extractor regex is stale.");
  }
  return out;
}

describe("SKILL.md tool-call examples validate against zod schemas", () => {
  const md = readFileSync(SKILL_PATH, "utf8");
  const examples = extractExamples(md);

  for (const example of examples) {
    test(`${example.toolName} @ line ${example.lineNumber} validates`, () => {
      const schema = SCHEMAS[example.toolName];
      expect(schema).toBeDefined();
      if (schema === undefined) return;
      const result = schema.safeParse(example.body);
      if (!result.success) {
        // Fail with a message that says what the schema wanted so
        // the doc author can fix the example (or the schema).
        throw new Error(
          `SKILL.md ${example.toolName} example failed validation: ${JSON.stringify(result.error.issues, null, 2)}\nBody: ${JSON.stringify(example.body, null, 2)}`,
        );
      }
    });
  }

  test("every documented MCP tool has at least one example", () => {
    const documented = new Set(examples.map((e) => e.toolName));
    const missing: string[] = [];
    // The 9 tools revkit's MCP server exposes. `mode` and
    // `presence` do not always warrant an example (mode is
    // no-args; presence is one shape) but their absence used to
    // hide the round-1 SKILL gap, so we assert the SKILL at
    // least MENTIONS each.
    const expected = ["publish", "threads", "reply", "resolve", "review_url", "ask", "await_answer"];
    for (const tool of expected) {
      if (!documented.has(tool)) missing.push(tool);
    }
    expect(missing).toEqual([]);
  });

  test("the SKILL text does NOT claim a background build the daemon does not run", () => {
    // Round-2 review: the SKILL's earlier text said "the background
    // full build catches up", but nothing in the daemon triggers a
    // build. The prose now says the human reruns `bun run build`.
    expect(md).not.toMatch(/background full build catches up/);
    expect(md).toMatch(/bun run build|astro build/);
  });

  test("the SKILL's 'publish returns' claim matches the code (`published[].revision`)", () => {
    // Old text said `docs[].revision` — code returns
    // `published[].revision`. Any regression here would mis-teach
    // consumers.
    expect(md).toMatch(/published\[\]\.revision/);
    expect(md).not.toMatch(/docs\[\]\.revision/);
  });

  test("the SKILL does NOT advertise a `revision` field on `reply`", () => {
    // replyArgsSchema uses `.strict()` — extra keys are refused,
    // so an example advertising a revision would 400. This regex
    // catches the specific claim from the round-1 SKILL text.
    expect(md).not.toMatch(/reply.*accepts.*revision|revision.*optional field on `reply`/);
  });
});
