/**
 * The sentences the gate says to a filer. Unit-level: the end-to-end proof
 * that a real filing's hold carries no invented figure is in
 * `review-judge-loop.test.ts`, which drives the whole route.
 *
 * All fixtures are invented — the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { numberTokens } from '@claude-workspaces/core/review-hold';
import {
  admittedLessSpecificMessage,
  admittedUnjudgedMessage,
  holdMessage,
} from '../src/review-hold-message.ts';

const BASE = {
  reason: 'The detail never says what waits on this',
  // Letter-only ids on purpose: the paste-ready call carries the board's own
  // ids, and a digit in one of those would be counted below as a figure the
  // message invented when it is nothing of the kind.
  reviseCall: 'revise_review_item(taskId="t-abc", reviewItemId="r-xyz")',
  ownerCheck: false,
  surface: 'ticket' as const,
  holds: 1,
  maxHolds: 2,
};

describe('holdMessage', () => {
  it('names the gap, quotes the item’s own words, and asks for a re-read', () => {
    const msg = holdMessage({ ...BASE, quote: 'the cache is fine as it is' });
    expect(msg).toContain('The detail never says what waits on this.');
    expect(msg).toContain('“the cache is fine as it is”');
    expect(msg).toContain('Re-read the source');
  });

  it('proposes no replacement text, and carries no figure of its own', () => {
    const msg = holdMessage({ ...BASE, quote: 'runs at 02:00' });
    // The one thing the whole change is about: no drafted sentence.
    expect(msg).not.toContain('Add this sentence');
    // Every digit in the message came out of the quote it was handed.
    expect(numberTokens(msg).sort()).toEqual(numberTokens('runs at 02:00').sort());
  });

  it('tells the filer how to answer when the source is less specific', () => {
    expect(holdMessage(BASE)).toContain('lessSpecific');
  });

  it('says the next revision goes through unjudged once the cap is reached', () => {
    expect(holdMessage({ ...BASE, holds: 2 })).toContain('UNJUDGED');
    expect(holdMessage({ ...BASE, holds: 1 })).not.toContain('UNJUDGED');
  });

  it('points an owner check at the check rather than at the wording', () => {
    const msg = holdMessage({ ...BASE, ownerCheck: true });
    expect(msg).toContain('done-when check you handed over');
    expect(msg).not.toContain('It is on the ticket');
  });

  it('names the surface the words live on', () => {
    expect(holdMessage({ ...BASE, surface: 'thread' })).toContain('It is on the thread');
  });
});

describe('the two admissions', () => {
  it('tells the filer the item went to the reader unjudged, and how often it was held', () => {
    const msg = admittedUnjudgedMessage(3);
    expect(msg).toContain('UNJUDGED');
    expect(msg).toContain('three times');
    expect(msg).toContain('admitted unjudged');
  });

  it('says where the filer’s own note will be read, rather than restating it', () => {
    expect(admittedLessSpecificMessage()).toContain('on the card in your words');
  });
});
