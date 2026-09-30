// Lifecycle tests for the asks view (`reduceAsks` + `selectAsks`) and
// the paired `validateNext` transitions. Mirrors `reducer.test.ts` for
// threads: the reducer is total on any partial slice, the terminal
// events land in exactly one state, and the validator refuses a
// double transition.
//
// These are the round-trip guarantees `ask` / `await_answer` (M2 item
// 7) depend on: an answered ask stays answered, a cancelled ask
// cannot be answered later, and an ask that expired cannot be
// answered by a slow POST that raced the expiry timer.

import { describe, expect, test } from "bun:test";
import {
  askSchema,
  CURRENT_SCHEMA_VERSION,
  emptyLogState,
  InMemoryThreadStore,
  reduceAsks,
  selectAsks,
  validateAnswerAgainstSpec,
  validateNext,
  type Ask,
  type AskAnswer,
  type ReviewEvent,
  type ReviewEventInput,
} from "../src/index.ts";

const actor = { kind: "gh-user", id: "gerchowl" } as const;
const agent = { kind: "agent", id: "revkit-live" } as const;
const t0 = "2026-09-30T12:00:00Z";
const t1 = "2026-09-30T12:00:01Z";

const choiceSpec: Ask = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  kind: "choice",
  title: "Which storage?",
  options: [
    { id: "d1", label: "D1" },
    { id: "kv", label: "KV" },
  ],
  allowOther: false,
  multi: false,
};

function evCreated(askId: string, seq: number, opts: { url?: string; expiresAtMs?: number } = {}): ReviewEvent {
  return {
    seq,
    ts: t0,
    actor: agent,
    kind: "ask.created",
    askId,
    spec: choiceSpec,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
  };
}

function evAnswered(askId: string, seq: number, value = "d1"): ReviewEvent {
  const answer: AskAnswer = { kind: "choice", value };
  return { seq, ts: t1, actor, kind: "ask.answered", askId, answer };
}

function evCancelled(askId: string, seq: number, reason?: string): ReviewEvent {
  return {
    seq,
    ts: t1,
    actor: agent,
    kind: "ask.cancelled",
    askId,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function evExpired(askId: string, seq: number): ReviewEvent {
  return { seq, ts: t1, actor: agent, kind: "ask.expired", askId };
}

describe("reduceAsks — happy paths", () => {
  test("a lone ask.created reduces to a pending record", () => {
    const asks = reduceAsks([evCreated("ask-1", 1, { url: "/ask/ask-1", expiresAtMs: 999 })]);
    const record = asks.get("ask-1");
    expect(record?.status).toBe("pending");
    expect(record?.url).toBe("/ask/ask-1");
    expect(record?.expiresAtMs).toBe(999);
    expect(record?.createdSeq).toBe(1);
  });

  test("ask.answered flips status and carries the answer + ts", () => {
    const asks = reduceAsks([evCreated("ask-1", 1), evAnswered("ask-1", 2, "kv")]);
    const record = asks.get("ask-1");
    expect(record?.status).toBe("answered");
    expect(record?.answer).toEqual({ kind: "choice", value: "kv" });
    expect(record?.answeredAt).toBe(t1);
  });

  test("ask.cancelled and ask.expired each land in the right terminal state", () => {
    const cancelled = reduceAsks([evCreated("c", 1), evCancelled("c", 2, "stale after rebuild")]);
    expect(cancelled.get("c")?.status).toBe("cancelled");
    expect(cancelled.get("c")?.cancelReason).toBe("stale after rebuild");

    const expired = reduceAsks([evCreated("e", 1), evExpired("e", 2)]);
    expect(expired.get("e")?.status).toBe("expired");
    expect(expired.get("e")?.expiredAt).toBe(t1);
  });

  test("selectAsks filters by status and orders by createdSeq", () => {
    const events = [
      evCreated("a", 1),
      evCreated("b", 2),
      evAnswered("a", 3),
      evCancelled("b", 4),
      evCreated("c", 5),
    ];
    const pending = selectAsks(events, { status: "pending" }).map((a) => a.id);
    expect(pending).toEqual(["c"]);
    const terminal = selectAsks(events, { status: ["answered", "cancelled"] }).map((a) => a.id);
    expect(terminal).toEqual(["a", "b"]);
  });
});

describe("reduceAsks — total on partial slices", () => {
  test("a terminal event before its create is skipped, not thrown", () => {
    // A `since(after)` slice that omits the create must not crash.
    // The reducer's guarding for terminals mirrors reducer.ts for
    // threads.
    const orphan = reduceAsks([evAnswered("only", 2)]);
    expect(orphan.size).toBe(0);
  });

  test("a second terminal event on the same ask is ignored (append-side would refuse)", () => {
    const asks = reduceAsks([evCreated("a", 1), evAnswered("a", 2), evCancelled("a", 3)]);
    // First terminal wins; second is a no-op on the derived view.
    expect(asks.get("a")?.status).toBe("answered");
  });
});

describe("validateNext — ask lifecycle", () => {
  test("duplicate ask.created is refused with duplicate-ask", () => {
    const state = emptyLogState();
    expect(validateNext(state, evCreated("a", 1)).ok).toBe(true);
    const result = validateNext(state, evCreated("a", 2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("duplicate-ask");
  });

  test("ask.answered on unknown ask is refused with unknown-ask", () => {
    const result = validateNext(emptyLogState(), evAnswered("nope", 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("unknown-ask");
  });

  test("a second ask.answered is refused with duplicate-answer", () => {
    const state = emptyLogState();
    validateNext(state, evCreated("a", 1));
    validateNext(state, evAnswered("a", 2));
    const result = validateNext(state, evAnswered("a", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("duplicate-answer");
  });

  test("ask.answered after cancel is refused with ask-not-pending naming the winner", () => {
    const state = emptyLogState();
    validateNext(state, evCreated("a", 1));
    validateNext(state, evCancelled("a", 2));
    const result = validateNext(state, evAnswered("a", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("ask-not-pending");
    if (result.rejection.kind !== "ask-not-pending") return;
    expect(result.rejection.currentStatus).toBe("cancelled");
    expect(result.rejection.attempted).toBe("answered");
  });

  test("ask.cancelled after answer is refused with ask-not-pending", () => {
    const state = emptyLogState();
    validateNext(state, evCreated("a", 1));
    validateNext(state, evAnswered("a", 2));
    const result = validateNext(state, evCancelled("a", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("ask-not-pending");
  });

  test("ask.expired after cancel is refused (both terminals are equally sticky)", () => {
    const state = emptyLogState();
    validateNext(state, evCreated("a", 1));
    validateNext(state, evCancelled("a", 2));
    const result = validateNext(state, evExpired("a", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("ask-not-pending");
  });

  test("answer-kind-mismatch fires when the answer discriminant differs from the spec's kind", () => {
    const state = emptyLogState();
    validateNext(state, evCreated("a", 1));
    // `spec.kind === "choice"` but the answer says "text".
    const bad: ReviewEvent = {
      seq: 2,
      ts: t1,
      actor,
      kind: "ask.answered",
      askId: "a",
      answer: { kind: "text", text: "hello" },
    };
    const result = validateNext(state, bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("answer-kind-mismatch");
  });
});

describe("InMemoryThreadStore.asks / ask — plugged into the review-core store", () => {
  test("asks() returns the reduced view; ask(id) is one record", async () => {
    const store = new InMemoryThreadStore({ clock: () => t0 });
    const createInput: ReviewEventInput = {
      actor: agent,
      kind: "ask.created",
      askId: "ask-1",
      spec: choiceSpec,
      url: "/ask/ask-1",
    };
    await store.append(createInput);
    const answerInput: ReviewEventInput = {
      actor,
      kind: "ask.answered",
      askId: "ask-1",
      answer: { kind: "choice", value: "d1" },
    };
    await store.append(answerInput);
    const asks = await store.asks();
    expect(asks).toHaveLength(1);
    expect(asks[0]?.status).toBe("answered");
    const record = await store.ask("ask-1");
    expect(record?.status).toBe("answered");
    expect(record?.answer).toEqual({ kind: "choice", value: "d1" });
  });
});

// ── PR #52 review: answer-shape validation at the append boundary ─

describe("validateAnswerAgainstSpec — answer values must conform to the ask", () => {
  test("choice: value not in options is refused when allowOther is false", () => {
    const spec: Ask = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kind: "choice",
      title: "Which?",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      allowOther: false,
      multi: false,
    };
    const issue = validateAnswerAgainstSpec(spec, { kind: "choice", value: "zzz" });
    expect(issue).not.toBeUndefined();
    expect(issue!.field).toBe("value");
    expect(issue!.message).toContain("not one of the ask's options");
  });

  test("choice: value not in options is ACCEPTED when allowOther is set and value starts with 'other:'", () => {
    const spec: Ask = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kind: "choice",
      title: "Which?",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      allowOther: true,
      multi: false,
    };
    expect(validateAnswerAgainstSpec(spec, { kind: "choice", value: "other:custom answer" })).toBeUndefined();
    // But a bare token that is not an option id and not other-prefixed is still refused.
    expect(validateAnswerAgainstSpec(spec, { kind: "choice", value: "zzz" })).not.toBeUndefined();
  });

  test("choice: array-value on a single-choice spec is refused, and vice versa", () => {
    const single: Ask = { schemaVersion: 1, kind: "choice", title: "x", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowOther: false, multi: false };
    const multi: Ask = { ...single, multi: true };
    const arrOnSingle = validateAnswerAgainstSpec(single, { kind: "choice", value: ["a", "b"] as unknown as string });
    expect(arrOnSingle?.message).toContain("must be a single option id");
    const strOnMulti = validateAnswerAgainstSpec(multi, { kind: "choice", value: "a" });
    expect(strOnMulti?.message).toContain("must be an array of option ids");
  });

  test("scale: value outside [min,max] is refused; on-step values are accepted", () => {
    const spec: Ask = { schemaVersion: 1, kind: "scale", title: "x", min: 1, max: 5, step: 1 };
    expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: 99999 })?.field).toBe("value");
    expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: 0 })?.field).toBe("value");
    expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: 3 })).toBeUndefined();
  });

  test("scale: off-step values are refused (step=2, value=3)", () => {
    const spec: Ask = { schemaVersion: 1, kind: "scale", title: "x", min: 0, max: 10, step: 2 };
    // Valid on-step values: 0, 2, 4, 6, 8, 10.
    expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: 6 })).toBeUndefined();
    const issue = validateAnswerAgainstSpec(spec, { kind: "scale", value: 3 });
    expect(issue?.field).toBe("value");
    expect(issue?.message).toContain("not on a step");
  });

  test("PR #52 round-2 review — scale spec with an off-step span (min=1,max=4,step=2 → span 3) is refused by askSchema", () => {
    // The reviewer's failure mode: an off-span spec would accept
    // itself but then reject its own default answer.
    // askSchema.superRefine catches this at CREATION time; the
    // daemon's `POST /api/asks` refuses with a Zod-issue 400.
    const spec = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kind: "scale",
      title: "off-step",
      min: 1,
      max: 4,
      step: 2, // span=3 is not a multiple of 2
    };
    // Round-trip through the ask schema — a strict `.strict()`
    // refinement rejects with a message on `step`.
    const result = askSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("step");
  });

  test("PR #52 round-2 review — scale on 1..4 step 1 (odd span): value 2 is accepted, value 2.5 (old midpoint) is refused", () => {
    // The reviewer's repro: `(1+4)/2 = 2.5` is off-step. The
    // integer-step-index validator refuses 2.5 with a clear
    // message and accepts 1, 2, 3, 4.
    const spec: Ask = { schemaVersion: 1, kind: "scale", title: "x", min: 1, max: 4, step: 1 };
    for (const v of [1, 2, 3, 4]) {
      expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: v }), `value=${v}`).toBeUndefined();
    }
    const bad = validateAnswerAgainstSpec(spec, { kind: "scale", value: 2.5 });
    expect(bad?.message).toContain("not on a step");
  });

  test("PR #52 round-2 review — scale tolerance scales with magnitude (999_999_999.999 on 0..1e9 step 0.001 is on-step)", () => {
    // Large-magnitude scales with a tiny step: binary-float noise
    // grows with the magnitude, and the earlier `1e-9` tolerance
    // (unscaled) rejected legitimate answers. The scaled
    // tolerance accepts values that reconstruct within
    // proportional noise.
    const spec: Ask = { schemaVersion: 1, kind: "scale", title: "x", min: 0, max: 1_000_000_000, step: 0.001 };
    // 999_999_999.999 = min + (999_999_999_999 * step) — a valid step.
    expect(validateAnswerAgainstSpec(spec, { kind: "scale", value: 999_999_999.999 })).toBeUndefined();
  });

  test("rank: ranking must be an exact permutation of the option ids", () => {
    const spec: Ask = { schemaVersion: 1, kind: "rank", title: "x", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] };
    expect(validateAnswerAgainstSpec(spec, { kind: "rank", ranking: ["nope"] })?.message).toContain("does not match option count");
    expect(validateAnswerAgainstSpec(spec, { kind: "rank", ranking: ["a", "b", "nope"] })?.message).toContain("not one of the ask's options");
    expect(validateAnswerAgainstSpec(spec, { kind: "rank", ranking: ["a", "a", "b"] })?.message).toContain("duplicate");
    expect(validateAnswerAgainstSpec(spec, { kind: "rank", ranking: ["c", "b", "a"] })).toBeUndefined();
  });

  test("region: odd-length coordinates array is refused", () => {
    const spec: Ask = { schemaVersion: 1, kind: "region", title: "x", target: "plots/x.json" };
    expect(validateAnswerAgainstSpec(spec, { kind: "region", coordinates: [0.5, 0.5, 0.6] })?.message).toContain("even length");
    expect(validateAnswerAgainstSpec(spec, { kind: "region", coordinates: [0.5, 0.5] })).toBeUndefined();
  });

  test("integration: validateNext with a malformed answer returns answer-shape-mismatch", async () => {
    const store = new InMemoryThreadStore({ clock: () => t0 });
    const spec: Ask = {
      schemaVersion: 1,
      kind: "choice",
      title: "Which?",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      allowOther: false,
      multi: false,
    };
    await store.append({ actor: agent, kind: "ask.created", askId: "ask-1", spec });
    // A `choice` answer with a value that is not an option id must be refused.
    let caught: unknown;
    try {
      await store.append({ actor, kind: "ask.answered", askId: "ask-1", answer: { kind: "choice", value: "zzz" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const rejection = (caught as { rejection: { kind: string; field: string } }).rejection;
    expect(rejection.kind).toBe("answer-shape-mismatch");
    expect(rejection.field).toBe("value");
  });
});
