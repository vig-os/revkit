// Runs the shared conformance suite against review-core's OWN reference
// implementation, so the suite is exercised in the package that owns the
// interface rather than only from the packages that consume it.
//
// This is the lane that fails fastest when `append`/`since`/`import`
// change: the reference implementation is the one every other backing is
// compared against, and it needs no I/O, no clock and no database.

import { describe } from "bun:test";
import { InMemoryThreadStore, type ThreadStore } from "../src/index.ts";
import { fixedClock, storeConformance, type StoreFactory } from "./store-conformance.ts";

describe("store conformance — InMemoryThreadStore (review-core reference)", () => {
  const factory: StoreFactory = {
    name: "InMemoryThreadStore (review-core reference)",
    async make(): Promise<ThreadStore> {
      return new InMemoryThreadStore({ clock: fixedClock() });
    },
    async reset(): Promise<void> {
      // Nothing to drop — `make()` hands back a fresh instance, which is
      // already empty. Same shape as any other in-memory store.
    },
  };

  storeConformance(factory);
});
