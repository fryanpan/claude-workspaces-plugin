/**
 * The block-addressed half of doc editing: reading a doc's outline, and
 * applying a batch of edits keyed on the ids that outline handed out.
 *
 * A sibling of `doc-edit-ops.ts` rather than two more methods on it, for the
 * plain reason that the file is at 463 lines and the 500-line bar is a gate.
 * The split is not arbitrary though: every verb in `doc-edit-ops.ts`
 * addresses the doc by TEXT — a find string, a thread's anchored range, a
 * heading's spelling — and these two address it by the opaque id minted in
 * `prose-outline.ts`. Different address space, different file; `DocEditOps`
 * keeps the two thin delegates so callers still have one object to hold.
 *
 * Both take an already-resolved `LiveDoc` so that "which doc" is asked once,
 * in the store, and answered the same way it is for every other verb.
 */
import { contentKind, prose } from '@claude-workspaces/core';
import type { LiveDoc } from './doc-store.ts';

/** What a caller gets back from an outline read. A wrapper object rather than
 *  a bare array because this is a REST body: a top-level array cannot grow a
 *  field later without breaking every reader. */
export interface DocOutline {
  blocks: prose.OutlineEntry[];
}

/** The batch result, with the not-found / unsupported answers the other
 *  store verbs give, so a route need not special-case doc resolution. */
export type BlockEditsResult =
  | ({ ok: true } & prose.ApplyBlockEditsResult)
  | { ok: false; error: 'not-found' | 'unsupported' };

/** Who a batch's writes belong to. `author` is the id stamped on the blocks;
 *  the name and colour are only used when an edit cannot apply directly and
 *  becomes a suggestion, which is why they are optional and defaulted the
 *  same way `parseSuggestionAuthor` defaults a missing colour. */
export interface BlockEditsAuthor {
  author: string;
  authorName?: string;
  authorColor?: string;
}

/**
 * The doc's blocks with their ids, or an empty outline for a doc that has no
 * prose to address.
 *
 * A flat (code / diff) doc answers `{ blocks: [] }` rather than an error, for
 * the same reason `listSuggestions` answers `[]`: a reader asking what it may
 * address is entitled to the answer "nothing", and an error would make every
 * caller branch on doc type before it could ask.
 */
export function readDocOutline(doc: LiveDoc, opts: prose.OutlineOptions = {}): DocOutline {
  if (contentKind(doc.meta.type) !== 'prose') return { blocks: [] };
  return { blocks: prose.readOutline(doc.ydoc, opts) };
}

/** Apply a batch of block-addressed edits in one transaction. */
export function applyDocBlockEdits(
  doc: LiveDoc,
  edits: prose.BlockEdit[],
  who: BlockEditsAuthor,
): BlockEditsResult {
  if (contentKind(doc.meta.type) !== 'prose') return { ok: false, error: 'unsupported' };
  const res = prose.applyBlockEdits(doc.ydoc, edits, {
    author: who.author,
    suggestionAuthor: {
      id: who.author,
      name: who.authorName ?? who.author,
      color: who.authorColor ?? '#888888',
    },
    // The same origin every other agent-side edit route writes under, so the
    // write-back observer flushes the result to disk and
    // `clearAuthorshipOnPersonEdit` does not mistake it for a person typing.
    transactionOrigin: 'agent',
  });
  return { ok: true, ...res };
}
