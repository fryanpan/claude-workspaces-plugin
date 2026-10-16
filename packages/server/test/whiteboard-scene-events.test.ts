/**
 * The settle clock behind `whiteboard.changed`, on a bare Y.Doc: one call per
 * author per burst, the author named, housekeeping silent. Waits derive from
 * `whiteboardSettleMs`, which this suite runs scaled.
 */
import { describe, expect, it } from 'bun:test';
import { putSceneElements } from '@claude-workspaces/core/whiteboard-scene';
import * as Y from 'yjs';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import {
  type SceneActor,
  describeChange,
  watchSceneChanges,
} from '../src/whiteboard/scene-events.ts';
import { drawShapes } from '../src/whiteboard/scene.ts';
import { insideWhiteboardSettle, pastWhiteboardSettle, waitFor } from './wait-for.ts';

const PERSON: SceneActor = { id: 'known-riverbend', name: 'Riverbend', kind: 'person' };
const AGENT: SceneActor = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const SOCKET = { socket: 'person' };

const el = (id: string, version = 1) => ({
  id,
  type: 'freedraw',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version,
  versionNonce: version,
  index: `a${id}`,
});

function watched() {
  const ydoc = new Y.Doc();
  const calls: Array<{ actor: SceneActor; changed: string[] }> = [];
  const stop = watchSceneChanges(ydoc, {
    settleMs: DOC_STORE_TIMINGS.whiteboardSettleMs,
    actorOf: (origin) => (origin === SOCKET ? PERSON : null),
    onSettled: (actor, changed) => calls.push({ actor, changed }),
  });
  return { ydoc, calls, stop };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchSceneChanges', () => {
  it('fires once for two strokes inside the window, naming both and the person', async () => {
    const { ydoc, calls, stop } = watched();
    putSceneElements(ydoc, [el('one')], SOCKET);
    // timed: a second stroke inside the settle window restarts it.
    await pause(insideWhiteboardSettle());
    putSceneElements(ydoc, [el('two')], SOCKET);
    await waitFor(() => calls.length > 0, { describe: 'the settled event' });
    // timed: long enough for a second call to have arrived, if one were coming.
    await pause(pastWhiteboardSettle());
    expect(calls).toEqual([{ actor: PERSON, changed: ['one', 'two'] }]);
    stop();
  });

  it('names the agent for its own write and times it apart from the person', async () => {
    const { ydoc, calls, stop } = watched();
    putSceneElements(ydoc, [el('pen')], SOCKET);
    drawShapes(ydoc, [{ id: 'dock', kind: 'box', x: 0, y: 0 }], 'add', AGENT);
    await waitFor(() => calls.length >= 2, { describe: 'one event per author' });
    expect(calls.map((c) => c.actor.kind).sort()).toEqual(['agent', 'person']);
    expect(calls.find((c) => c.actor.kind === 'agent')).toEqual({
      actor: AGENT,
      changed: ['dock'],
    });
    stop();
  });

  it('fires nothing for a write nobody authored', async () => {
    const { ydoc, calls, stop } = watched();
    putSceneElements(ydoc, [el('loaded')], 'hydrate');
    // timed: the whole window passes with nothing to report.
    await pause(pastWhiteboardSettle());
    expect(calls).toEqual([]);
    stop();
  });
});

describe('describeChange', () => {
  it('reports a changed label as its box, a deletion as removed, and the live count', () => {
    const ydoc = new Y.Doc();
    drawShapes(ydoc, [{ id: 'dock', kind: 'box', x: 0, y: 0, text: 'Dock' }], 'add', AGENT);
    putSceneElements(ydoc, [el('pen')], SOCKET);
    putSceneElements(ydoc, [{ ...el('pen', 2), isDeleted: true }], SOCKET);
    const d = describeChange(ydoc, ['dock-label', 'pen']);
    expect(d.shapes.map((s) => s.id)).toEqual(['dock']);
    expect(d.shapes[0]?.text).toBe('Dock');
    expect(d.removed).toEqual(['pen']);
    expect(d.count).toBe(2);
  });
});
