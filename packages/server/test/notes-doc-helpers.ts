/**
 * The doc-store slice the notes tests hand to the notes path, plus the
 * section reads their assertions are written in.
 *
 * WHY A STORE AND NOT A MAP. The note-taker writes through
 * `DocStore.applyBlockEdits` now — the same verb the MCP block tools and the
 * HTTP edit routes call — so a test that hands in a bare `{ get }` map is not
 * exercising the path production runs. This wraps a doc in exactly the three
 * methods `NotesDocStore` asks for, delegating to `doc-outline-ops.ts`, which
 * is the module `DocStore` itself delegates to. A test using this and the
 * server using its own store run the same code from `readOutline` down.
 *
 * IT ALSO INSTALLS `clearAuthorshipOnPersonEdit`, because the real store does
 * (`doc-store.ts` wires it per doc). Without it a person-origin transaction
 * would leave the note-taker's `cwAuthor` on the block they just edited, and
 * every test about "the agent may no longer replace this" would pass for the
 * wrong reason.
 *
 * The section reads below still find a section by its heading TEXT. That is
 * deliberate and is not a relapse: the PRODUCT no longer does, and a test
 * asserting "no second Meeting notes heading appeared" has to be able to
 * count headings by their words.
 */

import type { DocType } from '@claude-workspaces/core';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyDocBlockEdits, readDocOutline } from '../src/doc-outline-ops.ts';
import type { LiveDoc } from '../src/doc-store.ts';
import {
  type NotesDocMeta,
  type NotesDocStore,
  applyNotesBlockEdits,
} from '../src/notes-doc-access.ts';

/** One doc as the notes path sees it. */
export interface TestDoc {
  ydoc: Y.Doc;
  meta: NotesDocMeta;
  boundPath?: string;
}

/**
 * A `NotesDocStore` over docs a test built, with authorship clearing wired the
 * way the server wires it. Returns the store; the disposer is not offered
 * because a test doc is garbage at the end of the test.
 */
export function notesDocStore(docs: Readonly<Record<string, TestDoc>>): NotesDocStore {
  for (const doc of Object.values(docs)) prose.clearAuthorshipOnPersonEdit(doc.ydoc);
  const live = (docId: string): LiveDoc | undefined => {
    const doc = docs[docId];
    return doc === undefined ? undefined : (doc as unknown as LiveDoc);
  };
  return {
    get: (docId) => docs[docId],
    boundPathOf: (docId) => docs[docId]?.boundPath,
    readOutline: (docId, opts = {}) => {
      const doc = live(docId);
      return doc === undefined ? null : readDocOutline(doc, opts);
    },
    applyBlockEdits: (docId, edits, who) => {
      const doc = live(docId);
      return doc === undefined
        ? { ok: false, error: 'not-found' }
        : applyDocBlockEdits(doc, edits, who);
    },
  };
}

/** A store holding one doc under `docId`. The shape most tests want. */
export function oneDocStore(docId: string, doc: TestDoc): NotesDocStore {
  return notesDocStore({ [docId]: doc });
}

/** Where a heading sits in the top-level fragment: its index, and the first
 *  index past its body. The LAST match, so a doc that somehow grew two is
 *  read at its newest. */
export function findSectionSpan(
  fragment: Y.XmlFragment,
  heading: string,
): { start: number; endExclusive: number } | null {
  const top = fragment.toArray() as Y.XmlElement[];
  let start = -1;
  let level = 0;
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (headingTextOf(el) !== heading) continue;
    start = i;
    level = prose.headingLevelOf(el);
  }
  if (start < 0) return null;
  let endExclusive = top.length;
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (prose.headingLevelOf(el) <= level) {
      endExclusive = i;
      break;
    }
  }
  return { start, endExclusive };
}

/** A heading's text without its `#` marks. */
export function headingTextOf(el: Y.XmlElement): string {
  const line = prose.serializeBlockToMarkdown(el).split('\n', 1)[0] ?? '';
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/** Every top-level heading's text, in order. */
export function headingsOf(ydoc: Y.Doc): string[] {
  return (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[])
    .filter((el) => el.nodeName === 'heading')
    .map(headingTextOf);
}

/** The body of the section under `heading`, as markdown. Empty when there is
 *  no such heading. */
export function sectionBody(ydoc: Y.Doc, heading: string): string {
  const fragment = prose.getProseFragment(ydoc);
  const span = findSectionSpan(fragment, heading);
  if (!span) return '';
  const top = fragment.toArray() as Y.XmlElement[];
  const out: string[] = [];
  for (let i = span.start + 1; i < span.endExclusive; i++) {
    const md = prose.serializeBlockToMarkdown(top[i]!);
    if (md.length > 0) out.push(md);
  }
  return out.join('\n\n');
}

/** The whole doc as markdown. */
export function markdownOfDoc(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/**
 * Every note under `heading`, one per line, with its list marker stripped —
 * the unit a "no line appeared twice" assertion counts in, and the same unit
 * the old section reader returned so the assertions that used it did not have
 * to change.
 */
export function noteLines(ydoc: Y.Doc, heading: string): string[] {
  return sectionBody(ydoc, heading)
    .split('\n')
    .map((l) => l.trim().replace(/^([-*+]|\d+[.)])\s+/, ''))
    .filter((l) => l.length > 0);
}

/**
 * A person typing in the doc.
 *
 * The transaction origin is a non-string object, which is what the collab
 * socket produces and what `isPersonOrigin` tests for. Passing `'person'`
 * would be a STRING origin, i.e. a server-side write, and authorship would
 * not clear — the exact false pass this helper exists to prevent.
 */
export const PERSON_ORIGIN = { peer: 'browser' };

/** Run `edit` as a person would: one transaction, person origin. */
export function asPerson(ydoc: Y.Doc, edit: () => void): void {
  ydoc.transact(edit, PERSON_ORIGIN);
}

/**
 * A doc whose notes the agent wrote, and whose other content it did not.
 *
 * WHY EVERY SPEAKER-TAG TEST NEEDS THIS. The three tag passes used to be
 * scoped to "the section under the Meeting notes heading"; they are scoped to
 * "the blocks this agent still owns" now. A doc built by parsing markdown has
 * no authorship on any block, so it is entirely out of scope — a test written
 * that way would assert zero replacements for the wrong reason. Here `before`
 * is parsed as a person's writing and `notes` is written through
 * `applyBlockEdits` as the agent, which is how those blocks get their
 * `cwAuthor` in production.
 */
export function agentNotesDoc(before: string, notes: string): Y.Doc {
  const ydoc = new Y.Doc();
  if (before.trim().length > 0) {
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), before);
  }
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
  const res = applyNotesBlockEdits(store, 'd', [{ op: 'insert_at_end', markdown: notes }]);
  if (!res.ok || res.applied === 0) throw new Error('could not seed the agent’s notes');
  // Authorship clearing is wired by `oneDocStore`, and the seeding write is a
  // server-side (string-origin) transaction, so the blocks stay the agent's.
  return ydoc;
}

/** The same, with nothing above the notes. */
export function agentNotes(notes: string): Y.Doc {
  return agentNotesDoc('', notes);
}
