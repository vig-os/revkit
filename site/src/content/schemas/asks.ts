// Ask (question spec) schema — the JSON the agent writes and the daemon
// serves at /ask/<id> (DESIGN-0001 §5.1, ADR-0007). Runtime asks live under
// `.revkit/asks/<id>.json` (gitignored, ADR-0007 acceptance); the collection
// exists so promoted specs (`revkit ask --keep` → `docs/decisions/`, later)
// still validate at build time.
//
// The id is the filename, not a body field — this matches ADR-0007's shape
// (the daemon assigns ids) and keeps the source of truth in one place.
import { z } from "astro/zod";
import { schemaVersionField } from "./shared.ts";

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
 * that lists the allowed set; cross-field refinements ride on top. */
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
  if (ask.kind === "scale" && !(ask.min < ask.max)) {
    ctx.addIssue({
      code: "custom",
      path: ["max"],
      message: `scale: max (${ask.max}) must be greater than min (${ask.min}).`,
    });
  }
});

export type Ask = z.infer<typeof askSchema>;
