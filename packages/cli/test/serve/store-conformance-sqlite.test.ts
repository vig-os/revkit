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
import type { ThreadStore } from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { fixedClock, storeConformance, type StoreFactory } from "../../../review-core/test/store-conformance.ts";

describe("store conformance — SqliteThreadStore (daemon's bun:sqlite backing)", () => {
  const open: SqliteThreadStore[] = [];

  const factory: StoreFactory = {
    name: "SqliteThreadStore (daemon's bun:sqlite backing)",
    async make(): Promise<ThreadStore> {
      // `:memory:` so each case gets a private database and the suite stays
      // order-independent; the tracked list exists only so `afterEach` can
      // close them, which keeps bun from complaining about open handles.
      const store = SqliteThreadStore.open({ filename: ":memory:", clock: fixedClock() });
      open.push(store);
      return store;
    },
    async reset(): Promise<void> {
      // Nothing to drop — `make()` opens a fresh `:memory:` database per
      // case, which is what makes them independent.
    },
  };

  afterEach(() => {
    while (open.length > 0) open.pop()?.close();
  });

  storeConformance(factory);
});
