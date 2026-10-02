// `POST /api/publish` orchestrator (M2 item 9, story A4, ADR-0001
// amendment).
//
// The daemon accepts a batch of source files, validates them under
// the publish confinement + `revkit check`, writes them atomically,
// re-anchors comments, renders a fast-path HTML fragment for every
// `.md` document, splices that fragment into the existing built
// HTML under the target route, and stores the result as an
// IN-MEMORY OVERRIDE keyed on the route. Subsequent GETs of that
// route serve the override until a full `astro build` refreshes
// `site/dist/` on disk.
//
// The publish path is SERIALISED via a module-level mutex — one
// writer at a time. Concurrent publish requests queue; the second
// caller's request runs against the state the first one left on
// disk, so `revkit check` runs on a consistent snapshot. The rail
// re-fetches its state after `doc.published`, so the second caller
// sees the first caller's already-visible page.
//
// Design notes (why this over an incremental Astro build):
//
// - The whole `astro build` takes 3–5 seconds on this repo; the
//   story bar is under one second. The fast-path pipeline runs the
//   same remark/rehype plugins as `astro.config.mjs` on the SINGLE
//   changed document, so `data-src` stamps are identical and
//   thread anchors survive. Test:
//   `test/serve/publish-equivalence.test.ts` diffs the article
//   body of the fast path against a full build.
// - The shell (Starlight sidebar / header / footer / CSP-safe
//   scripts) is preserved BYTE FOR BYTE by splicing only the
//   `<div class="sl-markdown-content">…</div>` region. A page that
//   has never been built ("brand-new document") has no shell to
//   splice into: it is recorded as a `shell-missing` build item and
//   the scheduled full build creates it.
// - The daemon does NOT write into the serve dir itself; the
//   scheduled build does, through the shared `revkit build`
//   primitive. Overrides live in memory, keyed by route together
//   with the source revision they were rendered from. The next full
//   build produces a fresh dist that the daemon serves from disk
//   again — the cache entry is then simply unused, and a refusal is
//   cleared once the build for its generation succeeds.
//
// **Security discipline** (ADR-0013 amendment):
//
// - Every path goes through `resolvePublishTarget` — allowlisted
//   subtrees, extensions, symlink refusal — and then through
//   `stillConfined` AGAIN, after the check and immediately before
//   the rename. The second pass re-derives the answer from the
//   filesystem instead of trusting the first one, so a parent
//   directory or leaf swapped for a symlink while `revkit check`
//   was running cannot redirect the write outside the repo.
// - Every file's serialised size is capped
//   (`PUBLISH_FILE_MAX_BYTES`), and the whole request too
//   (`PUBLISH_REQUEST_MAX_BYTES`).
// - Writes are ATOMIC (stage to a sibling `.tmp-<random>` created
//   with `O_EXCL | O_NOFOLLOW`, then rename). A partial write cannot
//   leave a half-written file on disk for the next `revkit check` to
//   trip over, and a rolled-back file is restored through its own
//   rename rather than an in-place truncate.
// - The check runs against the STAGED bytes plus a `staged`
//   overlay, so cross-file rules (vocabulary, links) see the batch as
//   one snapshot: a doc may use a term or link to a doc that the
//   same batch defines.
// - Rollback on `revkit check` failure: nothing has been committed
//   yet, so the staged files are simply removed. On a mid-batch
//   rename failure the already-committed files are restored from a
//   pre-rename snapshot, each through its own atomic rename.
// - `revkit check` runs in-process (no `bun`/`bunx`, per
//   CLAUDE.md's "no bunx/npx in a trusted path"). It uses the
//   same rule set as the pre-commit hook — refuses hand-rolled
//   HTML, off-vocab terms, mis-shaped plots, and so on.
//
// **Every no-override outcome schedules a real build.** A document
// is either served by the fast path (`state: "fast"`) or recorded
// as a build item with a typed reason — `data-only`,
// `fast-path-refused`, `render-failed`, `shell-missing`. There is no
// third outcome in which a committed source stays invisible until a
// human runs a build by hand. `deps.recordGeneration` is called with
// every item in the batch BEFORE the first event append, so a batch
// whose log append fails is still reconciled by a restart.
//
// **Presence** (ADR-0007 §5.3 last paragraph, M2 item 6 round 2):
// presence beacons are EPHEMERAL — a viewer chip, not a durable
// log entry. The orchestrator calls the presence hub's
// `editing(actor, location)` BEFORE the write and `idle(actor)`
// AFTER the fanout, matching the "agent is editing X" flow #53
// shipped. Nothing about the publish itself lives on the
// `PresenceFrame` stream — that stream is per-viewer state, not a
// history.
//
// **Fan-out audiences** (M2 item 6 round 2). `doc.published`
// concerns BOTH the rail (page reload) and the agent (turn-level
// "the doc I was iterating on landed"), so the publish emits with
// audiences=["rail","agent"]. The delivery mode's own filter
// (`shouldFanOutToAgent`) accepts `doc.published` unconditionally
// today because publish is initiated by the agent — no
// human-authored comment gating is relevant. If a future ADR
// changes that, this is the one call site to update.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Author, ReviewEvent } from "@revkit/review-core";
import { revisionOf } from "@revkit/review-core";
import { runCheck, toCheckFiles } from "../check.ts";
import { spawnGh } from "../gh-runner.ts";
import type { EventBus, SubscriberAudience } from "./event-bus.ts";
import type { PresenceHub } from "./presence-hub.ts";
import type { SqliteThreadStore } from "./sqlite-store.ts";
import {
  PUBLISH_FILE_MAX_BYTES,
  PUBLISH_REQUEST_MAX_BYTES,
  UNIFORM_PUBLISH_REJECTION,
  resolvePublishTarget,
} from "./publish-confine.ts";
import { isRenderablePath, renderDocFragment, type FastPathRefusalReason } from "./publish-render.ts";
import type { PublishBuildItem, PublishBuildRecord } from "./publish-build.ts";

/** Result of one publish. `published` is one entry per file in the
 * batch that reached disk; `overrides` names the routes for which
 * the daemon now serves a fast-path HTML fragment; `refused` names
 * the paths where the fast path REFUSED to render (fenced code
 * blocks, Starlight asides) — the daemon then triggers a
 * background full build and serves a "rendering..." banner on
 * those routes until the build lands. On any failure (validation,
 * check, disk) the whole batch is rolled back and `ok: false` is
 * returned with a `kind` the caller can branch on. */
export type PublishOutcome =
  | {
      readonly ok: true;
      readonly published: readonly {
        readonly path: string;
        readonly route: string | undefined;
        readonly revision: string;
      }[];
      readonly seqs: readonly number[];
      readonly overrides: readonly {
        readonly route: string;
        readonly html: string;
        readonly dataSrcCount: number;
      }[];
      /** Paths whose fast-path render was REFUSED. Each entry
       * names the file and the reason. The caller can:
       *   - Show the reviewer a "rendering..." banner on that
       *     route (the daemon injects one automatically);
       *   - Wait for the background full build (`buildStarted`
       *     on the event bus, then a fresh `astro build`);
       *   - Tell the agent to rewrite the source to use a
       *     supported feature.
       *
       * `reason` matches `FastPathRefusal.reason` — the same
       * tag `renderDocFragment` returns for the source. */
      readonly refused: readonly {
        readonly path: string;
        readonly route: string | undefined;
        readonly reason: FastPathRefusalReason;
      }[];
      readonly generation: string;
      readonly rendering: readonly ({
        readonly path: string;
        readonly route?: string;
        readonly state: "fast";
      } | PublishBuildItem)[];
      readonly build: Pick<PublishBuildRecord, "generation" | "status" | "items">;
      /** Set when the batch landed on disk but one or more
       * `doc.published` appends to the durable log were rejected.
       * The publish is NOT rolled back (the source is valid and the
       * build is scheduled), so the outcome stays `ok: true` — but
       * the caller is told the rail will learn about this batch from
       * the build's own events rather than from `doc.published`. */
      readonly notice?: {
        readonly code: "event-append-failed";
        readonly message: string;
      };
    }
  | {
      readonly ok: false;
      readonly kind:
        | "confinement"
        | "too-many-files"
        | "too-large"
        | "check-failed"
        | "render-failed"
        | "shell-missing"
        | "write-failed"
        | "internal";
      readonly reason: string;
      readonly diagnostics?: readonly string[];
    };

/** One entry the client provided. `content` is the LF-normalised
 * source (the daemon normalises again as a defence in depth). */
export interface PublishFileInput {
  readonly path: string;
  readonly content: string;
}

/** Injection dependencies. Kept as parameters so a test can pass a
 * stubbed store / bus / gh runner without spinning up a full daemon. */
export interface PublishDependencies {
  readonly repoRoot: string;
  readonly store: SqliteThreadStore;
  readonly bus: EventBus;
  readonly presence: PresenceHub;
  readonly agentActor: Author;
  readonly systemActor: Author;
  readonly repoSlug: string;
  /** Trigger the re-anchor pipeline against `path` after the write.
   * The daemon passes its `reanchor.refresh` function; tests may
   * pass a no-op. */
  readonly refreshAnchors: (path: string) => Promise<void>;
  readonly reconcileWatchers: () => void;
  /** Fold a freshly-appended event into the delivery adapter's
   * incremental cache. The daemon's own `safeIngest` handles the
   * `IngestGapError` recovery path; publish just calls this after
   * every append so the derived state stays in lockstep. */
  readonly ingestDelivery: (event: ReviewEvent) => Promise<void>;
  /** Serve-dir root. The orchestrator does not write here — that
   * belongs to the background full build — but it does render an
   * article fragment eagerly so a stale dist doesn't reach the
   * next page-load. Kept in the deps bag so a test may point at
   * a temporary tree. */
  readonly distDir: string;
  /** Called with the fresh (`revision`, `html`) pair AFTER the
   * event has been fanned out. The daemon's static handler holds
   * a revision-keyed render cache (M2 item 9, PR-56 blocker 2):
   * this callback populates it so a page-load right after
   * publish is a cache hit instead of a re-render. */
  readonly setRenderCache: (
    route: string,
    revision: string,
    html: string,
    dataSrcCount: number,
  ) => void;
  readonly recordGeneration: (
    generation: string,
    items: readonly PublishBuildItem[],
  ) => Promise<Pick<PublishBuildRecord, "generation" | "status" | "items">>;
  /** TEST-ONLY hook: awaited after `revkit check` approves the staged
   * bytes and immediately before they are renamed onto their final
   * paths. Production passes nothing. A confinement-race test passes a
   * function that swaps a parent directory or the leaf itself for a
   * symlink, which is what makes the re-validation that follows this
   * call provably load-bearing rather than decorative. */
  readonly beforeStagedCommit?: () => Promise<void>;
}

/** Public entry point. Runs the whole publish pipeline for one
 * batch of files. */
export async function runPublish(
  input: {
    readonly docs: readonly PublishFileInput[];
    readonly data?: readonly PublishFileInput[];
  },
  deps: PublishDependencies,
): Promise<PublishOutcome> {
  // The mutex is module-scoped so ALL callers on this daemon serialise.
  return await publishMutex.run(() => runPublishInner(input, deps));
}

// ── implementation ─────────────────────────────────────────────────

async function runPublishInner(
  input: {
    readonly docs: readonly PublishFileInput[];
    readonly data?: readonly PublishFileInput[];
  },
  deps: PublishDependencies,
): Promise<PublishOutcome> {
  const files = [...input.docs, ...(input.data ?? [])];
  if (files.length === 0) {
    return { ok: false, kind: "confinement", reason: "publish: batch is empty" };
  }
  // The cap is over the WHOLE batch (`docs` + `data` together), not
  // per array — a caller splitting its work across the two arrays does
  // not get a bigger budget. `too-many-files` is its own kind rather
  // than `confinement`: `confinement` tells an agent its PATH is
  // wrong, and pointing it at a non-existent path bug when the real
  // problem is batch size costs a debugging round-trip on every
  // occurrence.
  if (files.length > MAX_FILES_PER_PUBLISH) {
    return {
      ok: false,
      kind: "too-many-files",
      reason:
        `publish: batch has ${files.length} files (${input.docs.length} docs + ${(input.data ?? []).length} data), ` +
        `cap is ${MAX_FILES_PER_PUBLISH} across BOTH arrays combined — split it into two publishes`,
    };
  }
  // 1) Aggregate size + per-file size caps + normalise line endings.
  interface Resolved {
    readonly input: PublishFileInput;
    readonly absolutePath: string;
    readonly siteRoute: string | undefined;
    readonly normalised: string;
    readonly revision: string;
  }
  let totalBytes = 0;
  const resolved: Resolved[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) {
      return {
        ok: false,
        kind: "confinement",
        reason: `publish: duplicate path in batch: ${file.path}`,
      };
    }
    seenPaths.add(file.path);
    const target = resolvePublishTarget(deps.repoRoot, file.path);
    if (!target.ok) {
      return { ok: false, kind: "confinement", reason: target.reason };
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > PUBLISH_FILE_MAX_BYTES) {
      return {
        ok: false,
        kind: "too-large",
        reason: `publish: file '${file.path}' is ${bytes} bytes, cap is ${PUBLISH_FILE_MAX_BYTES}`,
      };
    }
    totalBytes += bytes;
    if (totalBytes > PUBLISH_REQUEST_MAX_BYTES) {
      return {
        ok: false,
        kind: "too-large",
        reason: `publish: batch total ${totalBytes} bytes exceeds cap ${PUBLISH_REQUEST_MAX_BYTES}`,
      };
    }
    // LF-normalise to match `revisionOf`'s normalisation on read.
    const normalised = file.content.replace(/\r\n?/g, "\n");
    const revision = await revisionOf(normalised);
    resolved.push({
      input: file,
      absolutePath: target.absolutePath,
      siteRoute: target.siteRoute,
      normalised,
      revision,
    });
  }

  // 2) Stage the writes to `.tmp-<hash>` sibling files WITHOUT
  //    committing them to their final paths yet. Round-1 wrote
  //    to the final path first and rolled back on check failure
  //    — a brief window in which the on-disk source held content
  //    that check had not yet approved. The staged-copy approach
  //    keeps the final paths untouched until step 3 passes.
  //
  //    The staged file is created with `O_EXCL | O_NOFOLLOW`: a
  //    swapped leaf cannot be followed, and the random name cannot
  //    already exist.
  const staged: { absolutePath: string; repoRelativePath: string; tmp: string }[] = [];
  const cleanupStaged = (): void => {
    for (const { tmp } of staged) {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    }
  };
  try {
    for (const entry of resolved) {
      const tmp = `${entry.absolutePath}.tmp-${randomBytes(8).toString("hex")}`;
      const fd = openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, entry.normalised, "utf8");
      } finally {
        closeSync(fd);
      }
      staged.push({ absolutePath: entry.absolutePath, repoRelativePath: entry.input.path, tmp });
    }
  } catch (error) {
    cleanupStaged();
    return {
      ok: false,
      kind: "write-failed",
      reason: `publish: staged write failed: ${(error as Error).message}`,
    };
  }

  // 3) Run `revkit check` on the STAGED bytes. `toCheckFiles`
  //    takes `absolute` (the path check reads from) and
  //    `relative` (the path check reports in diagnostics) —
  //    passing tmp for `absolute` and the final path for
  //    `relative` runs the rules against the staged content
  //    while a failure names the file the caller published.
  //    This validates registered-component usage, vocabulary,
  //    links, plot structure, no hand-rolled UI. Runs OFFLINE
  //    (no `--online`) — the local daemon has no GITHUB_TOKEN
  //    by default, and the online check
  //    is a per-annotation issue-existence probe not relevant to a
  //    fresh publish (any `revkit-allow` annotation the agent
  //    writes will still be verified at commit time by the
  //    pre-commit hook).
  //
  //    Trusted mode: the agent is running against the local repo
  //    with the owner's session — the same trust boundary as a
  //    developer running `revkit check` locally. `revkit check`
  //    reads files by absolute path; the batch's paths are the
  //    ones just written.
  //
  //    The `staged` overlay is what makes the batch ONE snapshot
  //    rather than a set of independent files: the cross-file rules
  //    (vocabulary, links) consult it before the filesystem, so a
  //    doc that uses a term the same batch defines, or links to a
  //    doc the same batch creates, validates against the batch and
  //    not against the previous contents of files that have not
  //    landed yet.
  const stagedCheckFiles = staged.map((s) => ({
    absolute: s.tmp,
    relative: s.repoRelativePath,
  }));
  const stagedOverlay = buildStagedOverlay(deps.repoRoot, resolved, staged);
  const checkOutput = await runCheck(
    deps.repoRoot,
    stagedCheckFiles,
    [],
    { online: false, repoSlug: deps.repoSlug, gh: spawnGh, staged: stagedOverlay },
  );
  if (checkOutput.exitCode !== 0) {
    cleanupStaged();
    return {
      ok: false,
      kind: "check-failed",
      reason: `publish: revkit check refused the batch (${checkOutput.lines.length} finding${checkOutput.lines.length === 1 ? "" : "s"})`,
      diagnostics: checkOutput.lines,
    };
  }

  // 3b) The check took time. Re-verify confinement BEFORE the
  //     commit: `resolvePublishTarget` ran at step 1, and between
  //     then and the rename a concurrent writer could have replaced
  //     `docs/adr` with a symlink to `/etc`, or made the leaf itself
  //     a symlink pointing outside the repo. Re-running the same
  //     resolver and requiring the SAME absolute path — plus a
  //     realpath check on the parent directory, which must still be
  //     a real directory inside the repo root — turns that window
  //     from "the write trusts a stale decision" into "the write
  //     refuses unless the decision still holds".
  await deps.beforeStagedCommit?.();
  for (const { absolutePath, repoRelativePath } of staged) {
    if (!stillConfined(deps.repoRoot, repoRelativePath, absolutePath)) {
      cleanupStaged();
      return {
        ok: false,
        kind: "confinement",
        reason: UNIFORM_PUBLISH_REJECTION,
      };
    }
  }

  // 3c) Commit the staged files to their final paths atomically.
  //     `renameSync` on the same filesystem is atomic on
  //     Linux/macOS — a reader sees either the OLD file or the
  //     NEW file, never a half-written one. If a rename fails
  //     mid-batch, roll back the ones that already landed by
  //     renaming a freshly written copy of their previous contents
  //     back into place (a plain `writeFileSync` would expose a
  //     truncated window to a concurrent reader; the new-file case
  //     is removed outright).
  interface CommitSnapshot {
    absolutePath: string;
    existed: boolean;
    previous?: string;
  }
  const committed: CommitSnapshot[] = [];
  const rollback = (): void => {
    for (const snap of [...committed].reverse()) {
      try {
        if (snap.existed && snap.previous !== undefined) {
          // Restore through a rename so a concurrent reader sees the
          // old bytes or the new bytes, never a truncated file.
          const restore = `${snap.absolutePath}.rollback-${randomBytes(8).toString("hex")}`;
          const fd = openSync(
            restore,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeFileSync(fd, snap.previous, "utf8");
          } finally {
            closeSync(fd);
          }
          renameSync(restore, snap.absolutePath);
        } else if (existsSync(snap.absolutePath)) {
          rmSync(snap.absolutePath, { force: true });
        }
      } catch { /* best-effort */ }
    }
  };
  try {
    for (const { absolutePath, tmp } of staged) {
      let existed = false;
      let previous: string | undefined;
      try {
        const stat = lstatSync(absolutePath);
        if (stat.isFile()) {
          existed = true;
          previous = readFileSync(absolutePath, "utf8");
        }
      } catch { /* not-found is normal on new-file publish */ }
      renameSync(tmp, absolutePath);
      committed.push({ absolutePath, existed, ...(previous !== undefined ? { previous } : {}) });
    }
  } catch (error) {
    rollback();
    cleanupStaged();
    return {
      ok: false,
      kind: "write-failed",
      reason: `publish: rename failed after check: ${(error as Error).message}`,
    };
  }
  const generation = await revisionOf(
    JSON.stringify(resolved.map((entry) => [entry.input.path, entry.revision])),
  );

  // 4) Emit `presence editing` for every doc in the batch. Round-2
  //    (M2 item 6) makes presence EPHEMERAL — no store append; the
  //    hub broadcasts the frame straight to `/events` subscribers.
  //    A restart forgets the beacon, which is exactly the right
  //    lifetime for "agent is editing X RIGHT NOW".
  //
  //    Steps 4–8 run inside a try whose `finally` always clears the
  //    beacon. Everything after this point can throw (an event append
  //    against a locked sqlite file, a re-anchor pipeline that dies,
  //    a render cache that rejects), and a beacon left lit is a
  //    permanently-occupied chip in every reviewer's rail with
  //    nothing behind it — the one failure mode a restart does NOT
  //    heal, because presence is in-memory by design.
  for (const entry of resolved) {
    deps.presence.editing(deps.agentActor, { path: entry.input.path });
  }
  try {
  // 5) Fast-path render + shell splice.
  interface Rendered {
    readonly entry: Resolved;
    readonly override?: { route: string; html: string; dataSrcCount: number };
    readonly refused?: { reason: FastPathRefusalReason };
    readonly buildItem?: PublishBuildItem;
  }
  const rendered: Rendered[] = [];
  for (const entry of resolved) {
    if (entry.siteRoute === undefined || !isRenderablePath(entry.input.path)) {
      rendered.push({ entry, buildItem: { path: entry.input.path, reason: "data-only" } });
      continue;
    }
    let fragment: string;
    let dataSrcCount: number;
    try {
      const result = await renderDocFragment({
        repoRoot: deps.repoRoot,
        path: entry.input.path,
        source: entry.normalised,
      });
      if (result.refused === true) {
        // Source uses a feature the fast path can't render
        // byte-parity with the full build (fenced code blocks,
        // Starlight asides). Skip the override — dist serves
        // the previous build's HTML with a "rendering..." banner
        // until the background full build catches up
        // (M2 item 9, PR-56 round 3 blocker).
        rendered.push({
          entry,
          refused: { reason: result.reason },
          buildItem: {
            path: entry.input.path,
            route: entry.siteRoute,
            reason: "fast-path-refused",
            detail: result.reason,
          },
        });
        continue;
      }
      fragment = result.html;
      dataSrcCount = result.dataSrcCount;
    } catch (error) {
      // A render failure after write is a "we-almost-had-it": the
      // file was accepted by `revkit check`, so leaving the write
      // in place is the right call (the next full build will still
      // render it). Emit `doc.published` without an override.
      rendered.push({
        entry,
        buildItem: {
          path: entry.input.path,
          route: entry.siteRoute,
          reason: "render-failed",
          detail: (error as Error).message,
        },
      });
      // eslint-disable-next-line no-console
      console.error(`publish: fast-path render failed for ${entry.input.path}: ${(error as Error).message}`);
      continue;
    }
    // Splice the fragment into the existing built HTML.
    const spliced = await spliceIntoShell({
      distDir: deps.distDir,
      route: entry.siteRoute,
      fragment,
    });
    if (spliced === undefined) {
      // Shell missing (no full build ever ran, or the route is
      // new). Emit `doc.published` without an override.
      rendered.push({
        entry,
        buildItem: { path: entry.input.path, route: entry.siteRoute, reason: "shell-missing" },
      });
      continue;
    }
    rendered.push({
      entry,
      override: { route: entry.siteRoute, html: spliced, dataSrcCount },
    });
  }

  // 6) Populate the daemon's revision-keyed render cache + emit
  //    `doc.published` for every entry. The cache entry is
  //    content-addressed by `revision`, so a request for the
  //    same source at the same revision (before dist catches up)
  //    is a Map hit; after dist catches up the entry is simply
  //    unused. (M2 item 9, PR-56 blocker 2.)
  //
  //    The build is recorded FIRST, before any event append. Order
  //    is load-bearing: the batch is already on disk at this point,
  //    so the only durable record that a build is owed lives in
  //    `.revkit/publish-state.json`. Recording it before the first
  //    append means an append that throws on the very first event
  //    still leaves a restart-reconcilable record — the daemon comes
  //    back, sees `pending`, re-announces `build.requested` and runs
  //    the build. Recording it after would leave the source
  //    committed, invisible and unbuilt until the next publish.
  const overrides: { route: string; html: string; dataSrcCount: number }[] = [];
  const seqs: number[] = [];
  const publishedPaths = resolved.map((entry) => entry.input.path);
  const buildItems = rendered.flatMap((item) => item.buildItem === undefined ? [] : [item.buildItem]);
  const build = await deps.recordGeneration(generation, buildItems);
  let appendFailure: string | undefined;
  for (const item of rendered) {
    if (item.override !== undefined) {
      deps.setRenderCache(
        item.override.route,
        item.entry.revision,
        item.override.html,
        item.override.dataSrcCount,
      );
      overrides.push(item.override);
    }
    const event: import("@revkit/review-core").ReviewEventInput = {
      kind: "doc.published",
      actor: deps.agentActor,
      path: item.entry.input.path,
      revision: item.entry.revision,
      ...(item.entry.siteRoute !== undefined ? { route: item.entry.siteRoute } : {}),
      // The full batch's paths — a listener that fetches ONE route
      // can decide whether a plot data change on the same batch
      // affects it.
      paths: publishedPaths,
      // The batch boundary. Every event in this loop carries the
      // same generation, so a consumer can group the batch and
      // never mix revisions from two publishes.
      generation,
    };
    try {
      seqs.push(await appendAndFanOut(deps, event, ["rail", "agent"] as const));
    } catch (error) {
      // The source is committed and the build is scheduled; only
      // the log append failed. Keep going for the rest of the batch
      // (a later event may well succeed — an isolated constraint
      // violation on one path should not blind the others) and
      // report the gap on the outcome.
      appendFailure ??= `${item.entry.input.path}: ${(error as Error).message}`;
    }
  }

  // 7) Re-anchor each source-carrying path so any thread whose
  //    anchor lived on the file transitions to the new revision.
  //    `reanchor.refresh` is per-path and serialises per-path
  //    internally, so a concurrent watcher trigger joins the
  //    in-flight run.
  for (const entry of resolved) {
    // Only paths under `docs/` and `site/src/content/docs/` can
    // carry thread anchors; data files like `plots/x/data.json`
    // still trigger `refresh` because the plot spec that
    // references them is stamped, and a page render change from
    // the data may reposition the plot block. Cheap either way.
    try {
      await deps.refreshAnchors(entry.input.path);
    } catch {
      // Best-effort — a re-anchor failure is a separate concern,
      // and the publish itself is not undone by it.
    }
  }
  deps.reconcileWatchers();

  const refused = rendered
    .filter((item): item is Rendered & { refused: { reason: FastPathRefusalReason } } =>
      item.refused !== undefined,
    )
    .map((item) => ({
      path: item.entry.input.path,
      route: item.entry.siteRoute,
      reason: item.refused.reason,
    }));
  return {
    ok: true,
    published: resolved.map((entry) => ({
      path: entry.input.path,
      route: entry.siteRoute,
      revision: entry.revision,
    })),
    seqs,
    overrides,
    refused,
    generation,
    rendering: rendered.map((item) => item.buildItem ?? {
      path: item.entry.input.path,
      ...(item.entry.siteRoute !== undefined ? { route: item.entry.siteRoute } : {}),
      state: "fast" as const,
    }),
    build,
    ...(appendFailure !== undefined ? { notice: { code: "event-append-failed", message: appendFailure } } : {}),
  };
  } finally {
    // 8) Emit `presence idle` per doc so the "agent is editing X"
    //    beacon flips off. Ephemeral broadcast; no store append.
    for (const entry of resolved) {
      deps.presence.idle(deps.agentActor, { path: entry.input.path });
    }
  }
}

// ── staged batch snapshot ───────────────────────────────────────────

/** The batch as ONE snapshot for `revkit check`'s cross-file rules,
 * keyed by the ABSOLUTE path each staged file will occupy once
 * committed.
 *
 * Two keys per entry, deliberately. `resolvePublishTarget` composes
 * paths from the REALSYSPATH of the repo root (so a symlinked
 * `repoRoot` yields a realpath-keyed absolute), while the check
 * anchors its own cross-file lookups — the vocabulary file above all
 * — at the `repoRoot` string the caller passed. Keying by both makes
 * the overlay hit regardless of whether the daemon was started with a
 * real or a symlinked repo root, and both spellings name the same
 * inode, so neither key can shadow the other's content. */
function buildStagedOverlay(
  repoRoot: string,
  resolved: readonly { input: PublishFileInput; normalised: string }[],
  staged: readonly { absolutePath: string; repoRelativePath: string }[],
): Map<string, string> {
  const overlay = new Map<string, string>();
  resolved.forEach((entry, index) => {
    const absolutePath = staged[index]!.absolutePath;
    overlay.set(absolutePath, entry.normalised);
    overlay.set(join(repoRoot, entry.input.path), entry.normalised);
  });
  return overlay;
}

/** Is `repoRelativePath` STILL confined to the repo root, resolving to
 * exactly `expectedAbsolutePath`?
 *
 * This is the second half of a two-step confinement decision, run
 * after `revkit check` and immediately before the rename. The first
 * resolution is a point-in-time answer; between it and the write, a
 * concurrent process (or the agent itself, via another tool) can
 * replace `docs/adr` with a symlink to `/etc`, or make the leaf a
 * symlink to `/etc/passwd`. Four conditions have to hold together:
 *
 *   1. `resolvePublishTarget` still accepts the path — same
 *      allowlist, same no-symlink rule, same real root.
 *   2. It resolves to the SAME absolute path as before, so the write
 *      cannot be redirected somewhere else inside the repo.
 *   3. The parent realpaths to ITSELF, so no symlink sits between the
 *      repo root and the directory the leaf name will be created in.
 *   4. The parent realpaths INSIDE the repo root, and is a DIRECTORY
 *      (not a file that happens to sit where the directory was).
 *
 * **What this guarantees, precisely.** The decision is re-derived from
 * the filesystem at the last moment rather than trusted from earlier,
 * and the staged file is created with `O_NOFOLLOW`, so neither the
 * parent directory nor the leaf name can be followed through a
 * symlink that was swapped in before the write began.
 *
 * **What it does NOT guarantee.** There is no atomic
 * check-then-rename primitive in POSIX: a swap landing in the instant
 * between the `realpathSync` here and the `renameSync` a few
 * statements later is not observable by this function. Closing that
 * window needs an `openat`-relative walk pinned to directory file
 * descriptors, which Node/Bun do not expose. The staging step narrows
 * the exposure — the bytes are already written and validated, and
 * only the rename is left — and the per-file re-check means each file
 * is verified independently rather than inheriting one decision made
 * for the whole batch. Treat this as defence in depth around a
 * single-process trust boundary (ADR-0013: the agent has already been
 * invited by the owner into this repo), not as a sandbox. */
function stillConfined(repoRoot: string, repoRelativePath: string, expectedAbsolutePath: string): boolean {
  const target = resolvePublishTarget(repoRoot, repoRelativePath);
  if (!target.ok || target.absolutePath !== expectedAbsolutePath) return false;
  const parent = dirname(expectedAbsolutePath);
  let rootReal: string;
  let parentReal: string;
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    rootReal = realpathSync(resolvePath(repoRoot));
    parentReal = realpathSync(parent);
    // `lstat` (not `stat`) so a symlink AT the parent path is reported
    // as a symlink rather than silently followed to its target. The
    // `realpathSync === parent` comparison above already rejects that
    // case; asserting `isDirectory()` as well rejects the sibling case
    // where something replaced the directory with a regular file, which
    // would otherwise satisfy "realpaths to itself" and then make the
    // write fail (or, with `O_EXCL`, land beside it).
    parentStat = lstatSync(parent);
  } catch {
    return false;
  }
  if (parentReal !== parent) return false;
  if (!parentStat.isDirectory()) return false;
  return parentReal === rootReal || parentReal.startsWith(`${rootReal}/`);
}

// ── shell splicing ─────────────────────────────────────────────────

/** The `<div class="sl-markdown-content">…</div>` region is what
 * Starlight puts around the article body (see the built HTML
 * under `site/dist/`). Splicing at this boundary keeps the page
 * shell — sidebar, header, footer, CSP-safe scripts — byte-
 * identical to the last full build. */
export const ARTICLE_OPEN_MARKER = '<div class="sl-markdown-content">';

/** Splice `fragment` into the existing built HTML for `route`.
 * Returns the new HTML on success, or undefined when the shell is
 * missing (the site was never fully built for this route). The
 * caller emits `doc.published` without an override in that case. */
async function spliceIntoShell(options: {
  readonly distDir: string;
  readonly route: string;
  readonly fragment: string;
}): Promise<string | undefined> {
  const shellPath = shellPathForRoute(options.distDir, options.route);
  if (shellPath === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(shellPath, "utf8");
  } catch {
    return undefined;
  }
  return spliceArticleBody(raw, options.fragment);
}

/** Locate the built HTML for a site route. Astro emits
 * `<dist>/<route>/index.html`; the daemon's static handler also
 * accepts the file directly (a 404 fallback). Returns undefined
 * when neither shape exists. */
function shellPathForRoute(distDir: string, route: string): string | undefined {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  const candidate = trimmed.length === 0 ? `${distDir}/index.html` : `${distDir}/${trimmed}/index.html`;
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // Fall through.
  }
  return undefined;
}

/** Splice a rendered article fragment into the built HTML. Exported
 * for unit tests: input is the raw shell HTML plus the fragment, and
 * the return is the new HTML with the article body replaced. */
export function spliceArticleBody(shellHtml: string, fragment: string): string | undefined {
  const openAt = shellHtml.indexOf(ARTICLE_OPEN_MARKER);
  if (openAt === -1) return undefined;
  // Walk balanced `<div>` tags from the open marker to find the
  // matching close. A regex-only match would miss nested divs
  // (Starlight adds a lot). The walker is bounded (one HTML file),
  // linear, and refuses malformed input by returning undefined.
  let depth = 0;
  let cursor = openAt;
  while (cursor < shellHtml.length) {
    const nextOpen = shellHtml.indexOf("<div", cursor + 1);
    const nextClose = shellHtml.indexOf("</div>", cursor + 1);
    if (nextClose === -1) return undefined;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen;
      continue;
    }
    if (depth === 0) {
      // Splice: keep everything before the marker's content start,
      // insert the new fragment, keep everything from the close on.
      const contentStart = openAt + ARTICLE_OPEN_MARKER.length;
      const contentEnd = nextClose;
      return shellHtml.slice(0, contentStart) + fragment + shellHtml.slice(contentEnd);
    }
    depth--;
    cursor = nextClose;
  }
  return undefined;
}

// ── event append + fanout ──────────────────────────────────────────

/** Append + fold into the delivery-mode cache + fan out to the named
 * audiences. `doc.published` reaches both `rail` and `agent`. Returns
 * the assigned `seq`. */
async function appendAndFanOut(
  deps: PublishDependencies,
  event: import("@revkit/review-core").ReviewEventInput,
  audiences: readonly SubscriberAudience[],
): Promise<number> {
  const seq = await deps.store.append(event);
  const events = await deps.store.since(seq - 1);
  const materialised = events.find((e: ReviewEvent) => e.seq === seq);
  if (materialised !== undefined) {
    await deps.ingestDelivery(materialised);
    // AWAIT the fanout so the POST /api/publish response cannot
    // return before every SSE subscriber has enqueued the frame.
    // A previous `void bus.publish` version let the daemon reply
    // 201 before the microtask that delivers to the SSE stream
    // ran; on CI that produced a flaky test where the client
    // polled `/events` after the 201 landed and missed the
    // frame. `bus.publish` awaits each subscriber's `deliver`,
    // which for SSE is a synchronous `controller.enqueue` — so
    // awaiting here is nearly free but removes the race.
    await deps.bus.publish(materialised, { audiences });
  }
  return seq;
}

// ── serialisation mutex ────────────────────────────────────────────

/** A tiny FIFO mutex — the daemon runs one publish at a time.
 * `runPublish` is the only public entry point that acquires it. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let resolve: () => void = () => {};
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.tail = next;
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        resolve();
      }
    });
  }
}
const publishMutex = new Mutex();

// ── configuration ──────────────────────────────────────────────────

/** Hard cap on files in ONE publish batch — counted across `docs` and
 * `data` TOGETHER, not per array. Sixteen comfortably covers an ADR
 * with a plot (spec + data) plus a vocab tweak; a runaway batch is
 * refused so the mutex cannot be held for long.
 *
 * The MCP schema advertises `maxItems: 16` on each array, which is the
 * per-array bound the schema can express; the total is enforced here
 * and reported as its own `too-many-files` kind. `skill-examples.test.ts`
 * asserts the SKILL.md text states the total, so the two cannot drift. */
export const MAX_FILES_PER_PUBLISH = 16;

/** Per-array ceiling the request SCHEMAS enforce, deliberately well
 * above `MAX_FILES_PER_PUBLISH`.
 *
 * A schema cap of 16 per array would reject a 17-file batch with
 * `invalid-body` — a shape error that says nothing about the real
 * limit and nothing about what to do. Raising the schema ceiling
 * means every batch that is merely OVER THE LIMIT reaches the
 * orchestrator and is refused with `too-many-files` and a reason that
 * names the count and the fix. The schema ceiling remains as a hard
 * request-shape bound so a runaway array cannot allocate unbounded
 * before the orchestrator ever sees it; anything past it is genuinely
 * a malformed request rather than a large publish.
 *
 * Both the HTTP body schema and the MCP tool schema import this, so
 * the two cannot drift apart. */
export const PUBLISH_ARRAY_SHAPE_MAX = 64;

/** Re-export the confinement rejection so `daemon.ts` uses the same
 * spelling as the module tests. */
export { UNIFORM_PUBLISH_REJECTION };
