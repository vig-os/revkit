// pr-ref parser: every accepted shape has a positive test, every
// refused shape has a rejection assertion, and the refused set
// covers the "smuggle a hostile URL" cases the parser must not fall
// through on.

import { describe, expect, test } from "bun:test";
import { parsePrRef } from "../../src/review/pr-ref.ts";

const DEFAULT_SLUG = "vig-os/revkit";

describe("parsePrRef — accepted shapes", () => {
  test("bare number uses the default slug", () => {
    const r = parsePrRef("123", DEFAULT_SLUG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toEqual({ owner: "vig-os", repo: "revkit", pullNumber: 123 });
  });

  test("owner/repo#number", () => {
    const r = parsePrRef("some-org/some-repo#42", DEFAULT_SLUG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toEqual({ owner: "some-org", repo: "some-repo", pullNumber: 42 });
  });

  test("full https URL", () => {
    const r = parsePrRef("https://github.com/vig-os/revkit/pull/38", DEFAULT_SLUG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toEqual({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
  });

  test("scheme-less URL", () => {
    const r = parsePrRef("github.com/vig-os/revkit/pull/9", DEFAULT_SLUG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toEqual({ owner: "vig-os", repo: "revkit", pullNumber: 9 });
  });

  test("URL with /files or #anchor trailing is accepted", () => {
    const r = parsePrRef("https://github.com/vig-os/revkit/pull/38/files", DEFAULT_SLUG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref.pullNumber).toBe(38);
  });
});

describe("parsePrRef — refused shapes", () => {
  test("empty string", () => {
    const r = parsePrRef("", DEFAULT_SLUG);
    expect(r.ok).toBe(false);
  });

  test("non-github host is refused", () => {
    // A URL that looks PR-shaped but on the wrong host must NOT
    // parse — otherwise the review would resolve against a
    // hostile-controlled slug.
    const r = parsePrRef("https://evil.com/vig-os/revkit/pull/1", DEFAULT_SLUG);
    expect(r.ok).toBe(false);
  });

  test("PR number overflow", () => {
    const r = parsePrRef("99999999999999999", DEFAULT_SLUG);
    expect(r.ok).toBe(false);
  });

  test("negative PR number", () => {
    const r = parsePrRef("-5", DEFAULT_SLUG);
    // A bare `-5` isn't a valid number shape (leading `-`), so the
    // parser falls through to the URL branch and refuses; that's
    // the right outcome.
    expect(r.ok).toBe(false);
  });

  test("owner with dots and dashes only allowed inside the segment", () => {
    // `-startdash` should be refused because our regex requires
    // an alphanumeric first char (mirrors GitHub's own rule).
    const r = parsePrRef("-badorg/repo#1", DEFAULT_SLUG);
    expect(r.ok).toBe(false);
  });

  test("path with too few segments is refused", () => {
    const r = parsePrRef("https://github.com/vig-os/revkit/issues/38", DEFAULT_SLUG);
    expect(r.ok).toBe(false);
  });
});
