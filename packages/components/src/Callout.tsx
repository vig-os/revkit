// Callout — the first registered revkit component (ADR-0002 seed).
//
// A minimal accessible aside: renders its children inside a <div role="note">
// and exposes a `kind` prop for the four semantic tones documented in the
// design (info, success, warning, danger). Solid function component with no
// runtime dependencies beyond solid-js itself.
//
// Rendering is exercised end-to-end by the Playwright landing-page smoke
// (site/tests/landing.spec.ts), which is the only path this component takes
// in production — Astro compiles JSX through vite-plugin-solid, and Bun test
// cannot compose Solid's compile-time template runtime with `renderToString`
// on its own. Kobalte-based primitives ship with the comment rail in M2 (#7).
import type { JSX } from "solid-js";

/** Semantic tones a Callout may render with. Kept in a const array so
 * downstream tooling and tests can iterate every case. */
export const calloutKinds = ["info", "success", "warning", "danger"] as const;

/** One of the {@link calloutKinds}. */
export type CalloutKind = (typeof calloutKinds)[number];

/** Default tone used when a Callout is rendered without an explicit `kind`. */
export const defaultCalloutKind: CalloutKind = "info";

/** Props accepted by {@link Callout}. */
export interface CalloutProps {
  /** Tone of the aside. Defaults to {@link defaultCalloutKind}. */
  kind?: CalloutKind;
  /** Optional title rendered above the body. */
  title?: string;
  /** Body content. */
  children: JSX.Element;
}

/**
 * Render an aside with a semantic tone.
 *
 * The outer element is a `<div role="note">` so assistive tech treats the
 * whole callout as one landmark, matching Starlight's own `<Aside>` (ADR-0017).
 */
export function Callout(props: CalloutProps): JSX.Element {
  const kind: CalloutKind = props.kind ?? defaultCalloutKind;
  return (
    <div
      role="note"
      data-callout-kind={kind}
      class={`revkit-callout revkit-callout--${kind}`}
    >
      {props.title !== undefined ? (
        <p class="revkit-callout__title">{props.title}</p>
      ) : null}
      <div class="revkit-callout__body">{props.children}</div>
    </div>
  );
}
