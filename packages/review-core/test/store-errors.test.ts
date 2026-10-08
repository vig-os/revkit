import { expect, test } from "bun:test";
import * as reviewCore from "../src/index.ts";
import { ThreadStoreAppendError, ThreadStoreImportError, type AppendRejection } from "../src/index.ts";

test("#98-r1: every declared rejection kind has a bounded escaped field diagnostic and preserves machine data", async () => {
  const source = await Bun.file(new URL("../src/validator.ts", import.meta.url)).text();
  const union = source.split("export type AppendRejection =")[1]?.split("export type ValidationResult")[0] ?? "";
  const declared = [...union.matchAll(/kind: "([a-z-]+)"/g)].map((match) => match[1] ?? "").sort();
  const message = "untrusted\n\u001b[2J\u2028" + "x".repeat(1_000_000);
  const fixtures: { [K in AppendRejection["kind"]]: Extract<AppendRejection, { kind: K }> } = {
    "invalid-shape": { kind: "invalid-shape", message },
    "duplicate-thread": { kind: "duplicate-thread", threadId: "t", message },
    "unknown-thread": { kind: "unknown-thread", threadId: "t", message },
    "unknown-parent": { kind: "unknown-parent", threadId: "t", parentId: "p", message },
    "duplicate-comment-id": { kind: "duplicate-comment-id", commentId: "c", message },
    "not-open": { kind: "not-open", threadId: "t", message },
    "not-resolved": { kind: "not-resolved", threadId: "t", message },
    "unknown-comment": { kind: "unknown-comment", commentId: "c", message },
    "invalid-actor": { kind: "invalid-actor", actor: { kind: "agent", id: "a" }, message },
    "duplicate-ask": { kind: "duplicate-ask", askId: "a", message },
    "unknown-ask": { kind: "unknown-ask", askId: "a", message },
    "duplicate-answer": { kind: "duplicate-answer", askId: "a", message },
    "ask-not-pending": { kind: "ask-not-pending", askId: "a", currentStatus: "answered", attempted: "answered", message },
    "answer-kind-mismatch": { kind: "answer-kind-mismatch", askId: "a", askKind: "choice", answerKind: "text", message },
    "answer-shape-mismatch": { kind: "answer-shape-mismatch", askId: "a", askKind: "choice", field: "value", message },
    "duplicate-link": { kind: "duplicate-link", commentId: "c", backend: "github", message },
    "duplicate-external-id": { kind: "duplicate-external-id", commentId: "c", backend: "github", externalId: "1", existingCommentId: "c0", message },
    "already-orphaned": { kind: "already-orphaned", threadId: "t", message },
    "not-an-agent-draft": { kind: "not-an-agent-draft", threadId: "t", commentId: "c", message },
    "cross-file-reanchor": { kind: "cross-file-reanchor", threadId: "t", fromPath: "a", toPath: "b", message },
    "duplicate-review": { kind: "duplicate-review", reviewNodeId: "r", message },
    "review-not-pending": { kind: "review-not-pending", reviewNodeId: "r", currentStatus: "submitted", attempted: "submitted", message },
  };
  const paths: Record<AppendRejection["kind"], string> = {
    "invalid-shape": "event",
    "duplicate-thread": "threadId",
    "unknown-thread": "threadId",
    "unknown-parent": "parentId",
    "duplicate-comment-id": "commentId",
    "not-open": "threadId",
    "not-resolved": "threadId",
    "unknown-comment": "commentId",
    "invalid-actor": "actor",
    "duplicate-ask": "askId",
    "unknown-ask": "askId",
    "duplicate-answer": "askId",
    "ask-not-pending": "askId",
    "answer-kind-mismatch": "answer.kind",
    "answer-shape-mismatch": "answer.value",
    "duplicate-link": "external",
    "duplicate-external-id": "external",
    "already-orphaned": "threadId",
    "not-an-agent-draft": "commentId",
    "cross-file-reanchor": "anchor.path",
    "duplicate-review": "reviewNodeId",
    "review-not-pending": "reviewNodeId",
  };
  expect(Object.keys(fixtures).sort()).toEqual(declared);
  for (const rejection of Object.values(fixtures)) {
    const append = new ThreadStoreAppendError(rejection);
    expect(append.rejection).toBe(rejection);
    expect(append.message.length).toBeLessThan(1200);
    const open = new reviewCore.ThreadStoreOpenError(rejection, "db\n" + "x".repeat(1_000_000));
    const imported = new ThreadStoreImportError(rejection.message, {
      rejection: { kind: rejection.kind, seq: 1, index: 0, transition: rejection },
    });
    expect(open.rejection).toBe(rejection);
    expect(imported.rejection?.transition).toBe(rejection);
    for (const error of [append, open, imported]) {
      expect(error.message).toContain(`field "${paths[rejection.kind]}"`);
      expect(error.message).toContain(rejection.kind);
      expect(error.message).toContain("…(+");
      expect(error.message).toContain("untrusted\\n");
      expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(error.message.length).toBeLessThan(1200);
    }
  }
});

test("#98-r1: field paths, repair labels and control-only diagnostics stay bounded", () => {
  const rejection: AppendRejection = {
    kind: "answer-shape-mismatch", askId: "ask-1", askKind: "choice",
    field: "bad\n" + "\u001b".repeat(1_000_000), message: "\n".repeat(1_000_000),
  };
  const append = new ThreadStoreAppendError(rejection);
  expect(append.message.length).toBeLessThan(1200);
  const open = new reviewCore.ThreadStoreOpenError(rejection, "\u2028".repeat(1_000_000));
  for (const error of [append, open]) {
    expect(error.message).toContain('field "answer.bad\\n');
    expect(error.message).toContain("answer-shape-mismatch");
    expect(error.message).toContain("…(+");
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(error.message.length).toBeLessThan(1200);
  }
  expect(open.message).toContain("restore from backup");
  expect(reviewCore.quoteStoreDiagnostic("x".repeat(1_000_000))).toBe('"' + "x".repeat(120) + '"…(+999880 chars)');
});
