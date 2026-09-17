/**
 * The review quality gate's verdict, in the two shapes the gate answers in.
 *
 * These types live here — beside `review-gate.ts`, which produces them —
 * rather than in the route modules that consume them. They were written
 * inside `routes/task-routes-context.ts` and `routes/docs.ts` because that is
 * where the first reader of each sat, which left `review-gate.ts` importing
 * two types out of `routes/`: a service reaching up into the HTTP layer, and
 * the one import-direction edge the layers exist to forbid.
 *
 * The route contexts re-export their own from here, so a route still reads
 * its vocabulary off the context module it already imports and nothing under
 * `routes/` has to know where the gate keeps its types.
 */
import type { ReviewPayload, TaskReviewItem } from '@claude-workspaces/core';

/**
 * The gate's verdict on one review ITEM — held, or through.
 *
 * Both sides of the HTTP split need it: `createServer` runs the judge and the
 * task routes report what it said.
 */
export type ReviewGate =
  // `message` on a PASS is how the filer is told the item reached the reader
  // WITHOUT the judge passing it — the last-hold rule, or their own "the
  // source is less specific than that" answer. Absent on an ordinary pass.
  | { held: false; item: TaskReviewItem; message?: string }
  | { held: true; item: TaskReviewItem; reason: string; message: string };

/** The gate's answer for a COMMENT-borne item. Same three facts as
 *  `ReviewGate`; a bare payload where that one carries the wrapper. */
export type ThreadReviewGate =
  | { held: false; review: ReviewPayload; message?: string }
  | { held: true; review: ReviewPayload; reason: string; message: string };
