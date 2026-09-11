/**
 * A circle means somebody is there.
 *
 * The board could always say who was ATTACHED, which is a durable record: it
 * outlives the session that wrote it, along with the heartbeat and the last
 * tool call. So a strip built on the roster drew a circle for a session that
 * exited hours ago, and the only way to find out whether anybody was
 * listening was to ask them in chat — which is the question this strip exists
 * to answer without asking.
 *
 * Present now means connected AND listening: an agent earns a circle by
 * holding the event stream its MCP child opens, and an agent that is not
 * holding one gets nothing at all. This file pins the three halves of that:
 * the gate itself, the absence looking like absence rather than like a maybe,
 * and the circle leaving a board nobody reloaded.
 *
 * Names are invented — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoardChromeRegion } from '../src/board/board-chrome-region.ts';
import { type PresenceAgent, presenceChips } from '../src/board/board-presence-model.ts';
import { mountPresenceIsland, presenceData } from '../src/board/presence-island.tsx';
import { fakeLocation } from './boot-harness.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';
import { boardState, mountShell } from './support/board-region-harness.ts';

const RIVERBEND = 'agent-riverbend';
const HARBORLIGHT = 'agent-harborlight';

const attached = (agentId: string, over: Partial<PresenceAgent> = {}): PresenceAgent => ({
  agentId,
  state: 'active',
  stateLabel: 'active',
  lastToolCallAt: 1,
  listening: false,
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('presenceChips — who earns a circle', () => {
  const NOW = 1_700_000_000_000;

  it('draws the listening agent and not the one that only has a record', () => {
    const chips = presenceChips(
      [],
      [attached(HARBORLIGHT), attached(RIVERBEND, { listening: true })],
      NOW,
    );
    // One chip, and it is the one on the wire. The other is not dimmed, not
    // ordered last, not there.
    expect(chips.map((c) => c.label)).toEqual([RIVERBEND]);
  });

  it('keeps a person whether or not any agent is listening', () => {
    // People come from Yjs awareness, which exists only while their socket
    // does — the gate is about agents, whose records are durable. This is the
    // control: if the filter ever reached the people loop, this fails.
    const chips = presenceChips(
      [{ clientId: 3, userId: 'u-1', name: 'Ada', surface: 'board', lastActive: NOW }],
      [attached(RIVERBEND)],
      NOW,
    );
    expect(chips.map((c) => c.kind)).toEqual(['person']);
  });

  it('never tells a listening agent’s tooltip that requests queue', () => {
    // `away` is the heartbeat clock alone, and the clock loses to the socket:
    // work is handed to a stream-holding agent however quiet it has been. The
    // old label said "away — requests queue", which on a drawn circle is
    // simply false.
    const [chip] = presenceChips(
      [],
      [
        attached(RIVERBEND, {
          listening: true,
          state: 'away',
          stateLabel: 'away — requests queue',
        }),
      ],
      NOW,
    );
    expect(chip?.title).not.toContain('requests queue');
    expect(chip?.title).toContain('listening');
  });

  it('passes the unresponsive label through — present and wedged is worth saying', () => {
    const [chip] = presenceChips(
      [],
      [
        attached(RIVERBEND, {
          listening: true,
          state: 'unresponsive',
          stateLabel: 'process up, agent unresponsive',
        }),
      ],
      NOW,
    );
    expect(chip?.title).toContain('process up, agent unresponsive');
  });
});

describe('the strip on a board nobody reloaded', () => {
  let el: (id: string) => HTMLElement;
  let sheets: () => void;
  let dispose: Array<() => void>;

  beforeEach(() => {
    setViewport(IPAD);
    el = mountShell();
    sheets = installSheets('board.css', 'styles.css');
    dispose = [];
    presenceData.value = { chips: [], followedKey: null };
    return () => {
      for (const d of dispose) d();
      sheets();
    };
  });

  /** The real chrome region over a real mounted island — the whole client
   *  path from `state.agents` to a node on the page. */
  function board(agents: PresenceAgent[]) {
    const state = boardState({ agents });
    const chrome = createBoardChromeRegion({
      state,
      user: { name: 'Ada Lovelace', color: '#334455' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: {
        clientID: 1,
        getStates: () => new Map(),
      } as never,
    });
    dispose.push(
      mountPresenceIsland(
        el('board-people'),
        { onTap: vi.fn(), onLongPress: vi.fn() },
        { compact: true },
      ),
    );
    return { state, chrome };
  }

  const circles = () => [...el('board-people').querySelectorAll('.board-presence-circle')];

  it('the circle goes when the subscription does, with nothing remounted', async () => {
    // THE falsifiable one. Take a listening agent's stream away — which is
    // exactly what `loadAgents` writes into `state.agents` when the server's
    // `agent.listening` frame arrives — and the circle must leave a page that
    // was never reloaded and an island that was never remounted.
    const { state, chrome } = board([attached(RIVERBEND, { listening: true })]);
    chrome.renderPresenceRegion();
    await tick();
    expect(circles().map((c) => c.getAttribute('aria-label'))).toEqual([
      expect.stringContaining(RIVERBEND),
    ]);
    const host = el('board-people');
    const island = host.querySelector('[data-preact-island]');

    state.agents = [attached(RIVERBEND, { listening: false })];
    chrome.renderPresenceRegion();
    await tick();

    expect(circles()).toHaveLength(0);
    // Same island, same host: this was a repaint, not a reload. If the strip
    // had been torn down and rebuilt, the emptiness would prove nothing.
    expect(host.querySelector('[data-preact-island]')).toBe(island);
    // And an empty strip takes no room in the header rather than leaving a
    // gap where somebody used to be.
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('leaves no faded stand-in behind — absence is nothing, not something dim', async () => {
    // AC3 in computed values. A drawn circle is fully opaque; an absent agent
    // contributes no node at all, at either viewport.
    const { chrome } = board([
      // Listening, and quiet: the heartbeat clock says `away` while the
      // socket says here. This is the row the old fade actually reached, so
      // it is the row that proves the fade is gone rather than merely
      // unreachable.
      attached(RIVERBEND, {
        listening: true,
        state: 'away',
        stateLabel: 'away — requests queue',
      }),
      // Attached, quiet, and gone: the state that used to draw a 0.65-opacity
      // circle and read as "maybe somebody is there".
      attached(HARBORLIGHT, {
        listening: false,
        state: 'away',
        stateLabel: 'away — requests queue',
      }),
    ]);
    chrome.renderPresenceRegion();
    await tick();

    for (const viewport of [IPAD, PHONE]) {
      setViewport(viewport);
      const drawn = circles();
      expect(drawn, `one circle at ${viewport.width}px`).toHaveLength(1);
      const style = styleOf(drawn[0] as Element);
      const opacity = style.opacity;
      const width = style.width;
      const height = style.height;
      expect(opacity === '' || opacity === '1', `opaque at ${viewport.width}px`).toBe(true);
      // The convention's own size, unchanged by this ticket, at both tiers.
      expect(width, `28px wide at ${viewport.width}px`).toBe('28px');
      expect(height, `28px tall at ${viewport.width}px`).toBe('28px');
    }
  });

  it('an empty board draws no strip at all at either viewport', async () => {
    const { chrome } = board([attached(RIVERBEND), attached(HARBORLIGHT)]);
    chrome.renderPresenceRegion();
    await tick();
    for (const viewport of [IPAD, PHONE]) {
      setViewport(viewport);
      expect(circles(), `nothing at ${viewport.width}px`).toHaveLength(0);
      expect(el('board-people').classList.contains('hidden')).toBe(true);
    }
  });
});
