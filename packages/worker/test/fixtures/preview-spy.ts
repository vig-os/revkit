// A counting R2 binding around the REAL Worker, for `test/preview.test.ts`.
//
// **The claim this makes possible:** ADR-0012's preview rules must REFUSE a
// path *before* the bucket is read. Over workerd that is otherwise
// unobservable — R2 has no request log, and a refused path and a read of a
// missing object produce the same 404 with the same empty body. So this
// fixture counts.
//
// ── Why it wraps the module instead of editing the bundle ──────────────────
//
// `test/worker-runtime.test.ts` builds a deliberately-broken Worker by
// string-replacing text in the emitted bundle, and that pattern's weakness is
// recorded there: its replacement target did not exist in the emitted output, so
// the "broken" script was byte-identical to the real one and the test was
// asserting nothing. This file has no such seam to get wrong. It imports
// `src/index.ts`, calls the real default `fetch`, and replaces exactly one
// binding. Every other behaviour under test — the gate, the scope check, the
// allowlist, the header policy — is the shipped code path, unmodified.
//
// ── What it is NOT allowed to be ───────────────────────────────────────────
//
// It is not a stub of the Worker's logic, and it does not decide anything: it
// counts a call and forwards it. A method the real handler has never been
// written against THROWS rather than returning something plausible, because a
// silent no-op here would turn "the Worker called the bucket and the test could
// not see it" into green. That is the failure mode a counting wrapper creates,
// and closing it is the whole design.

import worker, { type Env } from "../../src/index.ts";

/** The fixture's own two paths. Both are answered by this wrapper and by
 *  NOTHING else — `test/preview.test.ts` asserts that the shipped route table
 *  classifies them `unknown`, so a reader can see the count cannot be confused
 *  with a product route. */
const READS_PATH = "/__revkit-preview-spy";
const RESET_PATH = "/__revkit-preview-spy/reset";

interface CountedReads {
  /** How many times the Worker called a read method on `env.PREVIEWS`. */
  reads: number;
  /** The keys it asked for, in order. A miss and a refusal are told apart by
   *  this list alone, so the count is not the only observable. */
  keys: string[];
}

const counted: CountedReads = { reads: 0, keys: [] };

/**
 * The wrapper: the real `get`, plus `head` because a future slice may reach for
 * it, plus a hard failure for anything else.
 *
 * `head` is implemented rather than left out on purpose — "the counter only
 * knows about `get`" is a gap a later change would walk straight into, and a
 * counted `head` is still counted.
 */
function countingPreviews(bucket: R2Bucket): R2Bucket {
  const count = (key: string): void => {
    counted.reads += 1;
    counted.keys.push(key);
  };
  return {
    get: (key: string) => {
      count(key);
      return bucket.get(key);
    },
    head: (key: string) => {
      count(key);
      return bucket.head(key);
    },
  } as unknown as R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === READS_PATH) return Response.json(counted);
    if (pathname === RESET_PATH) {
      counted.reads = 0;
      counted.keys.length = 0;
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, { ...env, PREVIEWS: countingPreviews(env.PREVIEWS) });
  },
} satisfies ExportedHandler<Env>;
