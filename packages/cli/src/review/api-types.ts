/** Successful summary refresh; import refusals are reported separately. */
export interface ReviewRefreshResponse {
  readonly ok: true;
  readonly moved: boolean;
  readonly previousHeadSha: string;
  readonly currentHeadSha: string;
  readonly stale: boolean;
  readonly openPendingReviewNodeId: string | null;
  readonly importedNew: number;
  readonly importedSkipped: number;
  readonly refused: number;
  readonly reconcile?: {
    readonly newlySynced: readonly string[];
    readonly newlyFailed: ReadonlyArray<{ readonly commentId: string; readonly reason: string }>;
  };
}
