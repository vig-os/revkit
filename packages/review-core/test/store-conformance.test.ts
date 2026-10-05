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
    async reopen(): Promise<ThreadStore> {
      // Honest answer, not a dodge: the reference store keeps its log in
      // INSTANCE fields (`#events`, `#logState`, `#head`), so there is no
      // storage for a second handle to reach. "Reopen" is a new instance,
      // and a new instance is a new empty log. The case that uses this
      // reads what the second instance can see and asserts the verdict
      // that follows, rather than pretending a second handle exists.
      return new InMemoryThreadStore({ clock: fixedClock() });
    },
    async reset(): Promise<void> {
      // Nothing to drop — `make()` hands back a fresh instance, which is
      // already empty. Same shape as any other in-memory store.
    },
  };

  storeConformance(factory);
});
