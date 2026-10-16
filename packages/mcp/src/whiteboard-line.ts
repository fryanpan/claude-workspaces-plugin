/**
 * The channel line for `whiteboard.changed`: who drew, and what, in the
 * shape form `get_whiteboard` reads and `draw_on_whiteboard` writes. Up to
 * eight shapes are spelled out; past that the line says how many more and
 * the agent reads the board.
 */

interface ShapeLike {
  id?: unknown;
  kind?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  text?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface WhiteboardChangedLike {
  docId?: string;
  docTitle?: string;
  actor?: { name?: string };
  shapes?: ShapeLike[];
  removed?: string[];
  count?: number;
}

const SHOWN = 8;

function shapeText(s: ShapeLike): string {
  const kind = typeof s.kind === 'string' ? s.kind : 'shape';
  const at = typeof s.x === 'number' && typeof s.y === 'number' ? ` at (${s.x}, ${s.y})` : '';
  const size = typeof s.w === 'number' && typeof s.h === 'number' ? ` ${s.w}x${s.h}` : '';
  const words = typeof s.text === 'string' && s.text ? ` "${s.text.slice(0, 80)}"` : '';
  const join =
    typeof s.from === 'string' || typeof s.to === 'string'
      ? ` ${typeof s.from === 'string' ? s.from : '?'}→${typeof s.to === 'string' ? s.to : '?'}`
      : '';
  return `${kind} ${String(s.id ?? '')}${words}${at}${size}${join}`;
}

export function whiteboardChangedLine(p: WhiteboardChangedLike): string {
  const who = p.actor?.name || 'Someone';
  const board = p.docTitle ? `"${p.docTitle}"` : (p.docId ?? 'a whiteboard');
  const shapes = p.shapes ?? [];
  const removed = p.removed ?? [];
  const parts: string[] = [];
  if (shapes.length > 0) {
    const listed = shapes.slice(0, SHOWN).map(shapeText).join('; ');
    const more = shapes.length > SHOWN ? `; and ${shapes.length - SHOWN} more` : '';
    parts.push(`drew or changed ${listed}${more}`);
  }
  if (removed.length > 0) parts.push(`removed ${removed.slice(0, SHOWN).join(', ')}`);
  const what = parts.length > 0 ? parts.join('; ') : 'changed the board';
  const count = typeof p.count === 'number' ? ` The board holds ${p.count} element(s).` : '';
  return `[whiteboard] ${who} ${what} on ${board}.${count} get_whiteboard reads it all.`;
}
