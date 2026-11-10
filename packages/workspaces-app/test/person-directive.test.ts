/**
 * A page obeying the server's instruction to move (`show_person`), and
 * telling the room whether it is the tab its person is attending to.
 *
 * The server's state is a participant like any other: its directive names
 * one page by awareness client id. Only that page moves, and it moves once
 * per directive. Order of events only; no clocks.
 */
import {
  DIRECTIVE_FIELD,
  type PersonDirective,
  type PresenceSpot,
} from '@claude-workspaces/core/workspace-presence';
import { describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { watchAttention } from '../src/presence/attention.ts';
import { createFollower } from '../src/presence/follower.ts';

const WS = 'w-harbor';
const BY = { id: 'agent-harborlight', name: 'Harborlight' };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function page(here: PresenceSpot, address: string) {
  const room = new Awareness(new Y.Doc());
  const went: string[] = [];
  const shown: PresenceSpot[] = [];
  createFollower({
    room,
    workspaceId: WS,
    here: () => here,
    address: () => address,
    go: (href) => went.push(href),
    show: (spot) => shown.push(spot),
    storage: memoryStorage(),
  });
  return { room, went, shown };
}

/** The server, as every page in the room hears it. */
function server(rooms: Awareness[]) {
  const self = new Awareness(new Y.Doc());
  return (d: PersonDirective) => {
    self.setLocalState({ [DIRECTIVE_FIELD]: d });
    for (const room of rooms) {
      applyAwarenessUpdate(room, encodeAwarenessUpdate(self, [self.clientID]), 'remote');
    }
  };
}

describe("a page and the server's directive", () => {
  it('moves only the page it names, onto another page of the workspace', () => {
    const front = page({ surface: 'doc', docId: 'd-diff' }, `/workspaces/${WS}/docs/d-diff`);
    const back = page({ surface: 'doc', docId: 'd-diff' }, `/workspaces/${WS}/docs/d-diff`);
    const send = server([front.room, back.room]);
    send({ to: front.room.clientID, seq: 10, by: BY, spot: { surface: 'doc', docId: 'd-plan' } });
    expect(front.went).toEqual([`/workspaces/${WS}/docs/d-plan`]);
    expect(back.went).toEqual([]);
    expect(back.shown).toEqual([]);
  });

  it('shows a place on the page already open, once per directive', () => {
    const p = page({ surface: 'doc', docId: 'd-plan' }, `/workspaces/${WS}/docs/d-plan`);
    const send = server([p.room]);
    const spot: PresenceSpot = { surface: 'doc', docId: 'd-plan', blockId: 'b-retention' };
    send({ to: p.room.clientID, seq: 10, by: BY, spot });
    // The server's awareness renews unchanged, and somebody else in the room
    // moves; neither is a second directive.
    send({ to: p.room.clientID, seq: 10, by: BY, spot });
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ user: { id: 'known-alice', name: 'Alice' } });
    applyAwarenessUpdate(p.room, encodeAwarenessUpdate(other, [other.clientID]), 'remote');
    expect(p.shown).toEqual([spot]);
    expect(p.went).toEqual([]);
    send({ to: p.room.clientID, seq: 11, by: BY, spot: { ...spot, blockId: 'b-scope' } });
    expect(p.shown.map((s) => s.blockId)).toEqual(['b-retention', 'b-scope']);
  });
});

describe('arriving where a directive sent the tab', () => {
  it('shows the place on the page that loads there, once', () => {
    const storage = memoryStorage();
    const room = new Awareness(new Y.Doc());
    const went: string[] = [];
    createFollower({
      room,
      workspaceId: WS,
      here: () => ({ surface: 'board' }),
      address: () => `/workspaces/${WS}`,
      go: (href) => went.push(href),
      show: () => {},
      storage,
    });
    const spot: PresenceSpot = { surface: 'doc', docId: 'd-plan', quote: 'Seven years' };
    server([room])({ to: room.clientID, seq: 5, by: BY, spot });
    expect(went).toEqual([`/workspaces/${WS}/docs/d-plan`]);
    // The page that loads at that address shows the place; a reload does not.
    const shown: PresenceSpot[] = [];
    const arrive = () =>
      createFollower({
        room: new Awareness(new Y.Doc()),
        workspaceId: WS,
        here: () => ({ surface: 'doc', docId: 'd-plan' }),
        address: () => `/workspaces/${WS}/docs/d-plan`,
        go: () => {},
        show: (s) => shown.push(s),
        storage,
      });
    arrive();
    arrive();
    expect(shown).toEqual([spot]);
  });
});

describe('attention', () => {
  function host(visible: boolean, focused: boolean) {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: visible ? 'visible' : 'hidden',
      hasFocus: () => focused,
    });
    return {
      win,
      doc,
      set(v: boolean, f: boolean, event: string) {
        doc.visibilityState = v ? 'visible' : 'hidden';
        focused = f;
        (event === 'visibilitychange' ? doc : win).dispatchEvent(new Event(event));
      },
    };
  }

  it('is attending only while visible and focused, and says so when that changes', () => {
    const h = host(true, true);
    let changes = 0;
    const a = watchAttention({ win: h.win, doc: h.doc as unknown as Document }, () => {
      changes += 1;
    });
    expect(a.attending()).toBe(true);
    h.set(true, false, 'blur');
    expect(a.attending()).toBe(false);
    h.set(false, false, 'visibilitychange');
    // Still not attending: no change to announce.
    expect(changes).toBe(1);
    h.set(true, true, 'focus');
    expect(a.attending()).toBe(true);
    expect(changes).toBe(2);
  });
});
