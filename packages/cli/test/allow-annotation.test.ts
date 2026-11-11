// Escape-hatch shape tests + offline/online verification for the
// revkit-allow annotation (ADR-0005).
import { describe, expect, test } from "bun:test";
import {
  parseAllowAnnotation,
  verifyAllowAnnotationOnline,
} from "../src/allow-annotation.ts";
import type { GhRunner } from "../src/gh-runner.ts";

describe("parseAllowAnnotation (offline shape)", () => {
  test("accepts a well-formed comment interior", () => {
    const parsed = parseAllowAnnotation("/* revkit-allow: #42 */");
    expect(parsed).not.toBeNull();
    expect(parsed?.issue).toBe(42);
  });

  test("accepts extra whitespace around the marker", () => {
    const parsed = parseAllowAnnotation("  /*    revkit-allow:  #7    */  ");
    expect(parsed?.issue).toBe(7);
  });

  test("rejects a missing '#'", () => {
    expect(parseAllowAnnotation("/* revkit-allow: 42 */")).toBeNull();
  });

  test("rejects a zero or negative issue", () => {
    expect(parseAllowAnnotation("/* revkit-allow: #0 */")).toBeNull();
  });

  test("rejects trailing prose inside the comment", () => {
    expect(parseAllowAnnotation("/* revkit-allow: #7 (feature) */")).toBeNull();
  });

  test("rejects an unrelated JSX comment", () => {
    expect(parseAllowAnnotation("/* just a note */")).toBeNull();
  });
});

describe("verifyAllowAnnotationOnline (fake gh runner)", () => {
  const annotation = { issue: 42, raw: "/* revkit-allow: #42 */" } as const;

  test("passes when the issue is open and labeled component-request", async () => {
    const gh: GhRunner = async (args) => {
      expect(args[0]).toBe("api");
      expect(args[1]).toBe("repos/vig-os/revkit/issues/42");
      return {
        stdout: JSON.stringify({ state: "open", labels: ["component-request"] }),
        stderr: "",
        exitCode: 0,
      };
    };
    const result = await verifyAllowAnnotationOnline(annotation, "vig-os/revkit", gh);
    expect(result.kind).toBe("ok");
  });

  test("fails when the issue is closed", async () => {
    const gh: GhRunner = async () => ({
      stdout: JSON.stringify({ state: "closed", labels: ["component-request"] }),
      stderr: "",
      exitCode: 0,
    });
    const result = await verifyAllowAnnotationOnline(annotation, "vig-os/revkit", gh);
    expect(result.kind).toBe("bad");
    if (result.kind === "bad") expect(result.message).toContain("not open");
  });

  test("fails when the issue lacks the component-request label", async () => {
    const gh: GhRunner = async () => ({
      stdout: JSON.stringify({ state: "open", labels: ["bug"] }),
      stderr: "",
      exitCode: 0,
    });
    const result = await verifyAllowAnnotationOnline(annotation, "vig-os/revkit", gh);
    expect(result.kind).toBe("bad");
    if (result.kind === "bad") expect(result.message).toContain("component-request");
  });

  test("surfaces gh failures verbatim without swallowing stderr", async () => {
    const gh: GhRunner = async () => ({
      stdout: "",
      stderr: "gh: not authenticated",
      exitCode: 4,
    });
    const result = await verifyAllowAnnotationOnline(annotation, "vig-os/revkit", gh);
    expect(result.kind).toBe("bad");
    if (result.kind === "bad") expect(result.message).toContain("gh api failed");
  });

  test("rejects a nearby-but-not-exact label like 'component-requested'", async () => {
    const gh: GhRunner = async () => ({
      stdout: JSON.stringify({ state: "open", labels: ["component-requested"] }),
      stderr: "",
      exitCode: 0,
    });
    const result = await verifyAllowAnnotationOnline(annotation, "vig-os/revkit", gh);
    expect(result.kind).toBe("bad");
  });
});
