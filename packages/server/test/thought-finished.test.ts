/**
 * The one "is this thought finished?" question (`thought-finished.ts`): how
 * its answer is read, which lines hand the room the floor, and that a failed
 * or cancelled call never lets a line go.
 */
import { describe, expect, it } from 'bun:test';
import {
  THOUGHT_SYSTEM,
  invitesReply,
  readThought,
  thoughtJudge,
} from '../src/spoken-reply/thought-finished.ts';
import { waitFor } from './wait-for.ts';

describe('the thought judge', () => {
  it('reads one word, and anything else as no answer', () => {
    expect(readThought('FINISHED')).toBe(true);
    expect(readThought(' unfinished.\n')).toBe(false);
    expect(readThought('Probably done')).toBeNull();
  });

  it('takes a question put to the room as the floor handed over', () => {
    expect(invitesReply('Any questions?')).toBe(true);
    expect(invitesReply('So that is the budget. What do people think?')).toBe(true);
    expect(invitesReply('Lead, anything from you?')).toBe(true);
    expect(invitesReply('Over to you.')).toBe(true);
    expect(invitesReply('Why does that matter?')).toBe(false);
    expect(invitesReply('We had any questions answered last week.')).toBe(false);
  });

  it('asks with the shared question and passes the verdict on', async () => {
    const seen: string[] = [];
    const judge = thoughtJudge(async ({ system, user }) => {
      seen.push(system, user);
      return 'UNFINISHED';
    });
    const got: boolean[] = [];
    judge('Harborlight: Three things. First the pier.', (f) => got.push(f));
    await waitFor(() => got.length === 1);
    expect(got).toEqual([false]);
    expect(seen[0]).toBe(THOUGHT_SYSTEM);
    expect(seen[1]).toContain('Harborlight: Three things. First the pier.');
  });

  it('holds on a failed call, and stays silent once cancelled', async () => {
    const got: boolean[] = [];
    thoughtJudge(async () => {
      throw new Error('HTTP 529');
    })('x', (f) => got.push(f));
    await waitFor(() => got.length === 1);
    expect(got).toEqual([false]);

    let answer: (s: string) => void = () => {};
    const late: boolean[] = [];
    const cancel = thoughtJudge(
      () =>
        new Promise<string>((r) => {
          answer = r;
        }),
    )('x', (f) => late.push(f));
    cancel();
    answer('FINISHED');
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toEqual([]);
  });
});
