/**
 * What the run has spent, WHILE it is spending it.
 *
 * SEPARATE FROM THE RUN because it is the only guard of the three that can
 * fire after the socket is open, and it is the only one a test can exercise
 * without a server: hand it a composer whose usage is a number the test chose
 * and the whole cap is observable in milliseconds. The pre-flight estimate in
 * `rerun-meeting-args.ts` is arithmetic on the audio's length; this is the
 * bill.
 *
 * ONE METER OVER BOTH BILLED PASSES. A live meeting pays for the compose AND
 * for the spoken-ask capture on every tick, and the capture half was invisible
 * until somebody measured it at roughly as much again — which is why the
 * pre-flight estimate multiplies by `CAPTURE_OVERHEAD`. A live cap that
 * watched the composer alone would have let a run reach about twice the
 * ceiling its operator named, so both passes report into the same total and
 * the total is what refuses the next compose.
 */

import { dollars, isPricedModel } from '../packages/core/src/model-cost.ts';
import type { NotesComposer } from '../packages/server/src/meeting-notes.ts';
import type {
  NotesCallMeasure,
  TaskCaptureExtractor,
} from '../packages/server/src/meeting-task-capture.ts';
import type { NotesComposeMeasure } from '../packages/server/src/notes-timing.ts';

/** The run's own spend ceiling, reached mid-meeting. */
export class SpendCapReached extends Error {}

export interface SpendMeter {
  /** The note-taker, refusing its next call once the ceiling is passed. */
  composer(inner: NotesComposer): NotesComposer;
  /** The capture pass, which bills too and is counted into the same total. */
  extractor(inner: TaskCaptureExtractor): TaskCaptureExtractor;
  /** Dollars booked so far, and how many priced calls made them. */
  readonly totalUsd: number;
  readonly calls: number;
}

/**
 * A ceiling, and the two wrappers that spend against it.
 *
 * `onUnpriceable` fires once, the first time a call bills under a model this
 * build cannot price — the ceiling has stopped meaning anything at that
 * moment, and the run's own stop is the only honest answer.
 *
 * Refusing the NEXT compose rather than interrupting one in flight is
 * deliberate: a compose already sent has been paid for, and throwing its reply
 * away would cost the money and lose the note too. The capture pass is never
 * refused — it runs before the compose on the same tick, and a tick whose
 * compose is about to be refused is a tick that is ending anyway.
 */
export function createSpendMeter(
  maxUsd: number,
  onSpend: (usd: number, calls: number) => void,
  onUnpriceable: (model: string) => void = () => {},
): SpendMeter {
  let total = 0;
  let calls = 0;
  // The model of a call that billed and could not be priced. Once one exists
  // the ceiling is no longer a ceiling — `dollars` answers 0 for a model this
  // build has never heard of, so the total would sit still while the vendor's
  // meter ran. Refusing the next compose is the same policy the ceiling
  // itself takes, and it fails CLOSED rather than free.
  let unpriceable: string | undefined;
  const book = (usage: unknown, model: string | undefined): void => {
    if (!usage) return;
    if (model === undefined || !isPricedModel(model)) {
      if (unpriceable !== undefined) return;
      unpriceable = model ?? 'a call that never named its model';
      // SAY IT TO THE RUN, not only to the next compose. The pipeline catches
      // a failed compose and carries on ticking, so a refusal that lived only
      // in `compose` would let the capture pass keep billing for the rest of
      // the recording under a ceiling that can no longer be enforced. This is
      // the same callback the ceiling itself stops the meeting through.
      onUnpriceable(unpriceable);
      return;
    }
    total += dollars(usage as Parameters<typeof dollars>[0], model);
    calls++;
    onSpend(total, calls);
  };
  return {
    get totalUsd() {
      return total;
    },
    get calls() {
      return calls;
    },
    composer(inner: NotesComposer): NotesComposer {
      return {
        name: `metered:${inner.name}`,
        // `async` so the cap arrives as a REJECTION. `compose` is declared to
        // return a promise, and a synchronous throw from it reaches a caller
        // that has not awaited anything yet — the pipeline's own error
        // handling sits around the await.
        async compose(input) {
          if (unpriceable !== undefined) {
            throw new SpendCapReached(
              `refusing the next compose: ${unpriceable} has no price in this build, so ` +
                `$${maxUsd.toFixed(2)} cannot be a ceiling — $${total.toFixed(4)} booked so far ` +
                'counts only the calls that could be priced.',
            );
          }
          if (total >= maxUsd) {
            throw new SpendCapReached(
              `spend cap reached: $${total.toFixed(4)} of $${maxUsd.toFixed(2)}`,
            );
          }
          // The composer reports its call in pieces — the model before the
          // request, the usage after it — so the model seen so far is what the
          // usage is priced against.
          let seen: NotesComposeMeasure = {};
          const onward = input.measure;
          return inner.compose({
            ...input,
            measure: (m: NotesComposeMeasure): void => {
              seen = { ...seen, ...m };
              if (m.usage) book(m.usage, seen.model);
              onward?.(m);
            },
          });
        },
      };
    },
    extractor(inner: TaskCaptureExtractor): TaskCaptureExtractor {
      return {
        name: `metered:${inner.name}`,
        extract(input) {
          // The capture pass names its model and its usage in one report, so
          // there is no half-seen state to carry here.
          const onward = input.measure;
          return inner.extract({
            ...input,
            measure: (m: NotesCallMeasure): void => {
              book(m.usage, m.model);
              onward?.(m);
            },
          });
        },
      };
    },
  };
}
