import { describe, expect, it } from 'vitest';
import { inlineMarksToDelta, normalizeMarkdown } from '../src/prose.ts';

/**
 * A `^[…]` note is OPAQUE to the inline parser, and a doc full of them comes
 * back off disk byte for byte.
 *
 * The danger is not the caret — it is what a note's body says. Notes carry
 * citations, and citations carry asterisks, underscores and bracketed links.
 * Read the body as prose and `^[rev. 3, *page 12*]` parses as an italic run
 * whose delimiters the serializer is then free to re-spell (`_page 12_`), so
 * the bound file changes on the next flush without anybody editing it. The
 * fix is that the parser never looks inside a note; these fixtures are the
 * proof, checked both ways — the bytes survive AND the note arrives as one
 * unmarked run, so a serializer that merely happened to re-emit the same
 * characters cannot pass.
 */

type Op = [string, Record<string, unknown> | undefined];

const CASES: Array<{ name: string; md: string; ops?: Op[] }> = [
  {
    name: 'one note',
    md: 'A permit takes 94 days^[Source: the 2025 annual report, table 4.] on paper.',
    ops: [
      ['A permit takes 94 days', undefined],
      ['^[Source: the 2025 annual report, table 4.]', undefined],
      [' on paper.', undefined],
    ],
  },
  {
    name: 'two notes in one sentence',
    md: 'It takes 94 days^[report, table 4], and a third of that waits^[three interviews].',
    ops: [
      ['It takes 94 days', undefined],
      ['^[report, table 4]', undefined],
      [', and a third of that waits', undefined],
      ['^[three interviews]', undefined],
      ['.', undefined],
    ],
  },
  {
    name: 'a note containing a link',
    md: 'Filed online^[See the [submittal guide](https://example.invalid/g), page 12.] today.',
    ops: [
      ['Filed online', undefined],
      ['^[See the [submittal guide](https://example.invalid/g), page 12.]', undefined],
      [' today.', undefined],
    ],
  },
  {
    name: 'a note carrying emphasis syntax the parser must not read',
    md: 'Two reviewers^[Staffing page, *retrieved 2 Sep 2026*; see also field_notes.] serve.',
    ops: [
      ['Two reviewers', undefined],
      ['^[Staffing page, *retrieved 2 Sep 2026*; see also field_notes.]', undefined],
      [' serve.', undefined],
    ],
  },
  {
    // The fixture that FAILED before the parser learned to skip a note's
    // body: `_underscored_` parsed as italic and the serializer re-spelled it
    // `*underscored*` — the bound file changing under the author.
    name: 'a note whose body holds underscore emphasis',
    md: 'Two reviewers^[Staffing page, _retrieved 2 Sep 2026_.] serve the city.',
    ops: [
      ['Two reviewers', undefined],
      ['^[Staffing page, _retrieved 2 Sep 2026_.]', undefined],
      [' serve the city.', undefined],
    ],
  },
  {
    name: 'an unconfirmed note',
    md: 'Fire review waits^[Stated by one applicant; the ordinance is silent. Unconfirmed.].',
  },
  {
    name: 'a note beside real emphasis in the same line',
    md: 'The **median** is 94 days^[report, table 4] and *not* the mean.',
    ops: [
      ['The ', undefined],
      ['median', { bold: true }],
      [' is 94 days', undefined],
      ['^[report, table 4]', undefined],
      [' and ', undefined],
      ['not', { italic: true }],
      [' the mean.', undefined],
    ],
  },
  {
    name: 'a note inside a list item',
    md: '- Bring the stamped checklist^[Submittal guide, rev. 3, page 12.] to the counter\n- Ask for the plan-check queue',
  },
  {
    name: 'a note inside a blockquote',
    md: '> The queue is two reviewers deep^[Council minutes, 14 May 2026, item 7b.] today.',
  },
  {
    name: 'a note whose body holds nested brackets',
    md: 'See the table^[Annual report [2025], table 4 [rows 1-3].] for the split.',
    ops: [
      ['See the table', undefined],
      ['^[Annual report [2025], table 4 [rows 1-3].]', undefined],
      [' for the split.', undefined],
    ],
  },
  {
    name: 'a note whose text holds an escaped bracket',
    md: 'Filed under x^[Form 3\\] of the appendix; see also \\[draft\\].] today.',
    ops: [
      ['Filed under x', undefined],
      ['^[Form 3\\] of the appendix; see also \\[draft\\].]', undefined],
      [' today.', undefined],
    ],
  },
  {
    name: 'an escaped caret writes the syntax down without using it',
    md: 'Type \\^[a note] where you want one, as in x^[the real thing] here.',
    ops: [
      ['Type \\^[a note] where you want one, as in x', undefined],
      ['^[the real thing]', undefined],
      [' here.', undefined],
    ],
  },
  {
    // Control: an unterminated caret is not a footnote, and the line still
    // has to survive untouched — otherwise "opaque" would just mean "eaten".
    name: 'an unterminated caret (control)',
    md: 'A caret^[with no closer, and a *real* italic after it.',
  },
  {
    // Control: a GFM reference footnote is NOT supported and must stay
    // literal — including the definition line, which is a paragraph.
    name: 'GFM reference footnotes stay literal (control)',
    md: 'It takes 94 days[^1] on paper.\n\n[^1]: Annual report, table 4.',
  },
];

describe('a doc with inline footnotes', () => {
  for (const c of CASES) {
    it(`round-trips byte-identical: ${c.name}`, () => {
      // normalizeMarkdown ends the document with a newline; everything before
      // it must be the author's own bytes.
      expect(normalizeMarkdown(c.md)).toBe(`${c.md}\n`);
    });
  }

  for (const c of CASES) {
    if (!c.ops) continue;
    it(`parses to the shape a reader means: ${c.name}`, () => {
      const delta = inlineMarksToDelta(c.md.replace(/^- |^> /, ''));
      expect(delta.map((op) => [op.insert, op.attributes])).toEqual(c.ops);
    });
  }

  it('leaves a note in a code span alone', () => {
    const md = 'Write `^[a note]` to add one.';
    expect(normalizeMarkdown(md)).toBe(`${md}\n`);
    expect(inlineMarksToDelta(md).map((op) => [op.insert, op.attributes])).toEqual([
      ['Write ', undefined],
      ['^[a note]', { code: true }],
      [' to add one.', undefined],
    ]);
  });
});
