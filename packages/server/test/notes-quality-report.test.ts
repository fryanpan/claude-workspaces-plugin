/**
 * The at-stop quality reading, driven on notes nobody's meeting produced.
 *
 * `notes-quality-report.ts` is the answer to a meeting that reported every
 * turn handled while its notes carried repeated lines, a subject nobody wrote
 * down and speakers the room never had. Every check in it is decidable, which
 * is the whole reason it is source rather than a paid eval run — so this file
 * drives each one directly, and drives the thresholds through a meeting built
 * to sit either side of them.
 *
 * All speech and all notes here are invented, and every name is fictional.
 * The repo is public and real meetings are not fixtures.
 */

import { describe, expect, it } from 'bun:test';
import {
  type SpokenTurn,
  buildNotesQualityReport,
  contentWords,
  latenessFrom,
  notesQualityLogLine,
  repeatedBullets,
  spokenIdeas,
  uncoveredIdeaCount,
  unknownVoices,
} from '../src/notes-quality-report.ts';
import {
  LATE_NOTE_MS,
  MAX_DUPLICATE_BULLET_LINES,
  MAX_UNCOVERED_IDEA_SHARE,
} from '../src/notes-quality-thresholds.ts';

/* ===== A line written twice ===== */

describe('repeated bullets', () => {
  it('counts a line written twice once, as one extra line', () => {
    const notes = [
      '## Meeting notes',
      '### Ferry timetable',
      '- The harbour run moves to the half hour',
      '- Kestrel Lane stays as it is',
      '- The harbour run moves to the half hour',
    ].join('\n');
    const repeats = repeatedBullets(notes);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.times).toBe(2);
  });

  it('reads a repeat that gained punctuation or a bold mark as the same line', () => {
    const notes = [
      '## Meeting notes',
      '- The harbour run moves to the half hour',
      '- **The harbour run moves to the half hour.**',
    ].join('\n');
    expect(repeatedBullets(notes)[0]?.times).toBe(2);
  });

  it('leaves two bullets that merely share a subject alone', () => {
    const notes = [
      '## Meeting notes',
      '- The harbour run moves to the half hour',
      '- The harbour run keeps its winter crew',
    ].join('\n');
    expect(repeatedBullets(notes)).toEqual([]);
  });

  it('counts a line written four times as three extra lines', () => {
    const line = '- Kestrel Lane stays as it is';
    const notes = ['## Meeting notes', line, line, line, line].join('\n');
    const report = buildNotesQualityReport({ notes, transcript: [] });
    expect(report.duplicateBulletLines).toBe(3);
  });
});

/* ===== A voice the meeting never had ===== */

describe('unknown voices', () => {
  const voices = { labels: ['A', 'B'], names: ['Priya Raman'] };

  it('reports a name nobody in the meeting was given', () => {
    const notes = '- [@Devon Marsh](speaker:B) wants the winter crew kept';
    const found = unknownVoices(notes, voices);
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('name');
    expect(found[0]?.name).toBe('Devon Marsh');
  });

  it('reports a label the transcript never carried', () => {
    const notes = '- [@Priya Raman](speaker:D) wants the winter crew kept';
    const found = unknownVoices(notes, voices);
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('label');
  });

  it('leaves the placeholder alone — it is what the instructions ask for', () => {
    const notes = '- [@Speaker B](speaker:B) wants the winter crew kept';
    expect(unknownVoices(notes, voices)).toEqual([]);
  });

  it('leaves a name the meeting record gave that voice alone', () => {
    const notes = '- [@Priya Raman](speaker:A) wants the winter crew kept';
    expect(unknownVoices(notes, voices)).toEqual([]);
  });

  it('reports one invented name once however often it is written', () => {
    const notes = [
      '- [@Devon Marsh](speaker:B) wants the winter crew kept',
      '- [@Devon Marsh](speaker:B) will write to the harbour office',
    ].join('\n');
    expect(unknownVoices(notes, voices)).toHaveLength(1);
  });
});

/* ===== A subject that reached no note ===== */

describe('spoken ideas and their coverage', () => {
  const said = (text: string): SpokenTurn => ({ text });

  it('skips a sentence with nothing in it', () => {
    expect(spokenIdeas([said('Yeah. Right, exactly.')])).toEqual([]);
  });

  it('counts a sentence carrying content as one idea', () => {
    expect(spokenIdeas([said('The harbour ferry moves to the half hour.')])).toHaveLength(1);
  });

  it('calls an idea carried when the notes keep its words', () => {
    const notes = '- The harbour ferry moves to the half hour';
    const { uncovered } = uncoveredIdeaCount(notes, [
      said('So the harbour ferry moves to the half hour from Monday.'),
    ]);
    expect(uncovered).toBe(0);
  });

  it('calls an idea uncovered when the notes are about something else', () => {
    const notes = '- Kestrel Lane keeps its winter crew';
    const { uncovered } = uncoveredIdeaCount(notes, [
      said('So the harbour ferry moves to the half hour from Monday.'),
    ]);
    expect(uncovered).toBe(1);
  });

  it('calls every idea uncovered when there are no notes at all', () => {
    const transcript = [
      said('The harbour ferry moves to the half hour from Monday.'),
      said('Kestrel Lane keeps the winter crew until April.'),
    ];
    const { ideas, uncovered } = uncoveredIdeaCount('', transcript);
    expect(ideas).toBe(2);
    expect(uncovered).toBe(2);
  });

  it('reads two forms of one word as one word', () => {
    expect(contentWords('shipping')).toEqual(contentWords('shipped'));
  });
});

/* ===== How late notes landed ===== */

describe('lateness', () => {
  it('says the wait is unknown rather than zero when nothing measured it', () => {
    const lateness = latenessFrom([]);
    expect(lateness.source).toBe('unavailable');
    expect(lateness.medianMs).toBeNull();
    expect(lateness.lateShare).toBeNull();
    expect(lateness.missing).toBeDefined();
  });

  it('counts the waits past the bar and reports the middle one', () => {
    const lateness = latenessFrom([
      { waitMs: 1_000 },
      { waitMs: 5_000 },
      { waitMs: LATE_NOTE_MS + 1 },
    ]);
    expect(lateness.source).toBe('ticks');
    expect(lateness.measured).toBe(3);
    expect(lateness.medianMs).toBe(5_000);
    expect(lateness.late).toBe(1);
  });
});

/* ===== The bars, either side ===== */

describe('the thresholds', () => {
  const cleanNotes = [
    '## Meeting notes',
    '### Ferry timetable',
    '- The harbour run moves to the half hour',
    '- Kestrel Lane keeps the winter crew until April',
    '### Signage',
    '- New boards go up at the slipway before the season',
  ].join('\n');
  const transcript: SpokenTurn[] = [
    { text: 'The harbour run moves to the half hour from Monday.' },
    { text: 'Kestrel Lane keeps the winter crew until April.' },
    { text: 'New signage boards go up at the slipway before the season.' },
  ];

  it('flags nothing on a meeting whose notes came out fine', () => {
    const report = buildNotesQualityReport({ notes: cleanNotes, transcript });
    expect(report.flags).toEqual([]);
  });

  it('flags a meeting once the repeats pass the bar and not before', () => {
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    const atBar = [cleanNotes, ...Array(MAX_DUPLICATE_BULLET_LINES).fill(repeat)].join('\n');
    const overBar = [atBar, repeat].join('\n');
    expect(
      buildNotesQualityReport({ notes: atBar, transcript }).flags.map((f) => f.kind),
    ).not.toContain('duplicate-bullets');
    expect(
      buildNotesQualityReport({ notes: overBar, transcript }).flags.map((f) => f.kind),
    ).toContain('duplicate-bullets');
  });

  it('flags a meeting that invented a speaker, on the first one', () => {
    const notes = `${cleanNotes}\n- [@Devon Marsh](speaker:Z) will write to the harbour office`;
    const report = buildNotesQualityReport({
      notes,
      transcript,
      voices: { labels: ['A'], names: ['Priya Raman'] },
    });
    expect(report.flags.map((f) => f.kind)).toContain('unknown-speakers');
  });

  it('holds its judgement on coverage until there are enough ideas to judge', () => {
    const thin = buildNotesQualityReport({ notes: '## Meeting notes', transcript });
    expect(thin.uncoveredShare).toBeNull();
    expect(thin.flags.map((f) => f.kind)).not.toContain('coverage');
  });

  it('flags coverage when a long meeting reached almost no note', () => {
    const long: SpokenTurn[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Berth ${i} needs its mooring chain replaced before the season opens.`,
    }));
    const report = buildNotesQualityReport({ notes: '## Meeting notes', transcript: long });
    expect(report.uncoveredShare).not.toBeNull();
    expect(report.uncoveredShare ?? 0).toBeGreaterThan(MAX_UNCOVERED_IDEA_SHARE);
    expect(report.flags.map((f) => f.kind)).toContain('coverage');
  });
});

/* ===== The line the log carries ===== */

describe('the log line', () => {
  it('carries counts and says the lateness is unknown, with no notes text in it', () => {
    const notes = ['## Meeting notes', '- Kestrel Lane keeps the winter crew'].join('\n');
    const line = notesQualityLogLine(buildNotesQualityReport({ notes, transcript: [] }));
    expect(line).toContain('repeated bullets');
    expect(line).toContain('lateness unknown');
    expect(line).not.toContain('Kestrel');
  });
});
