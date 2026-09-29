// Content collections for the revkit site.
//
// - `docs` uses Starlight's own loader for site-owned MDX (the landing page)
//   AND a repo-docs loader that surfaces this repo's ADRs, design docs and
//   feature matrix in the built site (M1 item 2 dogfood, ADR-0003).
// - `vocab`, `plots` and `asks` are the typed-data collections
//   (DESIGN-0001 §3) — every entry carries a `schemaVersion` (ADR-0003
//   Acceptance). The `i18n` collection is Starlight's, kept present so the
//   integration stops warning about it (ADR-0019).
import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import type { Loader } from "astro/loaders";
import { file, glob } from "astro/loaders";
import { parse as parseYaml } from "yaml";
import { repoDocsLoader } from "./content/loaders/repo-docs.ts";
import { askSchema } from "./content/schemas/asks.ts";
import { plotSpecSchema } from "./content/schemas/plots.ts";
import { vocabEntrySchema, vocabFileSchema } from "./content/schemas/vocab.ts";

/** Compose the Starlight docs loader with the repo-docs loader so a single
 * `docs` collection carries both site-owned MDX and this repo's documents.
 * Starlight only builds pages from a collection named `docs`, so a second
 * collection is not an option. */
function composedDocsLoader(): Loader {
  const starlight = docsLoader();
  const repo = repoDocsLoader();
  return {
    name: "revkit-composed-docs-loader",
    async load(context) {
      await starlight.load(context);
      await repo.load(context);
    },
  };
}

export const collections = {
  docs: defineCollection({
    loader: composedDocsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Present on repo-sourced ADR pages; the loader lifts it from the
        // ADR file's `- Status:` line (ADR-0003) so Starlight can render it
        // as a badge in the sidebar and in the page header.
        revkitStatus: z.string().min(1).optional(),
      }),
    }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  vocab: defineCollection({
    // `vocab/terms.yaml` is one YAML file: `{ schemaVersion, entries: [...] }`.
    // The file loader's parser validates schemaVersion + entry shape once,
    // then hands each entry to the collection under its own id — so a
    // reference like `getEntry('vocab', 'anchor')` returns one entry.
    loader: file("../vocab/terms.yaml", {
      parser: (text) => {
        const parsed: unknown = parseYaml(text);
        const file = vocabFileSchema.parse(parsed);
        return Object.fromEntries(file.entries.map((entry) => [entry.id, entry]));
      },
    }),
    schema: vocabEntrySchema,
  }),
  plots: defineCollection({
    // Plots live in `plots/<name>/spec.vl.json` with a sibling data file.
    // The glob loader emits one entry per spec; the schema enforces the
    // "no inline data" rule at build time (ADR-0004, C4).
    loader: glob({
      base: "../plots",
      pattern: "**/spec.vl.json",
    }),
    schema: plotSpecSchema,
  }),
  asks: defineCollection({
    // Question specs the agent writes at `asks/<id>.json` (DESIGN-0001 §5.1).
    // Kept out of git in normal operation (DESIGN-0001 §3) but validated when
    // present so an audit run catches malformed specs.
    loader: glob({
      base: "../asks",
      pattern: "*.json",
    }),
    schema: askSchema,
  }),
};
