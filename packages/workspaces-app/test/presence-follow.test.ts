/**
 * Presence and following across the workspace, driven over real awareness.
 *
 * Each participant is its own `Awareness`, and its updates are applied to the
 * follower's room the way a socket applies them — so the chips and the
 * follow are built from the same states a second browser would send.
 *
 *  - A person is ONE spot: two tabs fold to the newest one's spot.
 *  - An agent is the spot the server says it pointed at; nothing else.
 *  - Following moves this view there: scrolled on the same page, opened on
 *    another page, and still following when that page loads.
 *  - It stops the moment the reader moves on their own.
 *
 * Order of events only; no clocks.
 */
import {
  AGENT_SPOTS_FIELD,
  PERSON_SPOT_FIELD,
  type PresenceSpot,
} from '@claude-workspaces/core/workspace-presence';
import { describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { roomChips, spotOfParticipant } from '../src/presence/follow-model.ts';
import { createFollower, followStorageKey, stopOnOwnInput } from '../src/presence/follower.ts';

const WS = 'w-harbor';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

/** A participant in `room`: whatever it sets is what the room hears. */
function participant(room: Awareness) {
  const self = new Awareness(new Y.Doc());
  return (state: Record<string, unknown>) => {
    self.setLocalState(state);
    applyAwarenessUpdate(room, encodeAwarenessUpdate(self, [self.clientID]), 'remote');
  };
}

const person = (id: string, name: string, spot: PresenceSpot, lastActive: number) => ({
  user: { id, name },
  surface: spot.surface,
  ...(spot.docId ? { docId: spot.docId } : {}),
  [PERSON_SPOT_FIELD]: spot,
  lastActive,
});

/** A page holding the room, following through a recorded address bar. */
function page(here: PresenceSpot, storage = memoryStorage(), address = '/') {
  const room = new Awareness(new Y.Doc());
  const went: string[] = [];
  const shown: PresenceSpot[] = [];
  const follower = createFollower({
    room,
    workspaceId: WS,
    here: () => here,
    address: () => address,
    go: (href) => went.push(href),
    show: (spot) => shown.push(spot),
    storage,
  });
  return { room, went, shown, follower, storage };
}

describe('presence in the workspace room', () => {
  it("is one spot per person — their newest tab's — and an agent's pointed spot", () => {
    const { room } = page({ surface: 'board' });
    const firstTab = participant(room);
    const secondTab = participant(room);
    const server = participant(room);
    firstTab({ ...person('u-reader', 'Alice', { surface: 'doc', docId: 'd-quay' }, 1) });
    secondTab({
      ...person('u-reader', 'Alice', { surface: 'doc', docId: 'd-pier', blockId: 'b-7' }, 2),
    });
    server({
      [AGENT_SPOTS_FIELD]: {
        'agent-harborlight': {
          surface: 'whiteboard',
          docId: 'wb-plan',
          x: 40,
          y: 80,
          name: 'Harborlight',
          seq: 3,
        },
      },
    });

    const chips = roomChips(room.getStates(), room.clientID);
    expect(chips.map((c) => [c.key, c.kind, c.where])).toEqual([
      ['p-u-reader', 'person', 'd-pier'],
      ['a-agent-harborlight', 'agent', 'wb-plan'],
    ]);
    expect(spotOfParticipant(room.getStates(), 'p-u-reader', room.clientID)).toEqual({
      surface: 'doc',
      docId: 'd-pier',
      blockId: 'b-7',
    });
    // The board's roster names an agent by its name; the same spot answers.
    expect(spotOfParticipant(room.getStates(), 'a-Harborlight', room.clientID)).toMatchObject({
      docId: 'wb-plan',
      x: 40,
    });
  });

  it('draws no agent that has pointed nowhere, and no person for a state without one', () => {
    const { room } = page({ surface: 'board' });
    participant(room)({ agentSpots: {} });
    participant(room)({ surface: 'doc', docId: 'd-quay' });
    expect(roomChips(room.getStates(), room.clientID)).toEqual([]);
  });
});

describe('following', () => {
  it('opens the page they move to, and scrolls when they move on this one', () => {
    const p = page({ surface: 'doc', docId: 'd-quay' });
    const peer = participant(p.room);
    peer(person('u-peer', 'Bob', { surface: 'doc', docId: 'd-quay', blockId: 'b-1' }, 1));

    p.follower.follow('p-u-peer');
    expect(p.shown).toEqual([{ surface: 'doc', docId: 'd-quay', blockId: 'b-1' }]);
    expect(p.went).toEqual([]);

    peer(person('u-peer', 'Bob', { surface: 'doc', docId: 'd-quay', blockId: 'b-9' }, 2));
    expect(p.shown.at(-1)?.blockId).toBe('b-9');

    peer(person('u-peer', 'Bob', { surface: 'whiteboard', docId: 'wb-plan', x: 5, y: 6 }, 3));
    expect(p.went).toEqual([`/workspaces/${WS}/whiteboards/wb-plan`]);
  });

  it('follows an agent to the thread it commented on, and not to its last edit', () => {
    const p = page({ surface: 'board' });
    const server = participant(p.room);
    server({
      [AGENT_SPOTS_FIELD]: {
        'agent-harborlight': {
          surface: 'doc',
          docId: 'd-quay',
          threadId: 't-4',
          name: 'Harborlight',
          seq: 1,
        },
      },
    });
    p.follower.follow('a-agent-harborlight');
    expect(p.went).toEqual([`/workspaces/${WS}/docs/d-quay?thread=t-4`]);
  });

  it("moves an open doc's view as the agent's cursor moves from block to block", () => {
    // The planning voice's cursor is its spot: each question it asks moves
    // the server's entry for it, and a follower already on the doc scrolls.
    const p = page({ surface: 'doc', docId: 'd-plan' });
    const server = participant(p.room);
    const voice = (blockId: string, quote: string, seq: number) =>
      server({
        [AGENT_SPOTS_FIELD]: {
          'voice-interview': {
            surface: 'doc',
            docId: 'd-plan',
            blockId,
            quote,
            name: 'Claude',
            seq,
          },
        },
      });
    voice('b-goals', 'Goals', 1);
    p.follower.follow('a-voice-interview');
    expect(p.shown.at(-1)).toMatchObject({ blockId: 'b-goals', quote: 'Goals' });

    voice('b-design', 'Design', 2);
    expect(p.shown.at(-1)).toMatchObject({ blockId: 'b-design', quote: 'Design' });
    expect(p.shown).toHaveLength(2);
    expect(p.went).toEqual([]);
  });

  it('keeps following on the page the follow opened, and ends on a page the reader opened', () => {
    const storage = memoryStorage();
    const first = page({ surface: 'board' }, storage, `/workspaces/${WS}`);
    participant(first.room)(person('u-peer', 'Bob', { surface: 'doc', docId: 'd-pier' }, 1));
    first.follower.follow('p-u-peer');
    const href = `/workspaces/${WS}/docs/d-pier`;
    expect(first.went).toEqual([href]);

    // The page the follow opened: still following, and it shows the spot.
    const landed = page({ surface: 'doc', docId: 'd-pier' }, storage, href);
    expect(landed.follower.key()).toBe('p-u-peer');

    // A page the reader reached some other way, mid-follow: it ends.
    storage.setItem(followStorageKey(WS), JSON.stringify({ key: 'p-u-peer', arriving: href }));
    const elsewhere = page(
      { surface: 'doc', docId: 'd-other' },
      storage,
      `/workspaces/${WS}/docs/d-other`,
    );
    expect(elsewhere.follower.key()).toBeNull();
    expect(storage.map.has(followStorageKey(WS))).toBe(false);
  });

  it("stops when the reader moves on their own, and a press on the strip isn't that", () => {
    const p = page({ surface: 'doc', docId: 'd-quay' });
    const peer = participant(p.room);
    peer(person('u-peer', 'Bob', { surface: 'doc', docId: 'd-quay', blockId: 'b-1' }, 1));
    const target = new EventTarget();
    const strip = new EventTarget();
    stopOnOwnInput(target, p.follower, (t) => t === strip);
    p.follower.follow('p-u-peer');

    // A tap anywhere on the page.
    target.dispatchEvent(new Event('pointerdown'));
    expect(p.follower.key()).toBeNull();

    // Positive control for the strip exclusion: a strip press leaves it on.
    p.follower.follow('p-u-peer');
    const onStrip = new Event('pointerdown');
    Object.defineProperty(onStrip, 'target', { value: strip });
    target.dispatchEvent(onStrip);
    expect(p.follower.key()).toBe('p-u-peer');

    target.dispatchEvent(new Event('wheel'));
    expect(p.follower.key()).toBeNull();
    const before = p.shown.length;
    peer(person('u-peer', 'Bob', { surface: 'doc', docId: 'd-quay', blockId: 'b-2' }, 2));
    expect(p.shown.length).toBe(before);
    expect(p.went).toEqual([]);
  });
});
