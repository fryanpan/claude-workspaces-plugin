/**
 * A SOLO FIXTURE: one person, thinking aloud, with nobody else in the room.
 *
 * The meeting this is modelled on came out of the pipeline written as a
 * conversation between Speaker A and Speaker B. Two things made that
 * possible and both are asserted here. The prompt asked for a speaker tag on
 * every note and spelled "Speaker B" as what such a name looks like, in a
 * meeting whose transcript lines carry no name at all — so the composer was
 * told the phantom's name before it invented one. And the gate that catches
 * an invented tag unwrapped it to its own words, which took the link off and
 * left the person standing in the sentence.
 *
 * The composer here is scripted to misbehave exactly that way. Nothing in
 * this file mocks the gate: the notes it produces are what the real pipeline
 * would write, and the assertion is the one the ticket asks for — no note
 * names a voice this meeting did not carry.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { findSpeakerTags } from '@claude-workspaces/core';
import { meetingSummaryLine } from '../src/meeting-notes-doc.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { unknownVoices } from '../src/notes-quality-report.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** What the solo speaker actually said, and nobody else. */
const SOLO_TRANSCRIPT: readonly string[] = [
  'Right, the remote keeps disappearing down the side of the sofa.',
  'So a locator that beeps back when you whistle at it.',
  "I'll ask Riverbend whether the cost target leaves room for it.",
];

/** A composer that does what the model did under the old prompt: attributes
 *  every note, to voices this meeting never heard. */
const inventsVoices = (input: NotesComposeInput): ReturnType<typeof addNotes> =>
  addNotes(
    input,
    input.tick.turns
      .map((t, i) => {
        const label = i % 2 === 0 ? 'A' : 'B';
        return `- [@Speaker ${label}](speaker:${label}): ${t.text}`;
      })
      .join('\n'),
  );

describe('a solo meeting writes down nobody', () => {
  const runSolo = async (): Promise<ReturnType<typeof createNotesTickHarness>> => {
    const h = createNotesTickHarness({ compose: inventsVoices });
    for (const line of SOLO_TRANSCRIPT) await h.speak({ speaker: 'A', text: line });
    await h.end();
    return h;
  };

  it('no note names a voice the meeting did not carry', async () => {
    const h = await runSolo();
    const notes = h.notes();
    // Nothing tagged, and — the half that used to survive — nothing NAMED.
    expect(findSpeakerTags(notes)).toEqual([]);
    expect(notes).not.toContain('Speaker A');
    expect(notes).not.toContain('Speaker B');
    // The reading the quality pass takes of the same notes. A solo meeting
    // carried no labels, so any voice named in them is one it did not have.
    expect(unknownVoices(notes, { labels: [], names: [] })).toEqual([]);
  });

  it('keeps every word of what was said — the note, not the name, is the point', async () => {
    const notes = (await runSolo()).notes();
    for (const line of SOLO_TRANSCRIPT) expect(notes).toContain(line);
  });

  it('tells the composer it is solo, which is what takes the rules out of the prompt', async () => {
    const inputs: NotesComposeInput[] = [];
    const h = createNotesTickHarness({
      compose: (input) => {
        inputs.push(input);
        return inventsVoices(input);
      },
    });
    await h.speak({ speaker: 'A', text: SOLO_TRANSCRIPT[0]! });
    await h.end();
    expect(inputs[0]?.multiSpeaker).toBe(false);
  });

  it('counts every dropped tag, and says so on the line the stop writes', async () => {
    const h = await runSolo();
    const summary = h.summary();
    // Three turns, one tag each, every one of them a voice that never spoke.
    expect(summary?.phantomTags).toBe(3);
    expect(meetingSummaryLine(summary!, undefined)).toContain('3 invented speaker tags dropped');
  });

  it('a healthy meeting says nothing about invented tags', async () => {
    // The negative control for the line: the phrase appears because tags
    // were dropped, not because the line always carries it.
    const h = createNotesTickHarness({
      compose: (input) => addNotes(input, input.tick.turns.map((t) => `- ${t.text}`).join('\n')),
    });
    await h.speak({ speaker: 'A', text: SOLO_TRANSCRIPT[0]! });
    await h.end();
    const summary = h.summary();
    expect(summary?.phantomTags).toBe(0);
    expect(meetingSummaryLine(summary!, undefined)).not.toContain('invented speaker tag');
  });
});

describe('the same composer in a room with two voices in it', () => {
  it('keeps the tags that name a voice the meeting really carried', async () => {
    // THE POSITIVE CONTROL for the whole change. A gate that dropped every
    // tag would pass every assertion above while destroying attribution for
    // the meetings that need it most.
    const h = createNotesTickHarness({ compose: inventsVoices });
    await h.speak({ speaker: 'A', text: SOLO_TRANSCRIPT[0]! });
    await h.speak(
      { speaker: 'A', text: 'A locator that beeps.' },
      { speaker: 'B', text: 'The cost target may not stretch.' },
    );
    await h.end();
    const notes = h.notes();
    const tags = findSpeakerTags(notes);
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags.map((t) => t.label))).toEqual(new Set(['A', 'B']));
    expect(notes).toContain('Speaker A');
    expect(notes).toContain('Speaker B');
  });
});
