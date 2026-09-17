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

/**
 * What a caller may tell the gate about the call it is making.
 *
 * Here rather than inside `review-gate.ts` for the same reason the two
 * verdicts are: three route context modules used to declare their own
 * `{ lessSpecific?: string }` by hand, so a field added to the gate reached
 * none of them until somebody remembered all four sites.
 */
export interface GateRunOpts {
  /**
   * The filer's own words for why the honest answer is less specific than the
   * hold asked for. Only acted on when the item is currently held — on an
   * unheld item there is no hold to answer, and honouring it there would be a
   * one-field bypass of a gate nobody had raised.
   *
   * It exists because of what the gate was measured teaching: every hold
   * asked for a concrete specific, so a fabricated specific read as more
   * responsive than a vague truth and the revision loop selected for
   * invention. The filer needs a way to say "the source does not support
   * that", and it has to be an answer the gate ACCEPTS, or it is not an
   * answer at all.
   */
  lessSpecific?: string;
  /**
   * The caller is handing this verdict back in its own reply, so the held
   * EVENT is not sent to the author.
   *
   * The event and the reply carry the same four facts — which item, why, the
   * call that lifts it, the headline — and the author reads the reply in the
   * same turn it made the call. A push beside it is a second copy of
   * something the caller already has, and a wake is a whole turn: measured
   * over a week of the fleet's transcripts, `review_item_held` echoing a
   * reply was part of the 11% of model spend that repeat reminders cost.
   *
   * Passed by every route whose response body carries the hold, and by no
   * other. The paths that judge an item on somebody ELSE's behalf — the boot
   * sweep, and a sync whose filer is a different session — leave it off,
   * because there is no reply for their author to read.
   *
   * THE CONDITION IS `author === the caller`, not "this is a route". The
   * routes pass a flat `true` because every one of them takes its author from
   * the requesting session's own body, so the two are the same actor by
   * construction; `review-items/done-when-owner.ts` files on a WRITER's behalf
   * and compares the two ids before passing it. A route that ever files for
   * another actor must do the same, or the hold reaches nobody: the author
   * gets no event and the caller's reply is about somebody else's item.
   */
  heldInReply?: boolean;
}
