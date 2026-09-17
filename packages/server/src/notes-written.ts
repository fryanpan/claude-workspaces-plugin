/**
 * The notes a meeting wrote, WHEREVER THEY SIT.
 *
 * WHY THIS IS NOT "THE SECTION THIS MEETING OPENED". The note-taker used to
 * append its own `## Meeting notes` section and write everything into it, so
 * a heading id was the whole address of a meeting's output. Whole-doc
 * note-taking ended that: the instructions now ask for a note to go "under
 * the heading of its topic, wherever in the document that heading is", and a
 * well-behaved meeting on a prepared doc opens no section at all. Every
 * reading keyed on the heading then reads a handful of bullets and misses the
 * rest — measured on a real run on 2026-09-16, which read 4 bullets and
 * skipped the 182 the same meeting had written under the document's own
 * headings, and reported coverage over the 4.
 *
 * THE KEY IS AUTHORSHIP, because it is the only thing the document records
 * about who wrote a block. `prose` marks every block the note-taker writes
 * with `cwAuthor` = {@link NOTES_AUTHOR_ID}, and a recording RELEASES every
 * such claim when it starts (`releaseNotesAuthorship`), so the marks standing
 * when a meeting stops are that meeting's own.
 *
 * WHAT THE MARK CANNOT SAY, and this reading is bounded by it exactly as the
 * cleanup gate is (`notes-cleanup-scope.ts`): a person editing one of the
 * note-taker's bullets clears its mark, and a markdown round trip drops every
 * mark in the doc. Both directions lose notes from this reading rather than
 * gaining somebody else's, which is the error worth making — and the
 * meeting's own section is read as well, so a doc whose marks are all gone
 * reads exactly as it did before this module existed.
 *
 * THE HEADING A NOTE SITS UNDER COMES WITH IT, even when a person wrote that
 * heading. The structure checks downstream ask whether the notes read as
 * grouped topics or as a wall of bullets, and a reader meets the heading
 * above a bullet whoever typed it. Dropping it would report a note-taker that
 * filed every note under the right existing topic as one that opened no topic
 * at all.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { NOTES_AUTHOR_ID } from './notes-doc-access.ts';
import type { NotesDocStore } from './notes-doc-access.ts';

/** Whether this block is a list container — the element that serializes its
 *  children WITH their bullet markers. */
function isList(el: Y.XmlElement): boolean {
  return el.nodeName === 'bulletList' || el.nodeName === 'orderedList';
}

/** The addressable children of a list container. */
function childBlocks(el: Y.XmlElement, addressable: ReadonlySet<Y.XmlElement>): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement && addressable.has(child)) out.push(child);
  }
  return out;
}

/** The blocks of one doc, in reading order, or `null` when there is no doc to
 *  read. Never throws: a fragment that will not parse is no blocks. */
function blocksOf(docStore: NotesDocStore, docId: string): Y.XmlElement[] | null {
  const doc = docStore.get(docId);
  if (!doc) return null;
  try {
    return [...prose.addressableBlocks(prose.getProseFragment(doc.ydoc))];
  } catch {
    return null;
  }
}

/** The heading level of a block, or `undefined` for anything else. */
function levelOf(el: Y.XmlElement): number | undefined {
  if (el.nodeName !== 'heading') return undefined;
  const n = Number(el.getAttribute('level'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The blocks of one section: the block `headingId` names, then every block
 * after it until a heading at that level or above.
 */
function sectionScope(
  all: readonly Y.XmlElement[],
  headingId: string | undefined,
  skip: ReadonlySet<string>,
): Set<Y.XmlElement> {
  const scope = new Set<Y.XmlElement>();
  if (headingId === undefined) return scope;
  const start = all.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return scope;
  const openLevel = levelOf(all[start]!) ?? 2;
  for (let i = start; i < all.length; i++) {
    const el = all[i]!;
    const level = levelOf(el);
    if (i > start && level !== undefined && level <= openLevel) break;
    const id = prose.readBlockId(el);
    if (i > start && id !== undefined && skip.has(id)) continue;
    scope.add(el);
  }
  return scope;
}

/**
 * The blocks the document records as `author`'s, plus the heading each one
 * sits under.
 *
 * The heading is the NEAREST one above the block, whoever wrote it — see the
 * module note. A block with no heading above it brings nothing.
 */
function authoredScope(
  all: readonly Y.XmlElement[],
  author: string,
  skip: ReadonlySet<string>,
): Set<Y.XmlElement> {
  const scope = new Set<Y.XmlElement>();
  const headings = new Set<Y.XmlElement>();
  let lastHeading: Y.XmlElement | undefined;
  for (const el of all) {
    if (levelOf(el) !== undefined) lastHeading = el;
    if (prose.readBlockAuthor(el) !== author) continue;
    const id = prose.readBlockId(el);
    if (id !== undefined && skip.has(id)) continue;
    scope.add(el);
    if (lastHeading !== undefined) headings.add(lastHeading);
  }
  if (scope.size === 0) return scope;
  for (const heading of headings) scope.add(heading);
  return scope;
}

/**
 * The markdown of the blocks in `scope`, in reading order.
 *
 * A BLOCK INSIDE ONE ALREADY WRITTEN OUT IS NOT WRITTEN AGAIN. The walk
 * returns a list, its items, and every list nested in them, and a list
 * serializes all of it — so each nested bullet used to come out twice, and a
 * meeting that grouped its notes was reported, and filed, as repeating them
 * (2026-09-14: a replayed meeting read 8 repeated bullets of 23 in notes that
 * held 15 bullets and no repeat).
 *
 * A LIST HOLDING ANY OUT-OF-SCOPE ITEM IS DROPPED, AND ITS SURVIVORS CARRY
 * THEIR OWN MARKERS. Only the list serializes its children with the `- ` a
 * bullet check reads — so a meeting whose notes were appended to a list
 * somebody else opened would otherwise have their bullets counted as its own
 * (the list emits every child) or its own counted as none (the items emit
 * bare lines). Dropping the container and marking what is left is the only
 * split that gives each writer its own bullets.
 */
function markdownOfScope(all: readonly Y.XmlElement[], scope: ReadonlySet<Y.XmlElement>): string {
  const addressable = new Set(all);
  const emitted = new Set<unknown>();
  const insideEmitted = (el: Y.XmlElement): boolean => {
    for (let p = el.parent; p !== null; p = p.parent) if (emitted.has(p)) return true;
    return false;
  };
  const listEmitted = (el: Y.XmlElement): boolean =>
    scope.has(el) && childBlocks(el, addressable).every((child) => scope.has(child));
  const out: string[] = [];
  for (const el of all) {
    if (!scope.has(el)) continue;
    if (insideEmitted(el)) continue;
    if (isList(el) && !listEmitted(el)) continue;
    const orphaned =
      el.nodeName === 'listItem' &&
      el.parent instanceof Y.XmlElement &&
      isList(el.parent) &&
      !listEmitted(el.parent);
    emitted.add(el);
    out.push(
      orphaned ? `- ${prose.serializeBlockToMarkdown(el)}` : prose.serializeBlockToMarkdown(el),
    );
  }
  return out.join('\n');
}

/**
 * The markdown of one section: the block `headingId` names, then every block
 * after it until a heading at that level or above.
 *
 * Empty for a heading id nothing matches — a doc that is gone, a heading a
 * person deleted, or a meeting that never opened a section at all. Empty is
 * the honest reading of every one of those: this reading found no notes, and
 * a coverage check over empty notes reports exactly that.
 *
 * KEPT, and still the OLD definition of a meeting's notes, because a report
 * that changes what it measures owes its reader both readings of the run it
 * changed on. {@link readMeetingNotes} is the one the server acts on.
 */
export function readSectionMarkdown(
  docStore: NotesDocStore,
  docId: string,
  headingId: string | undefined,
  skip: ReadonlySet<string> = new Set(),
): string {
  const all = blocksOf(docStore, docId);
  if (all === null || headingId === undefined) return '';
  return markdownOfScope(all, sectionScope(all, headingId, skip));
}

/**
 * What one reading of a meeting's notes found, and whether it can be trusted
 * as a reading at all.
 *
 * THE THIRD STATE IS THE POINT. Before it there were two answers — some
 * markdown, or the empty string — and four different situations collapsed
 * into the empty one: a document the store could not hand over, a fragment
 * that would not parse, an address that named nothing in a document full of
 * notes, and a meeting where genuinely nothing was written down. Only the
 * last is a fact about the meeting. The first three are facts about this
 * reading, and a coverage verdict computed over any of them is 100% by
 * construction — which is how one meeting's notes were reported as reaching
 * nobody seven times while the doc held 172 of them (2026-09-15).
 */
export interface MeetingNotesReading {
  /** The markdown of the blocks this reading claimed. */
  markdown: string;
  /**
   * `notes` when the reading is a fact about the meeting — either it found
   * blocks, or the document holds none for it to have missed. `unreadable`
   * when it found nothing in a document that holds blocks, which says only
   * that the address failed.
   */
  source: 'notes' | 'unreadable';
  /** What could not be reached, in words, when `source` is `unreadable`, so
   *  a reader of the report is told rather than left to infer it. */
  missing?: string;
}

/** The words an unreadable reading carries, by what went wrong. */
const NO_DOCUMENT =
  'the document could not be read at the stop — it is not in the store, or its ' +
  'prose would not parse, so nothing can be said about what this meeting wrote';
const NO_ADDRESS =
  'the document holds blocks and this reading claimed none of them — the meeting ' +
  'opened no section this reading could find, and no block still carries the ' +
  "note-taker's authorship mark, which a person's edit, a markdown round trip " +
  'and the release every recording leg does on its own start all remove';

/**
 * Everything this meeting wrote in this doc: the blocks it still holds the
 * authorship mark on, wherever they sit, plus its own section.
 *
 * The union is deliberate and each half covers the other's blind spot. The
 * marks find notes filed under somebody else's headings, which is now the
 * ordinary case; the section finds notes whose mark a person's edit or a
 * markdown round trip has taken off, which is why a doc with no marks at all
 * reads exactly as it did before whole-doc note-taking.
 *
 * BOTH HALVES CAN FAIL AT ONCE, and then the honest answer is not "no notes".
 * A meeting on a prepared document opens no section, so the section half has
 * no address to use; `releaseNotesAuthorship` drops every mark at the start
 * of every recording LEG, so a leg that composed nothing new has no marks
 * either. That pair reads exactly like a meeting nobody wrote a word in, and
 * {@link MeetingNotesReading} is what tells them apart: a document holding
 * blocks that this reading claimed none of is `unreadable`, and a document
 * holding no blocks at all is the genuine zero.
 */
export function readMeetingNotes(
  docStore: NotesDocStore,
  docId: string,
  headingId: string | undefined,
  skip: ReadonlySet<string> = new Set(),
  author: string = NOTES_AUTHOR_ID,
): MeetingNotesReading {
  const all = blocksOf(docStore, docId);
  if (all === null) return { markdown: '', source: 'unreadable', missing: NO_DOCUMENT };
  const scope = sectionScope(all, headingId, skip);
  for (const el of authoredScope(all, author, skip)) scope.add(el);
  const markdown = markdownOfScope(all, scope);
  if (markdown !== '') return { markdown, source: 'notes' };
  // A document with nothing in it is the one empty reading that is a fact
  // about the meeting: there were no blocks for this address to have missed.
  return all.length === 0
    ? { markdown: '', source: 'notes' }
    : { markdown: '', source: 'unreadable', missing: NO_ADDRESS };
}
