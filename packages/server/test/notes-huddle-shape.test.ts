/**
 * A shared-mic huddle, replayed: its notes stay bullets, gain topic headings,
 * and each speaker tag carries the turns it was written from.
 *
 * WHY. A three-voice huddle on 2026-09-14 ended as three bullets and twelve
 * paragraphs under no heading. Each later note's speaker tag carried its
 * voice's first turn. The note-taker here does what that model did:
 *
 * - it writes an open question as a `**Question:**` line with no marker, and
 *   after that it copies the shape the outline shows;
 * - it copies a voice's speaker tag, href included, from a note the outline
 *   already shows;
 * - it opens a topic heading only when the server asks for one, then keeps
 *   opening one per subject.
 *
 * The fixture is invented (`fixtures/shared-mic-notes/NOTICE.md`).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSpeakerTags, type prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import {
  allBullets,
  decisionsWithoutSpeaker,
  longFlatRuns,
  proseNote,
} from '../src/notes-quality.ts';
import { homelessRun, regroupTargets } from '../src/notes-regroup.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

interface FixtureTick {
  turns: Array<{ speaker: string; text: string }>;
}

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'shared-mic-notes', 'RIVERBEND01.json'), 'utf8'),
) as { ticks: FixtureTick[] };

/** The subject a turn is about, by the words the fixture uses for each. */
function subjectOf(text: string): string | undefined {
  if (/ferry|sailing|timetable|council/i.test(text)) return 'Riverbend ferry timetable';
  if (/kiln|shelving|finance|thousand/i.test(text)) return 'Harborlight kiln budget';
  return undefined;
}

/** The tag for a voice as the outline shows it, href and all, when a note
 *  already carries one. */
function copiedTag(input: NotesComposeInput, label: string): string {
  const pattern = new RegExp(`\\[@[^\\]]*\\]\\(speaker:${label}(?:\\?[^)]*)?\\)`);
  for (const entry of input.outline) {
    const hit = entry.text.match(pattern);
    if (hit) return hit[0];
  }
  return `[@Speaker ${label}](speaker:${label})`;
}

/** A note-taker shaped like the huddle's model. See the header. */
function huddleComposer(): (input: NotesComposeInput) => prose.BlockEdit[] {
  let wroteAny = false;
  let subject: string | undefined;
  return (input) => {
    const lines: string[] = [];
    let spoke: string | undefined;
    for (const turn of input.tick.turns) {
      const label = turn.speakerLabel ?? turn.speaker;
      if (label === undefined || turn.text.split(/\s+/).length < 4) continue;
      spoke = subjectOf(turn.text) ?? spoke;
      const tag = copiedTag(input, label);
      const question = turn.text.trim().endsWith('?');
      const body = `${tag} ${turn.text}`;
      if (question) lines.push(`**Question:** ${body}`);
      else if (!wroteAny) lines.push(`- ${body}`);
      else lines.push(body);
      wroteAny = true;
    }
    if (lines.length === 0) return [];
    const topicHeadings = input.outline.filter((e) => e.kind === 'heading' && (e.level ?? 2) > 2);
    const asked = homelessRun(input.outline, {
      author: NOTES_AUTHOR_ID,
      notesHeadingId: input.notesHeadingId,
    });
    const next = spoke ?? subject;
    if (next !== undefined && (asked !== null || topicHeadings.length > 0) && next !== subject) {
      subject = next;
      return addNotes(input, `### ${next}\n\n${lines.join('\n\n')}`);
    }
    return addNotes(input, lines.join('\n\n'));
  };
}

async function replay() {
  const compose = huddleComposer();
  const harness = createNotesTickHarness({ compose: (input) => compose(input) });
  /** Turn number → the voice that spoke it, and the tick it was spoken in. */
  const spoken = new Map<number, { speaker: string; tick: number }>();
  let turn = 0;
  for (const [i, tick] of FIXTURE.ticks.entries()) {
    for (const t of tick.turns) spoken.set(turn++, { speaker: t.speaker, tick: i + 1 });
    await harness.speak(...tick.turns);
  }
  return { harness, spoken };
}

describe('a shared-mic huddle replayed', () => {
  test('every note is a bullet', async () => {
    const { harness } = await replay();
    const notes = harness.notes();
    const paragraphs = notes.split('\n').filter((line) => proseNote(line) !== undefined);
    expect(paragraphs).toEqual([]);
    expect(allBullets(notes).length).toBeGreaterThan(10);
    expect(harness.errors).toEqual([]);
  });

  test('the notes get a topic heading for each subject', async () => {
    const { harness } = await replay();
    const notes = harness.notes();
    expect(notes).toContain('### Riverbend ferry timetable');
    expect(notes).toContain('### Harborlight kiln budget');
  });

  test('each speaker tag carries turns its own voice spoke, in the tick that wrote the note', async () => {
    const { harness, spoken } = await replay();
    // The tick each note first appeared in, read off the snapshots.
    const firstSeen = new Map<string, number>();
    for (const shot of harness.snapshots) {
      for (const bullet of allBullets(shot.notes)) {
        const key = bullet.replace(/\(speaker:[^)]*\)/g, '');
        if (!firstSeen.has(key)) firstSeen.set(key, shot.tick);
      }
    }
    const checked: string[] = [];
    for (const bullet of allBullets(harness.notes())) {
      const tick = firstSeen.get(bullet.replace(/\(speaker:[^)]*\)/g, ''));
      for (const tag of findSpeakerTags(bullet)) {
        expect(tag.turns.length).toBeGreaterThan(0);
        for (const t of tag.turns) {
          expect({
            note: bullet,
            speaker: spoken.get(t)?.speaker,
            tick: spoken.get(t)?.tick,
          }).toEqual({ note: bullet, speaker: tag.label, tick });
        }
        checked.push(bullet);
      }
    }
    expect(checked.length).toBeGreaterThan(10);
  });

  test('the first note written is logged with how long the meeting waited for it', async () => {
    const log = spyOn(console, 'log');
    try {
      await replay();
      const lines = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('wrote its first note'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\[meeting-notes\] \S+ meeting \S+ wrote its first note \d+ms after the meeting started$/,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('notes that are already paragraphs', () => {
  const PARAGRAPHS = [
    'The Riverbend ferry timetable changes next month',
    'The early sailing moves to half past six',
    'Saltmarsh families lose their school run',
    'A weekday seven o’clock sailing stays',
    'The late Friday sailing is dropped',
  ];

  test('count towards the run that asks for a topic heading', async () => {
    let asked: ReturnType<typeof homelessRun> = null;
    const harness = createNotesTickHarness({
      doc: `## Meeting notes\n\n${PARAGRAPHS.join('\n\n')}\n`,
      compose: (input) => {
        asked = homelessRun(input.outline, {
          author: NOTES_AUTHOR_ID,
          notesHeadingId: input.notesHeadingId,
        });
        return [];
      },
    });
    await harness.speak({ speaker: 'A', text: 'Harborlight kiln budget next.' });
    expect(asked).toMatchObject({ runLength: PARAGRAPHS.length });
  });

  test('are never offered to nest_blocks, which only moves list items', () => {
    const own = { author: NOTES_AUTHOR_ID, underHeadingId: 'topic' };
    const outline: prose.OutlineEntry[] = [
      { id: 'topic', kind: 'heading', nodeName: 'heading', level: 3, text: 'Riverbend ferry' },
      ...PARAGRAPHS.slice(0, 4).map((text, i) => ({
        id: `p${i}`,
        kind: 'block' as const,
        nodeName: 'paragraph',
        text,
        ...own,
      })),
      { id: 'b0', kind: 'listItem', nodeName: 'listItem', text: 'One bullet', depth: 0, ...own },
    ];
    expect(regroupTargets(outline, { author: NOTES_AUTHOR_ID })).toEqual([]);
  });

  test('are counted by the at-stop reading', () => {
    const notes = [...PARAGRAPHS, PARAGRAPHS[0]].join('\n\n');
    const report = buildNotesQualityReport({ notes, transcript: [] });
    expect(report.bullets).toBe(PARAGRAPHS.length + 1);
    expect(report.duplicateBulletLines).toBe(1);
    expect(longFlatRuns(notes).map((run) => run.bullets.length)).toEqual([PARAGRAPHS.length + 1]);
    expect(
      decisionsWithoutSpeaker('**Decision:** we will keep the seven o’clock sailing'),
    ).toHaveLength(1);
  });
});
