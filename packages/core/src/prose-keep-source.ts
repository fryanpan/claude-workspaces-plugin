/**
 * Serialize a prose fragment for a file that already exists, keeping the
 * author's bytes for every block the live doc did not change.
 *
 * `serializeFragmentToMarkdown` writes the serializer's normal form, which is
 * not the file's: soft-wrapped lines are joined, list markers and indents are
 * rewritten, blank lines between lists are dropped. Writing that back after an
 * edit to one paragraph rewrote the whole file, and in an `.mdx` post it
 * joined consecutive `import` lines onto one line, which no longer compiles.
 *
 * So the write-back matches the live doc's top-level pieces against the
 * source's blocks, in serializer space — the same keys
 * `applyMarkdownToFragment` diffs by — and for each piece that matched it
 * emits the source's own lines, along with the source's own gap to the next
 * matched block. Everything else is the serializer's output. A block counts as
 * touched when its content no longer serializes to what the file held, whoever
 * changed it: a browser keystroke, an agent tool and a meeting-note insert all
 * reach the same fragment.
 *
 * The result is only returned when it parses to exactly what the plain
 * serializer would have written. The source is therefore a formatting hint and
 * never a content one: a stale or mismatched source costs fidelity, not text.
 *
 * Builds on `prose-markdown.ts` and `lcs.ts`.
 */
import * as Y from 'yjs';
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';
import { getProseFragment } from './prose-fragment.ts';
import {
  normalizeMarkdown,
  parseMarkdownSource,
  serializeBlockToMarkdown,
  serializeFragmentParts,
} from './prose-markdown.ts';
import type { MarkdownParseOptions } from './prose-mdx.ts';

/**
 * A source text with its top-level blocks already located: `keys[k]` is block
 * k's serialized form and `text.slice(from[k], to[k])` its bytes.
 *
 * A write-back returns the layout of what it wrote, so the next flush of a
 * live doc — a meeting writes one every few seconds — starts from it instead
 * of parsing the whole file again. A layout that is wrong about a block can
 * only make the result fail the parse check below and fall back to the plain
 * serializer, never write different content.
 */
export interface SourceLayout {
  text: string;
  keys: string[];
  from: number[];
  to: number[];
}

export function serializeKeepingSource(
  fragment: Y.XmlFragment,
  source: string | SourceLayout | undefined,
  opts: MarkdownParseOptions = {},
): string {
  return serializeKeepingSourceLayout(fragment, source, opts).text;
}

/** `serializeKeepingSource`, returning the layout of the text it produced. */
export function serializeKeepingSourceLayout(
  fragment: Y.XmlFragment,
  source: string | SourceLayout | undefined,
  opts: MarkdownParseOptions = {},
): SourceLayout {
  const parts = serializeFragmentParts(fragment);
  const plain = parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
  const fallback = (): SourceLayout => plainLayout(parts, plain);
  const layout = typeof source === 'string' ? layoutOf(source, opts) : source;
  if (!layout || parts.length === 0) return fallback();
  const { text, keys, from, to } = layout;

  // An edit leaves most of a doc alone, so the equal runs at either end are
  // paired directly and only the middle pays for the LCS — which keeps a
  // thousands-of-blocks file inside the table budget.
  const pairOf = new Map<number, number>();
  let head = 0;
  while (head < keys.length && head < parts.length && keys[head] === parts[head]) {
    pairOf.set(head, head);
    head++;
  }
  let tail = 0;
  while (
    tail < keys.length - head &&
    tail < parts.length - head &&
    keys[keys.length - 1 - tail] === parts[parts.length - 1 - tail]
  ) {
    pairOf.set(parts.length - 1 - tail, keys.length - 1 - tail);
    tail++;
  }
  const midKeys = keys.slice(head, keys.length - tail);
  const midParts = parts.slice(head, parts.length - tail);
  if (midKeys.length * midParts.length <= LCS_CELL_BUDGET) {
    const { keptA, keptB } = lcsKept(midKeys, midParts);
    // The LCS pairs are monotonic, so the i-th kept source block matches the
    // i-th kept part.
    const kA = [...keptA].sort((a, b) => a - b);
    const kB = [...keptB].sort((a, b) => a - b);
    for (let i = 0; i < kB.length; i++) pairOf.set(head + kB[i]!, head + kA[i]!);
  }

  // A block the edit changed is still the same block when it is the only
  // change between two kept neighbours and both sides are lists of one kind:
  // a note appended to a hand-written list, a word changed in one bullet. Its
  // items are matched the same way the blocks were, so only the items that
  // changed are re-serialized. Without this, one new meeting note rewrote the
  // markers and indents of every bullet already in its list.
  const merged = new Map<number, string>();
  for (let j = 0; j < parts.length; j++) {
    if (pairOf.has(j)) continue;
    if (j > 0 && !pairOf.has(j - 1)) continue;
    if (j + 1 < parts.length && !pairOf.has(j + 1)) continue;
    const k = j === 0 ? 0 : pairOf.get(j - 1)! + 1;
    const nextK = j + 1 < parts.length ? pairOf.get(j + 1)! : keys.length;
    if (nextK !== k + 1 || k >= keys.length) continue;
    const list = mergeListItems(text.slice(from[k], to[k]), keys[k]!, parts[j]!);
    if (list !== undefined) {
      pairOf.set(j, k);
      merged.set(j, list);
    }
  }

  let out = '';
  const outFrom: number[] = [];
  const outTo: number[] = [];
  let prev: number | undefined;
  for (let j = 0; j < parts.length; j++) {
    const k = pairOf.get(j);
    if (j === 0) {
      if (k === 0) out += text.slice(0, from[0]);
    } else if (k !== undefined && prev !== undefined && k === prev + 1) {
      out += text.slice(to[prev], from[k]);
    } else {
      out += '\n\n';
    }
    outFrom.push(out.length);
    out += merged.get(j) ?? (k !== undefined ? text.slice(from[k], to[k]) : parts[j]);
    outTo.push(out.length);
    prev = k;
  }
  out += prev === keys.length - 1 ? text.slice(to[prev]) : '\n';

  if (normalizeMarkdown(out, opts) !== plain) return fallback();
  return { text: out, keys: parts, from: outFrom, to: outTo };
}

const LIST_PART = /^(?:- |\d+\. )/;
const ORDERED_PART = /^\d+\. /;
const ITEM_LINE = /^( *)([-*]|\d+\.)\s/;

/**
 * One list block, rewritten item by item: the source's bytes for every
 * top-level item whose content is unchanged, the serializer's for the rest.
 * A new item takes the source list's bullet character and indent, so the list
 * a CommonMark renderer sees is still one list. `undefined` when the two are
 * not lists of the same kind.
 */
function mergeListItems(source: string, sourceKey: string, part: string): string | undefined {
  if (!LIST_PART.test(sourceKey) || !LIST_PART.test(part)) return undefined;
  if (ORDERED_PART.test(sourceKey) !== ORDERED_PART.test(part)) return undefined;
  const first = ITEM_LINE.exec(source);
  if (!first) return undefined;
  const base = first[1]!.length;
  const bullet = first[2]!;

  const src = splitItems(source, (line) => {
    const m = ITEM_LINE.exec(line);
    return m !== null && m[1]!.length === base;
  });
  const live = splitItems(part, (line) => LIST_PART.test(line));
  const dedent = (item: string) =>
    item
      .split('\n')
      .map((l) => (l.startsWith(' '.repeat(base)) ? l.slice(base) : l))
      .join('\n');
  const itemKey = (item: string) => normalizeMarkdown(item).replace(/\n$/, '');
  const srcKeys = src.items.map((it) => itemKey(dedent(source.slice(it.from, it.to))));
  const liveKeys = live.items.map((it) => itemKey(part.slice(it.from, it.to)));
  if (srcKeys.length * liveKeys.length > LCS_CELL_BUDGET) return undefined;
  const { keptA, keptB } = lcsKept(srcKeys, liveKeys);
  const kA = [...keptA].sort((a, b) => a - b);
  const kB = [...keptB].sort((a, b) => a - b);
  const pair = new Map<number, number>();
  for (let i = 0; i < kB.length; i++) pair.set(kB[i]!, kA[i]!);
  // An item edited in place sits where its old self did, so it keeps the old
  // one's gaps even though its bytes are new: between two matches, a run of
  // changed items as long as the run it replaced is paired by position.
  const slot = new Map(pair);
  for (let i = 0, lastK = -1; i <= live.items.length; i++) {
    if (i < live.items.length && !pair.has(i)) continue;
    const nextK = i < live.items.length ? pair.get(i)! : src.items.length;
    let runStart = i - 1;
    while (runStart >= 0 && !pair.has(runStart)) runStart--;
    const runLength = i - runStart - 1;
    if (runLength > 0 && runLength === nextK - lastK - 1) {
      for (let r = 1; r <= runLength; r++) slot.set(runStart + r, lastK + r);
    }
    lastK = nextK;
  }

  const firstGap = src.items.length > 1 ? source.slice(src.items[0]!.to, src.items[1]!.from) : '\n';
  const pad = ' '.repeat(base);
  let out = '';
  let prev: number | undefined;
  for (let i = 0; i < live.items.length; i++) {
    const k = pair.get(i);
    const at = slot.get(i);
    if (i > 0) {
      out +=
        at !== undefined && prev !== undefined && at === prev + 1
          ? source.slice(src.items[prev]!.to, src.items[at]!.from)
          : firstGap;
    }
    if (k !== undefined) {
      out += source.slice(src.items[k]!.from, src.items[k]!.to);
    } else {
      const item = part.slice(live.items[i]!.from, live.items[i]!.to);
      const marked = bullet === '-' || bullet === '*' ? item.replace(/^- /, `${bullet} `) : item;
      out += marked
        .split('\n')
        .map((l) => (l.length > 0 ? pad + l : l))
        .join('\n');
    }
    prev = at;
  }
  return out;
}

/** The top-level items of a list's text, each without its trailing blank
 *  lines. */
function splitItems(
  text: string,
  startsItem: (line: string) => boolean,
): { items: { from: number; to: number }[] } {
  const items: { from: number; to: number }[] = [];
  let at = 0;
  let lastNonBlankEnd = 0;
  for (const line of text.split('\n')) {
    if (startsItem(line)) {
      if (items.length > 0) items[items.length - 1]!.to = lastNonBlankEnd;
      items.push({ from: at, to: at + line.length });
    }
    if (line.trim() !== '') lastNonBlankEnd = at + line.length;
    at += line.length + 1;
  }
  if (items.length > 0) items[items.length - 1]!.to = lastNonBlankEnd;
  return { items };
}

/** Locate the top-level blocks of `text` with a fresh parse. */
function layoutOf(text: string, opts: MarkdownParseOptions): SourceLayout | undefined {
  // CRLF would make the source's line offsets disagree with the parse's.
  if (text.length === 0 || text.includes('\r')) return undefined;
  const { blocks, lines, starts } = parseMarkdownSource(text, opts);
  if (blocks.length === 0 || starts.length !== blocks.length) return undefined;

  const lineStart: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStart.push(at);
    at += line.length + 1;
  }
  const from: number[] = [];
  const to: number[] = [];
  for (let k = 0; k < blocks.length; k++) {
    let last = (k + 1 < starts.length ? starts[k + 1]! : lines.length) - 1;
    while (last > starts[k]! && (lines[last] ?? '').trim() === '') last--;
    from.push(lineStart[starts[k]!]!);
    to.push(lineStart[last]! + (lines[last] ?? '').length);
  }
  return { text, keys: sourceKeys(blocks), from, to };
}

/** The layout of the plain serializer's own output: its parts, a blank line
 *  apart. */
function plainLayout(parts: string[], plain: string): SourceLayout {
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const part of parts) {
    from.push(at);
    to.push(at + part.length);
    at += part.length + 2;
  }
  return { text: plain, keys: parts, from, to };
}

/** Serializer-space keys for freshly parsed blocks. A prelim block cannot be
 *  read, so they are integrated into a throwaway doc first. A block that
 *  writes nothing gets a key no part can equal. */
function sourceKeys(blocks: Y.XmlElement[]): string[] {
  const scratch = new Y.Doc();
  try {
    const fragment = getProseFragment(scratch);
    fragment.push(blocks);
    return (fragment.toArray() as Y.XmlElement[]).map(
      (b, k) => serializeBlockToMarkdown(b) || `\0empty-${k}`,
    );
  } finally {
    scratch.destroy();
  }
}
