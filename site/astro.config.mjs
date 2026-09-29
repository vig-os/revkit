// Astro configuration for the revkit review site.
//
// - Starlight is the docs shell (ADR-0001). Its i18n layer is configured with
//   English as the default locale (ADR-0019); no non-English locales ship in
//   v1, so `locales` stays undefined until we add one.
// - Solid is enabled as the island framework (ADR-0002); Starlight itself
//   uses Preact internally, so we pass `include` to Solid so it only
//   transforms our own islands.
// - Tailwind v4 comes in through `@tailwindcss/vite` per Starlight's own
//   `guides/css-and-tailwind` doc, and the base tokens are pulled from
//   `@astrojs/starlight-tailwind`.
// - `site` is set for absolute URLs in build output. Not the final review
//   host yet — hosted mode (ADR-0008) picks it up in M4.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://revkit.local",
  integrations: [
    starlight({
      title: "revkit",
      description: "HTML-first review surface for the agentic era.",
      // English-only in v1 (ADR-0019). Starlight's convention for a single-
      // language site is `locales: { root: {...} }`, which is the "i18n layer
      // configured for one locale" the ADR calls for — and avoids the
      // "collection i18n is empty" warning that fires when neither
      // `locales` nor `defaultLocale` is set.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
      },
      customCss: ["./src/styles/global.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/vig-os/revkit",
        },
      ],
      sidebar: [
        {
          label: "Start",
          items: [{ label: "Overview", link: "/" }],
        },
      ],
    }),
    solidJs({
      include: ["**/packages/components/**", "**/src/islands/**"],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
