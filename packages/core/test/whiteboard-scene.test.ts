import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type SceneElement,
  allSceneElements,
  incomingWins,
  isSceneElement,
  parseAgentPointers,
  putSceneElements,
  sceneMap,
} from '../src/whiteboard-scene.ts';

const el = (id: string, version: number, versionNonce = 5, index = 'a0'): SceneElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce,
  index,
});

describe('incomingWins', () => {
  it('takes the higher version, and on a tie the lower nonce', () => {
    expect(incomingWins(undefined, el('a', 1))).toBe(true);
    expect(incomingWins(el('a', 2), el('a', 3))).toBe(true);
    expect(incomingWins(el('a', 3), el('a', 2))).toBe(false);
    expect(incomingWins(el('a', 2, 9), el('a', 2, 4))).toBe(true);
    expect(incomingWins(el('a', 2, 4), el('a', 2, 9))).toBe(false);
  });
});

describe('putSceneElements', () => {
  it('writes only the copies that win, in one transaction', () => {
    const ydoc = new Y.Doc();
    let transactions = 0;
    ydoc.on('afterTransaction', () => transactions++);
    expect(putSceneElements(ydoc, [el('a', 2), el('b', 1)], 'here')).toEqual(['a', 'b']);
    expect(transactions).toBe(1);
    // Replaying the whole scene writes only what changed.
    expect(putSceneElements(ydoc, [el('a', 1), el('b', 2)], 'here')).toEqual(['b']);
    expect((sceneMap(ydoc).get('a') as SceneElement).version).toBe(2);
  });

  it('skips a malformed element rather than storing it', () => {
    const ydoc = new Y.Doc();
    const bad = { id: '', type: 'rectangle', version: 1, versionNonce: 1 } as SceneElement;
    expect(putSceneElements(ydoc, [bad], null)).toEqual([]);
    expect(isSceneElement({ id: 'x', type: 'text', version: Number.NaN, versionNonce: 1 })).toBe(
      false,
    );
  });
});

describe('allSceneElements', () => {
  it('reads elements back in paint order, ignoring anything malformed', () => {
    const ydoc = new Y.Doc();
    putSceneElements(ydoc, [el('b', 1, 1, 'a2'), el('a', 1, 1, 'a1')], null);
    sceneMap(ydoc).set('junk', { nope: true });
    expect(allSceneElements(ydoc).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('parseAgentPointers', () => {
  it('keeps well-formed pointers and caps the label', () => {
    const got = parseAgentPointers({
      'agent-harborlight': { x: 10, y: 20, label: 'Harborlight'.repeat(5) },
      broken: { x: 'left', y: 2, label: 'Riverbend' },
    });
    expect([...got.keys()]).toEqual(['agent-harborlight']);
    expect(got.get('agent-harborlight')?.label).toHaveLength(40);
    expect(parseAgentPointers(null).size).toBe(0);
  });
});
