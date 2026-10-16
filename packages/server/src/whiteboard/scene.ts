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
  parseAgentPointers,
  putSceneElements,
} from '@claude-workspaces/core/whiteboard-scene';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { type ShapeInput, buildElements, toShapes, tombstone } from './elements.ts';
import { type SceneActor, WHITEBOARD_AGENT_ORIGIN, runAsAgent } from './scene-events.ts';

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
 * shapes. Returns the ids written, the deleted ones included.
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
  const removed =
    mode === 'replace'
      ? stored.filter((e) => !e.isDeleted && !keep.has(e.id)).map((e) => tombstone(e, ctx))
      : [];
  return runAsAgent(actor, () =>
    putSceneElements(ydoc, [...built, ...removed], WHITEBOARD_AGENT_ORIGIN),
  );
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
