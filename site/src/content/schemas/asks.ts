// Ask (question spec) schema — the JSON the agent writes and the daemon
// serves at /ask/<id> (DESIGN-0001 §5.1). Question kinds v1: choice, rank,
// scale, text, region, review.
import { z } from "astro/zod";
import { schemaVersionField } from "./shared.ts";

/** The kinds a question spec may take (DESIGN-0001 §5.1). Kept as a const
 * array so the loader, the guard and tests all iterate the same list. */
export const askKinds = ["choice", "rank", "scale", "text", "region", "review"] as const;
export type AskKind = (typeof askKinds)[number];

/** One option in a `choice` or `rank` ask. `preview` points at a plot spec
 * that renders inside the option card (DESIGN-0001 §5.1). */
const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  preview: z.string().min(1).optional(),
});

const baseFields = {
  schemaVersion: schemaVersionField("asks/<id>.json"),
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1).optional(),
};

/** Kind-specific fields; a discriminated union keeps each shape narrow and
 * makes an invalid `kind` fail with a message that lists the allowed set. */
export const askSchema = z.discriminatedUnion("kind", [
  z.object({
    ...baseFields,
    kind: z.literal("choice"),
    options: z.array(optionSchema).min(2),
    allowOther: z.boolean().default(false),
    multi: z.boolean().default(false),
  }),
  z.object({
    ...baseFields,
    kind: z.literal("rank"),
    options: z.array(optionSchema).min(2),
  }),
  z.object({
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
      .optional(),
  }),
  z.object({
    ...baseFields,
    kind: z.literal("text"),
    multiline: z.boolean().default(false),
    placeholder: z.string().optional(),
  }),
  z.object({
    ...baseFields,
    kind: z.literal("region"),
    target: z.string().min(1),
  }),
  z.object({
    ...baseFields,
    kind: z.literal("review"),
    target: z.string().min(1),
  }),
]);

export type Ask = z.infer<typeof askSchema>;
