/**
 * Who the note-taker is, where its notes live, and the one doc-store slice
 * every notes writer reaches the doc through.
 *
 * ONE HOME FOR THE AGENT'S IDENTITY. `meeting-notes` is the author id stamped
 * on every block the note-taker writes, the id `applyBlockEdits` compares a
 * block's `cwAuthor` against before it will replace or delete it, and the id a
 * proposal is attributed to when it may not. Three things that must agree, so
 * they are one constant read from one file.
 *
 * ONE HOME FOR THE HEADING TEXT. `Meeting notes` is no longer how the section
 * is FOUND — a heading carries a block id now, and the session remembers it
 * (`meeting-notes-doc.ts`) — but it is still the words written when a meeting
 * opens its section, so the prompt and the opener need to agree on them.
 *
 * ONE WRITE PATH. Everything that changes a note goes through
 * `DocStore.applyBlockEdits`, which is the same verb the MCP block tools and
 * the HTTP edit routes call. The note-taker is an agent editing a doc with the
 * operations every other agent uses; it has no private pathway, and this
 * interface is deliberately too narrow to grow one.
 */

import type { suggestOps } from '@claude-workspaces/core';
import type { DocType, prose } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import type { BlockEditsResult, DocOutline } from './doc-outline-ops.ts';

/** The agent id every block the note-taker writes is stamped with. */
export const NOTES_AUTHOR_ID = 'meeting-notes';

/**
 * How a proposal from the note-taker is attributed, when an edit names a block
 * the agent no longer owns and `applyBlockEdits` turns it into a suggestion.
 * The id matches {@link NOTES_AUTHOR_ID} on purpose: a redline and a direct
 * write come from the same hand, and a reader should see one name.
 */
export const NOTES_SUGGESTION_AUTHOR: suggestOps.SuggestionAuthor = {
  id: NOTES_AUTHOR_ID,
  name: 'Meeting Assistant',
  color: '#7c5cff',
};

/**
 * The words a meeting's notes section is opened under.
 *
 * NOTHING FINDS THE SECTION BY THIS STRING ANY MORE, and that is the point of
 * the rebuild: a person who renames the heading used to orphan the section and
 * get a second one on the next tick. The heading is addressed by its block id
 * now. This constant is only what gets WRITTEN when a meeting opens a section,
 * so the prompt and the opener say the same thing.
 */
export const MEETING_NOTES_HEADING = 'Meeting notes';

/** The doc's meta, as much of it as the notes path reads. */
export interface NotesDocMeta {
  type: DocType;
  title?: string;
  setId?: string;
}

/**
 * The slice of `DocStore` the notes path needs — narrow enough that a test
 * hands in an object over a `Y.Doc` instead of a server.
 *
 * `readOutline` and `applyBlockEdits` are the SHARED verbs: the same two the
 * `read_doc_outline` / `apply_block_edits` MCP tools and their routes call.
 * Nothing here writes a Yjs fragment directly.
 */
export interface NotesDocStore {
  get(docId: string): { ydoc: Y.Doc; meta: NotesDocMeta } | undefined;
  /** The doc's addressable blocks and their ids. `null` for an unknown doc. */
  readOutline(docId: string, opts?: prose.OutlineOptions): DocOutline | null;
  /** Apply a batch of block-addressed edits in one transaction. */
  applyBlockEdits(
    docId: string,
    edits: prose.BlockEdit[],
    who: { author: string; authorName?: string; authorColor?: string },
  ): BlockEditsResult;
  /** The file this doc is bound to, when it is bound to one. Read only by the
   *  legacy-transcript removal, which must not touch a `Raw transcript`
   *  heading in a doc the old writer could never have written in. Optional so
   *  a test can leave it out; absent reads as unbound. */
  boundPathOf?(docId: string): string | undefined;
}

/**
 * Apply a batch as the note-taker, with its identity filled in. The one
 * helper, so no caller has to remember which of the three ids goes where.
 */
export function applyNotesBlockEdits(
  docStore: NotesDocStore,
  docId: string,
  edits: readonly prose.BlockEdit[],
): BlockEditsResult {
  return docStore.applyBlockEdits(docId, [...edits], {
    author: NOTES_AUTHOR_ID,
    authorName: NOTES_SUGGESTION_AUTHOR.name,
    authorColor: NOTES_SUGGESTION_AUTHOR.color,
  });
}

/** The doc's outline, or an empty one for a doc that is gone or is not prose.
 *  Every notes reader wants the same answer for those two cases: nothing to
 *  address. */
export function readNotesOutline(
  docStore: NotesDocStore,
  docId: string,
  opts: prose.OutlineOptions = {},
): readonly prose.OutlineEntry[] {
  return docStore.readOutline(docId, opts)?.blocks ?? [];
}
