// The preview-path grammar (ADR-0008: `review.exoma.org/<repo>/pr-<n>/`).
//
// Pure functions, so this is exhaustive rather than representative: the
// whole point of separating the recogniser from the serving is that every
// shape can be tried here, with no Worker, no account and no R2.
//
// These paths are the isolation boundary ADR-0012 leans on. A `..` or a
// second spelling of one path that both resolve would let one repo's
// preview address another's key, so the refusal cases are asserted as
// directly as the accepted ones.

import { describe, expect, test } from "bun:test";
import { API_SEGMENT, REVKIT_BUNDLE_ROOT, REVKIT_SEGMENT, isRevkitBundlePath, parsePreviewPath } from "../src/router.ts";

describe("parsePreviewPath — accepted", () => {
  test("the canonical shape", () => {
    expect(parsePreviewPath("/revkit/pr-7")).toEqual({ repo: "revkit", pr: 7, pathname: "/revkit/pr-7" });
  });

  test("a trailing path — the built site inside the preview", () => {
    const parsed = parsePreviewPath("/vig-os.revkit/pr-102/index.html");
    expect(parsed?.repo).toBe("vig-os.revkit");
    expect(parsed?.pr).toBe(102);
    expect(parsed?.pathname).toBe("/vig-os.revkit/pr-102/index.html");
  });

  test("a trailing slash", () => {
    expect(parsePreviewPath("/revkit/pr-7/")?.pr).toBe(7);
  });

  test("dots and dashes and digits in the repo segment", () => {
    for (const repo of ["revkit", "my-repo", "my.repo", "a", "a1", "repo-2.0"]) {
      expect(parsePreviewPath(`/${repo}/pr-1`)?.repo).toBe(repo);
    }
  });

  test("the largest PR number the grammar admits", () => {
    expect(parsePreviewPath("/revkit/pr-999999999")?.pr).toBe(999999999);
  });
});

describe("parsePreviewPath — refused", () => {
  test("non-preview routes", () => {
    for (const path of ["/", "/healthz", "/api/threads", "/api", "/nope", "/revkit", "/revkit/"]) {
      expect(parsePreviewPath(path)).toBeUndefined();
    }
  });

  test("the reserved first segments are never previews", () => {
    expect(parsePreviewPath(`/${REVKIT_SEGMENT}/pr-1`)).toBeUndefined();
    expect(parsePreviewPath(`/${API_SEGMENT}/pr-1`)).toBeUndefined();
  });

  test("traversal, encoded or literal", () => {
    for (const path of [
      "/../revkit/pr-1",
      "/revkit/../etc",
      "/revkit/pr-1/../../admin",
      "/%2e%2e/revkit/pr-1",
      "/revkit/pr-1%2f..%2f..",
      "/%2E%2E/revkit/pr-1",
      "/revkit%5c..%5cpr-1",
    ]) {
      expect(parsePreviewPath(path)).toBeUndefined();
    }
  });

  test("a doubled slash — two spellings of one path must not both resolve", () => {
    expect(parsePreviewPath("//revkit/pr-1")).toBeUndefined();
    expect(parsePreviewPath("/revkit//pr-1")).toBeUndefined();
    expect(parsePreviewPath("/revkit/pr-1//index.html")).toBeUndefined();
  });

  test("a nested repo segment is not a repo segment", () => {
    expect(parsePreviewPath("/vig-os/revkit/pr-1")).toBeUndefined();
  });

  test("`.` and `..` as the repo segment", () => {
    expect(parsePreviewPath("/./pr-1")).toBeUndefined();
    expect(parsePreviewPath("/../pr-1")).toBeUndefined();
  });

  test("a repo segment outside the allowed character set", () => {
    for (const repo of ["re vkit", "revkit!", "re%2Fvit", "révkit", "-leading-dash"]) {
      expect(parsePreviewPath(`/${repo}/pr-1`)).toBeUndefined();
    }
  });

  test("the repo segment is capped at 100 characters, and the boundary is accepted", () => {
    expect(parsePreviewPath(`/${"a".repeat(100)}/pr-1`)).toBeDefined();
    expect(parsePreviewPath(`/${"a".repeat(101)}/pr-1`)).toBeUndefined();
  });

  test("a PR segment that is not `pr-<positive integer>`", () => {
    for (const segment of ["pr-", "pr-0", "pr--1", "pr-1a", "pr-01", "PR-1", "pr- 1", "pr-1.0", "1", "pr"]) {
      expect(parsePreviewPath(`/revkit/${segment}`)).toBeUndefined();
    }
  });

  test("an over-long PR number", () => {
    expect(parsePreviewPath("/revkit/pr-1234567890")).toBeUndefined();
  });

  test("a path with no leading slash is not a path", () => {
    expect(parsePreviewPath("revkit/pr-1")).toBeUndefined();
    expect(parsePreviewPath("")).toBeUndefined();
  });
});

describe("isRevkitBundlePath", () => {
  test("recognises the bundle root and everything under it", () => {
    expect(isRevkitBundlePath("/_revkit")).toBe(true);
    expect(isRevkitBundlePath("/_revkit/")).toBe(true);
    expect(isRevkitBundlePath("/_revkit/0.0.0/rail.js")).toBe(true);
  });

  test("does not claim a preview or an API path", () => {
    expect(isRevkitBundlePath("/revkit/pr-1")).toBe(false);
    expect(isRevkitBundlePath("/api/threads")).toBe(false);
    // A prefix match, not a string prefix: `/_revkitfoo` is not revkit's.
    expect(isRevkitBundlePath("/_revkitfoo/bar.js")).toBe(false);
    expect(REVKIT_BUNDLE_ROOT).toBe("/_revkit/");
  });
});
