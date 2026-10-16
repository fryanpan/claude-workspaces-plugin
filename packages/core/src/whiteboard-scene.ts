/**
 * A whiteboard's scene as the Y.Doc holds it, and the one rule for which copy
 * of an element wins. Read by the server (the agent verbs, the change event)
 * and by the page (the canvas binding), so the two cannot disagree about
 * either.
 *
 * The scene is a `Y.Map` named `elements`, keyed by Excalidraw element id,
 * each value the element's whole JSON. A write replaces the whole element:
 * Excalidraw already versions every element (`version` grows on each change,
 * `versionNonce` is a random tiebreak), so the map does not merge fields, it
 * keeps the copy Excalidraw's own collaboration would keep. An element is
 * never removed from the map. Deleting one is a new version with
 * `isDeleted: true`, which is what lets a deletion beat a stale copy that
 * arrives later.
 */
import * as Y from 'yjs';

/** The Y.Map holding the elements. */
export const WHITEBOARD_ELEMENTS_MAP = 'elements';

/**
 * The presence field the server sets on its own awareness state for a
 * whiteboard: where each agent is pointing, keyed by agent id. A record and
 * not one `{x, y}` because the server holds ONE awareness state per doc, and
 * two agents on one board must not erase each other's spot. An agent appears
 * on the canvas only here, never at its last edit: an agent works in many
 * places at once, so its presence is the spot it chose to point at.
 */
export const AGENT_POINTERS_FIELD = 'agentPointers';

/** The presence field each page publishes beside `user`: its own pointer. */
export const PAGE_POINTER_FIELD = 'pointer';

export interface AgentPointer {
  x: number;
  y: number;
  label: string;
}

/**
 * An element in the form an agent reads and writes: a kind, a box in canvas
 * units, and the words on it. `from`/`to` are the ids of the shapes an arrow
 * joins. A kind other than the four an agent can draw (a person's pen stroke
 * reads `freedraw`) is reported as Excalidraw names it.
 */
export interface WhiteboardShape {
  id: string;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  from?: string;
  to?: string;
}

/** The fields this module reads. Every other field rides along untouched. */
export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  /** Excalidraw's fractional order key. Absent on a malformed element. */
  index?: string | null;
  [field: string]: unknown;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether a value has the shape of an element: an id, a type and a version. */
export function isSceneElement(v: unknown): v is SceneElement {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 100 &&
    typeof e.type === 'string' &&
    finite(e.version) &&
    finite(e.versionNonce)
  );
}

/**
 * Whether `incoming` replaces `current`. The higher version wins; on a tie the
 * lower nonce wins, which is the rule Excalidraw's own `reconcileElements`
 * applies, so every page converges on the copy the canvas would have kept.
 */
export function incomingWins(current: SceneElement | undefined, incoming: SceneElement): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

/** The scene map of a doc. */
export function sceneMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(WHITEBOARD_ELEMENTS_MAP);
}

/** Every well-formed element in the map, deleted ones included. */
export function allSceneElements(ydoc: Y.Doc): SceneElement[] {
  const out: SceneElement[] = [];
  sceneMap(ydoc).forEach((value) => {
    if (isSceneElement(value)) out.push(value);
  });
  return sortByIndex(out);
}

/** Elements in paint order: by fractional index, then by id. */
export function sortByIndex<T extends SceneElement>(elements: T[]): T[] {
  return elements.sort((a, b) => {
    const ai = a.index ?? '';
    const bi = b.index ?? '';
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The element stored under `id`, when it is well-formed. */
export function sceneElement(ydoc: Y.Doc, id: string): SceneElement | undefined {
  const value = sceneMap(ydoc).get(id);
  return isSceneElement(value) ? value : undefined;
}

/**
 * Write each element whose copy wins over the stored one, in one transaction.
 * Returns the ids written. An element that loses (an older version of one
 * already stored) is skipped, so a page replaying its whole scene writes only
 * what changed.
 */
export function putSceneElements(
  ydoc: Y.Doc,
  elements: readonly SceneElement[],
  origin: unknown,
): string[] {
  const map = sceneMap(ydoc);
  const written: string[] = [];
  ydoc.transact(() => {
    for (const el of elements) {
      if (!isSceneElement(el)) continue;
      if (!incomingWins(sceneElement(ydoc, el.id), el)) continue;
      map.set(el.id, JSON.parse(JSON.stringify(el)) as SceneElement);
      written.push(el.id);
    }
  }, origin);
  return written;
}

/** A presence state's agent pointers, keeping only well-formed entries. */
export function parseAgentPointers(raw: unknown): Map<string, AgentPointer> {
  const out = new Map<string, AgentPointer>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const p = value as Record<string, unknown>;
    if (!finite(p.x) || !finite(p.y) || typeof p.label !== 'string') continue;
    out.set(id, { x: p.x, y: p.y, label: p.label.slice(0, 40) });
  }
  return out;
}
