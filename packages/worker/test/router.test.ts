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
import {
  API_SEGMENT,
  REVKIT_BUNDLE_ROOT,
  REVKIT_SEGMENT,
  SCOPED_THREADS_SUFFIX,
  canonicalRepoName,
  isRepoName,
  isRevkitBundlePath,
  parsePreviewPath,
  parseScopedThreadsPath,
  previewScopePath,
} from "../src/router.ts";

describe("parsePreviewPath — accepted", () => {
  test("the canonical shape", () => {
    expect(parsePreviewPath("/revkit/pr-7")).toEqual({
      repo: "revkit",
      pr: 7,
      pathname: "/revkit/pr-7",
      logKey: "/revkit/pr-7",
    });
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

describe("canonicalRepoName — the ONE stored spelling of a repository name", () => {
  test("folds case and leaves the rest of the admitted class alone", () => {
    expect(canonicalRepoName("revkit")).toBe("revkit");
    expect(canonicalRepoName("Revkit")).toBe("revkit");
    expect(canonicalRepoName("REVKIT")).toBe("revkit");
    expect(canonicalRepoName("rEvKiT")).toBe("revkit");
    // The non-letter members of `REPO_SEGMENT` are not case, so they must survive
    // untouched — including the `.` a repo like `vig-os.revkit` carries.
    expect(canonicalRepoName("Vig-OS.Revkit")).toBe("vig-os.revkit");
    expect(canonicalRepoName("a_b-c.d0")).toBe("a_b-c.d0");
  });

  test("is a LOCALE-INDEPENDENT fold: no dotless i, no locale-sensitive letter", () => {
    // The reason this is `toLowerCase` and not `toLocaleLowerCase`. Under a
    // Turkish locale the latter folds `"I"` to `ı` (U+0131), which `REPO_SEGMENT`
    // does not admit — so the canonical form of an accepted name could be a
    // rejected one, and the stored value would depend on the runtime's locale
    // rather than on the input. Asserted on the CHARACTER, not on a locale
    // setting, because there is no locale switch to make here: what has to hold
    // is that the output is confined to the class the predicate accepts.
    const turkishI = "I".toLocaleLowerCase("tr");
    expect(turkishI).not.toBe(canonicalRepoName("I"));
    expect(turkishI).not.toBe("i");
    expect(canonicalRepoName("I")).toBe("i");
    // And the sweep below is the general form of that: the fold cannot produce a
    // character `REPO_SEGMENT` rejects.
  });

  test("cannot change a REFUSAL, over the whole admitted character class", () => {
    // The property `mintInvite` relies on when it validates BEFORE folding:
    // `isRepoName(canonicalRepoName(x)) === isRepoName(x)` for every input, so a
    // fold can neither admit a name the predicate rejects nor rescue one it
    // rejects. Swept rather than asserted on examples, because the claim is
    // about a character class.
    //
    // Swept in TWO directions, which is the part a single list would miss:
    //   - every string of length 1 over the whole admitted alphabet must keep its
    //     verdict (66 characters: 52 letters + digits + `.` `_` `-`)
    //   - every string of length 2 over the LETTERS must keep its verdict, which
    //     is where a fold that produced an outside character would show up
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
    for (const a of alphabet) {
      for (const b of ["", ...alphabet]) {
        const name = `${a}${b}`;
        expect(isRepoName(canonicalRepoName(name)), name).toBe(isRepoName(name));
      }
    }
    // Idempotence, over the same class: folding twice is folding once, which is
    // what makes the stored value stable if a caller ever folds twice.
    for (const a of alphabet) {
      const once = canonicalRepoName(a);
      expect(canonicalRepoName(once)).toBe(once);
    }
    // A case difference always collapses: that is the whole point, and it is why
    // `Acme` and `acme` are the same repository on GitHub.
    expect(canonicalRepoName("Acme")).toBe(canonicalRepoName("acme"));
    expect(canonicalRepoName("ACME")).toBe(canonicalRepoName("aCmE"));
  });

  test("is a CANONICALISER, not a validator — it admits nothing `isRepoName` refuses", () => {
    // Named so a caller does not reach for it as a filter. `mintInvite` calls
    // `isRepoName` first and this second; the order is what makes folding inert
    // on the refusal path, and this case is what would fail if someone swapped
    // them.
    for (const hostile of ["../etc", "a/b", "", "rev kit", "<script>", "x".repeat(101)]) {
      expect(isRepoName(hostile), hostile).toBe(false);
      // Folding such a string does not make it servable — it only changes its
      // case. The caller must still have refused it.
      expect(canonicalRepoName(hostile)).toBe(hostile.toLowerCase());
    }
  });

  test("the ROUTE is untouched: a path's repo segment is still verbatim", () => {
    // The half of the fix that must NOT exist. `parsePreviewPath` returns
    // `segments[1]` as it appeared, so two spellings of one path stay two
    // reviews — and folding the read side would have collapsed them.
    expect(parsePreviewPath("/Revkit/pr-7")?.repo).toBe("Revkit");
    expect(parsePreviewPath("/REVKIT/pr-7")?.repo).toBe("REVKIT");
    expect(parsePreviewPath("/Revkit/pr-7")?.logKey).toBe("/Revkit/pr-7");
    // The canonical form is the one `canonicalRepoName` agrees with, and it is
    // reachable — so a mint and a canonical URL do meet.
    expect(canonicalRepoName(parsePreviewPath("/Revkit/pr-7")?.repo ?? "")).toBe("revkit");
    expect(parsePreviewPath(`/revkit/pr-7`)?.logKey).toBe(canonicalRepoName("/Revkit/pr-7"));
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

// ── the scope axis (slice 5) ─────────────────────────────────────────────
//
// These two functions are how "which review is this request for" gets its
// answer, and the answer reaches a D1 partition key. So the cases below are
// about INJECTIVITY and about the shapes that must not be mistaken for the
// API — a wrong answer here is another review's comments.

describe("previewScopePath — the one spelling of a review's identity", () => {
  test("is ADR-0008's preview address without a trailing slash", () => {
    expect(previewScopePath("revkit", 7)).toBe("/revkit/pr-7");
    expect(previewScopePath("vig-os.revkit", 102)).toBe("/vig-os.revkit/pr-102");
  });

  test("is INJECTIVE over (repo, pr), which is what makes it a partition key", () => {
    // If two pairs shared a key they would share a log, so two reviews would
    // read each other's comments. The repo grammar admits no `/`, and `pr` is
    // a decimal integer, so the two halves cannot be confused — and this
    // asserts it rather than trusting the argument.
    const pairs: [string, number][] = [
      ["revkit", 7],
      ["revkit", 8],
      ["revkit", 70],
      ["revkit-7", 1],
      ["revkit", 1],
      ["a", 1],
      ["a.pr", 1],
      ["revkit.pr-7", 1],
      ["revkit", 999999999],
    ];
    const keys = pairs.map(([repo, pr]) => previewScopePath(repo, pr));
    expect(new Set(keys).size).toBe(pairs.length);
  });

  test("is what `parsePreviewPath` puts in `logKey`, for every path it accepts", () => {
    // One derivation, so a route's scope and its log key cannot disagree — the
    // disagreement would be a cross-review read.
    for (const path of ["/revkit/pr-7", "/revkit/pr-7/index.html", "/vig-os.revkit/pr-102/", "/a1/pr-999999999"]) {
      const parsed = parsePreviewPath(path);
      expect(parsed?.logKey).toBe(previewScopePath(parsed?.repo ?? "", parsed?.pr ?? 0));
    }
  });
});

describe("parseScopedThreadsPath — the ONLY spelling of the thread read", () => {
  test("accepts `<repo>/pr-<n>` + the API suffix, and reports the review", () => {
    const parsed = parseScopedThreadsPath("/revkit/pr-7/api/threads");
    expect(parsed?.repo).toBe("revkit");
    expect(parsed?.pr).toBe(7);
    expect(parsed?.logKey).toBe("/revkit/pr-7");
    expect(SCOPED_THREADS_SUFFIX).toBe("/api/threads");
  });

  test("the query string is not part of the path, so `?repo=` cannot move the scope", () => {
    // `parseScopedThreadsPath` takes a PATHNAME. A scope in the query string
    // would be exactly the caller-chosen axis slice 5 removed.
    expect(parseScopedThreadsPath("/revkit/pr-7/api/threads?repo=other-repo")).toBeUndefined();
  });

  test("the REMOVED unscoped path is not the API", () => {
    // `GET /api/threads` named no review, so it could only ever answer
    // org-wide. It is gone; this is the half of that which is pure grammar.
    expect(parseScopedThreadsPath("/api/threads")).toBeUndefined();
    expect(parseScopedThreadsPath("/api/threads/")).toBeUndefined();
  });

  test("a DEEPER base is a built site that happens to end in the suffix, not the API", () => {
    // The bug this refusal prevents: `parsePreviewPath` ignores everything
    // after the PR segment, so a preview of a document called `api/threads`
    // would otherwise answer the review's thread log.
    expect(parseScopedThreadsPath("/revkit/pr-7/docs/api/threads")).toBeUndefined();
    expect(parseScopedThreadsPath("/revkit/pr-7/api/threads/nested")).toBeUndefined();
    expect(parseScopedThreadsPath("/revkit/pr-7/xapi/threads")).toBeUndefined();
  });

  test("traversal and doubling are refused through the same rules as a preview", () => {
    for (const path of [
      "/revkit/pr-7/../api/threads",
      "/../revkit/pr-7/api/threads",
      "/revkit/pr-7//api/threads",
      "/revkit/pr-7/%2e%2e/api/threads",
      "/api/pr-7/api/threads",
      "/_revkit/pr-7/api/threads",
      "/revkit/pr-07/api/threads",
      "/revkit/pr-0/api/threads",
      "/revkit/pr-7/Api/threads",
    ]) {
      expect(parseScopedThreadsPath(path), path).toBeUndefined();
    }
  });

  test("a preview path that is not the API is not this function's business", () => {
    // Still a preview — the route table serves it from R2 — but NOT the read.
    expect(parseScopedThreadsPath("/revkit/pr-7")).toBeUndefined();
    expect(parseScopedThreadsPath("/revkit/pr-7/index.html")).toBeUndefined();
    expect(parsePreviewPath("/revkit/pr-7/api/threads")?.logKey).toBe("/revkit/pr-7");
  });
});
