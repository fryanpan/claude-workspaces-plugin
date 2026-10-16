/**
 * The agent's shapes become whole Excalidraw elements, and read back as the
 * shapes that were sent. Pure: no server, no Y.Doc.
 */
import { describe, expect, it } from 'bun:test';
import type { SceneElement } from '@claude-workspaces/core/whiteboard-scene';
import {
  type BuildContext,
  type ShapeInput,
  buildElements,
  labelIdOf,
  parseShapes,
  toShapes,
} from '../src/whiteboard/elements.ts';

function ctx(existing: SceneElement[] = []): BuildContext {
  let n = 0;
  let r = 1000;
  return {
    existing: new Map(existing.map((e) => [e.id, e])),
    newId: () => `new-${++n}`,
    random: () => ++r,
    now: 1_700_000_000_000,
  };
}

const byId = (els: SceneElement[]) => new Map(els.map((e) => [e.id, e]));

describe('parseShapes', () => {
  it('accepts the four kinds and refuses anything malformed, naming the field', () => {
    expect(parseShapes([{ kind: 'box', x: 0, y: 0, text: 'Harborlight' }]).ok).toBe(true);
    const cases: Array<[unknown, string]> = [
      ['nope', 'shapes must be an array'],
      [[{ kind: 'star', x: 0, y: 0 }], 'shapes[0].kind'],
      [[{ kind: 'box', x: '1', y: 0 }], 'shapes[0].x'],
      [[{ kind: 'box', x: 0, y: Number.NaN }], 'shapes[0].y'],
      [[{ kind: 'box', x: 0, y: 2e6 }], 'shapes[0].y'],
      [[{ kind: 'box', x: 0, y: 0, id: 'a b' }], 'shapes[0].id'],
      [[{ kind: 'arrow', x: 0, y: 0, to: '../x' }], 'shapes[0].to'],
      [[{ kind: 'text', x: 0, y: 0 }], 'shapes[0].text'],
      [[{ kind: 'box', x: 0, y: 0, text: 'x'.repeat(2001) }], 'shapes[0].text'],
      [Array.from({ length: 201 }, () => ({ kind: 'box', x: 0, y: 0 })), 'at most 200'],
    ];
    for (const [raw, needle] of cases) {
      const res = parseShapes(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(needle);
    }
  });
});

describe('buildElements', () => {
  it('builds a labelled box as a container and its bound text', () => {
    const els = buildElements([{ id: 'dock', kind: 'box', x: 10, y: 20, text: 'Dock' }], ctx());
    const m = byId(els);
    const box = m.get('dock');
    const label = m.get(labelIdOf('dock'));
    expect(box?.type).toBe('rectangle');
    expect(box?.boundElements).toEqual([{ id: labelIdOf('dock'), type: 'text' }]);
    expect(label?.type).toBe('text');
    expect(label?.containerId).toBe('dock');
    expect(label?.text).toBe('Dock');
    for (const el of els) {
      expect(typeof el.seed).toBe('number');
      expect(typeof el.versionNonce).toBe('number');
      expect(el.version).toBe(1);
      expect(typeof el.index).toBe('string');
    }
    // Paint order: each new element above the one before.
    expect(String(box?.index) < String(label?.index)).toBe(true);
  });

  it('binds an arrow to the shapes it joins, both ways', () => {
    const first = buildElements(
      [
        { id: 'a', kind: 'box', x: 0, y: 0 },
        { id: 'b', kind: 'ellipse', x: 400, y: 0 },
      ],
      ctx(),
    );
    const els = buildElements(
      [{ id: 'ab', kind: 'arrow', x: 0, y: 0, from: 'a', to: 'b' }],
      ctx(first),
    );
    const m = byId(els);
    const arrow = m.get('ab');
    expect(arrow?.startBinding).toEqual({ elementId: 'a', focus: 0, gap: 4 });
    expect(arrow?.endBinding).toEqual({ elementId: 'b', focus: 0, gap: 4 });
    // It starts at the right edge of `a` and ends at the left edge of `b`.
    expect(arrow?.x).toBe(164);
    const pts = arrow?.points as number[][];
    expect((arrow?.x as number) + (pts[1]?.[0] ?? 0)).toBe(396);
    expect(m.get('a')?.boundElements).toEqual([{ id: 'ab', type: 'arrow' }]);
    expect(m.get('b')?.boundElements).toEqual([{ id: 'ab', type: 'arrow' }]);
    expect(m.get('a')?.version).toBe(2);
  });

  it('replaces an element by id: a new version, the same seed and place in the order', () => {
    const [box] = buildElements([{ id: 'dock', kind: 'box', x: 0, y: 0 }], ctx());
    if (!box) throw new Error('no box');
    const [next] = buildElements([{ id: 'dock', kind: 'box', x: 50, y: 60, w: 300 }], ctx([box]));
    expect(next?.version).toBe(2);
    expect(next?.seed).toBe(box.seed);
    expect(next?.index).toBe(box.index);
    expect(next?.x).toBe(50);
    expect(next?.width).toBe(300);
  });

  it('deletes a label when a box loses its words', () => {
    const first = buildElements([{ id: 'dock', kind: 'box', x: 0, y: 0, text: 'Dock' }], ctx());
    const m = byId(buildElements([{ id: 'dock', kind: 'box', x: 0, y: 0 }], ctx(first)));
    expect(m.get(labelIdOf('dock'))?.isDeleted).toBe(true);
    expect(m.get('dock')?.boundElements).toBeNull();
  });
});

describe('toShapes', () => {
  it('reads back what the agent sent, a label folded into its box', () => {
    const sent: ShapeInput[] = [
      { id: 'a', kind: 'box', x: 0, y: 0, w: 160, h: 80, text: 'Riverbend' },
      { id: 'b', kind: 'ellipse', x: 400, y: 0, w: 140, h: 90 },
      { id: 'note', kind: 'text', x: 0, y: 200, text: 'Saltmarsh' },
    ];
    const built = buildElements(sent, ctx());
    const withArrow = [
      ...built,
      ...buildElements([{ id: 'ab', kind: 'arrow', x: 0, y: 0, from: 'a', to: 'b' }], ctx(built)),
    ];
    const latest = [...byId(withArrow).values()];
    const shapes = toShapes(latest);
    expect(shapes.map((s) => s.id).sort()).toEqual(['a', 'ab', 'b', 'note']);
    const s = new Map(shapes.map((x) => [x.id, x]));
    expect(s.get('a')).toEqual({
      id: 'a',
      kind: 'box',
      x: 0,
      y: 0,
      w: 160,
      h: 80,
      text: 'Riverbend',
    });
    expect(s.get('note')?.text).toBe('Saltmarsh');
    expect(s.get('ab')).toMatchObject({ kind: 'arrow', from: 'a', to: 'b' });
  });

  it('reports a kind it cannot draw by Excalidraw name, and leaves deleted elements out', () => {
    const pen = {
      id: 'p',
      type: 'freedraw',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      version: 1,
      versionNonce: 1,
    };
    const gone = { ...pen, id: 'g', isDeleted: true };
    expect(toShapes([pen, gone])).toEqual([{ id: 'p', kind: 'freedraw', x: 1, y: 2, w: 3, h: 4 }]);
  });
});
