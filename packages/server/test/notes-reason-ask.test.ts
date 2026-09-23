/**
 * A reason spoken on a tick is named in that tick's prompt, so the note for
 * the point keeps it. All speech is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { reasonDirective, reasonSentences } from '../src/notes-reason-ask.ts';

const said = (...texts: string[]): Array<{ text: string }> => texts.map((text) => ({ text }));

describe('reasonDirective', () => {
  it('quotes each sentence that gives a reason', () => {
    const out =
      reasonDirective(
        said('Keep the costs in one table, because the council only reads the totals. Next item.'),
      ) ?? '';
    expect(out).toContain('"X, because Y"');
    expect(out).toContain(
      '- "Keep the costs in one table, because the council only reads the totals."',
    );
    expect(out).not.toContain('Next item');
  });

  it('reads "so that" and a causal ", since" as reasons, and a "since" of time as none', () => {
    expect(reasonSentences(said('We close early so that crews rest.'))).toHaveLength(1);
    expect(reasonSentences(said('We wait, since the survey is late.'))).toHaveLength(1);
    expect(reasonSentences(said('Nothing changed since June.'))).toEqual([]);
  });

  it('says nothing on a tick that gives no reason', () => {
    expect(reasonDirective(said('The drains overflow at every spring tide.'))).toBeNull();
  });
});
