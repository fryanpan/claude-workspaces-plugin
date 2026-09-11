/**
 * A regroup the model can see but the doc could not make.
 *
 * `readOutline` describes a bullet by its heading and its depth and says
 * nothing about which list ELEMENT holds it. So the moment a note that is not
 * a bullet lands under a topic — a paragraph note, or a numbered line where
 * the instructions asked for a dash — the next insert opens a SECOND list, and
 * the two halves still read as siblings in the prompt. A `nest_blocks` naming
 * one bullet from each answered `nothing-to-nest`, tick after tick, with
 * nothing in the doc or in the prompt to say why.
 *
 * Measured on an hour of AMI EN2001a: seventeen of the run's twenty-four
 * failed edits were that refusal, ten of them the same regroup re-issued.
 *
 * These drive the real server write — the guard, the section scope and the
 * applier — because the reach has to survive all three, not just the core
 * function that does the moving.
 *
 * WHAT THIS LEVEL CANNOT SEE. Whether an already-made regroup answers
 * `applied` or `nothing-to-nest` is invisible here: a batch of nothing but
 * moves reports no failed write either way. That distinction is asserted
 * where it is observable, in `packages/core/src/prose-nest.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

function update(edits: readonly prose.BlockEdit[]): NotesUpdate {
  return {
    docId: 'd',
    meetingId: 'm',
    tick: { tick: 1, reason: 'pause', turns: [] },
    edits: [...edits],
  } as unknown as NotesUpdate;
}

/** A notes section the note-taker itself wrote, so every block is its own. */
function notesDoc(markdown: string): NotesDocStore {
  const store = oneDocStore('d', { ydoc: new Y.Doc(), meta: { type: 'markdown' } });
  expect(
    applyNotesUpdate(
      store,
      update([{ op: 'insert_at_end', markdown }]),
      createNotesHeadingMemory(),
    ),
  ).toBeNull();
  return store;
}

/** The id of the bullet reading `needle`. */
function idOf(store: NotesDocStore, needle: string): string {
  const found = (store.readOutline('d')?.blocks ?? []).find((b) => b.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
}

/** Each bullet's text with its depth — the only reading that shows a nest. */
function bullets(store: NotesDocStore): string[] {
  return (store.readOutline('d')?.blocks ?? [])
    .filter((b) => b.kind === 'listItem')
    .map((b) => `${'  '.repeat(b.depth ?? 0)}${b.text}`);
}

describe('a topic whose bullets a paragraph split in two', () => {
  test('regroups across the split, and reports no failed write', () => {
    const store = notesDoc(
      '## Meeting notes\n\n### Case design\n\n- the case has to survive a drop\n- rubber edging was floated\n\nNobody costed the edging.\n\n- a hard shell was preferred\n',
    );
    const skip = applyNotesUpdate(
      store,
      update([
        {
          op: 'nest_blocks',
          leadBlockId: idOf(store, 'survive a drop'),
          blockIds: [idOf(store, 'hard shell')],
        },
      ]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBeNull();
    expect(bullets(store)).toEqual([
      'the case has to survive a drop',
      '  a hard shell was preferred',
      'rubber edging was floated',
    ]);
  });

  test("the next topic's bullets are still out of reach — the control", () => {
    const store = notesDoc(
      '## Meeting notes\n\n### Case design\n\n- the case has to survive a drop\n\n### Cost\n\n- the beeper cost is not known\n',
    );
    const before = bullets(store);
    applyNotesUpdate(
      store,
      update([
        {
          op: 'nest_blocks',
          leadBlockId: idOf(store, 'survive a drop'),
          blockIds: [idOf(store, 'beeper cost')],
        },
      ]),
      createNotesHeadingMemory(),
    );
    expect(bullets(store)).toEqual(before);
  });
});
