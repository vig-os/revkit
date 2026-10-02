// Background full-build coordinator for the publish fast path (M2
// item 9, story A4, ADR-0001 amendment).
//
// The fast path renders a single changed `.md` document in-process
// and splices it into the previous full build's HTML. It REFUSES a
// document whose source uses a feature the shared pipeline cannot
// match byte-for-byte (fenced code, Starlight asides, indented
// code) and it cannot render a document that has no built shell yet
// (a brand-new route, or a consumer that never built). Those are not
// failures — the source is on disk and `revkit check` approved it —
// they are "the reviewer will see this at the next full build". This
// module IS that next full build.
//
// ## One primitive, not a private astro spawn
//
// The build runs through `runBuildCommand` — the SAME function
// `revkit build` runs — so a background build and a manual build
// cannot diverge. That matters more than it looks: `runBuildCommand`
// is the only path that (a) runs `revkit check` over the whole
// consumer tree first, (b) stages the consumer's content into a
// private directory under `.revkit/build/` whose `node_modules` is a
// symlink to the PACKAGED dependency tree, (c) resolves the `astro`
// binary by absolute path from that packaged root, and (d) runs
// `revkit check-dist` over the output before declaring success. A
// background build that shelled out to `site/node_modules/.bin/astro`
// would work in THIS repo (the dev shell has those binaries) and fail
// for every normal consumer, which by ADR-0010 has no `site/` at all.
// Output lands in `.revkit/dist` — the same `defaultConsumerDist` the
// daemon serves from.
//
// ## Durability
//
// The coordinator's state lives in `.revkit/publish-state.json`
// (mode 0600), not in memory. Every lifecycle transition appends a
// `build.*` event through the store, so each frame carries a real
// positive `seq`: an SSE client that reconnects with `Last-Event-ID`
// replays the build, and a daemon that died mid-build finds the
// `pending` record on restart and reschedules it. Nothing here mints
// a synthetic seq-0 frame (a seq-0 frame breaks the monotonic resume
// contract the rail and the agent channel both depend on).
//
// `generation` on every event is the publish generation the build was
// scheduled FOR. That is what makes generation safety decidable: a
// `build.succeeded` for generation G may clear the refusals recorded
// by G and must NOT clear a refusal recorded by a later publish G'
// that arrived while the build was running.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewEventInput } from "@revkit/review-core";
import { ensureRevkitDir } from "./serve-state.ts";
import { runBuildCommand as defaultRunBuildCommand, type RunBuildResult } from "../build/cli.ts";

/** Why a build is needed. Every non-`fast` publish outcome lands in
 * exactly one of these — there is no "no build" path for a document
 * that is on disk but not visible in the browser.
 *
 * - `data-only`: the path has no route of its own (plot spec / data
 *   file, `vocab/terms.yaml`). Nothing fast-path can render, but the
 *   plots and pages that embed it are build-time products.
 * - `fast-path-refused`: the renderer refused the source for byte-
 *   parity reasons. The write landed; the HTML did not.
 * - `render-failed`: the renderer threw AFTER the check passed. Same
 *   visible state as a refusal, different cause.
 * - `shell-missing`: no built HTML exists for the route (brand-new
 *   route, or a consumer that never ran a build). There is nothing
 *   to splice into. */
export const publishBuildReasons = [
  "data-only",
  "fast-path-refused",
  "render-failed",
  "shell-missing",
] as const;
export type PublishBuildReason = (typeof publishBuildReasons)[number];

export interface PublishBuildItem {
  readonly path: string;
  readonly route?: string;
  readonly reason: PublishBuildReason;
  readonly detail?: string;
}

/** The persisted coordinator state.
 *
 * `status` is the whole lifecycle: `fast` (every document in the
 * batch rendered and was served — nothing to build), `pending`
 * (scheduled), `running` (a build is in this process right now),
 * `succeeded` / `failed` (terminal for this generation). */
export interface PublishBuildRecord {
  readonly generation: string;
  readonly status: "fast" | "pending" | "running" | "succeeded" | "failed";
  readonly items: readonly PublishBuildItem[];
  readonly error?: string;
  readonly updatedAt: string;
}

/** Terminal outcome handed to `onSettled` after each build attempt.
 * `generation` is the generation the attempt was FOR — it may no
 * longer be the current one (a newer publish landed while the build
 * ran), which is exactly why the callback names it. */
export interface PublishBuildSettlement {
  readonly generation: string;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}

export interface PublishBuildCoordinator {
  /** Record a publish generation. `items` empty means every document
   * in the batch rendered — status `fast`, no build, no event. A
   * non-empty `items` schedules a debounced build and appends
   * `build.requested`. Returns the record so the caller can react
   * to the schedule synchronously (the daemon keys its refusal map
   * off the returned items). */
  record(generation: string, items: readonly PublishBuildItem[]): Promise<PublishBuildRecord>;
  state(): PublishBuildRecord | undefined;
  /** Resolve when no build is scheduled or running. Test/shutdown
   * helper; never used on a request path. */
  awaitIdle(): Promise<void>;
  stop(): void;
}

export type BuildRunner = (
  args: readonly string[],
  env: { readonly cwd: string; readonly version: string; readonly repoSlug: string },
) => Promise<RunBuildResult>;

export function createPublishBuildCoordinator(options: {
  readonly repoRoot: string;
  readonly distDir: string;
  readonly version: string;
  readonly repoSlug: string;
  /** Append one durable lifecycle event. Rejecting is survivable:
   * the persisted record is the reconciliation source, so a restart
   * re-announces the pending build. */
  readonly appendEvent: (event: ReviewEventInput) => Promise<void>;
  /** Injectable build primitive. Defaults to the shared
   * `runBuildCommand`; tests pass a stub so the acceptance suite
   * does not pay for a real astro build. */
  readonly runBuildCommand?: BuildRunner;
  /** Coalescing window for a burst of publishes. */
  readonly debounceMs?: number;
  /** Called after each build attempt with the generation the attempt
   * was FOR, so the caller can clear exactly that generation's
   * refusals and no others. */
  readonly onSettled?: (settlement: PublishBuildSettlement) => void;
  readonly log?: (level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) => void;
}): PublishBuildCoordinator {
  const statePath = join(options.repoRoot, ".revkit", "publish-state.json");
  const runBuild = options.runBuildCommand ?? defaultRunBuildCommand;
  const debounceMs = options.debounceMs ?? 500;
  let current = readRecord(statePath);
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleResolvers: (() => void)[] = [];

  const writeRecord = (record: PublishBuildRecord): void => {
    ensureRevkitDir(options.repoRoot);
    const tmp = `${statePath}.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, statePath);
    current = record;
  };

  const notifyIdle = (): void => {
    if (running || timer !== undefined || current?.status === "pending") return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, debounceMs);
  };

  const routesOf = (record: PublishBuildRecord): string[] =>
    [...new Set(record.items.flatMap((item) => (item.route === undefined ? [] : [item.route])))];

  const append = async (
    kind: "build.requested" | "build.started" | "build.succeeded" | "build.failed",
    record: PublishBuildRecord,
    error?: string,
  ): Promise<void> => {
    const routes = routesOf(record);
    const envelope = {
      actor: { kind: "system" as const, id: "revkit-daemon" },
      generation: record.generation,
      routes,
    };
    // Spelled out per-kind rather than passed as a widened union:
    // `ReviewEventInput` discriminates on `kind`, so a single object
    // literal with a union-typed `kind` will not typecheck (and the
    // optional `error` on `build.failed` is not a legal field on the
    // other three).
    if (kind === "build.failed") {
      await options.appendEvent({
        kind: "build.failed",
        ...envelope,
        error: error ?? "revkit build failed without a diagnostic",
      });
      return;
    }
    await options.appendEvent({ kind, ...envelope });
  };

  const settle = (settlement: PublishBuildSettlement): void => {
    try {
      options.onSettled?.(settlement);
    } catch (error) {
      options.log?.("warn", "publish-build.on-settled-threw", {
        generation: settlement.generation,
        errorKind: (error as Error).name,
      });
    }
  };

  const drain = async (): Promise<void> => {
    if (running || stopped || current?.status !== "pending") {
      notifyIdle();
      return;
    }
    const generation = current.generation;
    const starting = current;
    running = true;
    try {
      await append("build.started", starting);
      if (current?.generation === generation) {
        writeRecord({ ...starting, status: "running", updatedAt: new Date().toISOString() });
      }
      const result = await runBuild(
        ["--dir", options.repoRoot, "--out", options.distDir],
        { cwd: options.repoRoot, version: options.version, repoSlug: options.repoSlug },
      );
      const latest = current;
      // A newer publish landed while this build ran. Its record is the
      // truth; the outcome of THIS build describes a generation that is
      // no longer on screen, so it neither settles nor clears anything
      // except through `onSettled` (which is generation-scoped anyway).
      if (latest?.generation !== generation) {
        settle({
          generation,
          status: result.exitCode === 0 ? "succeeded" : "failed",
          ...(result.exitCode === 0 ? {} : { error: errorFromResult(result) }),
        });
        return;
      }
      if (result.exitCode === 0) {
        await append("build.succeeded", latest);
        if (current?.generation === generation) {
          writeRecord({ ...latest, status: "succeeded", error: undefined, updatedAt: new Date().toISOString() });
        }
        settle({ generation, status: "succeeded" });
      } else {
        const error = errorFromResult(result);
        await append("build.failed", latest, error);
        if (current?.generation === generation) {
          writeRecord({ ...latest, status: "failed", error, updatedAt: new Date().toISOString() });
        }
        settle({ generation, status: "failed", error });
      }
    } catch (error) {
      // The lifecycle itself failed (an append rejected, the build
      // primitive threw). Terminal for this generation: retrying on a
      // fixed debounce would spin forever against a condition that is
      // not going to change. The record says `failed` so the banner
      // shows the reason, and a NEW publish schedules a fresh attempt.
      options.log?.("error", "publish-build.lifecycle-failed", {
        generation,
        errorKind: (error as Error).name,
      });
      if (current?.generation === generation) {
        writeRecord({
          ...starting,
          status: "failed",
          error: (error as Error).message,
          updatedAt: new Date().toISOString(),
        });
      }
      settle({ generation, status: "failed", error: (error as Error).message });
    } finally {
      running = false;
      if (!stopped && current?.status === "pending") schedule();
      notifyIdle();
    }
  };

  // ── restart reconciliation ──────────────────────────────────────
  //
  // A record left `pending` or `running` means this process died with a
  // build outstanding. `running` is process-local and is NOT
  // authoritative across a restart (nothing is running now), so it is
  // demoted to `pending` and retried. Re-announcing `build.requested`
  // is what makes the durable log tell the same story as the persisted
  // state: a rail that connects after the restart sees the build as
  // requested rather than silently waiting on an event that was lost
  // with the dead process. Idempotent — the frames carry the same
  // generation, so a consumer that already saw the original
  // `build.requested` simply sees it again.
  if (current?.status === "pending" || current?.status === "running") {
    const resumed: PublishBuildRecord = { ...current, status: "pending", updatedAt: new Date().toISOString() };
    writeRecord(resumed);
    void append("build.requested", resumed).catch((error: unknown) => {
      options.log?.("warn", "publish-build.resume-event-failed", {
        generation: resumed.generation,
        errorKind: (error as Error).name,
      });
    });
    schedule();
  }

  return {
    async record(generation, items): Promise<PublishBuildRecord> {
      const record: PublishBuildRecord = {
        generation,
        status: items.length === 0 ? "fast" : "pending",
        items,
        updatedAt: new Date().toISOString(),
      };
      writeRecord(record);
      if (items.length > 0) {
        try {
          await append("build.requested", record);
        } catch (error) {
          // The source is already committed and the build is already
          // scheduled — only the announcement was lost. The persisted
          // record carries the generation, so a restart reconciles.
          options.log?.("warn", "publish-build.request-event-failed", {
            generation,
            errorKind: (error as Error).name,
          });
        }
        schedule();
      } else {
        notifyIdle();
      }
      return record;
    },
    state(): PublishBuildRecord | undefined {
      return current;
    },
    awaitIdle(): Promise<void> {
      if (!running && timer === undefined && current?.status !== "pending") return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      notifyIdle();
    },
  };
}

/** Tail of a failed build's output, clipped to the schema's 8192-char
 * cap. `stderr` first (astro's diagnostics land there), then stdout,
 * then the bare exit code so the message is never empty. */
function errorFromResult(result: RunBuildResult): string {
  const text = result.stderr.trim().length > 0
    ? result.stderr
    : result.stdout.trim().length > 0
      ? result.stdout
      : `revkit build exited ${result.exitCode}`;
  return text.slice(-8192);
}

function readRecord(path: string): PublishBuildRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PublishBuildRecord;
    if (typeof value.generation !== "string" || !Array.isArray(value.items)) return undefined;
    if (!["fast", "pending", "running", "succeeded", "failed"].includes(value.status)) return undefined;
    if (!value.items.every((item) =>
      typeof item.path === "string" &&
      publishBuildReasons.includes(item.reason as PublishBuildReason),
    )) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
