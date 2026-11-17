/**
 * A component's state lives in the doc's Y.Doc, so every page holding the doc
 * shares it: writes to different paths both survive, two writes to one path
 * settle on one value everywhere, and push keeps both appends. A page that
 * may not write is refused with a message, and so is a write past the size,
 * depth or rate limit — and a refused write changes nothing.
 *
 * Two Y.Docs stand in for two pages, wired to each other the way the server
 * relays updates, so "concurrent" means each wrote before seeing the other.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  STATE_LIMITS,
  applyStateOps,
  componentStateIds,
  createStateHook,
  readComponentState,
} from './mdx-component-state.ts';

/** Two pages. `sync()` exchanges what each has that the other lacks. */
function twoPages() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a, b, sync };
}

const writer = (ydoc: Y.Doc, id = 'map', now?: () => number) =>
  createStateHook(ydoc, id, { canWrite: true, ...(now ? { now } : {}) });

describe('component state in the doc', () => {
  it('reads back what was written, by path', () => {
    const doc = new Y.Doc();
    const s = writer(doc);
    expect(s.get()).toEqual({});
    expect(s.set('pins.harborlight', { lat: 37.8, label: 'Harborlight' })).toEqual({ ok: true });
    expect(s.set('filter', 'open')).toEqual({ ok: true });
    expect(s.get('pins.harborlight.label')).toBe('Harborlight');
    expect(s.get(['pins', 'harborlight', 'lat'])).toBe(37.8);
    expect(s.get('missing.deeper')).toBeUndefined();
    expect(s.push('visits', 'Riverbend')).toEqual({ ok: true });
    expect(s.push('visits', 'Saltmarsh')).toEqual({ ok: true });
    expect(s.set('visits.0', 'Bob')).toEqual({ ok: true });
    expect(s.delete('filter')).toEqual({ ok: true });
    expect(s.get()).toEqual({
      pins: { harborlight: { lat: 37.8, label: 'Harborlight' } },
      visits: ['Bob', 'Saltmarsh'],
    });
    expect(readComponentState(doc, 'map')).toEqual(s.get());
    expect(componentStateIds(doc)).toEqual(['map']);
  });

  it('keeps writes to different paths made at once on two pages', () => {
    const { a, b, sync } = twoPages();
    writer(a).set('pins', { a: { x: 1 }, b: { name: 'Harborlight' } });
    sync();
    // Alice moves pin a while Bob renames pin b, neither seeing the other.
    writer(a).set('pins.a.x', 5);
    writer(b).set('pins.b.name', 'Riverbend');
    sync();
    const want = { pins: { a: { x: 5 }, b: { name: 'Riverbend' } } };
    expect(readComponentState(a, 'map')).toEqual(want);
    expect(readComponentState(b, 'map')).toEqual(want);
  });

  it('keeps two first writes to one component, made before either page saw the other', () => {
    const { a, b, sync } = twoPages();
    writer(a).set('filter', 'open');
    writer(b).set('selected', 'saltmarsh');
    sync();
    const want = { filter: 'open', selected: 'saltmarsh' };
    expect(readComponentState(a, 'map')).toEqual(want);
    expect(readComponentState(b, 'map')).toEqual(want);
  });

  it('settles two writes to one path on one value, and keeps both pushes', () => {
    const { a, b, sync } = twoPages();
    writer(a).set('visits', []);
    sync();
    writer(a).set('filter', 'open');
    writer(b).set('filter', 'closed');
    writer(a).push('visits', 'Alice');
    writer(b).push('visits', 'Bob');
    sync();
    const onA = readComponentState(a, 'map');
    expect(onA).toEqual(readComponentState(b, 'map'));
    expect(['open', 'closed']).toContain(onA.filter);
    expect([...(onA.visits as string[])].sort()).toEqual(['Alice', 'Bob']);
  });

  it('tells a listener about a write from the other page', () => {
    const { a, b, sync } = twoPages();
    const seen: unknown[] = [];
    const off = writer(b).on((state) => seen.push(state));
    writer(a).set('filter', 'open');
    sync();
    expect(seen).toEqual([{ filter: 'open' }]);
    off();
    writer(a).set('filter', 'closed');
    sync();
    expect(seen).toHaveLength(1);
  });

  it('lets a read-only page read state and refuses its writes with a message', () => {
    const { a, b, sync } = twoPages();
    writer(a).set('filter', 'open');
    sync();
    const reader = createStateHook(b, 'map', { canWrite: false });
    expect(reader.canWrite).toBe(false);
    expect(reader.get('filter')).toBe('open');
    for (const out of [
      reader.set('filter', 'closed'),
      reader.push('visits', 'Bob'),
      reader.delete('filter'),
    ]) {
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toMatch(/can only read/);
    }
    sync();
    expect(readComponentState(a, 'map')).toEqual({ filter: 'open' });
  });
});

describe('the limits on a write', () => {
  it('refuses a write that would take one component past its size, and keeps the state', () => {
    const doc = new Y.Doc();
    const s = writer(doc);
    s.set('note', 'Harborlight');
    const out = s.set('blob', 'x'.repeat(STATE_LIMITS.instanceBytes));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/256 KB/);
    expect(s.get()).toEqual({ note: 'Harborlight' });
  });

  it('refuses a write that would take the doc past its size, across components', () => {
    const doc = new Y.Doc();
    const chunk = 'x'.repeat(200 * 1024);
    let t = 0;
    const now = () => (t += 1000);
    for (let i = 0; i < 10; i++) {
      expect(writer(doc, `pin-${i}`, now).set('data', chunk)).toEqual({ ok: true });
    }
    const out = writer(doc, 'pin-10', now).set('data', chunk);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/2 MB/);
    expect(componentStateIds(doc)).not.toContain('pin-10');
  });

  it('refuses state nested deeper than the limit', () => {
    const s = writer(new Y.Doc());
    let deep: unknown = 'Saltmarsh';
    for (let i = 0; i < STATE_LIMITS.depth; i++) deep = { d: deep };
    const out = s.set('top', deep);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/levels deep/);
    expect(s.get()).toEqual({});
  });

  it('refuses a value that is not JSON', () => {
    const s = writer(new Y.Doc());
    for (const bad of [() => 1, undefined, Number.NaN, new Date(0), { a: Symbol('x') }]) {
      const out = s.set('bad', bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toMatch(/JSON only/);
    }
    expect(s.get()).toEqual({});
  });

  it('refuses the write past the rate limit, and accepts again a second later', () => {
    let t = 0;
    const s = writer(new Y.Doc(), 'map', () => t);
    for (let i = 0; i < STATE_LIMITS.writesPerSecond; i++) {
      expect(s.set('x', i)).toEqual({ ok: true });
    }
    const out = s.set('x', 999);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/20 times a second/);
    expect(s.get('x')).toBe(STATE_LIMITS.writesPerSecond - 1);
    t = 1001;
    expect(s.set('x', 1000)).toEqual({ ok: true });
  });

  it('counts the rate per component, shared by two tags with one id', () => {
    const doc = new Y.Doc();
    const t = 0;
    const first = writer(doc, 'map', () => t);
    const second = writer(doc, 'map', () => t);
    for (let i = 0; i < STATE_LIMITS.writesPerSecond; i++) first.set('x', i);
    expect(second.set('y', 1).ok).toBe(false);
    expect(writer(doc, 'other', () => t).set('y', 1)).toEqual({ ok: true });
  });

  it('refuses a __proto__ key in a path or a value, and reads no inherited key', () => {
    const s = writer(new Y.Doc());
    expect(s.set('__proto__.polluted', 'Bob').ok).toBe(false);
    expect(s.set('pins', JSON.parse('{"__proto__": {"polluted": "Bob"}}')).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(s.get('constructor')).toBeUndefined();
    expect(s.set('constructor.name', 'Alice')).toEqual({ ok: true });
    expect(s.get('constructor.name')).toBe('Alice');
  });

  it('refuses a path through a value that holds no keys', () => {
    const s = writer(new Y.Doc());
    s.set('filter', 'open');
    const out = s.set('filter.kind', 'Harborlight');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/filter/);
    const push = s.push('filter', 'x');
    expect(push.ok).toBe(false);
  });
});

describe('a batch of writes from an agent', () => {
  it('applies every op in one transaction, tagged with its origin', () => {
    const { a, b, sync } = twoPages();
    createStateHook(a, 'map', { canWrite: true }).set('pins', ['harbor']);
    sync();
    const origins: unknown[] = [];
    let changes = 0;
    a.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.size > 0) {
        origins.push(tr.origin);
        changes++;
      }
    });
    const res = applyStateOps(
      a,
      'map',
      [
        { op: 'set', path: 'filter', value: 'open' },
        { op: 'push', path: 'pins', value: 'saltmarsh' },
        { op: 'set', path: 'view.zoom', value: 12 },
      ],
      { origin: 'agent:Alice' },
    );
    expect(res).toEqual({ ok: true });
    expect(changes).toBe(1);
    expect(origins).toEqual(['agent:Alice']);
    sync();
    expect(readComponentState(b, 'map')).toEqual({
      pins: ['harbor', 'saltmarsh'],
      filter: 'open',
      view: { zoom: 12 },
    });
  });

  it('applies a later op once to a value an earlier op in the batch set', () => {
    const ydoc = new Y.Doc();
    const pins: string[] = [];
    const res = applyStateOps(ydoc, 'map', [
      { op: 'set', path: 'pins', value: pins },
      { op: 'push', path: 'pins', value: 'harbor' },
      { op: 'set', path: 'list', value: [1, 2] },
      { op: 'delete', path: 'list.0' },
    ]);
    expect(res).toEqual({ ok: true });
    expect(readComponentState(ydoc, 'map')).toEqual({ pins: ['harbor'], list: [2] });
    expect(pins).toEqual([]);
  });

  it('changes nothing when any op is refused, and names which one', () => {
    const ydoc = new Y.Doc();
    createStateHook(ydoc, 'map', { canWrite: true }).set('filter', 'open');
    const res = applyStateOps(ydoc, 'map', [
      { op: 'set', path: 'filter', value: 'closed' },
      { op: 'push', path: 'filter', value: 'x' },
    ]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/^ops\[1\]: "filter" is not a list/);
    expect(readComponentState(ydoc, 'map')).toEqual({ filter: 'open' });
  });

  it('holds the batch to the size limit and refuses a bad op shape', () => {
    const ydoc = new Y.Doc();
    const big = 'x'.repeat(STATE_LIMITS.instanceBytes);
    const res = applyStateOps(ydoc, 'map', [{ op: 'set', path: 'blob', value: big }]);
    expect(!res.ok && res.error).toMatch(/over the 256 KB limit/);
    expect(applyStateOps(ydoc, 'map', [{ op: 'move', path: 'a' } as never])).toEqual({
      ok: false,
      error: 'ops[0].op must be "set", "push" or "delete".',
    });
    expect(applyStateOps(ydoc, 'map', []).ok).toBe(false);
    expect(readComponentState(ydoc, 'map')).toEqual({});
  });
});
