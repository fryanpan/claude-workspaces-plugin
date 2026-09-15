/**
 * What an applied block edit must leave standing AROUND itself — the parts of
 * `applyBlockEdits` that are about the doc's structure rather than about the
 * edit's own words.
 *
 * Three rules, each from the same live meeting (2026-09-14):
 *
 * - **A replaced bullet hands its nested notes to its replacement.** A list
 *   item holds its sub-list, so deleting the item to write the new one
 *   deleted every note grouped under it. The note-taker rewrites a lead
 *   bullet as a matter of course (a question sharpened, a topic renamed), and
 *   one such rewrite took three notes with it, the meeting's main point among
 *   them, with the outcome reported `applied`.
 * - **An insert goes in front of the editor's trailing blank line.** Tiptap's
 *   TrailingNode keeps an empty paragraph after the last block. An insert at
 *   the section end landed after it, stranding it mid-section, and the
 *   editor then added another: one blank line above every heading the
 *   note-taker opened, eight in one short meeting.
 * - **A block with no words applies directly, whoever owns it.** Authorship
 *   decides direct-vs-proposal to protect somebody's words, and a blank block
 *   has none. A proposal is a strike-through on text, so on a blank block it
 *   could only answer `no-range`, and an agent had no way to remove one.
 */
import * as Y from 'yjs';
import { isUnclaimedBlankParagraph } from './prose-fragment.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from './suggest.ts';

/** Elements that are structure only: a blank one of these holds no content. */
const STRUCTURAL = new Set([
  'paragraph',
  'heading',
  'listItem',
  'bulletList',
  'orderedList',
  'blockquote',
]);

/**
 * Whether `el` holds nothing a person could lose: every text run under it is
 * blank and carries no suggestion mark, and nothing under it is an image, a
 * rule, a table or any other element that is content without being text.
 */
export function holdsNoWords(el: Y.XmlElement): boolean {
  if (!STRUCTURAL.has(el.nodeName)) return false;
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{
        insert?: unknown;
        attributes?: Record<string, unknown>;
      }>) {
        if (typeof op.insert !== 'string') return false;
        if (op.insert.trim().length > 0) return false;
        const marks = op.attributes ?? {};
        if (marks[SUGGEST_INSERT_MARK] != null || marks[SUGGEST_DELETE_MARK] != null) return false;
      }
      continue;
    }
    // A line break is not a word. A paragraph holding only breaks outlines as
    // blank text and serializes to nothing, so a reader sees an empty line
    // whose id refused both edits with `no-range`.
    if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak' && child.length === 0) {
      continue;
    }
    if (!(child instanceof Y.XmlElement) || !holdsNoWords(child)) return false;
  }
  return true;
}

/**
 * Where an insert at `index` should really go: in front of any run of blank,
 * unclaimed paragraphs that ends there. A paragraph somebody left blank
 * between two blocks is not in front of `index` unless nothing but blanks
 * follows it up to the insertion point, so it keeps its place.
 */
export function insertionIndexBeforeBlanks(
  siblings: readonly (Y.XmlElement | Y.XmlText)[],
  index: number,
): number {
  let at = index;
  while (at > 0 && isUnclaimedBlankParagraph(siblings[at - 1])) at--;
  return at;
}

/** The nested notes a list item carries, copied out before it is replaced. */
export interface NestedNotes {
  lists: Array<{ nodeName: string; items: Y.XmlElement[]; texts: string[] }>;
}

/** A list item's own words — its paragraphs, not its sub-lists — normalised
 *  so a note restated with different casing or punctuation reads as the same
 *  note. */
function ownText(item: Y.XmlElement): string {
  return item
    .toArray()
    .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === 'paragraph')
    .flatMap((p) => p.toArray().map((t) => (t instanceof Y.XmlText ? t.toString() : '')))
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isList(el: unknown): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * Copy the sub-lists out of a list item that is about to be deleted.
 *
 * CLONED BEFORE THE DELETE, because a deleted Yjs type gives up its content.
 * A clone carries each item's attributes, so the notes keep their block ids
 * and their authors: a person's bullet nested under the note-taker's lead is
 * still a person's afterwards.
 */
export function takeNestedNotes(item: Y.XmlElement): NestedNotes {
  if (item.nodeName !== 'listItem') return { lists: [] };
  const lists: NestedNotes['lists'] = [];
  for (const child of item.toArray()) {
    if (!isList(child)) continue;
    const items = child
      .toArray()
      .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === 'listItem');
    if (items.length === 0) continue;
    lists.push({
      nodeName: child.nodeName,
      items: items.map((i) => i.clone()),
      texts: items.map(ownText),
    });
  }
  return { lists };
}

/** Every list item anywhere under `els`, by its own words; the first wins. */
function itemsByText(els: readonly Y.XmlElement[]): Map<string, Y.XmlElement> {
  const out = new Map<string, Y.XmlElement>();
  const visit = (el: Y.XmlElement): void => {
    if (el.nodeName === 'listItem' && !out.has(ownText(el))) out.set(ownText(el), el);
    for (const child of el.toArray()) if (child instanceof Y.XmlElement) visit(child);
  };
  for (const el of els) visit(el);
  return out;
}

/**
 * Put the notes `takeNestedNotes` saved under the first list item the
 * replacement wrote. A note the replacement already restates is not put back
 * a second time: the saved item takes its restatement's place instead, so the
 * block id, the author and whatever is keyed on them survive. When the
 * restatement is the lead itself, or carries notes of its own, it stays and
 * the saved copy goes. When the replacement wrote no list item there is
 * nowhere a sub-list can live, and the notes go back as a list right after it.
 *
 * Call AFTER claiming the replacement for its author: claiming walks the
 * subtree, and these notes keep the authors they already had.
 */
export function restoreNestedNotes(
  fragment: Y.XmlFragment,
  written: readonly Y.XmlElement[],
  saved: NestedNotes,
): void {
  if (saved.lists.length === 0) return;
  const restated = itemsByText(written);
  const target = written.find((el) => el.nodeName === 'listItem');
  for (const list of saved.lists) {
    const keep = list.items.filter((item, i) => {
      const twin = restated.get(list.texts[i] ?? '');
      if (twin === undefined) return true;
      restated.delete(list.texts[i] ?? '');
      const parent = twin.parent;
      if (twin !== target && !written.includes(twin) && parent instanceof Y.XmlElement) {
        if (!twin.toArray().some(isList)) {
          const at = parent.toArray().indexOf(twin);
          parent.delete(at, 1);
          parent.insert(at, [item]);
        }
      }
      return false;
    });
    if (keep.length === 0) continue;
    if (target) {
      const existing = target
        .toArray()
        .find((c): c is Y.XmlElement => isList(c) && c.nodeName === list.nodeName);
      if (existing) {
        existing.insert(existing.length, keep);
        continue;
      }
      const made = new Y.XmlElement(list.nodeName);
      target.insert(target.length, [made]);
      made.insert(0, keep);
      continue;
    }
    const last = written[written.length - 1];
    const parent = (last?.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
    const at = last ? (parent.toArray() as unknown[]).indexOf(last) + 1 : parent.length;
    const made = new Y.XmlElement(list.nodeName);
    parent.insert(Math.max(0, at), [made]);
    made.insert(0, keep);
  }
}
