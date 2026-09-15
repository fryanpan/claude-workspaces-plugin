/**
 * What the run has spent, WHILE it is spending it.
 *
 * SEPARATE FROM THE RUN because it is the only guard of the three that can
 * fire after the socket is open, and it is the only one a test can exercise
 * without a server: hand it a composer whose usage is a number the test chose
 * and the whole cap is observable in milliseconds. The pre-flight estimate in
 * `rerun-meeting-args.ts` is arithmetic on the audio's length; this is the
 * bill.
 */

import { dollars } from '../packages/core/src/model-cost.ts';
import type { NotesComposer } from '../packages/server/src/meeting-notes.ts';
import type { NotesComposeMeasure } from '../packages/server/src/notes-timing.ts';

/** The run's own spend ceiling, reached mid-meeting. */
export class SpendCapReached extends Error {}

/**
 * The composer, wrapped so the run knows what it has spent.
 *
 * It tees `input.measure` — the seam the composer already reports its own call
 * through, sizes and model names only, never the words — and refuses the next
 * compose once the total has passed the ceiling. Refusing the NEXT one rather
 * than interrupting this one is deliberate: a compose already in flight has
 * been paid for, and throwing its reply away would cost the money and lose the
 * note.
 */
export function meteredComposer(
  inner: NotesComposer,
  maxUsd: number,
  onSpend: (usd: number, calls: number) => void,
): NotesComposer {
  let total = 0;
  let calls = 0;
  return {
    name: `metered:${inner.name}`,
    // `async` so the cap arrives as a REJECTION. `compose` is declared to
    // return a promise, and a synchronous throw from it reaches a caller that
    // has not awaited anything yet — the pipeline's own error handling sits
    // around the await.
    async compose(input) {
      if (total >= maxUsd) {
        throw new SpendCapReached(
          `spend cap reached: $${total.toFixed(4)} of $${maxUsd.toFixed(2)}`,
        );
      }
      // The composer reports its call in pieces — the model before the
      // request, the usage after it — so the model seen so far is what the
      // usage is priced against. A call whose model was never reported prices
      // at nothing and is left out of the count, because a model this build
      // has no price for must not advance the cap as though it were free.
      let seen: NotesComposeMeasure = {};
      const onward = input.measure;
      return inner.compose({
        ...input,
        measure: (m: NotesComposeMeasure): void => {
          seen = { ...seen, ...m };
          if (m.usage && seen.model !== undefined) {
            total += dollars(m.usage, seen.model);
            calls++;
            onSpend(total, calls);
          }
          onward?.(m);
        },
      });
    },
  };
}
