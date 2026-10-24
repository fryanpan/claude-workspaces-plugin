/**
 * The writer under `applyBlockEdits` (`prose-batch.ts`): turn markdown into
 * elements at a position in the doc, and nothing else.
 *
 * Nothing here knows about edits, ops, outcomes or who owns a block. The
 * batch decides WHAT to write and whether it is a direct edit or a proposal;
 * these functions decide how the words become elements — a list grown rather
 * than twinned, one bullet rewritten as several, a rewritten block keeping
 * its address. They return the elements written, or the reason they wrote
 * nothing.
 */
import * as Y from 'yjs';
import { insertionIndexBeforeBlanks } from './prose-batch-structure.ts';
import { precedingBlock } from './prose-fragment.ts';
import { BLOCK_ID_ATTR, readBlockId } from './prose-identity.ts';
import { parseMarkdownBlocks } from './prose-markdown.ts';
import type { MarkdownParseOptions } from './prose-mdx.ts';

/** A markdown list line, e.g. `- point` or `2. point`. */
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

interface LeadingList {
  ordered: boolean;
  /** Inner markdown of each item, marker stripped and de-indented. */
  items: string[];
  /** Whatever followed the run of items. */
  rest: string;
}

/**
 * Split a leading run of top-level list items off the front of `markdown`.
 *
 * Deliberately a line reader rather than a round trip through the block
 * parser: a parsed-but-unintegrated `Y.XmlElement` exposes neither its
 * children nor its attributes, so there is no way to take items back out of
 * a list the parser built. Reading the lines and building the items here is
 * the only route to putting them inside a list that already exists.
 */
export function splitLeadingListItems(markdown: string): LeadingList | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const first = lines[0]?.match(LIST_LINE);
  if (!first || (first[1] ?? '').length > 0) return null;
  const ordered = /^\d/.test(first[2] ?? '');
  const items: string[] = [];
  let current: string[] | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(LIST_LINE);
    const indent = (m?.[1] ?? '').length;
    if (m && indent === 0) {
      // A switch of list type ends the run — the caller's `rest` picks it up.
      if (/^\d/.test(m[2] ?? '') !== ordered) break;
      if (current) items.push(current.join('\n'));
      current = [m[3] ?? ''];
      continue;
    }
    if (current === null) break;
    if (line.trim() === '') {
      // A blank line inside the run is only a continuation if more indented
      // content follows; otherwise the list has ended.
      const next = lines[i + 1] ?? '';
      if (next.trim() !== '' && /^\s/.test(next)) {
        current.push('');
        continue;
      }
      break;
    }
    if (!/^\s/.test(line)) break;
    current.push(line.replace(/^ {1,4}|^\t/, ''));
  }
  if (current) items.push(current.join('\n'));
  if (items.length === 0) return null;
  return { ordered, items, rest: lines.slice(i).join('\n').trim() };
}

/** Build a `listItem` element from one item's inner markdown. */
function buildListItem(inner: string): Y.XmlElement | null {
  const children = parseMarkdownBlocks(inner.trim().length > 0 ? inner : ' ');
  if (children.length === 0) return null;
  const li = new Y.XmlElement('listItem');
  li.insert(0, children);
  return li;
}

export function isList(el: Y.XmlElement | Y.XmlText | undefined): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * Insert `markdown` into `parent` at `index`, growing a neighbouring list of
 * the same type instead of creating a second one. Returns the elements it
 * created, in document order.
 */
export function insertBlocksMerging(
  parent: Y.XmlFragment | Y.XmlElement,
  index: number,
  markdown: string,
  parse: MarkdownParseOptions = {},
): Y.XmlElement[] {
  const created: Y.XmlElement[] = [];
  const siblings = parent.toArray() as (Y.XmlElement | Y.XmlText)[];
  const leading = splitLeadingListItems(markdown);
  let rest = markdown;
  // In front of the editor's trailing blank line, never behind it
  // (`prose-batch-structure.ts`).
  let at = insertionIndexBeforeBlanks(siblings, index);
  if (leading) {
    // Grow the list ENDING AT the insertion point rather than splicing a
    // second one after it: appending keeps the new points in the order they
    // were said. A mirror branch that prepended into a list AFTER the point
    // was deleted rather than fixed — nothing ever reached it (callers insert
    // at a section end or the fragment end) and it inverted the markdown.
    const wanted = leading.ordered ? 'orderedList' : 'bulletList';
    // `precedingBlock`, not `siblings[index - 1]`: it steps back over the
    // browser's trailing paragraph, which made every note open its own list.
    const before = precedingBlock(siblings, index);
    const host = isList(before) && before.nodeName === wanted ? before : null;
    if (host) {
      const items = leading.items
        .map(buildListItem)
        .filter((li): li is Y.XmlElement => li !== null);
      if (items.length > 0) {
        host.insert(host.length, items);
        created.push(...items);
      }
      // Whatever the markdown put after its items goes after them here too —
      // in FRONT of the paragraph stepped over, or a note's own detail
      // paragraph would land past it with the gap back in between.
      at = siblings.indexOf(host) + 1;
      rest = leading.rest;
    }
  }
  if (rest.trim().length === 0) return created;
  const blocks = parseMarkdownBlocks(rest, parse);
  if (blocks.length === 0) return created;
  created.push(...insertParsed(parent, at, blocks));
  return created;
}

/** Insert parsed `blocks` into `parent` at `at`; return the elements written. */
export function insertParsed(
  parent: Y.XmlFragment | Y.XmlElement,
  at: number,
  blocks: Y.XmlElement[],
): Y.XmlElement[] {
  parent.insert(at, blocks);
  // Reading the freshly inserted elements is safe — they are integrated now.
  return (parent.toArray() as (Y.XmlElement | Y.XmlText)[])
    .slice(at, at + blocks.length)
    .filter((el): el is Y.XmlElement => el instanceof Y.XmlElement);
}

/**
 * Put `markdown` immediately after the list `holder` — the home for the tail
 * a multi-item `replace_block` left over. A no-op when `holder` is not a list
 * or has left the doc: losing the tail is bad, but writing it into the middle
 * of somebody's list would be worse.
 */
function insertAfterList(
  fragment: Y.XmlFragment,
  holder: Y.XmlFragment | Y.XmlElement,
  markdown: string,
): Y.XmlElement[] {
  if (!(holder instanceof Y.XmlElement) || !isList(holder)) return [];
  const grand = (holder.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const at = (grand.toArray() as unknown[]).indexOf(holder) + 1;
  if (at <= 0) return [];
  const blocks = parseMarkdownBlocks(markdown);
  return blocks.length === 0 ? [] : insertParsed(grand, at, blocks);
}

/**
 * Build `markdown` into the doc at `el`: in its place (`'replace'`, a direct
 * edit) or straight after it (`'after'`, where a proposal offers it, so the
 * struck words read first). Returns every element written.
 *
 * ONE BULLET MAY BECOME SEVERAL. The prompt lets a `replace_block` carry
 * multi-line markdown — regrouping a topic replaces one flat bullet with a
 * lead bullet and its sub-points — so the marker stripping has to be a
 * per-line read, not a single-line regex. `LIST_LINE` has no `m` flag, so it
 * matched nothing on a multi-line string and the `- ` markers survived into
 * the item's text: an empty bullet with the whole replacement nested under
 * it, reported as `applied`.
 *
 * AND THE BLOCK KEEPS ITS ADDRESS. Yjs has no in-place rewrite, so a replace
 * is a delete and an insert — which used to mean the rewritten block came
 * back with a NEW id, and every edit that still named the old one was
 * answered `unknown-block`. Inside a single batch that is the caller's own
 * earlier edit invalidating its later ones: edits resolve against the doc as
 * the ones before them left it, so "correct this bullet, then nest these
 * under it", "rename this heading, then insert under it" and "rewrite this
 * bullet, then rewrite it again" all lost their second half, on blocks that
 * were demonstrably on the page when the batch was composed. The words a
 * note-taker could not put back are the ones this cost
 * (`packages/server/src/notes-edit-address.ts` measured the recovery).
 *
 * So the FIRST element written in `'replace'` mode inherits the replaced
 * block's id. One block is replaced by one address — a replacement that
 * parses to several blocks gives the extras ids of their own at
 * `mintMissingIds`, so no two blocks ever share one. `'after'` mode copies
 * nothing: the original is still in the doc there, and a proposal offered
 * beside it must never wear its address. This is the same law `prose-nest.ts`
 * already holds a MOVE to — "it keeps its block id, so an edit that named it
 * a tick ago still names it" — extended to a rewrite.
 */
export function writeReplacement(
  fragment: Y.XmlFragment,
  el: Y.XmlElement,
  markdown: string,
  mode: 'replace' | 'after',
  parse: MarkdownParseOptions = {},
): Y.XmlElement[] | 'unknown-block' | 'parse-failed' {
  const parent = (el.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const idx = (parent.toArray() as unknown[]).indexOf(el);
  if (idx < 0) return 'unknown-block';
  const at = mode === 'replace' ? idx : idx + 1;
  // READ BEFORE THE DELETE, and only for a replace: the attribute has to come
  // off the element while it is still integrated.
  const keepId = mode === 'replace' ? readBlockId(el) : undefined;
  if (el.nodeName === 'listItem') {
    const split = splitLeadingListItems(markdown);
    const items = (split ? split.items : [markdown.replace(LIST_LINE, '$3')])
      .map(buildListItem)
      .filter((made): made is Y.XmlElement => made !== null);
    if (items.length === 0) return 'parse-failed';
    if (mode === 'replace') parent.delete(idx, 1);
    const created = insertParsed(parent, at, items);
    inheritBlockId(created, keepId);
    // Whatever followed the run of items is still the caller's words, and a
    // paragraph cannot live between two list items — it goes after the list.
    if (split && split.rest.trim().length > 0) {
      created.push(...insertAfterList(fragment, parent, split.rest));
    }
    return created;
  }
  const blocks = parseMarkdownBlocks(markdown, parse);
  if (blocks.length === 0) return 'parse-failed';
  if (mode === 'replace') parent.delete(idx, 1);
  const written = insertParsed(parent, at, blocks);
  inheritBlockId(written, keepId);
  return written;
}

/** Give the first block written by an in-place rewrite the address the block
 *  it replaced was known by. A no-op when there is nothing to inherit. */
function inheritBlockId(written: readonly Y.XmlElement[], keepId: string | undefined): void {
  const first = written[0];
  if (keepId === undefined || first === undefined) return;
  first.setAttribute(BLOCK_ID_ATTR, keepId);
}
