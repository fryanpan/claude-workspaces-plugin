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
 * So the write-back matches the live doc's top-level pieces against a fresh
 * parse of the source, block by block, in serializer space — the same keys
 * `applyMarkdownToFragment` diffs by — and for each piece that matched it
 * emits the source's own lines, along with the source's own gap to the next
 * matched block. Everything else is the serializer's output.
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

export function serializeKeepingSource(
  fragment: Y.XmlFragment,
  source: string | undefined,
  opts: MarkdownParseOptions = {},
): string {
  const parts = serializeFragmentParts(fragment);
  const plain = parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
  // CRLF would make the source's line offsets disagree with the parse's.
  if (!source || source.includes('\r') || parts.length === 0) return plain;

  const { blocks, lines, starts } = parseMarkdownSource(source, opts);
  if (blocks.length === 0 || starts.length !== blocks.length) return plain;
  const keys = sourceKeys(blocks);

  // Character offsets of each line, and of each block's first and last line.
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

  let out = '';
  let prev: number | undefined;
  for (let j = 0; j < parts.length; j++) {
    const k = pairOf.get(j);
    if (j === 0) {
      if (k === 0) out += source.slice(0, from[0]);
    } else if (k !== undefined && prev !== undefined && k === prev + 1) {
      out += source.slice(to[prev], from[k]);
    } else {
      out += '\n\n';
    }
    out += k !== undefined ? source.slice(from[k], to[k]) : parts[j];
    prev = k;
  }
  out += prev === blocks.length - 1 ? source.slice(to[prev]) : '\n';

  return normalizeMarkdown(out, opts) === plain ? out : plain;
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
