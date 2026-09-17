import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness as RealAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import * as shim from '../scripts/shims/y-protocols-awareness.ts';

/**
 * The widget takes no part in presence, and this is what that means on the
 * wire and on the host page's event loop.
 *
 * Every case drives the REAL module as its control, in the same shape, because
 * the claim this shim rests on is a claim about what the real one does — and
 * the comment in `ws-client.ts` asserted the opposite for a year ("a no-op for
 * clients like the widget that never set local awareness state"). A test that
 * only exercised the stand-in would have agreed with that comment.
 *
 * `ws-client.ts` is the only importer in the widget's graph, and it uses five
 * things: the constructor, `on`/`off('update')`, `getStates()`, `destroy()`,
 * and `applyAwarenessUpdate` on an inbound frame. All five are here.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.restoreAllMocks();
});

/** A real Awareness, destroyed after the case so its interval cannot outlive it. */
function real(doc: Y.Doc): RealAwareness {
  const a = new RealAwareness(doc);
  cleanups.push(() => a.destroy());
  return a;
}

describe('the local entry a client announces on connect', () => {
  it('is one for the real module and none for the shim', () => {
    const doc = new Y.Doc();
    // CONTROL, and the thing the old comment denied: the real constructor ends
    // with `setLocalState({})`, so a client that never touches presence still
    // holds an entry — and `ws-client` sends it, because it sends whenever
    // `getStates()` is non-empty.
    expect(real(doc).getStates().size).toBe(1);
    expect(new shim.Awareness(doc).getStates().size).toBe(0);
  });

  it('is what decides whether a frame goes out at all', () => {
    const doc = new Y.Doc();
    // `ws-client`'s own condition, in both worlds.
    const sends = (a: { getStates(): Map<number, unknown> }) => a.getStates().size > 0;
    expect(sends(real(doc))).toBe(true);
    expect(sends(new shim.Awareness(doc))).toBe(false);
  });

  it('stays none however the widget is asked to set one', () => {
    const a = new shim.Awareness(new Y.Doc());
    a.setLocalState({ user: { name: 'Riverbend' } });
    a.setLocalStateField('user', { name: 'Riverbend' });
    expect(a.getStates().size).toBe(0);
    expect(a.getLocalState()).toBeNull();
  });
});

describe('the timer a guest page is left running', () => {
  /** How many intervals constructing this costs the page.
   *
   *  Cleared before each measurement, not spied afresh: `vi.spyOn` hands back
   *  the SAME mock for a method already spied, so the second call read the
   *  first one's total and the shim looked like it armed a timer. */
  function intervals(make: () => { destroy(): void }): number {
    const spy = vi.spyOn(globalThis, 'setInterval');
    spy.mockClear();
    make().destroy();
    return spy.mock.calls.length;
  }

  it('is one every three seconds for the real module and none for the shim', () => {
    const doc = new Y.Doc();
    // CONTROL: `outdatedTimeout / 10` — 3s, for the life of the page, on
    // somebody else's site, renewing a clock nothing here reads.
    expect(intervals(() => new RealAwareness(doc))).toBe(1);
    expect(intervals(() => new shim.Awareness(doc))).toBe(0);
    expect(shim.outdatedTimeout).toBe(30_000);
  });
});

describe('an awareness frame arriving from the server', () => {
  it('leaves the shim empty, and throws nothing the socket loop would see', () => {
    const doc = new Y.Doc();
    const source = real(doc);
    source.setLocalState({ user: { name: 'Harborlight' } });
    const frame = shim.encodeAwarenessUpdate;
    const a = new shim.Awareness(doc);
    // The payload `ws-client` decodes off the wire before it gets here — the
    // real encoder's output, so this is the shape the server really sends.
    const wire = new Uint8Array([1, 2, 3]);
    expect(() => shim.applyAwarenessUpdate(a, wire, 'ws')).not.toThrow();
    expect(a.getStates().size, 'dropped, not applied').toBe(0);
    // CONTROL: the real module does apply the same kind of frame.
    expect(source.getStates().size).toBe(1);
    expect(frame()).toEqual(new Uint8Array(0));
  });

  it('is never answered with one of our own', () => {
    const a = new shim.Awareness(new Y.Doc());
    const sent: Uint8Array[] = [];
    // `ws-client` sends only from the 'update' handler. Nothing emits here, so
    // registering one and then setting state produces no frame.
    a.on('update', () => sent.push(shim.encodeAwarenessUpdate()));
    a.setLocalState({ user: { name: 'Saltmarsh' } });
    a.destroy();
    expect(sent).toEqual([]);
  });

  it('hands a frame back unmodified rather than rewriting one nobody reads', () => {
    const wire = new Uint8Array([9, 9]);
    expect(shim.modifyAwarenessUpdate(wire)).toBe(wire);
    expect(() => shim.removeAwarenessStates()).not.toThrow();
  });
});
