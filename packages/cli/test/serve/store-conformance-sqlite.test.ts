// Runs the shared conformance suite against `SqliteThreadStore` — the
// daemon's SHIPPED local backing, 455 lines with its own `BEGIN IMMEDIATE`
// seq allocator.
//
// This lane was added by the #76 review, and it is the one that should have
// existed from the start. `D1ThreadStore` is new code whose conformance
// failures would be caught by whoever wrote it; `SqliteThreadStore` has been
// in production since M2 item 2 and had never been run against the shared
// rules, so a divergence between it and the interface would have been
// invisible in both directions. The suite's whole argument is that three
// implementations of one interface are three claims until something runs all
// three.
//
// A case that fails HERE is a finding about the daemon's store, not a reason
// to skip the case: `storeConformance` has no skip mechanism to reach for.

import { afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadStore } from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { fixedClock, storeConformance, type StoreFactory } from "../../../review-core/test/store-conformance.ts";

describe("store conformance — SqliteThreadStore (daemon's bun:sqlite backing)", () => {
  const open: SqliteThreadStore[] = [];
  const dirs: string[] = [];
  /** The file `make()` opened this case, so `reopen()` can open the SAME
   * storage. `:memory:` cannot do this — a second `:memory:` connection is
   * a different, empty database — and this lane's whole reason for being
   * the daemon's shipped backing is that the daemon REOPENS its file
   * across restarts (`SqliteThreadStore.open` rehydrates head + state from
   * it). */
  let currentFile: string | undefined;

  const factory: StoreFactory = {
    name: "SqliteThreadStore (daemon's bun:sqlite backing)",
    async make(): Promise<ThreadStore> {
      // A fresh temp file per case, which keeps the suite
      // order-independent exactly as `:memory:` did, and `afterEach`
      // removes it.
      const dir = mkdtempSync(join(tmpdir(), "revkit-conformance-sqlite-"));
      dirs.push(dir);
      currentFile = join(dir, "threads.sqlite");
      const store = SqliteThreadStore.open({ filename: currentFile, clock: fixedClock() });
      open.push(store);
      return store;
    },
    async reopen(): Promise<ThreadStore> {
      if (currentFile === undefined) {
        throw new Error("reopen() before make(): the suite opens the storage before reopening it.");
      }
      const store = SqliteThreadStore.open({ filename: currentFile, clock: fixedClock() });
      open.push(store);
      return store;
    },
    async reset(): Promise<void> {
      // Nothing to drop — `make()` opens a fresh file per case, which is
      // what makes them independent.
    },
  };

  afterEach(() => {
    while (open.length > 0) open.pop()?.close();
    currentFile = undefined;
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  storeConformance(factory);
});
