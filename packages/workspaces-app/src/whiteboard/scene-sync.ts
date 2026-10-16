/**
 * The whiteboard page's two directions of sync, with no canvas in them.
 *
 * Local → shared: a finished change (never half a stroke) writes each element
 * whose copy on the canvas beats the shared one. Shared → local: a change from
 * anyone else is merged into what the canvas holds, except the elements the
 * person here is still drawing, dragging or typing into, which keep their
 * local copy until the gesture ends. Both use `incomingWins`, the rule the
 * server and Excalidraw's own reconcile use, so every page converges.
 *
 * Presence is read here too: a person is where their pointer is, and an agent
 * is only where it chose to point (`agentPointers`), never at its last edit.
 */
import {
  AGENT_POINTERS_FIELD,
  PAGE_POINTER_FIELD,
  type SceneElement,
  incomingWins,
  isSceneElement,
  parseAgentPointers,
  putSceneElements,
  sortByIndex,
} from '@claude-workspaces/core/whiteboard-scene';
import type * as Y from 'yjs';

/** The canvas state fields that mean a gesture is in progress. */
export interface GestureState {
  cursorButton?: 'up' | 'down';
  newElement?: { id: string } | null;
  resizingElement?: { id: string } | null;
  multiElement?: { id: string } | null;
  editingTextElement?: { id: string } | null;
  selectedElementsAreBeingDragged?: boolean;
  isResizing?: boolean;
  isRotating?: boolean;
  selectedElementIds?: Readonly<Record<string, boolean>>;
}

/** Whether the person here is mid-gesture: a pen down, a drag, a resize, typing. */
export function inGesture(s: GestureState): boolean {
  return (
    s.cursorButton === 'down' ||
    !!s.newElement ||
    !!s.resizingElement ||
    !!s.multiElement ||
    !!s.editingTextElement ||
    !!s.selectedElementsAreBeingDragged ||
    !!s.isResizing ||
    !!s.isRotating
  );
}

/**
 * The ids a remote change must not overwrite right now: whatever the gesture
 * is drawing, typing into, or moving.
 */
export function protectedIds(s: GestureState): Set<string> {
  const ids = new Set<string>();
  for (const el of [s.newElement, s.resizingElement, s.multiElement, s.editingTextElement]) {
    if (el?.id) ids.add(el.id);
  }
  if (s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating) {
    for (const [id, on] of Object.entries(s.selectedElementIds ?? {})) if (on) ids.add(id);
  }
  return ids;
}

/** Write the canvas's winning copies to the shared scene. Returns the ids written. */
export function commitLocal(ydoc: Y.Doc, canvas: readonly unknown[], origin: unknown): string[] {
  const elements = canvas.filter(isSceneElement);
  return putSceneElements(ydoc, elements, origin);
}

/**
 * What the canvas should hold after a shared change: the shared copy of each
 * element where it wins, the local copy where the local one wins or is in a
 * gesture, and every local-only element kept. `null` when nothing would
 * change, so the page skips a redraw.
 */
export function mergeForCanvas(
  canvas: readonly unknown[],
  shared: readonly SceneElement[],
  keep: ReadonlySet<string>,
): SceneElement[] | null {
  const local = new Map<string, SceneElement>();
  for (const el of canvas) if (isSceneElement(el)) local.set(el.id, el);
  let changed = false;
  const out = new Map(local);
  for (const el of shared) {
    if (keep.has(el.id)) continue;
    if (incomingWins(local.get(el.id), el)) {
      out.set(el.id, el);
      changed = true;
    }
  }
  return changed ? sortByIndex([...out.values()]) : null;
}

/** One remote cursor, in the shape the canvas draws collaborators in. */
export interface RemoteCursor {
  key: string;
  name: string;
  color: string;
  x: number;
  y: number;
  kind: 'person' | 'agent';
}

type PresenceStates = ReadonlyMap<number, Record<string, unknown>>;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Every other client's pointer: each page's person where they point, and each
 * agent where it pointed. A state with no pointer draws nothing.
 */
export function remoteCursors(states: PresenceStates, selfClientId: number): RemoteCursor[] {
  const out: RemoteCursor[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || !state) continue;
    const user = state.user as { name?: unknown; color?: unknown } | undefined;
    const pointer = state[PAGE_POINTER_FIELD] as { x?: unknown; y?: unknown } | undefined;
    if (
      user &&
      typeof user.name === 'string' &&
      pointer &&
      finite(pointer.x) &&
      finite(pointer.y)
    ) {
      out.push({
        key: `p:${clientId}`,
        name: user.name,
        color: typeof user.color === 'string' ? user.color : '#555555',
        x: pointer.x,
        y: pointer.y,
        kind: 'person',
      });
    }
    for (const [agentId, p] of parseAgentPointers(state[AGENT_POINTERS_FIELD])) {
      out.push({
        key: `a:${agentId}`,
        name: p.label,
        color: '#2e7dd7',
        x: p.x,
        y: p.y,
        kind: 'agent',
      });
    }
  }
  return out;
}

/** The names of everyone else here, people first, for the header. */
export function presenceNames(states: PresenceStates, selfClientId: number): string[] {
  const people = new Set<string>();
  const agents = new Set<string>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || !state) continue;
    const name = (state.user as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.trim()) people.add(name.trim());
    for (const p of parseAgentPointers(state[AGENT_POINTERS_FIELD]).values()) agents.add(p.label);
  }
  return [...people, ...agents];
}

/** The header's presence line. */
export function presenceLine(names: readonly string[]): string {
  if (names.length === 0) return 'Live · just you';
  return `Live · you and ${names.join(', ')}`;
}
