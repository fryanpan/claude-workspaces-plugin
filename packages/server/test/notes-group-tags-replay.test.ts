/**
 * A replayed meeting, tick by tick, with the column of names and without it.
 *
 * The unit tests beside this one drive one write. This drives the whole tick
 * path — the ticker, the compose seam, the guard, the applier and the passes
 * that run after the write — because the thing being claimed is about a
 * MEETING: a group is opened in one tick, a note lands flat in the next and
 * is nested in the one after that, and no single write can show where the
 * name ends up.
 *
 * The engine is the scripted one the harness offers. Nothing here calls a
 * paid model.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, test } from 'bun:test';
import { findSpeakerTags, type prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** How many names the section prints. */
function tags(notes: string): number {
  return findSpeakerTags(notes).length;
}

/** The distinct voices the section attributes anything to. */
function voices(notes: string): string[] {
  return [...new Set(findSpeakerTags(notes).map((t) => t.label))].sort();
}

/** The notes indented under a lead bullet, by their words. */
function nested(notes: string): string[] {
  return notes
    .split('\n')
    .filter((line) => /^\s+[-*]\s/.test(line))
    .map((line) => line.trim());
}

/** The id of the outline block whose words contain `needle`. */
function idOf(input: NotesComposeInput, needle: string): string {
  const found = input.outline.find((e) => e.text.includes(needle));
  if (found === undefined) throw new Error(`no block reading ${needle}`);
  return found.id;
}

describe('a replayed meeting', () => {
  test('prints one name for a run of notes from one voice', async () => {
    const composed: string[] = [];
    const harness = createNotesTickHarness({
      compose: (input, tick): readonly prose.BlockEdit[] => {
        if (tick === 1) {
          return addNotes(
            input,
            '- Ferry timetable\n' +
              '    - [@Devi](speaker:B) wants the 07:40 sailing back\n' +
              '    - [@Devi](speaker:B) says the ramp is the real cost',
          );
        }
        if (tick === 2) {
          return addNotes(input, '- [@Devi](speaker:B) will ask the operator for numbers');
        }
        if (tick === 3) {
          // The regroup the instructions ask for: the flat note joins the
          // topic it belongs to. By TOPIC — nothing here is aware of who
          // said it.
          return [
            {
              op: 'nest_blocks',
              leadBlockId: idOf(input, 'Ferry timetable'),
              blockIds: [idOf(input, 'ask the operator')],
            },
          ];
        }
        return [];
      },
    });
    // Two voices in the room, so the tags the composer writes survive: a
    // meeting the engine hears one voice in shows the composer no voices at
    // all, and every tag it writes is then dropped as invented.
    harness.say({ speaker: 'B', text: 'Can we have the 07:40 sailing back on the timetable?' });
    harness.say({ speaker: 'C', text: 'Say more about the timetable.' });
    const first = await harness.tick();
    composed.push(
      ...first.composed.map((e: prose.BlockEdit) => ('markdown' in e ? e.markdown : '')),
    );

    harness.say({ speaker: 'B', text: 'The ramp is where the money actually goes.' });
    const second = await harness.tick();
    composed.push(
      ...second.composed.map((e: prose.BlockEdit) => ('markdown' in e ? e.markdown : '')),
    );

    harness.say({ speaker: 'B', text: 'I will ask the operator what the numbers are.' });
    await harness.tick();

    // BEFORE — what the composer wrote across the meeting: one name per note.
    expect(tags(composed.join('\n'))).toBe(3);
    // AFTER — what the reader sees: three notes under the topic, ONE name,
    // on the bullet above them.
    expect(nested(harness.notes())).toHaveLength(3);
    expect(tags(harness.notes())).toBe(1);
    expect(harness.notes()).toContain('&g=3');
    expect(harness.notes().split('\n')[0]).toContain('Ferry timetable');
    // Every note kept its words.
    expect(harness.notes()).toContain('07:40 sailing back');
    expect(harness.notes()).toContain('ramp is the real cost');
    expect(harness.notes()).toContain('ask the operator for numbers');
    expect(harness.errors).toEqual([]);
  });

  test('keeps a name on every note when two voices share the topic', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) {
          return addNotes(
            input,
            '- Ferry timetable\n' +
              '    - [@Devi](speaker:B) wants the 07:40 sailing back\n' +
              '    - [@Wren](speaker:C) says the slipway costs more than the sailing',
          );
        }
        return [];
      },
    });
    harness.say({ speaker: 'B', text: 'Can we have the 07:40 sailing back on the timetable?' });
    harness.say({ speaker: 'C', text: 'The slipway is what costs, not the sailing.' });
    await harness.tick();

    // ONE topic, TWO voices, a name on each note. Nothing is split into a
    // Devi group and a Wren group: the notes are filed by what they are
    // about, and only a transcript files by who was talking.
    expect(nested(harness.notes())).toHaveLength(2);
    expect(tags(harness.notes())).toBe(2);
    expect(voices(harness.notes())).toEqual(['B', 'C']);
    expect(harness.notes()).not.toContain('&g=');
    expect(harness.errors).toEqual([]);
  });
});
