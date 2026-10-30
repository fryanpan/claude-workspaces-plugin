import type { RedlineSegment } from '@claude-workspaces/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

/**
 * Word-diff segments mapped onto one node of the live doc.
 *
 * A segment carries markdown; the node holds rendered text. Each segment's
 * words are found in the node's flattened text in order, so a cursor walks
 * the node as the segments do. The search is confined to `node`: a caller
 * that can narrow the node (one list item rather than the whole list) keeps
 * a lost cursor from marking text in a neighbour.
 */

export interface SegmentMarkup {
  insRanges: Array<{ from: number; to: number }>;
  deletions: Array<{ pos: number; deletedMarkdown: string }>;
}

/** Flattened text of a node with a per-character PM position index. */
interface FlatIndex {
  text: string;
  pos: number[];
}

function flatIndex(block: ProseNode, blockPos: number): FlatIndex {
  let text = '';
  const pos: number[] = [];
  block.descendants((child, rel) => {
    if (child.isText && child.text) {
      const abs = blockPos + 1 + rel;
      for (let k = 0; k < child.text.length; k++) {
        text += child.text[k];
        pos.push(abs + k);
      }
      return true;
    }
    // Separate nested textblocks (list items, table cells) so a token can't
    // falsely match across a boundary.
    if (child.isTextblock && text.length > 0 && !text.endsWith(' ')) {
      text += ' ';
      pos.push(blockPos + 1 + rel);
    }
    return true;
  });
  return { text, pos };
}

/** Strip markdown syntax a serialized token carries but the rendered text
 *  doesn't (emphasis, code ticks, list bullets, heading hashes, links). */
function cleanToken(token: string): string {
  const stripped = token
    // A link's target is never rendered: `text](https://…)` renders `text`.
    .replace(/\]\(.*$/, '')
    .replace(/^[#>*_`~[\]()!-]+/, '')
    // Punctuation after closing syntax: "`keys.log`," renders "keys.log,".
    .replace(/[*_`~[\]()]+([.,;:!?]*)$/, '$1');
  // Ordered-list numbering ("1.") exists only in the markdown source.
  if (/^\d+\.$/.test(stripped)) return '';
  return stripped;
}

/** Locate a diff segment's words in the flat text, at/after `from`. Returns
 *  the covered [start, end) char range, or null when nothing matched. */
function matchTokens(
  flat: string,
  from: number,
  segText: string,
): { start: number; end: number } | null {
  const tokens = (segText.match(/\S+/g) ?? []).map(cleanToken).filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const start = flat.indexOf(tokens[0], from);
  if (start === -1) return null;
  let end = start + tokens[0].length;
  for (let i = 1; i < tokens.length; i++) {
    const idx = flat.indexOf(tokens[i], end);
    if (idx === -1) break; // partial match — cover what we found
    end = idx + tokens[i].length;
  }
  return { start, end };
}

/** Markup for `segments` (a word diff whose new side is `node`, at `pos`). */
export function segmentMarkup(
  node: ProseNode,
  pos: number,
  segments: RedlineSegment[],
): SegmentMarkup {
  const out: SegmentMarkup = { insRanges: [], deletions: [] };
  const flat = flatIndex(node, pos);
  let cursor = 0;
  for (const seg of segments) {
    if (seg.kind === 'del') {
      out.deletions.push({
        pos: flat.pos[Math.min(cursor, flat.pos.length - 1)] ?? pos + 1,
        deletedMarkdown: seg.text,
      });
      continue;
    }
    const m = matchTokens(flat.text, cursor, seg.text);
    if (!m) continue; // syntax-only segment (e.g. bare `**`) — nothing rendered to mark
    if (seg.kind === 'ins') {
      const from = flat.pos[m.start];
      const last = flat.pos[m.end - 1];
      if (from != null && last != null) out.insRanges.push({ from, to: last + 1 });
    }
    cursor = m.end;
  }
  return out;
}
