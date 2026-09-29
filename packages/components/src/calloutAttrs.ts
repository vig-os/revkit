// Pure attribute helpers for {@link Callout}. Kept in a JSX-free file so
// `bun test` can exercise them directly, without the Solid renderer's
// compile-time template plumbing (which is only wired up inside Astro via
// vite-plugin-solid).

/** Semantic tones a Callout may render with. Kept in a const array so tests
 * can iterate every case. */
export const calloutKinds = ["info", "success", "warning", "danger"] as const;

/** One of the {@link calloutKinds}. */
export type CalloutKind = (typeof calloutKinds)[number];

/** Default tone used when a Callout is rendered without an explicit `kind`. */
export const defaultCalloutKind: CalloutKind = "info";

/**
 * Class name a Callout of the given tone should carry on its outer element.
 * A single ownership boundary for the BEM naming, so a rename never has to
 * be repeated between component and test.
 */
export function calloutKindClass(kind: CalloutKind): string {
  return `revkit-callout--${kind}`;
}
