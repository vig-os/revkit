// Tests for the repo-docs loader's link rewriter (issue #6, PR #20 review).
// A markdown link in an ADR that points at a sibling ADR must resolve to
// the rendered site route; a link that points outside the rendered set
// (LICENSE, scripts/…) must resolve to a GitHub blob URL on `main`; every
// other href passes through untouched.
import { describe, expect, test } from "bun:test";
import { rewriteInternalMarkdownLinks, siteRouteForDoc } from "./repo-docs.ts";

const REPO_ROOT = "/repo";
const ADR_FILE = `${REPO_ROOT}/docs/adr/0001-static-first-site-stack.md`;
const MATRIX_FILE = `${REPO_ROOT}/docs/FEATURE-MATRIX.md`;
const DESIGN_FILE = `${REPO_ROOT}/docs/designs/DESIGN-0001-revkit-architecture.md`;

describe("siteRouteForDoc", () => {
  test("maps ADR sources to lowercased slug routes", () => {
    expect(siteRouteForDoc("docs/adr/0002-solid-islands-component-registry.md")).toBe(
      "/adr/0002-solid-islands-component-registry/",
    );
  });

  test("maps DESIGN sources to lowercased slug routes", () => {
    expect(siteRouteForDoc("docs/designs/DESIGN-0001-revkit-architecture.md")).toBe(
      "/designs/design-0001-revkit-architecture/",
    );
  });

  test("maps FEATURE-MATRIX.md to /feature-matrix/", () => {
    expect(siteRouteForDoc("docs/FEATURE-MATRIX.md")).toBe("/feature-matrix/");
  });

  test("returns null for files outside the rendered set", () => {
    expect(siteRouteForDoc("LICENSE")).toBeNull();
    expect(siteRouteForDoc("docs/COMMIT_MESSAGE_STANDARD.md")).toBeNull();
    expect(siteRouteForDoc("scripts/adr-index.sh")).toBeNull();
  });
});

describe("rewriteInternalMarkdownLinks", () => {
  test("rewrites a sibling ADR link to its rendered slug", () => {
    const html = '<p>See <a href="0002-solid-islands-component-registry.md">ADR-0002</a></p>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain('href="/adr/0002-solid-islands-component-registry/"');
    expect(out).not.toContain(".md");
  });

  test("rewrites a link with a fragment, preserving the anchor", () => {
    const html = '<p><a href="../designs/DESIGN-0001-revkit-architecture.md#3-content-model">DESIGN §3</a></p>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain('href="/designs/design-0001-revkit-architecture/#3-content-model"');
  });

  test("rewrites a ../FEATURE-MATRIX.md link to /feature-matrix/", () => {
    const html = '<p><a href="../FEATURE-MATRIX.md">feature matrix</a></p>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain('href="/feature-matrix/"');
  });

  test("rewrites the ADR README's link to a sibling ADR file", () => {
    const html = '<p><a href="0001-static-first-site-stack.md">ADR-0001</a></p>';
    const out = rewriteInternalMarkdownLinks(
      html,
      `${REPO_ROOT}/docs/adr/README.md`,
      REPO_ROOT,
    );
    expect(out).toContain('href="/adr/0001-static-first-site-stack/"');
  });

  test("routes an out-of-set .md link to a GitHub blob URL on main", () => {
    const html = '<p><a href="../COMMIT_MESSAGE_STANDARD.md">Commit standard</a></p>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain(
      'href="https://github.com/vig-os/revkit/blob/main/docs/COMMIT_MESSAGE_STANDARD.md"',
    );
  });

  test("leaves absolute URLs, mailto and same-page anchors untouched", () => {
    const html =
      '<a href="https://example.com/x">x</a> <a href="mailto:a@b">m</a> <a href="#a">n</a>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('href="mailto:a@b"');
    expect(out).toContain('href="#a"');
  });

  test("leaves non-markdown relative links (assets, scripts) untouched", () => {
    const html = '<a href="../../assets/diagram.svg">diagram</a>';
    const out = rewriteInternalMarkdownLinks(html, ADR_FILE, REPO_ROOT);
    expect(out).toContain('href="../../assets/diagram.svg"');
  });

  test("resolves DESIGN → sibling design doc without escaping to root", () => {
    const html = '<a href="DESIGN-0001-revkit-architecture.md">design</a>';
    const out = rewriteInternalMarkdownLinks(html, DESIGN_FILE, REPO_ROOT);
    expect(out).toContain('href="/designs/design-0001-revkit-architecture/"');
  });

  test("routes a matrix → ADR link", () => {
    const html = '<a href="adr/0016-testing-strategy.md">ADR-0016</a>';
    const out = rewriteInternalMarkdownLinks(html, MATRIX_FILE, REPO_ROOT);
    expect(out).toContain('href="/adr/0016-testing-strategy/"');
  });
});
