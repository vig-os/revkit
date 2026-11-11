/** A refusal is unchanged only while both its intent and reason match.
 * A new approval/request or a different failure must remain observable. */
export function isUnchangedSyncFailure(
  previous: { readonly intentSeq: number; readonly reason: string } | undefined,
  intentSeq: number,
  reason: string,
): boolean {
  return previous?.intentSeq === intentSeq && previous.reason === reason;
}
