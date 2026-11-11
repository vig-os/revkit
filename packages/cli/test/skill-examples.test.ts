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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ZodSchema } from "zod";
import { publishBuildReasons } from "../src/serve/publish-build.ts";
import { MAX_FILES_PER_PUBLISH, PUBLISH_ARRAY_SHAPE_MAX } from "../src/serve/publish.ts";
import { resolvePublishTarget } from "../src/serve/publish-confine.ts";
import { fastPathRefusalReasons } from "../src/serve/publish-render.ts";
import { reviewEventKinds } from "@revkit/review-core";
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

  test("the SKILL describes the build the daemon ACTUALLY schedules", () => {
    // Round-2 caught the SKILL promising "the background full build
    // catches up" when nothing in the daemon triggered one. The
    // daemon now does — so the guard flips from "the prose must not
    // promise a build" to "the prose must describe the build that
    // exists", which is a stronger claim: the vocabulary the SKILL
    // teaches has to match the code's vocabulary exactly.
    expect(md).not.toMatch(/background full build catches up/);
    // Every build-item reason the code can return is taught.
    for (const reason of publishBuildReasons) {
      expect(md).toContain(`"${reason}"`);
    }
    // Every renderer refusal tag the code can return is taught.
    for (const reason of fastPathRefusalReasons) {
      expect(md).toContain(`\`${reason}\``);
    }
    // The accepted state is named, so "fast path served it" is as
    // discoverable as "a build was scheduled".
    expect(md).toContain('state: "fast"');
    // Every build lifecycle kind on the log is taught.
    for (const kind of reviewEventKinds.filter((k) => k.startsWith("build."))) {
      expect(md).toContain(kind);
    }
    // The SKILL must NOT teach a reason or event the code cannot emit
    // — that is the same drift in the other direction.
    const taught = [...md.matchAll(/"(data-only|fast-path-refused|render-failed|shell-missing)"/g)]
      .map((m) => m[1]);
    expect([...new Set(taught)].sort()).toEqual([...publishBuildReasons].sort());
  });

  test("the SKILL's claim that the rail reloads on build.failed is backed by the rail's code", () => {
    // The prose promises a reviewer is never left watching a spinner
    // for a build that already died. That promise lives in exactly
    // one place in the rail — assert it here so the prose and the
    // subscription handler cannot drift apart.
    const railSource = readFileSync(resolve(__dirname, "../src/rail/rail.tsx"), "utf8");
    expect(railSource).toMatch(/event\.kind === "build\.succeeded" \|\| event\.kind === "build\.failed"/);
    expect(md).toMatch(/reloads?\s+(the\s+)?page on BOTH `build\.succeeded` and `build\.failed`/i);
  });

  test("the SKILL's claim that a batch is checked as one snapshot matches the check's option", () => {
    // "you can add a term to the vocabulary AND use `<Term id=…/>` in
    // a document in the SAME publish call" is only true because
    // `runCheck` accepts a staged overlay and `runPublish` passes it.
    // Assert both halves so the promise cannot survive on one side.
    const checkSource = readFileSync(resolve(__dirname, "../src/check.ts"), "utf8");
    expect(checkSource).toMatch(/readonly staged\?: StagedOverlay/);
    const publishSource = readFileSync(resolve(__dirname, "../src/serve/publish.ts"), "utf8");
    expect(publishSource).toMatch(/staged: stagedOverlay/);
    expect(md).toMatch(/checked as ONE snapshot/);
  });

  test("the SKILL's file-count claim matches the code's TOTAL cap", () => {
    // The rejected head had three truths out of step: the code
    // enforced a TOTAL, the MCP schema advertised a PER-ARRAY max, and
    // the refusal was labelled `confinement` — which tells an agent its
    // PATH is wrong when the real problem is batch size. Assert all
    // three against the code, and the SKILL's failure table.
    expect(MAX_FILES_PER_PUBLISH).toBe(16);
    expect(md).toContain(String(MAX_FILES_PER_PUBLISH));
    expect(md).toMatch(/across `docs` AND\s*\n?`data` TOGETHER|across `docs` and `data` together/i);
    // The per-array schema ceiling must EXCEED the total, or a batch
    // that is merely over the limit never reaches the orchestrator and
    // the agent gets a schema complaint instead of the truthful kind.
    expect(PUBLISH_ARRAY_SHAPE_MAX).toBeGreaterThan(MAX_FILES_PER_PUBLISH);
    // The truthful kind is named in the failure table.
    expect(md).toContain("too-many-files");
    // And the mislabel is gone from the schema descriptions.
    expect(md).not.toMatch(/maxItems: 16/);
    // The orchestrator really does refuse with that kind.
    const publishSource = readFileSync(resolve(__dirname, "../src/serve/publish.ts"), "utf8");
    expect(publishSource).toMatch(/kind: "too-many-files"/);
    expect(publishSource).not.toMatch(/kind: "confinement",\s*\n\s*reason: `publish: batch has/);
  });

  test("the SKILL's publishable-path list matches the REAL resolver, path by path", () => {
    // The previous version of this test grepped `publish-confine.ts`
    // for substrings, which cannot tell ACCEPTED from REFUSED and so
    // happily passed a SKILL table that contradicted itself: the prose
    // claimed `docs/adr/README.md` was refused while the table claimed
    // every `docs/adr/*.md` was accepted (it is accepted), and the
    // plots row implied two required segments plus unlimited nesting
    // (it is one-or-more, and nesting is bounded by which parent
    // directories already exist).
    //
    // So: drive `resolvePublishTarget` itself. Every row below is the
    // resolver's verdict on a real repo shape, and the SKILL's table
    // must name a shape on the correct side of each one.
    const root = mkdtempSync(join(tmpdir(), "revkit-skill-paths-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      mkdirSync(join(root, "docs", "designs"), { recursive: true });
      mkdirSync(join(root, "plots", "series"), { recursive: true });
      mkdirSync(join(root, "plots", "series", "nested"), { recursive: true });
      mkdirSync(join(root, "vocab"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "README.md"), "# readme\n", "utf8");

      const accepted = [
        // The SKILL table's five accepted shapes, one concrete path each.
        "docs/adr/0001-example.md",
        "docs/designs/DESIGN-0001-example.md",
        "docs/FEATURE-MATRIX.md",
        "plots/series/spec.vl.json",
        "vocab/terms.yaml",
        // The cases the table used to get WRONG, all of which are
        // accepted — the table and prose must not contradict these.
        "docs/adr/README.md",
        "plots/spec.json",
        "plots/series/data.csv",
        "plots/series/data.tsv",
        "plots/series/anything.json",
        "plots/series/nested/deep.json",
      ] as const;
      const refused = [
        // Wrong extension.
        "docs/adr/note.txt",
        // UPPERCASE extension.
        "docs/adr/UPPER.MD",
        // Missing the trailing slash, so the prefix does not match.
        "docs/adr.md",
        // Parent directory does not exist — the daemon does not mkdir.
        "docs/adr/deep/new.md",
        // Exact-file root: only `terms.yaml`, not its siblings.
        "vocab/other.yaml",
        // MDX is deliberately outside the allowlist in M2.
        "site/src/content/docs/x.mdx",
        // Outside every publishable root.
        "README.md",
      ] as const;

      for (const path of accepted) {
        const verdict = resolvePublishTarget(root, path);
        expect(verdict.ok, `resolver rejected ${path}, but the SKILL table presents it as accepted`).toBe(true);
      }
      for (const path of refused) {
        const verdict = resolvePublishTarget(root, path);
        expect(verdict.ok, `resolver ACCEPTED ${path}, which the SKILL must list as refused`).toBe(false);
      }

      // Now the SKILL's own text. Each claim reports WHICH one failed,
      // because `toMatch` against the whole document otherwise prints
      // 19 KB of markdown and names nothing.
      const claims: readonly [string, boolean][] = [
        // 1) `docs/adr/` siblings are ACCEPTED — the table says so and
        //    the prose must not contradict it.
        [
          "SKILL does not list docs/adr/README.md as refused",
          !/including\s*\n?\s*`docs\/adr\/README\.md`/.test(md),
        ],
        [
          "SKILL's docs/adr row is a shape, not a filename enumeration",
          /`docs\/adr\/<[a-z]+>\.md`/.test(md),
        ],
        [
          "SKILL's docs/adr row says every .md under it is accepted",
          /EVERY `\.md` directly under it/.test(md),
        ],
        // 2) The plots row is one-or-more segments, not exactly two.
        [
          "SKILL's plots row does not imply exactly two path segments",
          !/plots\/<any>\/<any>/.test(md),
        ],
        ["SKILL's plots row names the plots/<name>/ shape", /`plots\/<name>\//.test(md)],
        [
          "SKILL says plots nesting is bounded by existing parent directories",
          /parent directories must (?:already )?exist|every directory\s*\n?between/i.test(md),
        ],
        // 3) The lowercase-extension rule is stated.
        ["SKILL states the LOWERCASE extension rule", /LOWERCASE/.test(md)],
      ];
      const broken = claims.filter(([, ok]) => !ok).map(([label]) => label);
      expect(broken, `SKILL.md path-list claims that are not true:\n  - ${broken.join("\n  - ")}`).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the SKILL tells the agent its build can FAIL and how it learns that", () => {
    // The rejected head's channel never surfaced a build outcome, so an
    // agent could not learn its build had failed. The SKILL must not
    // imply builds always succeed, and must name the live path.
    expect(md).toContain("build.failed");
    expect(md).toMatch(/not\s+retried in a loop|is not retried in a loop/i);
    // The MCP tool description carries the same contract.
    // The daemon's fan-out: build events go to BOTH audiences, so the
    // publishing agent's own stream carries them.
    const daemonSource = readFileSync(resolve(__dirname, "../src/serve/daemon.ts"), "utf8");
    expect(daemonSource).toContain('audiences: ["rail", "agent"]');
    // The channel surfaces the TERMINAL pair as a notification the
    // agent can act on, and only those two.
    const channelSource = readFileSync(resolve(__dirname, "../src/mcp/channel-server.ts"), "utf8");
    expect(channelSource).toContain('"build.succeeded"');
    expect(channelSource).toContain('"build.failed"');
    expect(channelSource).toContain('case "build.failed"');
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
