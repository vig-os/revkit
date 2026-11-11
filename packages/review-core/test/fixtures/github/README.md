# GitHub fixtures for the review-core adapter tests

Recorded read-only responses from public PRs in `vig-os/revkit`, used
to replay real GitHub API shapes through an injected `fetch` in the
adapter tests. **No network in CI** — the fixtures live in-repo and
tests refuse an unmatched request.

## Recording

The fixtures were captured with the local reviewer's `gh` token, then
scrubbed of anything token-shaped before being committed. Every JSON
value passed through the scrubber (see the `scrub-fixture.mjs` script
kept in the operator scratchpad — it is not shipped in-tree, so the
scrubber cannot be run silently on writable secrets by a future
recorder without paying attention). The scrubber applies:

- GitHub token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`) followed by a plausible tail → `<scrubbed:token>`;
- any `Authorization: Bearer <value>` / `Authorization: token <value>`
  substring → `Authorization: Bearer <scrubbed>`.

Commands used (against `vig-os/revkit#38`, a merged public PR with
four review threads):

```
gh api repos/vig-os/revkit/pulls/38                    > pr-38-pull.json
gh api repos/vig-os/revkit/pulls/38/files?per_page=100 > pr-38-files.json
gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:50){
        pageInfo{hasNextPage,endCursor}
        nodes{
          id path isResolved isOutdated
          line startLine originalLine originalStartLine
          diffSide startDiffSide
          comments(first:100){
            nodes{ id databaseId body createdAt url author{login __typename} }
          }
        }
      }
    }
  }
}' -F owner=vig-os -F name=revkit -F number=38 > pr-38-review-threads.json
```

## Files

| file                          | endpoint                          | shape covered                                      |
|-------------------------------|-----------------------------------|----------------------------------------------------|
| `pr-38-pull.json`             | REST: `GET /pulls/:n`             | head/base SHAs, repo full names, state             |
| `pr-38-files.json`            | REST: `GET /pulls/:n/files`       | one page of files with real patches, `status`      |
| `pr-38-review-threads.json`   | GraphQL: `reviewThreads`          | RIGHT-side, resolved, outdated, bot-authored       |

## Refreshing

If GitHub's response shape drifts, refresh with the commands above and
re-run the scrubber. The `github-adapter-fixtures.test.ts` suite will
fail on any drift the mapping code cares about.

The live smoke test (`github-adapter-live-smoke.test.ts`,
`REVKIT_LIVE_GH=1`) reads the same PR against the real API to confirm
the recorded shapes still match.

## What is NOT in these fixtures

- No unresolved, non-outdated threads (PR #38's threads are all
  resolved) — synthetic threads in
  `github-adapter-mapping.test.ts` cover that case.
- No write-path responses. Write paths are exercised against an
  in-process fake in `github-adapter-writes.test.ts` — the adapter
  MUST NOT create, submit or delete anything on GitHub with the
  owner's identity (ADR-0025 hard boundary).
