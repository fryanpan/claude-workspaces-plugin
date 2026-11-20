import { LEADS_FIELD, PERSON_SPOT_FIELD } from '@claude-workspaces/core/workspace-presence';
import { beforeEach, describe, expect, it } from 'vitest';
/**
 * A second tab for a person who has followers offers to bring them along
 * (M10).
 *
 * The board under test is Riverbend's SECOND tab. Her first tab is a peer in
 * the room, listed in this browser's shared storage the way every one of
 * her tabs lists itself; Bob is a peer following her. Both are in the room
 * before the board's socket syncs, as they would be for a tab opened while
 * he follows.
 *
 * Where Bob's follow goes is read with the follow model itself, over the
 * states the room holds, with Riverbend's name on the second tab's state
 * because the server writes the proven name over whatever a page announces.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { tabsStorageKey } from '../src/presence/bring-along.ts';
import { spotOfParticipant } from '../src/presence/follow-model.ts';
import { type Booted, WS, bootTestBoard, resetBoardServer, settle } from './support/board-drive.ts';

const RIVERBEND = { id: 'known-riverbend', name: 'Riverbend' };
const BOB = { id: 'known-bob', name: 'Bob' };
const FIRST_TAB_SPOT = { surface: 'doc', docId: 'tide-tables' };

beforeEach(() => {
  resetBoardServer();
});

/** A peer whose state is applied to the board's room. */
function peer(board: Booted, state: Record<string, unknown>): Awareness {
  const p = new Awareness(new Y.Doc());
  p.setLocalState(state);
  applyAwarenessUpdate(
    board.sockets.first().awareness,
    encodeAwarenessUpdate(p, [p.clientID]),
    'remote',
  );
  return p;
}

/** Riverbend's second tab with her first tab open, Bob following her or not. */
async function secondTab(opts: { followed: boolean; firstTabListed?: boolean }) {
  const firstTab = new Awareness(new Y.Doc());
  const listed = opts.firstTabListed ?? true;
  const board = await bootTestBoard({
    noSync: true,
    storage: listed ? { [tabsStorageKey(WS)]: JSON.stringify([firstTab.clientID]) } : {},
  });
  const room = board.sockets.first().awareness;
  firstTab.setLocalState({
    user: RIVERBEND,
    surface: 'doc',
    docId: FIRST_TAB_SPOT.docId,
    [PERSON_SPOT_FIELD]: FIRST_TAB_SPOT,
    lastActive: 1,
  });
  applyAwarenessUpdate(room, encodeAwarenessUpdate(firstTab, [firstTab.clientID]), 'remote');
  const bob = peer(board, {
    user: BOB,
    surface: 'board',
    lastActive: 1,
    ...(opts.followed ? { following: `p-${RIVERBEND.id}` } : {}),
  });
  await board.project([]);
  board.sockets.first().sync();
  await settle();

  /** Where Bob's follow of Riverbend leads now. */
  const bobGoesTo = () => {
    const states = new Map(room.getStates());
    const mine = states.get(room.clientID) as Record<string, unknown>;
    // The server's stamp: the room hears this tab as Riverbend.
    states.set(room.clientID, { ...mine, user: RIVERBEND, lastActive: 2 });
    return spotOfParticipant(states, `p-${RIVERBEND.id}`, bob.clientID);
  };
  const leads = () => (room.getLocalState() as Record<string, unknown>)[LEADS_FIELD];
  const offer = () => document.querySelector<HTMLElement>('.board-bring-along');
  const button = (label: string) =>
    [...(offer()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  return { board, bobGoesTo, leads, offer, button };
}

describe('a second tab for a person somebody follows', () => {
  it('offers to bring them along, and keeps them on the first tab until asked', async () => {
    const tab = await secondTab({ followed: true });
    expect(tab.offer()?.querySelector('b')?.textContent).toBe('Bob is following you');
    expect(tab.button('Bring them here')).toBeDefined();
    expect(tab.leads()).toBe(false);
    expect(tab.bobGoesTo()).toMatchObject(FIRST_TAB_SPOT);

    tab.button('Bring them here')?.click();
    await settle();
    expect(tab.offer()).toBeNull();
    expect(tab.leads()).toBe(true);
    // The second tab is on the board, so that is where Bob is taken.
    expect(tab.bobGoesTo()).toMatchObject({ surface: 'board' });
  });

  it('leaves them where they are when she says not now', async () => {
    const tab = await secondTab({ followed: true });
    tab.button('Not now')?.click();
    await settle();
    expect(tab.offer()).toBeNull();
    expect(tab.leads()).toBe(false);
    expect(tab.bobGoesTo()).toMatchObject(FIRST_TAB_SPOT);
  });

  it('offers nothing, and leads, when nobody follows her', async () => {
    const tab = await secondTab({ followed: false });
    expect(tab.offer()).toBeNull();
    expect(tab.leads()).toBe(true);
  });

  it('offers nothing to her only tab: there is nowhere to leave them', async () => {
    const tab = await secondTab({ followed: true, firstTabListed: false });
    expect(tab.offer()).toBeNull();
    expect(tab.leads()).toBe(true);
  });
});
