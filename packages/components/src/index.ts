// Public entry point for @revkit/components — the ONLY component set MDX
// pages may import from (ADR-0002, guard C1). New components go through the
// escalation path (ADR-0005), never a hand-rolled export here.
export {
  Callout,
  calloutKinds,
  defaultCalloutKind,
  type CalloutKind,
  type CalloutProps,
} from "./Callout.tsx";
