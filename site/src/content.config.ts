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
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { plotsLoader } from "./content/loaders/plots.ts";
import { repoDocsLoader } from "./content/loaders/repo-docs.ts";
import { askSchema } from "@revkit/review-core";
import { plotSpecSchema } from "./content/schemas/plots.ts";
import { vocabEntrySchema, vocabFileSchema } from "./content/schemas/vocab.ts";
import { readConsumerRoot } from "./lib/consumer-root.ts";

// Consumer-root mode (issue #57): when set, this config is rendering
// an EXTERNAL repo's `docs/`, `vocab/`, `plots/` through the packaged
// site. Absent, every branch collapses to its pre-#57 form so revkit's
// own build is unchanged.
const CONSUMER_ROOT = readConsumerRoot();

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

/** Vocab source path — a workspace-owned yaml file. In own-repo
 * mode this is Astro's `../vocab/terms.yaml` (relative to the
 * site's project root). In consumer mode `revkit build` symlinks
 * `<staging>/vocab` → `<consumer>/vocab`, so the SAME relative
 * path reaches the consumer's file. An empty stub is returned
 * when the consumer has no `vocab/terms.yaml` — Astro requires
 * every collection to declare a loader. */
const VOCAB_RELATIVE = "../vocab/terms.yaml";

/** Plots source dir — same argument. `revkit build` symlinks
 * `<staging>/plots` → `<consumer>/plots`, so this constant is
 * unchanged. */
const PLOTS_RELATIVE = "../plots";

/** Absolute checks so the loader can pick a stub in consumer mode
 * when the consumer's tree omits `vocab/` or `plots/`. */
const VOCAB_ABS = CONSUMER_ROOT ? resolvePath(CONSUMER_ROOT, "vocab", "terms.yaml") : null;
const PLOTS_ABS = CONSUMER_ROOT ? resolvePath(CONSUMER_ROOT, "plots") : null;

/** An empty inline loader — returned when a consumer has no vocab
 * (or no plots) tree. Astro treats an empty loader as "collection
 * has no entries" and skips validation; a page that references a
 * missing vocab term still fails via the `<Term id>` component's
 * runtime check. */
function emptyLoader(name: string): Loader {
  return {
    name,
    async load() {
      // no entries
    },
  };
}

export const collections = {
  docs: defineCollection({
    // Own-repo mode composes Starlight's docsLoader (site-owned MDX
    // under `src/content/docs/`) with `repoDocsLoader` (ADRs /
    // designs / FEATURE-MATRIX above the site). Consumer mode drops
    // repoDocsLoader (revkit-specific structure) and reads the
    // consumer's `docs/` through Starlight's own loader — `revkit
    // build` populates `<staging>/src/content/docs/` with symlinks
    // to the consumer's tree so the default base still works.
    loader: CONSUMER_ROOT ? docsLoader() : composedDocsLoader(),
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
    loader:
      CONSUMER_ROOT !== null && VOCAB_ABS !== null && !existsSync(VOCAB_ABS)
        ? emptyLoader("revkit-vocab-empty")
        : file(VOCAB_RELATIVE, {
            parser: (text) => {
              const parsed: unknown = parseYaml(text);
              const file = vocabFileSchema.parse(parsed);
              return Object.fromEntries(file.entries.map((entry) => [entry.id, entry]));
            },
          }),
    schema: vocabEntrySchema,
  }),
  plots: defineCollection({
    // Plots live in `plots/<name>/spec.vl.json` with a sibling data file
    // (ADR-0004, C4). The loader wraps glob() and adds a build-time check
    // that every `data.url` references an existing sibling file — the
    // filesystem check the schema cannot enforce on its own.
    loader:
      CONSUMER_ROOT !== null && PLOTS_ABS !== null && !existsSync(PLOTS_ABS)
        ? emptyLoader("revkit-plots-empty")
        : plotsLoader(PLOTS_RELATIVE),
    schema: plotSpecSchema,
  }),
  asks: defineCollection({
    // Runtime asks the daemon writes at `.revkit/asks/<id>.json`, gitignored
    // (ADR-0007 acceptance). The id is the filename, never a body field.
    // The collection is empty in a fresh checkout — it validates promoted
    // asks (via `revkit ask --keep`, wired up in M2) so a stale spec still
    // fails the build with a clear message. In consumer mode the asks
    // path is `<consumer>/.revkit/asks/`; `revkit build` symlinks
    // `<staging>/.revkit` → `<consumer>/.revkit` so the same relative
    // glob reaches it.
    loader: glob({
      base: "../.revkit/asks",
      pattern: "*.json",
    }),
    schema: askSchema,
  }),
};
