/**
 * What a row of the raw transcript is, once the turns stop deciding it.
 *
 * The rules under test are the two judgement calls the feature stands on:
 * which short rows fold onto the row they answered, and where a wall of words
 * breaks. Both are exercised through `foldTranscriptRows`, which is a pure
 * function over stored turns, so every case here is the shape the reader ends
 * up with rather than the shape of the source.
 *
 * All speech is invented. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  type FoldedRow,
  breakAtPauses,
  foldTranscriptRows,
  wordCount,
} from '../src/meeting-transcript-fold.ts';
import type { TranscriptTurn } from '../src/meetings.ts';

/** Turns a second apart, in the order given. */
function turns(...spoken: Array<[speaker: string, text: string]>): TranscriptTurn[] {
  return spoken.map(([speaker, text], i) => ({
    turn: i,
    text,
    ts: Date.UTC(2026, 8, 2, 10, 0, 0) + i * 1000,
    speaker,
  }));
}

/** Every word the rows carry, in the order a reader meets them. */
function spokenOf(rows: readonly FoldedRow[]): string {
  return rows
    .flatMap((r) => [r.text, ...r.continued, ...r.answers.map((a) => a.text)])
    .join(' ')
    .trim();
}

describe('which short rows fold', () => {
  it('folds a run of acknowledgement onto the row it answered, keeping its voice', () => {
    const rows = foldTranscriptRows(
      turns(
        ['A', 'The ferry timetable slips whenever the tide is out.'],
        ['B', 'Yeah.'],
        ['B', 'Right.'],
        ['B', 'Mhm.'],
        ['A', 'So we publish two timetables.'],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.answers.map((a) => a.text)).toEqual(['Yeah.', 'Right.', 'Mhm.']);
    expect(rows[0]?.answers.every((a) => a.speaker === 'B')).toBe(true);
    expect(rows[1]?.text).toBe('So we publish two timetables.');
  });

  it('keeps a short row that carries a content word: a quantity, a name', () => {
    const rows = foldTranscriptRows(
      turns(
        ['A', 'How long does the survey take?'],
        ['B', 'Three weeks.'],
        ['A', 'And who runs it?'],
        ['B', 'Devi.'],
      ),
    );
    expect(rows.map((r) => r.text)).toEqual([
      'How long does the survey take?',
      'Three weeks.',
      'And who runs it?',
      'Devi.',
    ]);
    expect(rows.every((r) => r.answers.length === 0)).toBe(true);
  });

  it('keeps a bare yes or no when it answers a question', () => {
    const rows = foldTranscriptRows(
      turns(
        ['A', 'Did the harbour survey land?'],
        ['B', 'No.'],
        ['A', 'Is the second jetty in scope?'],
        ['B', 'Yes.'],
      ),
    );
    expect(rows).toHaveLength(4);
    expect(rows[1]?.text).toBe('No.');
    expect(rows[3]?.text).toBe('Yes.');
  });

  it('keeps a short question, and the answer it opens', () => {
    const rows = foldTranscriptRows(
      turns(['A', 'The survey slipped to the spring.'], ['B', 'Right?'], ['A', 'No.']),
    );
    expect(rows.map((r) => r.text)).toEqual(['The survey slipped to the spring.', 'Right?', 'No.']);
  });

  it('keeps speech in a script the stoplist cannot read', () => {
    // The stoplist tokenizes on the Latin alphabet, so a remainder it cannot
    // see comes back empty — which must not read as filler.
    const rows = foldTranscriptRows(
      turns(['A', 'The survey slipped to the spring.'], ['B', 'Yeah, \u6211\u4e0d\u540c\u610f']),
    );
    expect(rows).toHaveLength(2);
  });

  it('keeps every answer in the run a question starts, not just the first', () => {
    const rows = foldTranscriptRows(
      turns(
        ['A', 'Did the jetty work ship?'],
        ['B', 'Yeah.'],
        ['A', 'No.'],
        ['B', 'Well the first half shipped and the rest is waiting on the survey.'],
        ['A', 'Right.'],
      ),
    );
    // Three answers standing, then the row that ends the run — and only after
    // that does acknowledgement start folding again.
    expect(rows.map((r) => r.text)).toEqual([
      'Did the jetty work ship?',
      'Yeah.',
      'No.',
      'Well the first half shipped and the rest is waiting on the survey.',
    ]);
    expect(rows[3]?.answers.map((x) => x.text)).toEqual(['Right.']);
  });

  it('folds a short row with a content word once it has been said five times', () => {
    // "Makes sense" keeps a content word, so the stoplist alone leaves it
    // standing. Said over and over it is the same acknowledgement as "Yeah",
    // which is why repetition is a fold rule of its own.
    const said = turns(
      ['A', 'We move the survey to the spring.'],
      ['B', 'Makes sense.'],
      ['A', 'And the jetty work waits on it.'],
      ['B', 'Makes sense.'],
      ['A', 'Which pushes the dredging.'],
      ['B', 'Makes sense.'],
      ['A', 'And the budget with it.'],
      ['B', 'Makes sense.'],
      ['A', 'Nobody has told the ferry operator.'],
      ['B', 'Makes sense.'],
    );
    const rows = foldTranscriptRows(said);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.answers.length === 1)).toBe(true);
    // Under five it is somebody's opinion, not their tic.
    const twice = foldTranscriptRows(said.slice(0, 4));
    expect(twice).toHaveLength(4);
  });

  it('never folds across a hole in the record', () => {
    const said = turns(['A', 'The tide gauge went quiet at noon.'], ['B', 'Yeah.']);
    const before = said[0]?.ts ?? 0;
    const after = said[1]?.ts ?? 0;
    // Drawn between the two rows, so the words are on either side of it.
    expect(foldTranscriptRows(said, { barriers: [before + 500] })).toHaveLength(2);
    // And on the previous turn's own millisecond, which the renderer still
    // draws after that turn — a tie is a hole, not a coincidence.
    expect(foldTranscriptRows(said, { barriers: [before] })).toHaveLength(2);
    // Stamped at the acknowledgement's own millisecond it is drawn AFTER the
    // acknowledgement, so both rows are before it and the fold stands.
    expect(foldTranscriptRows(said, { barriers: [after] })).toHaveLength(1);
  });

  it('loses no word and reorders nothing, whatever it folds', () => {
    const said = turns(
      ['A', 'The ferry timetable slips whenever the tide is out.'],
      ['B', 'Yeah.'],
      ['B', 'Okay right.'],
      ['A', 'So we publish two.'],
      ['B', 'Mhm.'],
    );
    expect(spokenOf(foldTranscriptRows(said))).toBe(said.map((t) => t.text).join(' '));
  });

  it('keeps a short sentence made only of small words: it is a decision', () => {
    // Every word of "We should go." is on the stoplist, which exists to strip
    // what two ideas have in common — so having nothing left is not evidence
    // of acknowledgement. An opener has to have been said.
    const rows = foldTranscriptRows(
      turns(['A', 'The tide turns at four.'], ['B', 'We should go.'], ['B', 'Yeah.']),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.text).toBe('We should go.');
    expect(rows[1]?.answers.map((x) => x.text)).toEqual(['Yeah.']);
  });

  it('keeps a question that ends in a closing quote a question', () => {
    // An engine punctuating reported speech leaves the mark inside the quote.
    const rows = foldTranscriptRows(
      turns(
        ['A', 'Are we shipping?"'],
        ['B', 'No.'],
        ['A', 'He asked, \u201cAre we shipping?\u201d'],
        ['B', 'Yes.'],
      ),
    );
    expect(rows).toHaveLength(4);
  });

  it('folds onto the row it follows on the page, not the turn revised last', () => {
    // A provider that settles a turn twice moves its timestamp to the revision
    // and leaves it where it was in the array, so the stored order and the
    // read order come apart. The acknowledgement belongs to the row it sits
    // under once the segment is ordered by the clock.
    const said: TranscriptTurn[] = [
      { turn: 0, text: 'The tide gauge went quiet at noon.', ts: 1_000, speaker: 'A' },
      { turn: 1, text: 'We should call the harbour office about it.', ts: 5_000, speaker: 'A' },
      { turn: 2, text: 'Yeah.', ts: 2_000, speaker: 'B' },
    ];
    const rows = foldTranscriptRows(said);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe('The tide gauge went quiet at noon.');
    expect(rows[0]?.answers.map((a) => a.text)).toEqual(['Yeah.']);
    expect(rows[1]?.answers).toHaveLength(0);
  });

  it('starts a segment with a row rather than folding onto nothing', () => {
    const rows = foldTranscriptRows(turns(['B', 'Yeah.'], ['A', 'Morning.']));
    expect(rows[0]?.text).toBe('Yeah.');
  });
});

describe('where a wall of words breaks', () => {
  const sentence = (n: number): string =>
    `Point ${n} is that the dredging schedule and the survey window have never once lined up in the same quarter.`;

  it('breaks a long row at a sentence end, never inside one', () => {
    const wall = [1, 2, 3, 4, 5].map(sentence).join(' ');
    const chunks = breakAtPauses(wall, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => wordCount(c) <= 40)).toBe(true);
    for (const chunk of chunks) expect(chunk.trim().endsWith('.')).toBe(true);
    expect(chunks.join(' ')).toBe(wall);
  });

  it('leaves a row at the limit alone', () => {
    const short = sentence(1);
    expect(wordCount(short)).toBeLessThan(40);
    expect(breakAtPauses(short, 40)).toEqual([short]);
  });

  it('breaks an unpunctuated sentence at its commas instead', () => {
    const run =
      'we looked at the tide tables, we looked at the ferry logs, we looked at the weather';
    const chunks = breakAtPauses(run, 6);
    expect(chunks.length).toBe(3);
    expect(chunks.join(' ')).toBe(run);
  });

  it('leaves a wall with no pause in it whole rather than cutting mid-phrase', () => {
    const run = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    expect(breakAtPauses(run, 10)).toEqual([run]);
  });

  it('hangs the rest of a broken row under it with no clock and no name of its own', () => {
    const wall = [1, 2, 3].map(sentence).join(' ');
    const rows = foldTranscriptRows(turns(['A', wall]), { longRowWords: 25 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.continued.length).toBeGreaterThan(0);
    expect([rows[0]?.text, ...(rows[0]?.continued ?? [])].join(' ')).toBe(wall);
    // One turn, one timestamp: the chunks are not turns and never claim to be.
    expect(rows[0]?.turn).toBe(0);
  });
});
