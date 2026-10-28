import { LCS_CELL_BUDGET, lcsKept } from '@claude-workspaces/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

/**
 * Row- and cell-level markup for a pipe table that changed.
 *
 * The redline never word-diffs two tables (`pairable` in core/redline.ts):
 * across pipes and padding a word diff is noise. Left there, one appended row
 * shows the whole table as deleted and re-added, so the reader sees every
 * row marked and cannot tell which one is new. Here the old and new tables
 * are compared row by row instead: a new row is marked whole, a row that
 * kept its shape is compared cell by cell, and a removed row becomes a
 * deletion at the row that now follows it.
 */

export interface TableMarkup {
  insRanges: Array<{ from: number; to: number }>;
  deletions: Array<{ pos: number; deletedMarkdown: string }>;
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** The rows of a serialized pipe table, header first, delimiter row dropped. */
function tableRows(md: string): string[] {
  return md
    .split('\n')
    .filter((line, i) => line.trim() !== '' && !(i === 1 && DELIMITER_ROW.test(line.trim())));
}

/** A row's cell texts, trimmed. Escaped pipes (`\|`) stay inside their cell. */
function rowCells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

interface PmRow {
  /** Inside the row's first cell paragraph: where a deletion before this row
   *  anchors. A position between rows would put the margin's chip widget
   *  inside the table body, where a browser lays it out as a stray cell. */
  pos: number;
  /** [from, to) of each cell's content. */
  cells: Array<{ from: number; to: number }>;
}

function pmRows(table: ProseNode, tablePos: number): PmRow[] {
  const rows: PmRow[] = [];
  table.forEach((row, rowOff) => {
    const rowPos = tablePos + 1 + rowOff;
    const cells: PmRow['cells'] = [];
    row.forEach((cell, cellOff) => {
      const cellPos = rowPos + 1 + cellOff;
      cells.push({ from: cellPos + 1, to: cellPos + cell.nodeSize - 1 });
    });
    rows.push({ pos: (cells[0]?.from ?? rowPos) + 1, cells });
  });
  return rows;
}

/**
 * Markup for `table` (the live node at `tablePos`, serialized as `newMd`)
 * against the base table `baseMd`. Null when the live node and its markdown
 * disagree on the row or cell count, so the caller keeps its whole-block
 * markup rather than mark the wrong cells.
 */
export function tableMarkup(
  baseMd: string,
  newMd: string,
  table: ProseNode,
  tablePos: number,
): TableMarkup | null {
  if (table.type.name !== 'table') return null;
  const baseRows = tableRows(baseMd);
  const newRows = tableRows(newMd);
  const rows = pmRows(table, tablePos);
  if (rows.length !== newRows.length) return null;
  const newCells = newRows.map(rowCells);
  if (newCells.some((cells, i) => cells.length !== rows[i]?.cells.length)) return null;
  if (baseRows.length * newRows.length > LCS_CELL_BUDGET) return null;
  const baseCells = baseRows.map(rowCells);

  const key = (cells: string[]) => cells.join('\u0000');
  const { keptA, keptB } = lcsKept(baseCells.map(key), newCells.map(key));

  const out: TableMarkup = { insRanges: [], deletions: [] };
  const lastCell = rows[rows.length - 1]?.cells.at(-1);
  const tableEnd = lastCell ? lastCell.to - 1 : tablePos + 1;
  const markRow = (row: PmRow) => {
    for (const c of row.cells) if (c.to > c.from) out.insRanges.push(c);
  };

  let i = 0;
  let j = 0;
  while (i < baseRows.length || j < newRows.length) {
    if (keptA.has(i) && keptB.has(j)) {
      i++;
      j++;
      continue;
    }
    const gapA: number[] = [];
    const gapB: number[] = [];
    while (i < baseRows.length && !keptA.has(i)) gapA.push(i++);
    while (j < newRows.length && !keptB.has(j)) gapB.push(j++);
    if (gapA.length === 0 && gapB.length === 0) break;
    // The row the gap's deletions sit before: the next live row, or the end.
    const anchor = rows[j]?.pos ?? tableEnd;
    for (let k = 0; k < Math.max(gapA.length, gapB.length); k++) {
      const a = gapA[k];
      const b = gapB[k];
      if (b == null) {
        out.deletions.push({ pos: anchor, deletedMarkdown: baseRows[a] ?? '' });
        continue;
      }
      const row = rows[b];
      if (!row) continue;
      const old = a == null ? undefined : baseCells[a];
      if (old == null || old.length !== newCells[b]?.length) {
        if (a != null) out.deletions.push({ pos: row.pos, deletedMarkdown: baseRows[a] ?? '' });
        markRow(row);
        continue;
      }
      // Same shape: an edited row. Mark only the cells whose text changed.
      newCells[b]?.forEach((text, c) => {
        const cell = row.cells[c];
        if (!cell || text === old[c]) return;
        if (old[c] !== '')
          out.deletions.push({ pos: cell.from + 1, deletedMarkdown: old[c] ?? '' });
        if (text !== '' && cell.to > cell.from) out.insRanges.push(cell);
      });
    }
  }
  return out;
}
