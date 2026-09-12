/**
 * A tick that still cannot write is visible to the person in the meeting.
 *
 * WHAT THE PERSON COULD SEE BEFORE. Nothing. A failed write puts its turns
 * back on the live transcript, where they read as "still being written up" —
 * true for a failure the next tick recovers, and a lie for one that repeats.
 * The only other trace was a `console.error` line in the server log, which
 * nobody in a meeting is reading. So a meeting could stop taking notes and
 * look exactly like a meeting in which nothing quotable was said.
 *
 * The notice goes in the doc for the reason the quota one does (Bryan,
 * 2026-09-09): the notes are the one surface everybody in the room already
 * has open.
 *
 * All fixtures are invented place names. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { MEETING_NOTES_HEADING } from '../src/notes-doc-access.ts';
import { NOTES_NOT_WRITTEN_MARK } from '../src/notes-notice.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/**
 * A meeting whose composer answers tick `from` onward by replacing the
 * meeting's own section heading — the one edit `notes-edit-guard.ts` RULE 1
 * refuses outright, so the write is declined however the doc is addressed.
 * It is the shape a model repeats once it has started: the same prompt and
 * the same doc produce the same wrong answer.
 */
function stalling(from: number): ReturnType<typeof createNotesTickHarness> {
  return createNotesTickHarness({
    doc: '# Harborlight survey\n',
    compose: (input, tick) => {
      const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
      if (markdown.length === 0) return [];
      if (tick < from) return addNotes(input, markdown);
      const section = input.outline.find(
        (e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING,
      );
      return section === undefined
        ? addNotes(input, markdown)
        : [{ op: 'replace_block', blockId: section.id, markdown: `## ${markdown}` }];
    },
  });
}

const carriesNotice = (markdown: string): boolean => markdown.includes(NOTES_NOT_WRITTEN_MARK);

describe('the doc says when the note-taker has stopped taking words', () => {
  test('says nothing about one failure the next tick recovers', async () => {
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input, tick) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (tick !== 2) return addNotes(input, markdown);
        const section = input.outline.find(
          (e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING,
        );
        return section === undefined
          ? addNotes(input, markdown)
          : [{ op: 'replace_block', blockId: section.id, markdown: `## ${markdown}` }];
      },
    });
    // EVERY TICK, NOT THE END STATE. A notice that appeared and was retracted
    // before the meeting stopped is invisible in the final doc, so an
    // end-state assertion here passes whatever the threshold is — measured,
    // by setting it to 1 and watching this test stay green.
    const seen: boolean[] = [];
    for (const line of [
      'the survey starts on the first',
      'the pier needs a permit',
      'the budget is signed off',
    ]) {
      seen.push(carriesNotice((await h.speak(line)).markdown));
    }
    await h.end();
    // One refusal, then a tick that wrote: the words arrived late, and a
    // sentence about them would have been noise.
    expect(seen).toEqual([false, false, false]);
    expect(carriesNotice(h.markdown())).toBe(false);
    expect(h.markdown()).toContain('the pier needs a permit');
  });

  test('tells the room once the failure repeats', async () => {
    const h = stalling(2);
    await h.speak('the survey starts on the first');
    await h.speak('the pier needs a permit');
    await h.speak('the budget is signed off');
    await h.speak('the ferry timetable changes in March');
    await h.end();
    expect(carriesNotice(h.markdown())).toBe(true);
  });

  test('says it once, not once per refused tick', async () => {
    const h = stalling(2);
    for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) await h.speak(line);
    await h.end();
    const said = h
      .markdown()
      .split('\n')
      .filter((l) => l.includes(NOTES_NOT_WRITTEN_MARK));
    expect(said).toHaveLength(1);
  });

  test('takes it away again when a tick writes', async () => {
    // Refused for ticks 2-4, then the composer goes back to writing notes.
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input, tick) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (tick < 2 || tick > 4) return addNotes(input, markdown);
        const section = input.outline.find(
          (e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING,
        );
        return section === undefined
          ? addNotes(input, markdown)
          : [{ op: 'replace_block', blockId: section.id, markdown: `## ${markdown}` }];
      },
    });
    const seen: boolean[] = [];
    for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
      seen.push(carriesNotice((await h.speak(line)).markdown));
    }
    await h.end();
    // IT WAS THERE, AND THEN IT WENT. Without the first half this passes on a
    // notice that was never raised at all.
    expect(seen.some((carried) => carried)).toBe(true);
    expect(carriesNotice(h.markdown())).toBe(false);
  });
});
