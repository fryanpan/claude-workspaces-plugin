import { LCS_CELL_BUDGET, diffWords, lcsKept } from '@claude-workspaces/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { type SegmentMarkup, segmentMarkup } from './segment-markup.ts';

/**
 * Item-level markup for a list that changed.
 *
 * The redline treats a whole list as one block, so one edited bullet makes
 * the list a 'changed' block and the word diff runs over every bullet. Its
 * segments are then found in the list's rendered text by searching for
 * their words, and one word the search cannot find (inline code followed by
 * a comma, a link target) leaves the search behind, so the next insertion's
 * first word matches in an earlier, unchanged bullet and marks it. Here the
 * old and new lists are compared item by item instead: an unchanged item is
 * left alone, a new item is marked whole, an edited item is word-diffed
 * against its own text only, and a removed item becomes a deletion at the
 * item that now follows it.
 */

const ITEM_START = /^([-*+]|\d+[.)])\s+/;

/** A list's top-level items, each with its nested lines. Null when the list
 *  does not start with an item at column 0. */
function listItems(md: string): string[] | null {
  const items: string[] = [];
  for (const line of md.split('\n')) {
    if (ITEM_START.test(line)) items.push(line);
    else if (items.length === 0) return null;
    else items[items.length - 1] += `\n${line}`;
  }
  return items.map((item) => item.replace(/\n+$/, ''));
}

/** An item without its marker, so renumbering an ordered list is no change. */
const body = (item: string): string => item.replace(ITEM_START, '');

interface PmItem {
  node: ProseNode;
  pos: number;
  /** Inside the item's first textblock: where a deletion before it anchors. */
  anchor: number;
}

/** Position just inside the first or last textblock under `node`. */
function textblockEdge(node: ProseNode, pos: number, edge: 'start' | 'end'): number | null {
  let found: number | null = null;
  node.descendants((child, rel) => {
    if (edge === 'start' && found != null) return false;
    if (!child.isTextblock) return true;
    const at = pos + 1 + rel;
    found = edge === 'start' ? at + 1 : at + child.nodeSize - 1;
    return false;
  });
  return found;
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * Markup for `list` (the live node at `listPos`, serialized as `newMd`)
 * against the base list `baseMd`. Null when the live node and its markdown
 * disagree on the item count, so the caller keeps its whole-list word diff
 * rather than mark the wrong items.
 */
export function listMarkup(
  baseMd: string,
  newMd: string,
  list: ProseNode,
  listPos: number,
): SegmentMarkup | null {
  if (!LIST_TYPES.has(list.type.name)) return null;
  const baseItems = listItems(baseMd);
  const newItems = listItems(newMd);
  if (!baseItems || !newItems || newItems.length !== list.childCount) return null;
  if (baseItems.length * newItems.length > LCS_CELL_BUDGET) return null;

  const items: PmItem[] = [];
  list.forEach((node, off) => {
    const pos = listPos + 1 + off;
    items.push({ node, pos, anchor: textblockEdge(node, pos, 'start') ?? pos + 1 });
  });
  const listEnd = textblockEdge(list, listPos, 'end') ?? listPos + 1;

  const { keptA, keptB } = lcsKept(baseItems.map(body), newItems.map(body));
  const out: SegmentMarkup = { insRanges: [], deletions: [] };
  const markItem = (item: PmItem) => {
    const from = item.pos + 1;
    const to = item.pos + item.node.nodeSize - 1;
    if (to > from) out.insRanges.push({ from, to });
  };

  let i = 0;
  let j = 0;
  while (i < baseItems.length || j < newItems.length) {
    if (keptA.has(i) && keptB.has(j)) {
      i++;
      j++;
      continue;
    }
    const gapA: number[] = [];
    const gapB: number[] = [];
    while (i < baseItems.length && !keptA.has(i)) gapA.push(i++);
    while (j < newItems.length && !keptB.has(j)) gapB.push(j++);
    if (gapA.length === 0 && gapB.length === 0) break;
    // The item the gap's deletions sit before: the next live item, or the end.
    const anchor = items[j]?.anchor ?? listEnd;
    for (let k = 0; k < Math.max(gapA.length, gapB.length); k++) {
      const a = gapA[k];
      const b = gapB[k];
      const old = a == null ? undefined : baseItems[a];
      const item = b == null ? undefined : items[b];
      if (!item) {
        if (old != null) out.deletions.push({ pos: anchor, deletedMarkdown: old });
        continue;
      }
      const segments = old == null ? [] : diffWords(body(old), body(newItems[b] ?? ''));
      // Nothing in common: one item removed and an unrelated one added.
      if (!segments.some((s) => s.kind === 'same' && s.text.trim() !== '')) {
        if (old != null) out.deletions.push({ pos: item.anchor, deletedMarkdown: old });
        markItem(item);
        continue;
      }
      const edit = segmentMarkup(item.node, item.pos, segments);
      out.insRanges.push(...edit.insRanges);
      out.deletions.push(...edit.deletions);
    }
  }
  return out;
}
