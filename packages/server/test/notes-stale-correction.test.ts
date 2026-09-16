/**
 * A correction the note-taker decided to make is either in the notes, or the
 * meeting's own record says it did not happen and why.
 *
 * THE MEASUREMENT THIS COMES FROM. Over an hour of meeting, six of
 * twenty-four failed edits were the note-taker pointing at a bullet it had
 * written itself — four corrections and two removals — and every one of them
 * was answered `unknown-block` and dropped. A dropped correction leaves the
 * wording the note-taker judged wrong sitting on the page looking deliberate,
 * and a dropped removal leaves a note nobody can tell was meant to be gone.
 *
 * TWO HALVES, AND THEY ARE DIFFERENT CLAIMS.
 *
 * 1. THE CAUSE, closed in `prose-batch.ts`: the block WAS on the page, and
 *    the batch's own earlier edit is what moved it. `replace_block` is a
 *    delete and an insert, so the rewritten block used to come back under a
 *    new address while later edits in the same batch still named the old one.
 *    The first two tests drive that through the real tick path — a compose, a
 *    guard, a dedupe and `DocStore.applyBlockEdits` — because the unit case is
 *    `packages/core/src/prose-batch-address.test.ts` and this file's job is to
 *    show a MEETING keeping its corrections.
 *
 * 2. WHAT IS LEFT, which no fix can close: a block that really has left the
 *    doc — a person deleted the bullet while the model was composing about
 *    it. There is nothing to correct any more, so the requirement is that the
 *    meeting SAYS SO. The tick's timing row carries every edit the doc would
 *    not take, its verdict, and whether the words were re-homed anyway.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

/**
 * Delete one block the way a person's editor does: a person-origin
 * transaction, so the doc clears the note-taker's claim on it exactly as it
 * would in a browser.
 */
function deleteBlock(ydoc: Y.Doc, blockId: string): void {
  const fragment = prose.getProseFragment(ydoc);
  const el = prose.findBlockById(fragment, blockId);
  if (el === null || el === undefined) throw new Error(`no block ${blockId} to delete`);
  const parent = (el.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const at = (parent.toArray() as unknown[]).indexOf(el);
  if (at < 0) throw new Error('the block is not in its own parent');
  ydoc.transact(() => parent.delete(at, 1), { person: true });
}

/** The bullet in this tick's outline whose words contain `needle`, as the
 *  composer would find it — by reading the outline it was handed. */
function bulletId(input: NotesComposeInput, needle: string): string {
  const found = input.outline.find((e) => e.kind === 'listItem' && e.text.includes(needle));
  if (found === undefined) throw new Error(`no bullet reading ${needle} in the outline`);
  return found.id;
}

function headingId(input: NotesComposeInput, needle: string): string {
  const found = input.outline.find((e) => e.kind === 'heading' && e.text.includes(needle));
  if (found === undefined) throw new Error(`no heading reading ${needle} in the outline`);
  return found.id;
}

const OPENING =
  '## Meeting notes\n\n### Launch date\n\n- ships Tuesday\n- Riverbend runs the pilot\n';

describe('the note-taker keeps the corrections it makes', () => {
  test('a correction rides in the same batch as the regroup that moves its bullet', async () => {
    // THE SHAPE THAT USED TO LOSE IT. The prompt asks a tick to regroup a
    // topic past the flat-run bar AND to correct earlier notes the new speech
    // overturns, so one batch naming one bullet twice is ordinary output.
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const ships = bulletId(input, 'ships Tuesday');
        return [
          // Reword the bullet into a lead for the topic…
          { op: 'replace_block', blockId: ships, markdown: '- Launch timing' },
          // …and put the correction under it, in the same answer.
          {
            op: 'insert_under_heading',
            headingId: headingId(input, 'Launch date'),
            markdown: '- ships Thursday, not Tuesday\n',
          },
          // …and fold the rest of the topic under the lead it just reworded.
          {
            op: 'nest_blocks',
            leadBlockId: ships,
            blockIds: [bulletId(input, 'Riverbend runs the pilot')],
          },
        ];
      },
    });
    await harness.speak('We ship Tuesday.');
    const second = await harness.speak('Correction, it is Thursday, not Tuesday.');

    expect(second.notes).toContain('Launch timing');
    expect(second.notes).toContain('ships Thursday, not Tuesday');
    // The regroup landed too: the sibling is nested under the reworded lead.
    expect(second.notes).toContain('  - Riverbend runs the pilot');
    // The wording the note-taker replaced is NOT still standing beside it.
    expect(second.notes).not.toContain('ships Tuesday');
    const row = harness.timing().rows().at(-1);
    expect(row?.dropped).toEqual([]);
  });

  test('a second pass at the same bullet lands on the first pass, not beside it', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const ships = bulletId(input, 'ships Tuesday');
        return [
          { op: 'replace_block', blockId: ships, markdown: '- ships Thursday' },
          { op: 'replace_block', blockId: ships, markdown: '- ships Thursday morning' },
        ];
      },
    });
    await harness.speak('We ship Tuesday.');
    const second = await harness.speak('Thursday. Thursday morning, in fact.');

    expect(second.notes).toContain('ships Thursday morning');
    expect(second.notes).not.toContain('ships Tuesday');
    // One bullet under the topic, not two disagreeing about the date.
    expect(second.notes.split('\n').filter((l) => l.includes('ships')).length).toBe(1);
    expect(harness.timing().rows().at(-1)?.dropped).toEqual([]);
  });
});

describe('a correction that cannot land is on the meeting’s record', () => {
  test('a rewrite of a bullet a person deleted mid-compose says so, and where its words went', async () => {
    // THE BLOCK REALLY DOES LEAVE. The composer is handed an outline with the
    // bullet in it and, while it is "thinking", the person deletes that
    // bullet — the one drop this pipeline cannot design away.
    let removed = false;
    const harness = createNotesTickHarness({
      compose: async (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const ships = bulletId(input, 'ships Tuesday');
        if (!removed) {
          removed = true;
          deleteBlock(harness.ydoc, ships);
        }
        return [{ op: 'replace_block', blockId: ships, markdown: '- ships Thursday' }];
      },
    });
    await harness.speak('We ship Tuesday.');
    const second = await harness.speak('Thursday, not Tuesday.');

    const row = harness.timing().rows().at(-1);
    expect(row?.dropped).toEqual([{ op: 'replace_block', why: 'unknown-block', recovered: true }]);
    // `recovered` is a claim about the doc, so read the doc: the words are in
    // the notes, under the meeting's section rather than under their topic.
    expect(second.notes).toContain('ships Thursday');
  });

  test('a removal that cannot land is recorded as words nothing could put back', async () => {
    let removed = false;
    const harness = createNotesTickHarness({
      compose: async (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const ships = bulletId(input, 'ships Tuesday');
        if (!removed) {
          removed = true;
          deleteBlock(harness.ydoc, ships);
        }
        return [
          {
            op: 'insert_under_heading',
            headingId: headingId(input, 'Launch date'),
            markdown: '- Saltmarsh owns the rollout\n',
          },
          { op: 'delete_block', blockId: ships },
        ];
      },
    });
    await harness.speak('We ship Tuesday.');
    const second = await harness.speak('Drop that, Saltmarsh owns the rollout.');

    // The tick WROTE — a note landed — so nothing else in the record calls it
    // a failure. The dropped list is the only place the removal is stated.
    const row = harness.timing().rows().at(-1);
    expect(row?.outcome).toBe('written');
    expect(row?.dropped).toEqual([{ op: 'delete_block', why: 'unknown-block', recovered: false }]);
    expect(second.notes).toContain('Saltmarsh owns the rollout');
  });

  test('the meeting’s closing line counts what the doc would not take', async () => {
    let removed = false;
    const harness = createNotesTickHarness({
      compose: async (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const ships = bulletId(input, 'ships Tuesday');
        if (!removed) {
          removed = true;
          deleteBlock(harness.ydoc, ships);
        }
        return [
          {
            op: 'insert_under_heading',
            headingId: headingId(input, 'Launch date'),
            markdown: '- Saltmarsh owns the rollout\n',
          },
          { op: 'delete_block', blockId: ships },
        ];
      },
    });
    await harness.speak('We ship Tuesday.');
    await harness.speak('Drop that, Saltmarsh owns the rollout.');

    const line = harness.timing().summary() ?? '';
    expect(line).toContain('1 edit(s) the doc would not take');
    expect(line).toContain('1 whose words are nowhere in the notes');
  });

  test('a tick whose batch landed whole records nothing dropped', async () => {
    // CONTROL. Without this the dropped list could be filled on every tick
    // and every assertion above would still read the same.
    const harness = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? [{ op: 'insert_at_end', markdown: OPENING }]
          : [
              {
                op: 'insert_under_heading',
                headingId: headingId(input, 'Launch date'),
                markdown: '- Riverbend signs off first\n',
              },
            ],
    });
    await harness.speak('We ship Tuesday.');
    await harness.speak('Riverbend signs off first.');
    for (const row of harness.timing().rows()) expect(row.dropped).toEqual([]);
    expect(harness.timing().summary() ?? '').not.toContain('would not take');
  });
});

describe('the fix reaches nobody’s writing', () => {
  test('a person’s line is proposed on, never rewritten, and never moved', async () => {
    const harness = createNotesTickHarness({
      doc: 'Bryan’s own opening line.\n',
      compose: (input, tick) => {
        if (tick === 1) return [{ op: 'insert_at_end', markdown: OPENING }];
        const theirs = input.outline.find((e) => e.text.includes('own opening line'));
        if (theirs === undefined) throw new Error('the person’s line left the outline');
        return [{ op: 'replace_block', blockId: theirs.id, markdown: 'A tidier opening line.' }];
      },
    });
    await harness.speak('We ship Tuesday.');
    const second = await harness.speak('Tidy that first line.');

    // Their words are still there, still first, and the offer is a proposal
    // beside them rather than a rewrite of them.
    expect(second.markdown).toContain('own opening line');
    expect(second.markdown.indexOf('own opening line')).toBeLessThan(
      second.markdown.indexOf('Meeting notes'),
    );
  });
});
