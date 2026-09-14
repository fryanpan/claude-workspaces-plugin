import { describe, expect, test } from 'bun:test';
/**
 * The guard's one exception to turning a replace into an add: the note being
 * replaced is already said by another bullet in the section, so replacing it
 * loses no idea and adding beside it would leave the note standing twice.
 *
 * A pair, because the exception has to be exactly as wide as a restatement.
 * The twin that says the OPPOSITE shares every content word — `not` is a
 * stopword — and is no restatement at all.
 *
 * Fictional throughout. The repo is public.
 */
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { guardNotesEdits } from '../src/notes-edit-guard.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};
const NOTE = 'the Harborlight crane inspection is a week late';
const OVERWRITE = '- the Riverbend batch is running two days behind';

/** A flat note, and under a topic a second bullet reading `twin`; every block
 *  the note-taker's. Returns what the doc reads after the guarded replace. */
function replaceFlatNote(twin: string): { kept: number; text: string[] } {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(
    prose.getProseFragment(doc),
    `## Meeting notes\n\n- ${NOTE}\n\n### Crane\n\n- ${twin}\n`,
  );
  prose.ensureBlockIds(doc);
  for (const el of prose.addressableBlocks(prose.getProseFragment(doc))) {
    prose.claimSubtree(el, AUTHOR);
  }
  const outline = prose.readOutline(doc);
  const flat = outline.find((e) => e.kind === 'listItem')?.id as string;
  const guarded = guardNotesEdits([{ op: 'replace_block', blockId: flat, markdown: OVERWRITE }], {
    notesHeadingId: outline[0]?.id as string,
    outline,
  });
  prose.applyBlockEdits(doc, [...guarded.edits], WHO);
  return { kept: guarded.kept.length, text: prose.readOutline(doc).map((e) => e.text) };
}

describe('a replace of a note another bullet already says', () => {
  test('replaces it, rather than keeping it beside its twin', () => {
    const { kept, text } = replaceFlatNote(NOTE);
    expect(kept).toBe(0);
    expect(text.filter((t) => t.includes('crane inspection'))).toHaveLength(1);
    expect(text.some((t) => t.includes('Riverbend batch'))).toBe(true);
  });

  test('keeps it when the only twin says the opposite', () => {
    const { kept, text } = replaceFlatNote('the Harborlight crane inspection is not a week late');
    expect(kept).toBe(1);
    expect(text).toContain(NOTE);
    expect(text.some((t) => t.includes('Riverbend batch'))).toBe(true);
  });
});
