/**
 * Wait for work, but not past a deadline — and take the deadline's timer back
 * out of the event loop when the work wins.
 *
 * `Promise.race([work, new Promise((r) => setTimeout(r, ms))])` is the obvious
 * spelling and it leaks: the race settles on `work`, and the timer it lost to
 * is still scheduled. A referenced timer keeps the process alive, so a
 * shutdown that raced a five-second deadline and won it instantly still sits
 * for five seconds with nothing left to do.
 *
 * That was not hypothetical. `RecallMeetings.dispose()` races an empty
 * `allSettled` against a 5s leave deadline on every shutdown, so every server
 * that stopped — with no bot meetings at all — held its process open for five
 * more seconds. It is why `yjs-single-copy.test.ts` took six to eight seconds
 * in every CI run of September: its probe subprocess finished its work in
 * ~0.7s and then waited out that timer before `proc.exited` resolved.
 *
 * Clearing it makes the wait cost what the work costs, so nothing downstream
 * has to wait on a timer nobody is using.
 */

/**
 * Settle when `work` settles, or after `ms`, whichever comes first, with the
 * deadline's timer cleared either way.
 *
 * `work` is awaited, not cancelled — there is no cancelling a promise. What
 * this bounds is how long the CALLER waits, which is the whole of what a
 * shutdown drain needs.
 */
export async function raceDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
