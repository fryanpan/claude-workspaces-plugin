/**
 * `raceDeadline` bounds the CALLER's wait and takes its own timer back out of
 * the event loop.
 *
 * The second half is the one that had been getting missed, and it is not
 * cosmetic: a referenced `setTimeout` keeps a process alive, so a shutdown
 * that raced a five-second deadline and won it instantly still sat for five
 * seconds with nothing left to do. The case below proves it in the only place
 * the difference shows — a real process, asked to exit.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { raceDeadline } from '../src/race-deadline.ts';

describe('raceDeadline', () => {
  it('returns when the work settles, without waiting out the deadline', async () => {
    const order: string[] = [];
    // A marker due well before the deadline: the event loop fires timers in
    // DUE order, so if the wait had run to the deadline this marker would be
    // in `order` first. Ordering, not a measured duration.
    const marker = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('marker');
        resolve();
      }, 50);
    });
    await raceDeadline(Promise.resolve('done'), 10_000);
    order.push('raced');
    await marker;
    expect(order).toEqual(['raced', 'marker']);
  });

  it('returns at the deadline when the work never settles', async () => {
    // The bound itself: a promise nobody will ever resolve must not hold the
    // caller. `dispose()` on a wedged meeting is this shape.
    await raceDeadline(new Promise(() => {}), 20);
    expect(true).toBe(true);
  });

  it('lets the process exit as soon as the work is done', async () => {
    // The regression, driven for real. A subprocess that races a long
    // deadline and wins it instantly must be able to exit: nothing is left
    // running, so nothing may hold the loop open. Before the timer was
    // cleared this same script exited only after the full deadline.
    const script = `
      import { raceDeadline } from ${JSON.stringify(join(import.meta.dir, '../src/race-deadline.ts'))};
      await raceDeadline(Promise.resolve(), 60_000);
      console.log('RACED');
    `;
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    // The assertion is that this await RETURNS: a held timer keeps the child
    // alive for its whole deadline, which is far past this case's budget, so
    // a regression fails here rather than passing slowly.
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(out).toContain('RACED');
    expect(code).toBe(0);
  }, 20_000);

  it('propagates a rejection, exactly as the Promise.race it replaces did', async () => {
    // Every caller hands it an `allSettled`, which never rejects. Pinned so
    // that a caller which one day hands it a bare promise gets the failure
    // rather than a silent success at the deadline.
    await expect(raceDeadline(Promise.reject(new Error('nope')), 10_000)).rejects.toThrow('nope');
  });
});
