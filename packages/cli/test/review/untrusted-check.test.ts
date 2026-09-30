// Test the `trust: "untrusted"` posture of `runCheck` end-to-end.
// Each vector in this file drives the SHIPPING code — the same
// `checkComponentRegistryFile` / `runCheck` the production CLI
// calls when reviewing a PR — and asserts a specific failure that
// would not fire in the default `trusted` mode.
//
// **The vectors** (PR #48 round-2 blocker 1):
//   1. Allow-annotation exempting `<Callout title={expr}/>` — the
//      RCE reproducer. `trusted` passes; `untrusted` refuses.
//   2. `{expression}` in flow position — already refused in trusted,
//      here as belt-and-braces.
//   3. `export const foo = …` — an ESM export that's not a plain
//      import.
//   4. `import` from `node:child_process`, an absolute path, a
//      relative path — all refused.
//   5. A vega-lite spec with `expr` / `signal` / `calculate` keys —
//      passes plot-structure in `trusted`; refused in `untrusted`.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, toCheckFiles } from "../../src/check.ts";
import type { GhRunner } from "../../src/gh-runner.ts";

const noopGh: GhRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });

/** Build a minimal repo skeleton where `runCheck` can run: a
 * package.json marker, a valid vocab, and the caller-supplied
 * files under `docs/`. Returns the repo root. */
function makeMiniRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-untrusted-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "vocab"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"revkit","private":true}');
  writeFileSync(
    join(dir, "vocab", "terms.yaml"),
    `schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: a stable pointer.\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

async function runFor(
  repoRoot: string,
  files: readonly string[],
  trust: "trusted" | "untrusted",
): Promise<{ exitCode: number; lines: readonly string[] }> {
  const abs = files.map((f) => join(repoRoot, f));
  const checkFiles = toCheckFiles(abs, repoRoot);
  return runCheck(repoRoot, checkFiles, [], {
    online: false,
    repoSlug: "vig-os/revkit",
    gh: noopGh,
    trust,
  });
}

describe("untrusted mode: allow-annotation escape hatch is DISABLED (RCE-shaped bypass)", () => {
  // The load-bearing test. If the escape hatch fires in untrusted
  // mode, a PR with `{/* revkit-allow: #1 */}\n<Callout
  // title={expr}/>` would smuggle a build-time expression past
  // every attribute guard. This test PROVES the shipping code
  // refuses that shape only in untrusted mode.
  const rcePr = `import { Callout } from "@revkit/components";

{/* revkit-allow: #1 */}

<Callout kind="info" title={globalThis.process.getBuiltinModule("node:child_process").execSync("id")}>
text
</Callout>
`;
  const rel = "docs/evil.mdx";
  test("trusted mode ACCEPTS the annotation-shielded expression attribute (proves the escape hatch is what does it)", async () => {
    const repo = makeMiniRepo({ [rel]: rcePr });
    try {
      const out = await runFor(repo, [rel], "trusted");
      expect(out.exitCode).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test("untrusted mode REFUSES the same file with a specific attribute-expression diagnostic", async () => {
    const repo = makeMiniRepo({ [rel]: rcePr });
    try {
      const out = await runFor(repo, [rel], "untrusted");
      expect(out.exitCode).toBe(1);
      // The rule points at the attribute-expression rule.
      expect(out.lines.some((l) => l.includes("non-static expression"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("untrusted mode: `{expression}` in flow position is refused (defence in depth)", () => {
  // Already refused in trusted, too. This test just documents the
  // shape — the untrusted-mode assertion is redundant here but
  // proves the rule still fires under the flipped flag.
  const src = `import { Callout } from "@revkit/components";

{globalThis.eval("1")}
<Callout kind="info" title="ok">x</Callout>
`;
  const rel = "docs/expr.mdx";
  test("untrusted refuses the top-level `{expr}` node", async () => {
    const repo = makeMiniRepo({ [rel]: src });
    try {
      const out = await runFor(repo, [rel], "untrusted");
      expect(out.exitCode).toBe(1);
      expect(out.lines.some((l) => l.includes("expression in content is not allowed"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("untrusted mode: `export const …` and unknown imports are refused", () => {
  test("`export const foo = …` refused", async () => {
    const rel = "docs/exp.mdx";
    const src = `import { Callout } from "@revkit/components";

export const evil = 1;

<Callout kind="info" title="ok">x</Callout>
`;
    const repo = makeMiniRepo({ [rel]: src });
    try {
      const out = await runFor(repo, [rel], "untrusted");
      expect(out.exitCode).toBe(1);
      expect(out.lines.some((l) => l.includes("`export`"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test.each([
    ["node:child_process", `import cp from "node:child_process";`],
    ["/etc/passwd", `import x from "/etc/passwd";`],
    ["../../evil.ts", `import x from "../../evil.ts";`],
  ])("import from %s is refused", async (_desc, importLine) => {
    const rel = "docs/imp.mdx";
    const src = `import { Callout } from "@revkit/components";
${importLine}

<Callout kind="info" title="ok">x</Callout>
`;
    const repo = makeMiniRepo({ [rel]: src });
    try {
      const out = await runFor(repo, [rel], "untrusted");
      expect(out.exitCode).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("untrusted mode: vega-lite executable keys refused", () => {
  const trustedSpecPath = "plots/ok/spec.vl.json";
  const badSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { name: "table" },
    mark: "bar",
    transform: [{ calculate: "1+1", as: "z" }],
    encoding: { x: { field: "x", type: "quantitative" } },
  };

  test("trusted mode does NOT flag the executable key (proves the untrusted rule is what refuses it)", async () => {
    const repo = makeMiniRepo({});
    mkdirSync(join(repo, "plots", "ok"), { recursive: true });
    writeFileSync(join(repo, trustedSpecPath), JSON.stringify(badSpec));
    // Also drop a stub data file so plot-structure doesn't
    // complain about a missing data.url.
    writeFileSync(join(repo, "plots", "ok", "data.json"), "[]");
    try {
      const out = await runFor(repo, [trustedSpecPath], "trusted");
      // The plot may still fail schema validation (missing data
      // fields) — we only care that the `calculate` string does
      // not itself surface a plot-structure diagnostic in trusted
      // mode. The untrusted rule adds a diagnostic pointing at
      // "'calculate'"; the trusted run must never mention it.
      expect(out.lines.every((l) => !l.includes("'calculate'"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("untrusted mode refuses `calculate`", async () => {
    const repo = makeMiniRepo({});
    mkdirSync(join(repo, "plots", "ok"), { recursive: true });
    writeFileSync(join(repo, trustedSpecPath), JSON.stringify(badSpec));
    writeFileSync(join(repo, "plots", "ok", "data.json"), "[]");
    try {
      const out = await runFor(repo, [trustedSpecPath], "untrusted");
      expect(out.exitCode).toBe(1);
      expect(out.lines.some((l) => l.includes("'calculate'"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("untrusted mode refuses `expr` inside `params`", async () => {
    const rel = "plots/exp/spec.vl.json";
    const spec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { name: "t" },
      mark: "line",
      params: [{ name: "p", expr: "utcnow()" }],
      encoding: {},
    };
    const repo = makeMiniRepo({});
    mkdirSync(join(repo, "plots", "exp"), { recursive: true });
    writeFileSync(join(repo, rel), JSON.stringify(spec));
    writeFileSync(join(repo, "plots", "exp", "data.json"), "[]");
    try {
      const out = await runFor(repo, [rel], "untrusted");
      expect(out.exitCode).toBe(1);
      expect(out.lines.some((l) => l.includes("expr"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
