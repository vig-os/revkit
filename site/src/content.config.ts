// Content collections for the revkit site.
//
// M1 (#6) only ships Starlight's own `docs` and `i18n` collections so the
// landing page builds. The domain-specific collections (ADR-0003: `sets`,
// `vocab`, `plots`, `asks`) land in M1 item 2 (content model) — added there
// with their Zod schemas and `schemaVersion` fields.
import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Explicit i18n collection so Starlight stops warning about it. English is
  // the only shipped locale (ADR-0019); the collection stays empty until we
  // override a UI string.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
