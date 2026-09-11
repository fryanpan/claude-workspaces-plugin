/**
 * What happens to the SENTENCE when a speaker tag is withdrawn.
 *
 * The gate used to unwrap a phantom tag to its own words, which took the
 * link off and left the invented person standing: a solo huddle came out of
 * the pass reading "Speaker A: ..." and "Speaker B: ...", tagless and still
 * naming two people who were never in the room. So the drop is a line-level
 * edit now — the name goes, the punctuation that introduced it goes, and the
 * word left opening the note gets its capital.
 *
 * Its own file because `speaker-tags.test.ts` is at the size bar; every case
 * here drives `normalizeSpeakerTags` with an empty `known` set, which is
 * exactly what a solo tick's gate does.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSpeakerTags, reattributeSpeakerTags } from './speaker-tags.ts';

/** The gate as a solo tick runs it: no voice is known, so every tag is a
 *  claim the meeting cannot make. */
const dropAll = (markdown: string): string =>
  normalizeSpeakerTags(markdown, { names: {}, known: new Set<string>() }).markdown;

describe('a phantom tag leaves the note and takes its name with it', () => {
  it('drops the name and the colon that introduced it', () => {
    expect(dropAll('- [@Speaker B](speaker:B?t=1,3): The locator beeps when whistled at')).toBe(
      '- The locator beeps when whistled at',
    );
  });

  it('drops an em-dash lead-in the same way', () => {
    expect(dropAll('- [@Speaker B](speaker:B) — the deploy gate moves before merge')).toBe(
      '- The deploy gate moves before merge',
    );
  });

  it('gives the sentence back the capital the name was supplying', () => {
    expect(dropAll('- [@Speaker A](speaker:A) said the batteries run flat')).toBe(
      '- Said the batteries run flat',
    );
  });

  it('leaves a word that spells its own capitals alone', () => {
    // "iPhone" is spelled the way it is spelled. A word carrying a capital
    // anywhere is one somebody chose the case of.
    expect(dropAll('- [@Speaker D](speaker:D) iPhone battery drains overnight')).toBe(
      '- iPhone battery drains overnight',
    );
  });

  it('keeps a nested bullet nested — indentation is not whitespace to collapse', () => {
    expect(dropAll('    - [@Riverbend](speaker:C): the CSV path uses another dialog')).toBe(
      '    - The CSV path uses another dialog',
    );
  });

  it('closes the gap when the name was mid-sentence, and does not capitalise there', () => {
    expect(dropAll('- Harborlight agreed with [@Riverbend](speaker:C) about the gate')).toBe(
      '- Harborlight agreed with about the gate',
    );
  });

  it('does not leave a full stop floating where the name used to be', () => {
    expect(dropAll('- Noted by [@Speaker C](speaker:C).')).toBe('- Noted by.');
  });

  it('takes every phantom out of a line that names two of them', () => {
    const out = normalizeSpeakerTags(
      '- [@Speaker A](speaker:A) and [@Speaker B](speaker:B) disagreed',
      { names: {}, known: new Set<string>() },
    );
    expect(out.markdown).not.toContain('Speaker A');
    expect(out.markdown).not.toContain('Speaker B');
    expect(out.unknown).toEqual(['A', 'B']);
  });

  it('reports the label it dropped, so the count is not lost with the words', () => {
    const out = normalizeSpeakerTags('- [@Speaker B](speaker:B): a point', {
      names: {},
      known: new Set<string>(),
    });
    expect(out.unknown).toEqual(['B']);
  });
});

describe('what the drop must not touch', () => {
  const known = new Set(['B']);

  it('a real voice keeps its tag, its name and its provenance', () => {
    const md = '- [@Mallory](speaker:B?t=4): the gate moves before merge';
    expect(normalizeSpeakerTags(md, { names: { B: 'Mallory' }, known }).markdown).toBe(md);
  });

  it("a person's own line is left byte for byte alone, phantom and all", () => {
    // The merge recognises a person's line by exact text; rewriting one
    // lands a second copy of it beside theirs.
    const mine = '- [@Speaker C](speaker:C): my own note, spelled my way';
    const out = normalizeSpeakerTags(mine, {
      names: {},
      known,
      protect: [mine.slice(2)],
    });
    expect(out.markdown).toBe(mine);
    expect(out.unknown).toEqual([]);
  });

  it('an ordinary markdown link that merely sits beside one survives', () => {
    expect(dropAll('- [@Speaker B](speaker:B): filed as [Move the gate](/w/w-1/t/t-1)')).toBe(
      '- Filed as [Move the gate](/w/w-1/t/t-1)',
    );
  });

  it('a mention the revision moved keeps its name — only the withdrawn one loses it', () => {
    const out = reattributeSpeakerTags(
      '- [@Mallory](speaker:B?t=10) asked\n- [@Mallory](speaker:B?t=11) answered',
      { revisions: new Map([[10, 'C']]), names: { B: 'Mallory', C: 'Bob' } },
    );
    expect(out.markdown.split('\n')[0]).toBe('- [@Bob](speaker:C?t=10) asked');
    expect(out.markdown.split('\n')[1]).toBe('- [@Mallory](speaker:B?t=11) answered');
    expect(out.moved).toBe(1);
    expect(out.unwrapped).toBe(0);
  });
});
