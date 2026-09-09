/**
 * The placeholder a spoken "can you research X" leaves in the meeting doc.
 *
 * A section headed with the row's title, holding one line that links the row
 * and says the findings land here. It is the capture pill's second half made
 * visible — the row is where the errand is tracked, the section is where the
 * person who asked will look for the answer.
 *
 * IT IS A BLOCK EDIT LIKE EVERY OTHER NOTE. It used to be a bespoke Yjs
 * insert with its own placement rule, which is exactly the private pathway
 * this rebuild removed: `insert_at_end` puts it at the end of the doc, under
 * whatever the notes have grown to, and the block it creates carries the
 * note-taker's authorship so a later edit of it obeys the same ownership rule
 * as a bullet.
 *
 * IDEMPOTENT BY HEADING, still. The same ask heard twice files one row (the
 * capture pass dedupes) and must leave one section: a heading already reading
 * the row's title means the placeholder is there, so nothing is written.
 * Asked of the OUTLINE rather than of the fragment, because the outline is
 * what every reader on this path now uses.
 */

import type { prose } from '@claude-workspaces/core';
import { type NotesDocStore, applyNotesBlockEdits, readNotesOutline } from './notes-doc-access.ts';

/** What one attempt did. `present` is the idempotent answer, not a failure. */
export interface ResearchPlaceholderResult {
  ok: boolean;
  mode?: 'appended' | 'present';
  error?: 'not-found' | 'unsupported' | 'write-failed';
}

/**
 * The edit that writes the placeholder, or none when the doc already has it.
 *
 * Split out from the write so a caller holding an outline it already read
 * does not read a second one, and so the decision is unit-testable without a
 * doc store.
 */
export function researchPlaceholderEdits(
  outline: readonly prose.OutlineEntry[],
  title: string,
  url: string,
): prose.BlockEdit[] {
  const wanted = title.trim();
  if (wanted.length === 0) return [];
  if (outline.some((e) => e.kind === 'heading' && e.text === wanted)) return [];
  return [
    {
      op: 'insert_at_end',
      markdown: `## ${wanted}\n\nFiled as [${wanted}](${url}) — the lead writes what it finds here.`,
    },
  ];
}

/** Write the placeholder into `docId`, unless it is already there. */
export function appendResearchPlaceholder(
  docStore: NotesDocStore,
  docId: string,
  title: string,
  url: string,
): ResearchPlaceholderResult {
  if (!docStore.get(docId)) return { ok: false, error: 'not-found' };
  // Headings only: the question is whether a section with this title exists,
  // and a meeting doc's bullets are not part of the answer.
  const outline = readNotesOutline(docStore, docId, { headingsOnly: true });
  const edits = researchPlaceholderEdits(outline, title, url);
  if (edits.length === 0) return { ok: true, mode: 'present' };
  const res = applyNotesBlockEdits(docStore, docId, edits);
  if (!res.ok) return { ok: false, error: res.error };
  return res.applied > 0 ? { ok: true, mode: 'appended' } : { ok: false, error: 'write-failed' };
}
