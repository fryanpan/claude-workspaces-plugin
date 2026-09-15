/**
 * The words of a recording, and which of them a note holds yet — driven with
 * engine frames the way a live engine sends them. Synthetic words only.
 */
import { describe, expect, it } from 'bun:test';
import { VoiceTurns } from '../src/voice-feedback-turns.ts';

describe('VoiceTurns', () => {
  it('counts provisional words as waiting, and takes only the settled ones', () => {
    const t = new VoiceTurns();
    expect(t.update({ turn: 0, text: 'the header', final: false })).toEqual({
      settled: false,
      grew: true,
    });
    expect(t.untaken()).toEqual(['the', 'header']);
    expect(t.waiting()).toBe('the header');
    expect(t.take(), 'nothing settled yet').toBe('');

    t.update({ turn: 0, text: 'the header is tall', settledText: 'the header', final: false });
    const first = t.take();
    expect(first).toBe('the header');
    // In flight: no longer untaken, still waiting for its note.
    expect(t.untaken()).toEqual(['is', 'tall']);
    expect(t.waiting()).toBe('the header is tall');
    t.update({
      turn: 0,
      text: 'the header is tall',
      settledText: 'the header is tall',
      final: false,
    });
    const second = t.take();
    expect(second, 'a tap takes more while a tick is out').toBe('is tall');
    expect(t.waiting()).toBe('the header is tall');
    t.done(first);
    expect(t.waiting(), 'the first note came back').toBe('is tall');
    t.done(second);
    expect(t.waiting()).toBe('');
  });

  it('says once when a turn settles, and never loses a word a reformatted turn moved', () => {
    const t = new VoiceTurns();
    t.update({ turn: 0, text: 'sixty six', settledText: 'sixty six', final: false });
    expect(t.take()).toBe('sixty six');
    t.done('sixty six');
    expect(t.update({ turn: 0, text: '66 dollars', final: true })).toEqual({
      settled: true,
      grew: true,
    });
    expect(t.update({ turn: 0, text: '66 dollars', final: true }), 'a repeat: nothing new').toEqual(
      { settled: false, grew: false },
    );
    // "sixty six" came back as "66": a repeated word is cheaper than a lost "dollars".
    expect(t.take()).toBe('66 dollars');
    t.done('66 dollars');
    expect(t.update({ turn: 1, text: '', final: true }).settled, 'a turn with no words').toBe(
      false,
    );
    expect(t.waiting()).toBe('');
  });

  it('keeps the last few seconds of everything heard', () => {
    const t = new VoiceTurns();
    t.update({ turn: 0, text: 'a'.repeat(300), final: true });
    t.update({ turn: 1, text: 'the footer is faint', final: false });
    expect(t.tail()).toHaveLength(240);
    expect(t.tail().endsWith('the footer is faint')).toBe(true);
  });
});
