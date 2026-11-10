/**
 * `person-presence.ts` on its own: which of the owner's tabs is attended,
 * who hears a landing, which tab a `show` addresses, and the wall between
 * boards. The route and the real sockets are `person-presence-route.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  ATTENDING_FIELD,
  DIRECTIVE_FIELD,
  PERSON_SPOT_FIELD,
  type PresenceSpot,
  parseDirective,
} from '@claude-workspaces/core/workspace-presence';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type Landing, createPersonPresence } from '../src/person-presence.ts';

const OWNER = 'known-harborlight';

/** A page in a room: its own awareness, carried by a socket with `stamp`. */
function page(room: Awareness, stamp: Record<string, unknown> = {}) {
  const own = new Awareness(new Y.Doc());
  const socket = { data: stamp };
  const set = (state: Record<string, unknown>) => {
    own.setLocalState(state);
    applyAwarenessUpdate(room, encodeAwarenessUpdate(own, [own.clientID]), socket);
  };
  return { id: own.clientID, set, own };
}

const at = (
  spot: PresenceSpot,
  attending: boolean,
  user: { id: string; name: string } = { id: OWNER, name: 'Riverbend' },
) => ({ user, [PERSON_SPOT_FIELD]: spot, [ATTENDING_FIELD]: attending });

function harness() {
  let clock = 1_000;
  const timers: Array<() => void> = [];
  const heard: Array<{ agentId: string; landing: Landing }> = [];
  const pp = createPersonPresence({
    isOwner: (id) => id === OWNER,
    describe: (_w, spot) =>
      spot.docId ? { kind: 'doc', id: spot.docId } : { kind: 'page' },
    deliver: (_w, agentId, landing) => heard.push({ agentId, landing }),
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: (h) => {
      timers[(h as number) - 1] = () => {};
    },
  });
  return {
    pp,
    heard,
    tick: (ms = 1) => {
      clock += ms;
    },
    settle: () => {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

describe('person presence', () => {
  it("tells a watching agent the owner's attended tab landed on a doc, with the place in view", () => {
    const h = harness();
    const room = new Awareness(new Y.Doc());
    h.pp.attach('w-harbor', room);
    h.pp.watch('w-harbor', 'agent-a', true);
    const tab = page(room);
    tab.set(at({ surface: 'doc', docId: 'd-plan' }, true));
    // The page says which block is in view inside the settle window.
    tab.set(at({ surface: 'doc', docId: 'd-plan', blockId: 'b-retention' }, true));
    expect(h.heard).toEqual([]);
    h.settle();
    expect(h.heard).toHaveLength(1);
    expect(h.heard[0]?.agentId).toBe('agent-a');
    expect(h.heard[0]?.landing).toMatchObject({
      workspaceId: 'w-harbor',
      person: { id: OWNER },
      resource: { kind: 'doc', id: 'd-plan' },
      spot: { docId: 'd-plan', blockId: 'b-retention' },
    });
    // A scroll within the page is not a landing.
    tab.set(at({ surface: 'doc', docId: 'd-plan', blockId: 'b-scope' }, true));
    h.settle();
    expect(h.heard).toHaveLength(1);
  });

  it('follows the tab the owner attends to last, not a background one', () => {
    const h = harness();
    const room = new Awareness(new Y.Doc());
    h.pp.attach('w-harbor', room);
    const ipad = page(room);
    const laptop = page(room);
    ipad.set(at({ surface: 'doc', docId: 'd-plan' }, true));
    h.tick();
    laptop.set(at({ surface: 'doc', docId: 'd-diff' }, true));
    // Two devices both in the foreground: the one attended to most recently.
    expect(h.pp.current('w-harbor')?.spot.docId).toBe('d-diff');
    ipad.set(at({ surface: 'doc', docId: 'd-plan' }, false));
    expect(h.pp.current('w-harbor')?.spot.docId).toBe('d-diff');
    const shown = h.pp.show('w-harbor', { id: 'agent-a', name: 'Lead' }, {
      surface: 'doc',
      docId: 'd-plan',
    });
    expect(shown).toMatchObject({ ok: true, to: laptop.id });
    const d = parseDirective(room.getLocalState()?.[DIRECTIVE_FIELD]);
    expect(d?.to).toBe(laptop.id);
    expect(d?.spot.docId).toBe('d-plan');
  });

  it("never counts a share visitor's tab or a proven non-owner's, whatever id it announces", () => {
    const h = harness();
    const room = new Awareness(new Y.Doc());
    h.pp.attach('w-harbor', room);
    h.pp.watch('w-harbor', 'agent-a', true);
    page(room, { shareId: 's-1' }).set(at({ surface: 'doc', docId: 'd-a' }, true));
    page(room, { personProof: 'other' }).set(at({ surface: 'doc', docId: 'd-b' }, true));
    page(room, { readOnly: true }).set(at({ surface: 'doc', docId: 'd-c' }, true));
    h.settle();
    expect(h.heard).toEqual([]);
    expect(h.pp.show('w-harbor', { id: 'agent-a', name: 'Lead' }, { surface: 'board' })).toEqual({
      ok: false,
      reason: 'not-here',
    });
    // A proven owner socket counts whatever the page announced.
    page(room, { personProof: 'owner' }).set(
      at({ surface: 'doc', docId: 'd-d' }, true, { id: 'anon-x', name: 'Riverbend' }),
    );
    expect(h.pp.current('w-harbor')?.spot.docId).toBe('d-d');
  });

  it('keeps an agent on one board from hearing or moving a tab on another', () => {
    const h = harness();
    const a = new Awareness(new Y.Doc());
    const b = new Awareness(new Y.Doc());
    h.pp.attach('w-a', a);
    h.pp.attach('w-b', b);
    h.pp.watch('w-a', 'agent-a', true);
    h.pp.watch('w-b', 'agent-b', true);
    // A background tab on board A, the attended one on board B.
    page(a).set(at({ surface: 'doc', docId: 'd-a' }, false));
    page(b).set(at({ surface: 'doc', docId: 'd-b' }, true));
    h.settle();
    expect(h.heard.map((x) => x.agentId)).toEqual(['agent-b']);
    expect(h.pp.current('w-a')).toBeNull();
    expect(h.pp.show('w-a', { id: 'agent-a', name: 'A' }, { surface: 'board' })).toMatchObject({
      ok: false,
    });
    expect(a.getLocalState()?.[DIRECTIVE_FIELD]).toBeUndefined();
    expect(b.getLocalState()?.[DIRECTIVE_FIELD]).toBeUndefined();
  });

  it('names the agent whose show sent the owner to the page, and only that landing', () => {
    const h = harness();
    const room = new Awareness(new Y.Doc());
    h.pp.attach('w-harbor', room);
    h.pp.watch('w-harbor', 'agent-a', true);
    const tab = page(room);
    tab.set(at({ surface: 'doc', docId: 'd-diff' }, true));
    h.settle();
    h.pp.show('w-harbor', { id: 'agent-a', name: 'Lead' }, { surface: 'doc', docId: 'd-plan' });
    // The tab obeys: a new page, a new client id.
    tab.set(at({ surface: 'doc', docId: 'd-diff' }, false));
    h.tick();
    page(room).set(at({ surface: 'doc', docId: 'd-plan', blockId: 'b-1' }, true));
    h.settle();
    h.tick();
    page(room).set(at({ surface: 'doc', docId: 'd-scope' }, true));
    h.settle();
    expect(h.heard.map((x) => [x.landing.spot.docId, x.landing.actor?.id])).toEqual([
      ['d-diff', undefined],
      ['d-plan', 'agent-a'],
      ['d-scope', undefined],
    ]);
  });

  it('stops telling an agent that stopped watching, and numbers each show above the last', () => {
    const h = harness();
    const room = new Awareness(new Y.Doc());
    h.pp.attach('w-harbor', room);
    h.pp.watch('w-harbor', 'agent-a', true);
    h.pp.watch('w-harbor', 'agent-a', false);
    const tab = page(room);
    tab.set(at({ surface: 'doc', docId: 'd-plan' }, true));
    h.settle();
    expect(h.heard).toEqual([]);
    const by = { id: 'agent-a', name: 'Lead' };
    const one = h.pp.show('w-harbor', by, { surface: 'board' });
    const two = h.pp.show('w-harbor', by, { surface: 'board' });
    expect(one.ok && two.ok && two.seq > one.seq).toBe(true);
  });
});
