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
import type { prose } from '@claude-workspaces/core';
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

  // A TICK THAT SAID NOTHING MUST NOT READ AS RECOVERY. An empty compose
  // reaches the write path as a success — there is nothing to refuse — so it
  // used to clear the streak and pull the notice down while the doc was still
  // taking none of the room's words. Found by an independent review of this
  // branch, not by a test that existed.
  test('leaves it standing through a tick the composer answered with nothing', async () => {
    // The silent tick is the one right after the notice goes up, which is the
    // only place the bug is reachable — so the script finds it by READING the
    // doc rather than by counting ticks, whose numbering a retry can move.
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (input.outline.some((e) => e.text.includes(NOTES_NOT_WRITTEN_MARK))) return [];
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
    seen.push(carriesNotice(h.markdown()));
    // MONOTONIC, not an end state: nothing in this meeting ever writes, so
    // once the notice is up it must never come back down. A retraction by the
    // silent tick shows up as a `false` after a `true`.
    const raised = seen.indexOf(true);
    expect(raised).toBeGreaterThanOrEqual(0);
    expect(seen.slice(raised)).toEqual(seen.slice(raised).map(() => true));
  });

  // THE SAME HOLE, THROUGH THE OTHER DOOR. A batch of nothing but moves is
  // not empty, so `edits.length > 0` read it as a write — and it answers
  // `null` whether the moves land or not, by design. A regroup is not a note.
  test('leaves it standing through a tick that only regrouped', async () => {
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (input.outline.some((e) => e.text.includes(NOTES_NOT_WRITTEN_MARK))) {
          const lead = input.outline.find((e) => e.kind === 'listItem');
          return [{ op: 'nest_blocks', leadBlockId: lead?.id ?? 'b-1', blockIds: ['b-gone'] }];
        }
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
    seen.push(carriesNotice(h.markdown()));
    const raised = seen.indexOf(true);
    expect(raised).toBeGreaterThanOrEqual(0);
    expect(seen.slice(raised)).toEqual(seen.slice(raised).map(() => true));
  });

  // AND THROUGH A BATCH THAT MIXES THE TWO. A refused note beside a regroup
  // the guard lets through is a batch the write path calls a success — the
  // regroup is what it applied — while the only words in it never reached
  // the doc. Judging recovery from the edits the tick COMPOSED saw the words
  // and cleared the notice; only the write path knows which edits landed.
  // Found by an independent review of this branch.
  test('leaves it standing through a tick whose words were refused beside a regroup', async () => {
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        const section = input.outline.find(
          (e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING,
        );
        if (section === undefined) return addNotes(input, markdown);
        const refused: prose.BlockEdit = {
          op: 'replace_block',
          blockId: section.id,
          markdown: `## ${markdown}`,
        };
        if (!input.outline.some((e) => e.text.includes(NOTES_NOT_WRITTEN_MARK))) return [refused];
        const lead = input.outline.find((e) => e.kind === 'listItem');
        return [
          refused,
          { op: 'nest_blocks', leadBlockId: lead?.id ?? 'b-1', blockIds: ['b-gone'] },
        ];
      },
    });
    const seen: boolean[] = [];
    for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
      seen.push(carriesNotice((await h.speak(line)).markdown));
    }
    await h.end();
    seen.push(carriesNotice(h.markdown()));
    const raised = seen.indexOf(true);
    expect(raised).toBeGreaterThanOrEqual(0);
    expect(seen.slice(raised)).toEqual(seen.slice(raised).map(() => true));
  });

  // PINS THE THRESHOLD FROM ABOVE, where the first test pins it from below.
  // It has to read the SNAPSHOT of the tick that is the second failure, not
  // the end of the meeting: the final pass at `end()` is a failing tick too,
  // so by then even a threshold of three has been met and the assertion
  // passes on the wrong number — measured, by setting it to three and
  // watching an end-state version of this test stay green.
  test('two failures are enough — it does not wait for a third', async () => {
    const h = stalling(2);
    const seen: boolean[] = [];
    // Tick 1 writes; ticks 2 and 3 are refused, so the third line is the
    // tick at which the room is owed the sentence.
    for (const line of ['the survey starts on the first', 'the pier needs a permit', 'so noted']) {
      seen.push(carriesNotice((await h.speak(line)).markdown));
    }
    await h.end();
    expect(seen[1]).toBe(false);
    expect(seen[2]).toBe(true);
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
