/**
 * What the whiteboard verbs do to a live doc: read its scene, draw shapes on
 * it, and set where an agent is pointing.
 *
 * Every write goes through `putSceneElements`, the one rule pages use too, so
 * an agent's element and a person's element are merged the same way. An
 * agent's write carries the `WHITEBOARD_AGENT_ORIGIN` string, which counts as
 * authoring (it starts with `agent`) and which `scene-events.ts` reads to
 * name the agent in the change event.
 */
import { randomBytes } from 'node:crypto';
import {
  AGENT_POINTERS_FIELD,
  type AgentPointer,
  type SceneElement,
  type WhiteboardShape,
  allSceneElements,
  incomingWins,
  isSceneElement,
  parseAgentPointers,
  putSceneElements,
  sceneElement,
  sceneMap,
} from '@claude-workspaces/core/whiteboard-scene';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { type ShapeInput, buildElements, toShapes, tombstone } from './elements.ts';
import { type SceneActor, WHITEBOARD_AGENT_ORIGIN, runAsAgent } from './scene-events.ts';

/**
 * How far `replace` raises the version of every element it writes.
 *
 * Excalidraw adds one to an element's version on each pointer move, and an
 * open tab keeps those moves until the gesture ends, or until its socket
 * returns. Those copies then carry a higher version than a replace that only
 * added one, so they win and the old board comes back shape by shape, mixed
 * with the new one. The step is larger than any tab can climb: a million
 * moves is over four hours of one continuous drag at 60 per second. It needs
 * nothing from the page, so a tab on an older bundle is covered too.
 */
export const REPLACE_VERSION_STEP = 1_000_000;

/** The transaction origin of a copy put back by `keepWinningCopies`. */
const SCENE_GUARD_ORIGIN = 'whiteboard-scene-guard';

const random31 = (): number => randomBytes(4).readUInt32BE(0) >>> 1;
const newElementId = (): string => randomBytes(10).toString('base64url');

/** The scene in the agent's form, and how many elements are on it. */
export function readScene(ydoc: Y.Doc): { shapes: WhiteboardShape[]; count: number } {
  const live = allSceneElements(ydoc).filter((e) => !e.isDeleted);
  return { shapes: toShapes(live), count: live.length };
}

/**
 * Draw shapes on a scene. `add` writes the shapes over what is there, an id
 * already on the board replacing that element; `replace` also deletes every
 * element the call did not write, so the board ends up holding exactly these
 * shapes, and beats every copy an open tab has not sent yet
 * (`REPLACE_VERSION_STEP`). A person's unsent change to a shape is dropped; a
 * shape only their tab holds is new work, and stays. Returns the ids written,
 * the deleted ones included.
 */
export function drawShapes(
  ydoc: Y.Doc,
  shapes: readonly ShapeInput[],
  mode: 'add' | 'replace',
  actor: SceneActor,
  now: number = Date.now(),
): string[] {
  const stored = allSceneElements(ydoc);
  const existing = new Map<string, SceneElement>(stored.map((e) => [e.id, e]));
  const ctx = { existing, newId: newElementId, random: random31, now };
  const built = buildElements(shapes, ctx);
  const keep = new Set(built.map((e) => e.id));
  // A shape already deleted is written again: a stale tab can hold it live.
  const writes =
    mode === 'replace'
      ? [...built, ...stored.filter((e) => !keep.has(e.id)).map((e) => tombstone(e, ctx))].map(
          (e) => ({ ...e, version: e.version + REPLACE_VERSION_STEP }),
        )
      : built;
  return runAsAgent(actor, () => putSceneElements(ydoc, writes, WHITEBOARD_AGENT_ORIGIN));
}

/**
 * Hold a scene to `incomingWins` across concurrent writes. A page checks the
 * rule against what it has seen, so a write it made offline never met the
 * copy that beats it, and Yjs then settles the two by client id alone. When
 * that seats a losing copy here, this writes the winner back, and every page
 * follows. Returns the function that stops watching.
 */
export function keepWinningCopies(ydoc: Y.Doc): () => void {
  const map = sceneMap(ydoc);
  const observer = (event: Y.YMapEvent<unknown>, tr: Y.Transaction): void => {
    if (tr.origin === SCENE_GUARD_ORIGIN) return;
    const winners: SceneElement[] = [];
    for (const [id, change] of event.changes.keys) {
      const was = change.oldValue;
      if (change.action !== 'update' || !isSceneElement(was)) continue;
      const now = sceneElement(ydoc, id);
      if (now && incomingWins(now, was)) winners.push(was);
    }
    if (winners.length === 0) return;
    ydoc.transact(() => {
      for (const el of winners) map.set(el.id, el);
    }, SCENE_GUARD_ORIGIN);
  };
  map.observe(observer);
  return () => map.unobserve(observer);
}

/**
 * Set, move or clear one agent's pointer. The server holds a single presence
 * state per doc, so every agent's spot lives in one record keyed by agent id
 * and this rewrites only the caller's entry.
 */
export function setAgentPointer(
  awareness: awarenessProtocol.Awareness,
  agentId: string,
  point: { x: number; y: number; label: string } | null,
): void {
  const current = parseAgentPointers(awareness.getLocalState()?.[AGENT_POINTERS_FIELD]);
  if (point) current.set(agentId, point);
  else current.delete(agentId);
  const next: Record<string, AgentPointer> = Object.fromEntries(current);
  awareness.setLocalStateField(AGENT_POINTERS_FIELD, next);
}
