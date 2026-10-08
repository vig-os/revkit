// Browser-safe wire contract. Stored review events keep the ADR-0006 schema.
export const PROVENANCE_VERSION = 1;
export interface LeafEndpoint {
  readonly leaf: string;
  readonly offset: number;
}
export type SourceSelection = {
  readonly version: number;
  readonly revision: string;
} & (
  | { readonly kind: "range"; readonly start: LeafEndpoint; readonly end: LeafEndpoint }
  | { readonly kind: "block" }
);
