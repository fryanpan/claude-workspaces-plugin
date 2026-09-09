import { describe, expect, it } from 'vitest';
import { factRange, findFootnotes, isUnsureNote } from '../src/footnotes.ts';

/**
 * The footnote grammar: where a `^[…]` note starts and ends in a line of
 * prose, which sentence it is a note ABOUT, and whether its author was sure.
 *
 * Everything that renders a footnote — the margin column, the phone popover,
 * the print sources list — asks these three questions, so they are answered
 * once here rather than three times in the browser.
 */

describe('finding footnotes in a line', () => {
  it('reads a pandoc inline note and the text it carries', () => {
    const text = 'A permit takes 94 days^[Source: the 2025 annual report.] on average.';
    const found = findFootnotes(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.note).toBe('Source: the 2025 annual report.');
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe('^[Source: the 2025 annual report.]');
  });

  it('finds both notes in one sentence, in order', () => {
    const text = 'It takes 94 days^[report, table 4] and a third of that^[three interviews] waits.';
    expect(findFootnotes(text).map((f) => f.note)).toEqual(['report, table 4', 'three interviews']);
  });

  it('reads a note containing a bracketed link as one note', () => {
    const text = 'Filed online^[See the [submittal guide](https://example.invalid/guide).] now.';
    const found = findFootnotes(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.note).toBe('See the [submittal guide](https://example.invalid/guide).');
  });

  it('leaves an unterminated note alone', () => {
    expect(findFootnotes('A caret^[with no closer')).toEqual([]);
  });

  it('does not read a bare caret or a plain bracket as a note', () => {
    expect(findFootnotes('x^2 and [a link](u) and [^gfm]')).toEqual([]);
  });
});

describe('how sure the note is', () => {
  it('reads a note ending in Unconfirmed as unsure', () => {
    expect(isUnsureNote('Estimate from three applicants. Unconfirmed.')).toBe(true);
  });

  it('reads the word anywhere in the note, in any case', () => {
    expect(isUnsureNote('unconfirmed as of August')).toBe(true);
    expect(isUnsureNote('UNCONFIRMED')).toBe(true);
  });

  it('reads everything else as confirmed', () => {
    expect(isUnsureNote('Council minutes, 14 May 2026, item 7b.')).toBe(false);
    // The stem is not the word: "confirmed" must not match on a substring.
    expect(isUnsureNote('Confirmed by the department.')).toBe(false);
  });
});

describe('the fact a note is about', () => {
  const factOf = (text: string, i = 0) => {
    const f = findFootnotes(text)[i];
    if (!f) throw new Error('no footnote at that index');
    const r = factRange(text, f.start);
    return text.slice(r.start, r.end);
  };

  it('is the sentence the note sits at the end of', () => {
    const text = 'Nothing here. A permit takes 94 days^[report] on paper.';
    expect(factOf(text)).toBe('A permit takes 94 days');
  });

  it('starts at the doc start when there is no earlier sentence', () => {
    expect(factOf('A permit takes 94 days^[report].')).toBe('A permit takes 94 days');
  });

  it('starts after the previous note, not back at the sentence', () => {
    const text = 'It takes 94 days^[report], and a third of that is waiting^[interviews].';
    expect(factOf(text, 1)).toBe('a third of that is waiting');
  });

  it('never runs back past a sentence that ends in a question or an exclamation', () => {
    expect(factOf('Is it slow? Yes, by 94 days^[report].')).toBe('Yes, by 94 days');
  });
});

describe('a bracket the author escaped', () => {
  it('does not close the note it sits in', () => {
    const notes = findFootnotes('Filed under x^[Form 3\\] of the appendix.] today.');
    expect(notes.map((f) => f.note)).toEqual(['Form 3\\] of the appendix.']);
  });

  it('does not open one either, so a lone escaped `[` cannot swallow the note', () => {
    const notes = findFootnotes('See x^[the \\[draft sheet] now.');
    expect(notes.map((f) => f.note)).toEqual(['the \\[draft sheet']);
  });

  it('leaves a real nested bracket counting as before (control)', () => {
    const notes = findFootnotes('See x^[the [draft](u) sheet] now.');
    expect(notes.map((f) => f.note)).toEqual(['the [draft](u) sheet']);
  });
});
