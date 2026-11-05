/**
 * The owner-check card's template on its own: which of its sentences are the
 * board's, and the key that says whether a line has moved since the card was
 * written. The route-level behaviour is owner-check-held-revision.test.ts.
 * All fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import {
  ownerCheckBoilerplate,
  ownerCheckReview,
  ownerTemplateKey,
} from '../src/review-items/owner-check-template.ts';

const TASK = { id: 't-1', title: 'Reader can see the chart' } as unknown as Task;
const LINE: DoneWhenLine = {
  id: 'd-1',
  text: 'the chart reads on a phone',
  verdict: 'owner',
  by: 'Kiln Bot',
  proof: [{ text: 'the shot', url: 'https://example.com/shot.png' }],
};

describe('ownerCheckBoilerplate', () => {
  it('names sentences the card really carries, and none of the line’s own words', () => {
    const card = ownerCheckReview(TASK, LINE);
    const text = [
      card.detail,
      ...(card.options as Array<{ detail: string }>).map((o) => o.detail),
    ].join(' ');
    const boilerplate = ownerCheckBoilerplate(TASK, LINE);
    // The answers sentence and both option details appear verbatim.
    const present = boilerplate.filter((b) => text.includes(b));
    expect(present.length).toBeGreaterThanOrEqual(3);
    for (const b of boilerplate) expect(b).not.toContain(LINE.text);
  });
});

describe('ownerTemplateKey', () => {
  it('is the same for the same line and different once its proof moves', () => {
    const a = ownerTemplateKey(ownerCheckReview(TASK, LINE));
    expect(ownerTemplateKey(ownerCheckReview(TASK, { ...LINE }))).toBe(a);
    const moved = { ...LINE, proof: [{ text: 'a newer shot', url: 'https://example.com/2.png' }] };
    expect(ownerTemplateKey(ownerCheckReview(TASK, moved))).not.toBe(a);
  });
});
