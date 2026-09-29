/** @jsxRuntime automatic */
/** @jsxImportSource solid-js/h */
// Callout — the first registered revkit component (ADR-0002 seed).
//
// A minimal accessible aside: renders its children inside a <div role="note">
// and exposes a `kind` prop for the four semantic tones documented in the
// design (info, success, warning, danger). Solid function component with no
// runtime dependencies beyond solid-js itself, so it is safe to import from
// both Astro islands (via @astrojs/solid-js) and consumer pages.
//
// The two pragmas above pin Bun's JSX transform to Solid's hyperscript
// runtime for `bun test` (bun 1.3 does not honour tsconfig's jsxImportSource
// or bunfig.toml's [jsx] section for TSX inputs — verified 2026-09-29). The
// Astro site uses vite-plugin-solid for production, which does the optimized
// compile-time transform regardless of these pragmas.
//
// Kept intentionally small in M1: it exists to prove the registry package
// works end-to-end (typecheck + unit test + MDX import). Kobalte-based
// primitives ship with the comment rail in M2 (#7). The pure attribute
// helpers live in ./calloutAttrs.ts so `bun test` can exercise them without
// touching solid-js's SSR renderer, which is a compile-time construct.
import type { JSX } from "solid-js/h/jsx-runtime";
import { calloutKindClass, defaultCalloutKind, type CalloutKind } from "./calloutAttrs.ts";

export { calloutKinds, defaultCalloutKind, type CalloutKind } from "./calloutAttrs.ts";

/** Props accepted by {@link Callout}. */
export interface CalloutProps {
  /** Tone of the aside. Defaults to `"info"`. */
  kind?: CalloutKind;
  /** Optional title rendered above the body. */
  title?: string;
  /** Body content. Typed against the `solid-js/h` JSX namespace so it
   * matches the pragma above; Solid's own `JSX.Element` is a structurally
   * compatible superset that Astro's islands runtime accepts. */
  children: JSX.Element;
}

/**
 * Render an aside with a semantic tone.
 *
 * The outer element is a `<div role="note">` so assistive tech treats the
 * whole callout as one landmark, matching Starlight's own `<Aside>` (ADR-0017).
 *
 * The return type is deliberately inferred: the `@jsxImportSource
 * solid-js/h` pragma above pins JSX for `bun test`, and an explicit
 * `solid-js` `JSX.Element` annotation here would then disagree with the
 * pragma's namespace at typecheck time.
 */
export function Callout(props: CalloutProps) {
  const kind: CalloutKind = props.kind ?? defaultCalloutKind;
  return (
    <div
      role="note"
      data-callout-kind={kind}
      class={`revkit-callout ${calloutKindClass(kind)}`}
    >
      {props.title !== undefined ? (
        <p class="revkit-callout__title">{props.title}</p>
      ) : null}
      <div class="revkit-callout__body">{props.children}</div>
    </div>
  );
}
