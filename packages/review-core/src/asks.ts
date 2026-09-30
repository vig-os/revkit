// Ask (question spec) schema — the JSON the agent writes and the daemon
// serves at /ask/<id> (DESIGN-0001 §5.1, ADR-0007). Runtime asks live under
// `.revkit/asks/<id>.json` (gitignored, ADR-0007 acceptance); the site's
// `asks` content collection exists so a promoted spec (`revkit ask --keep`
// → `docs/decisions/`, wired up in M2 item 7) still validates at build
// time.
//
// The id is the filename, not a body field — this matches ADR-0007's shape
// (the daemon assigns ids) and keeps the source of truth in one place.
//
// Moved from `site/src/content/schemas/asks.ts` into review-core because
// the `ask.created` / `ask.answered` events need the same shape at the
// process boundary; keeping one copy avoids the schema drifting between
// the site collection and the event log (ADR-0025: one core, three
// surfaces).
import { z } from "zod";
import { schemaVersionField } from "./schema-version.ts";

/** The kinds a question spec may take (DESIGN-0001 §5.1). Kept as a const
 * array so the loader, the guard and tests all iterate the same list. */
export const askKinds = ["choice", "rank", "scale", "text", "region", "review"] as const;
export type AskKind = (typeof askKinds)[number];

/** One option in a `choice` or `rank` ask. `preview` points at a plot spec
 * that renders inside the option card (DESIGN-0001 §5.1). */
const optionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    preview: z.string().min(1).optional(),
  })
  .strict();

const baseFields = {
  schemaVersion: schemaVersionField(".revkit/asks/<id>.json"),
  title: z.string().min(1),
  prompt: z.string().min(1).optional(),
};

/** Kind-specific variants — `.strict()` on each so a stray or misspelled
 * field fails loudly rather than silently strips. */
const askVariants = [
  z
    .object({
      ...baseFields,
      kind: z.literal("choice"),
      options: z.array(optionSchema).min(2),
      allowOther: z.boolean().default(false),
      multi: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      kind: z.literal("rank"),
      options: z.array(optionSchema).min(2),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      kind: z.literal("scale"),
      min: z.number(),
      max: z.number(),
      step: z.number().positive().default(1),
      labels: z
        .object({
          min: z.string().min(1).optional(),
          max: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      kind: z.literal("text"),
      multiline: z.boolean().default(false),
      placeholder: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      kind: z.literal("region"),
      target: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      kind: z.literal("review"),
      target: z.string().min(1),
    })
    .strict(),
] as const;

/** Discriminated union on `kind` so an invalid kind fails with a message
 * that lists the allowed set. The `superRefine` below adds two
 * cross-field checks the discriminant cannot see:
 *
 *   - `choice`/`rank`: option ids are UNIQUE across `options[]`
 *     (duplicates would let the daemon route an answer to two
 *     rows in one call). Reports the offending index in the path.
 *   - `scale`: `min < max` (equal or flipped is not a scale).
 *
 * ANSWER-side validation (that a `choice.value` is an option id,
 * a `rank.ranking` is a permutation of the option ids, a
 * `scale.value` is in [min, max] on a step) lives with the event
 * log in `validator.ts::validateAnswerAgainstSpec`, run at
 * `ask.answered` append-time; PR #52 review pointed out that
 * doing it only here would leave a client-side bypass writing a
 * malformed answer to the log. */
export const askSchema = z.discriminatedUnion("kind", askVariants).superRefine((ask, ctx) => {
  if (ask.kind === "choice" || ask.kind === "rank") {
    const seen = new Map<string, number>();
    for (const [index, option] of ask.options.entries()) {
      const previous = seen.get(option.id);
      if (previous !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["options", index, "id"],
          message: `duplicate option id '${option.id}' (also at options[${previous}]) — the daemon routes an answer by this id.`,
        });
      } else {
        seen.set(option.id, index);
      }
    }
  }
  if (ask.kind === "scale") {
    if (!(ask.min < ask.max)) {
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: `scale: max (${ask.max}) must be greater than min (${ask.min}).`,
      });
      return;
    }
    // PR #52 round-2 review — the span (max - min) MUST be an
    // integer multiple of step. If it isn't, `max` is not itself
    // a valid answer value on the step lattice, and the slider's
    // default (min + i * step for the last valid i) is
    // strictly less than max, which is a UX surprise on top of
    // the correctness hazard. `(max - min) / step` is checked
    // with a tolerance scaled to the magnitudes involved so
    // decimal steps (0.1, 0.001) don't fail on binary-float
    // representation noise.
    const step = ask.step ?? 1;
    const span = ask.max - ask.min;
    const nRaw = span / step;
    const n = Math.round(nRaw);
    const tolerance = 1e-9 * Math.max(1, Math.abs(ask.max), Math.abs(ask.min), Math.abs(span));
    if (n <= 0 || Math.abs(span - n * step) > tolerance) {
      ctx.addIssue({
        code: "custom",
        path: ["step"],
        message: `scale: (max - min) = ${span} must be a positive integer multiple of step (${step}); got ${nRaw}.`,
      });
    }
  }
});

export type Ask = z.infer<typeof askSchema>;

/** The answer payload carried by `ask.answered`. Kind-aligned with `Ask`
 * so a router can dispatch on `kind` without re-parsing the original spec.
 * A `multi: true` choice answers with an array of option ids; a single
 * choice answers with one. `region` returns a point (`[x, y]`) or a brush
 * (an even-length coordinate list). `review` mirrors GitHub's three review
 * decisions so the hosted surface can pass it through. */
export const askAnswerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("choice"),
      value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      note: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rank"),
      ranking: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scale"),
      value: z.number(),
      note: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("region"),
      coordinates: z.array(z.number()).min(2),
      note: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      decision: z.enum(["approve", "request-changes", "comment"]),
      note: z.string().min(1).optional(),
    })
    .strict(),
]);

export type AskAnswer = z.infer<typeof askAnswerSchema>;

// ── Lifecycle ─────────────────────────────────────────────────────

/** Lifecycle of one ask (DESIGN-0001 §5.1, ADR-0007).
 *
 * - `pending`   — the ask exists and is awaiting an answer.
 * - `answered`  — the human answered; `AskRecord.answer` carries the
 *                 payload and `AskRecord.answeredAt` the ts.
 * - `cancelled` — the agent cancelled the ask (e.g. it went stale
 *                 after a rebuild). Terminal.
 * - `expired`   — the ask crossed its `expiresAtMs` deadline. Terminal.
 *
 * A terminal ask stays in the log — the audit trail keeps every
 * question the agent raised, even the ones nobody answered.
 */
export const askStatuses = ["pending", "answered", "cancelled", "expired"] as const;
export type AskStatus = (typeof askStatuses)[number];
export const askStatusSchema = z.enum(askStatuses);

/** The `.revkit/asks/<id>.json` file's on-disk shape — the SAME
 * fields as an `Ask` (spec-only, `id` = filename per ADR-0007). We
 * keep the field name distinct from `Ask` so a caller reading a
 * committed spec off disk with `askFileSchema.parse` gets the exact
 * same shape as one produced by the daemon. */
export const askFileSchema = askSchema;
export type AskFile = z.infer<typeof askFileSchema>;

/** Derived view of one ask, reduced from `ask.created`,
 * `ask.answered`, `ask.cancelled` and `ask.expired` events (see
 * `asks-view.ts`). This is what `AsksStore.ask(id)` returns — the
 * `/api/asks/:id` daemon endpoint serves it verbatim, and the
 * `/ask/<id>` page renders it. Only the fields relevant to the
 * current state are set: `answer` / `answeredAt` on `answered`,
 * `cancelReason` / `cancelledAt` on `cancelled`, `expiredAt` on
 * `expired`. */
export const askRecordSchema = z
  .object({
    id: z.string().min(1),
    spec: askSchema,
    status: askStatusSchema,
    /** Same-origin path the human opens (`/ask/<id>`) or an absolute
     * URL when the daemon knows its public origin. */
    url: z.string().min(1).optional(),
    /** Wall-clock ms since epoch, when the ask was created. Copied
     * from the `ask.created` event's `ts` (ISO) → `Date.parse` so
     * a caller doing math on ages does not re-parse. */
    createdAtMs: z.number().int().nonnegative(),
    /** ISO timestamp of the `ask.created` event. */
    createdAt: z.string().min(1),
    /** Deadline (ms since epoch) recorded on `ask.created`. Absent
     * when the caller passed no `ttlMs`. */
    expiresAtMs: z.number().int().positive().optional(),
    answer: askAnswerSchema.optional(),
    answeredAt: z.string().min(1).optional(),
    cancelReason: z.string().min(1).optional(),
    cancelledAt: z.string().min(1).optional(),
    expiredAt: z.string().min(1).optional(),
    /** Monotone seq of the `ask.created` event — the deterministic
     * key `selectAsks` orders on. */
    createdSeq: z.number().int().positive(),
  })
  .strict();
export type AskRecord = z.infer<typeof askRecordSchema>;

/** Filter for `AsksStore.asks(filter?)`. `status` accepts a single
 * value or an array; the daemon's `GET /api/asks?status=` accepts
 * a comma-list. */
export const askFilterSchema = z
  .object({
    status: z.union([askStatusSchema, z.array(askStatusSchema).min(1)]).optional(),
  })
  .strict();
export type AskFilter = z.infer<typeof askFilterSchema>;
