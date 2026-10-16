import type { SceneElement } from '@claude-workspaces/core/whiteboard-scene';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  commitLocal,
  inGesture,
  mergeForCanvas,
  presenceLine,
  presenceNames,
  protectedIds,
  remoteCursors,
} from '../src/whiteboard/scene-sync.ts';

const el = (id: string, version: number, index = 'a0'): SceneElement => ({
  id,
  type: 'freedraw',
  version,
  versionNonce: 7,
  index,
});

describe('a gesture in progress', () => {
  it('counts a pen down, a new element, a drag and typing, and nothing else', () => {
    expect(inGesture({})).toBe(false);
    expect(inGesture({ cursorButton: 'up' })).toBe(false);
    expect(inGesture({ cursorButton: 'down' })).toBe(true);
    expect(inGesture({ newElement: { id: 's1' } })).toBe(true);
    expect(inGesture({ selectedElementsAreBeingDragged: true })).toBe(true);
    expect(inGesture({ editingTextElement: { id: 't1' } })).toBe(true);
  });

  it('protects the stroke being drawn, and the selection only while it moves', () => {
    expect([...protectedIds({ newElement: { id: 's1' } })]).toEqual(['s1']);
    const selected = { selectedElementIds: { b1: true, b2: false } };
    expect(protectedIds(selected).size).toBe(0);
    expect([...protectedIds({ ...selected, selectedElementsAreBeingDragged: true })]).toEqual([
      'b1',
    ]);
  });
});

describe('merging a shared change into the canvas', () => {
  it('takes the newer shared copy and keeps elements only the canvas has', () => {
    const merged = mergeForCanvas([el('a', 1), el('mine', 1, 'a5')], [el('a', 2)], new Set());
    expect(merged?.map((e) => [e.id, e.version])).toEqual([
      ['a', 2],
      ['mine', 1],
    ]);
  });

  it('never replaces the element the person here is still drawing', () => {
    expect(mergeForCanvas([el('s1', 1)], [el('s1', 4)], new Set(['s1']))).toBeNull();
  });

  it('returns null when nothing would change, so the canvas skips a redraw', () => {
    expect(mergeForCanvas([el('a', 3)], [el('a', 2)], new Set())).toBeNull();
  });
});

describe('committing the canvas', () => {
  it('writes only the elements that changed since the last commit', () => {
    const ydoc = new Y.Doc();
    expect(commitLocal(ydoc, [el('a', 1), el('b', 1), { not: 'an element' }], 'page')).toEqual([
      'a',
      'b',
    ]);
    expect(commitLocal(ydoc, [el('a', 1), el('b', 2)], 'page')).toEqual(['b']);
  });
});

describe('presence', () => {
  const states = new Map<number, Record<string, unknown>>([
    [1, { user: { name: 'Bryan', color: '#cc3333' }, pointer: { x: 4, y: 5 } }],
    [2, { user: { name: 'Riverbend' } }],
    [9, { agentPointers: { 'agent-harborlight': { x: 40, y: 50, label: 'Harborlight' } } }],
    [3, { user: { name: 'Me' }, pointer: { x: 1, y: 1 } }],
  ]);

  it('draws a person where they point and an agent only where it chose to point', () => {
    expect(remoteCursors(states, 3)).toEqual([
      { key: 'p:1', name: 'Bryan', color: '#cc3333', x: 4, y: 5, kind: 'person' },
      {
        key: 'a:agent-harborlight',
        name: 'Harborlight',
        color: '#2e7dd7',
        x: 40,
        y: 50,
        kind: 'agent',
      },
    ]);
  });

  it('names everyone else, people before agents', () => {
    const names = presenceNames(states, 3);
    expect(names).toEqual(['Bryan', 'Riverbend', 'Harborlight']);
    expect(presenceLine(names)).toBe('Live · you and Bryan, Riverbend, Harborlight');
    expect(presenceLine([])).toBe('Live · just you');
  });
});
