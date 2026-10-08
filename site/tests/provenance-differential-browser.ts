// Browser entry used by the permanent differential and manual full-size run.
import { rangeSelection, rangeBlock } from "../../packages/cli/src/rail/selection-provenance.ts";
Object.assign(window, { rangeSelection, rangeBlock });

declare global {
  interface Window {
    rangeSelection: typeof rangeSelection;
    rangeBlock: typeof rangeBlock;
  }
}
