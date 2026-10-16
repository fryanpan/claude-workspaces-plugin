/**
 * One `whiteboard.changed` per author per burst, never one per stroke.
 *
 * A person sketching a flow commits several strokes in a few seconds, and an
 * agent watching the board wants to hear about the sketch, not each line of
 * it. So every commit to the scene map restarts a settle timer for its author,
 * and the event fires once that author has been quiet for
 * `whiteboardSettleMs`. Authors are timed apart: an agent drawing while a
 * person draws does not hold the person's event back, and the person's event
 * names only the person's elements.
 *
 * The page never commits half a stroke (it writes on pointer-up), so the
 * settle timer measures the gap between finished strokes.
 *
 * Who wrote a commit comes from its transaction origin. A doc socket is a
 * person, named by `actorOf`; the verbs write under
 * `WHITEBOARD_AGENT_ORIGIN` inside `runAsAgent`, which names the agent for
 * the length of that synchronous transaction. Any other origin (a load from
 * disk, housekeeping) names nobody and fires nothing.
 */
import {
  type SceneElement,
  type WhiteboardShape,
  allSceneElements,
  sceneMap,
} from '@claude-workspaces/core/whiteboard-scene';
import type * as Y from 'yjs';
import { toShapes } from './elements.ts';

/** The transaction origin of every agent write to a scene. */
export const WHITEBOARD_AGENT_ORIGIN = 'agent-whiteboard';

export interface SceneActor {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

let agentActor: SceneActor | null = null;

/** Run a synchronous scene write on an agent's behalf, so its event names it. */
export function runAsAgent<T>(actor: SceneActor, write: () => T): T {
  const previous = agentActor;
  agentActor = actor;
  try {
    return write();
  } finally {
    agentActor = previous;
  }
}

export interface SceneWatch {
  settleMs: number;
  /** The person behind a non-agent origin, or null for housekeeping. */
  actorOf: (origin: unknown) => SceneActor | null;
  /** One author's burst has settled: these ids changed, in first-changed order. */
  onSettled: (actor: SceneActor, changed: string[]) => void;
}

/** Watch a doc's scene map. Returns the function that stops watching. */
export function watchSceneChanges(ydoc: Y.Doc, watch: SceneWatch): () => void {
  const pending = new Map<
    string,
    { actor: SceneActor; ids: Set<string>; timer: ReturnType<typeof setTimeout> }
  >();
  const map = sceneMap(ydoc);
  const observer = (event: Y.YMapEvent<unknown>, tr: Y.Transaction): void => {
    const actor = tr.origin === WHITEBOARD_AGENT_ORIGIN ? agentActor : watch.actorOf(tr.origin);
    if (!actor) return;
    const key = `${actor.kind}:${actor.id}`;
    const entry = pending.get(key);
    if (entry) clearTimeout(entry.timer);
    const ids = entry?.ids ?? new Set<string>();
    for (const id of event.keysChanged) ids.add(id);
    const timer = setTimeout(() => {
      pending.delete(key);
      watch.onSettled(actor, [...ids]);
    }, watch.settleMs);
    (timer as { unref?: () => void }).unref?.();
    pending.set(key, { actor, ids, timer });
  };
  map.observe(observer);
  return () => {
    map.unobserve(observer);
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  };
}

/**
 * What a change event says about the ids that changed: the ones still on the
 * board in the agent's form, the ones now deleted, and the board's size.
 * A changed label is reported as its container, which is the shape an agent
 * reads and writes.
 */
export function describeChange(
  ydoc: Y.Doc,
  changed: readonly string[],
): { changed: string[]; shapes: WhiteboardShape[]; removed: string[]; count: number } {
  const all = allSceneElements(ydoc);
  const byId = new Map<string, SceneElement>(all.map((e) => [e.id, e]));
  const live = all.filter((e) => !e.isDeleted);
  const wanted = new Set<string>();
  const removed: string[] = [];
  for (const id of changed) {
    const el = byId.get(id);
    if (!el) continue;
    if (el.isDeleted) {
      removed.push(id);
      continue;
    }
    wanted.add(id);
    if (typeof el.containerId === 'string') wanted.add(el.containerId);
  }
  const shapes = toShapes(live).filter((s) => wanted.has(s.id));
  return { changed: [...changed], shapes, removed, count: live.length };
}
