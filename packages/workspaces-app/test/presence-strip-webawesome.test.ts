import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * The board's presence strip on Web Awesome (D1 step 10), driven through the
 * real board boot against the fake server and feed.
 *
 * A board the collab core serves draws each circle as a `<wa-avatar>` in a
 * bare button; every other board draws today's filled button. Both are fed by
 * the same awareness and roster, so the claims below are the same for both
 * faces and are run against each: the same people in the same order with the
 * same labels, and the same follow ring armed by the same long-press, with the
 * follow taking the reader where it does today. Then the live half: a
 * `collab-core.changed` frame swaps the strip on an open page, and a resync
 * after the stream was down reads the record again.
 *
 * Names are the house placeholders — the repo is public.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { collabCoreActive } from '../src/board/presence-core-switch.ts';
import { LIVE_RESYNC_MIN_MS } from '../src/connection-state.ts';
import { FakeEventSource } from './boot-harness.ts';
import {
  type Booted,
  WS,
  bootTestBoard,
  el,
  longPress,
  resetBoardServerWith,
  server,
  settle,
} from './support/board-drive.ts';

const AGENT = 'agent-harborlight';

/** Every route the boot reads, with the board record saying whether the
 *  collab core serves this board, and one listening agent on the roster. */
function recordSays(active: boolean | undefined): void {
  resetBoardServerWith(active === undefined ? {} : { collabCore: { active } });
  server.on(`/workspaces/${WS}/agents`, {
    workspaceId: WS,
    attachments: [
      { agentId: AGENT, state: 'active', stateLabel: 'active', lastToolCallAt: 1, listening: true },
    ],
  });
}

/** Wait for the strip to show the face it should. The Web Awesome strip is an
 *  `import()`, so it arrives some turns after the signal moves. */
async function untilFace(face: 'classic' | 'wa'): Promise<void> {
  const selector = face === 'wa' ? '.board-presence-wa' : '.board-presence-circle';
  for (let i = 0; i < 200; i++) {
    if (el('board-people').querySelector(selector)) return;
    await settle();
  }
  throw new Error(`the strip never showed the ${face} face`);
}

function joinBoard(board: Booted, user: { id: string; name: string }) {
  const peer = new Awareness(new Y.Doc());
  return async (where: { surface: string; docId?: string }): Promise<void> => {
    peer.setLocalState({ user, lastActive: Date.now(), ...where });
    applyAwarenessUpdate(
      board.sockets.first().awareness,
      encodeAwarenessUpdate(peer, [peer.clientID]),
      'remote',
    );
    await settle();
  };
}

/** What a reader can tell about each circle: who, which face, which ring. */
function strip() {
  return [...el('board-people').querySelectorAll<HTMLButtonElement>('button')].map((b) => {
    const avatar = b.querySelector('wa-avatar');
    return {
      label: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      kind: b.classList.contains('board-presence-agent') ? 'agent' : 'person',
      following: b.classList.contains('board-following'),
      // What the avatar drew in its shadow root, not the property it was
      // handed: a component that never rendered would still hold the prop.
      initials: avatar
        ? avatar.shadowRoot?.querySelector('[part="initials"]')?.textContent
        : b.textContent,
      shape: avatar?.getAttribute('shape') ?? null,
    };
  });
}

const circleFor = (name: string): HTMLButtonElement => {
  const found = el('board-people').querySelector<HTMLButtonElement>(
    `button[aria-label^="${name}"]`,
  );
  if (!found) throw new Error(`no presence circle for ${name}`);
  return found;
};

beforeEach(() => {
  recordSays(undefined);
  collabCoreActive.value = false;
  for (const l of document.head.querySelectorAll('link[data-wa-theme]')) l.remove();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Boot a board, put Alice on it, follow her, and read the strip. */
async function followAlice(active: boolean) {
  recordSays(active);
  const board = await bootTestBoard();
  await untilFace(active ? 'wa' : 'classic');
  const alice = joinBoard(board, { id: 'u-alice', name: 'Alice' });
  await alice({ surface: 'board' });
  const before = strip();
  await longPress(board, circleFor('Alice'));
  const after = strip();
  await alice({ surface: 'doc', docId: 'saltmarsh-notes' });
  return { board, before, after, navigations: board.location.navigations };
}

describe('done-when 1: the Web Awesome strip shows what today’s does', () => {
  it('draws each circle from a wa-avatar: a circle for a person, a rounded square for an agent', async () => {
    const { before } = await followAlice(true);
    const avatars = [...el('board-people').querySelectorAll('button > wa-avatar')];
    expect(avatars).toHaveLength(before.length);
    expect(customElements.get('wa-avatar'), 'the component registered itself').toBeDefined();
    expect(before.map((c) => [c.kind, c.shape])).toEqual(
      before.map((c) => [c.kind, c.kind === 'agent' ? 'rounded' : 'circle']),
    );
    expect(el('board-people').querySelector('.board-presence-circle')).toBeNull();
    // The theme file is linked once, for this strip.
    expect(document.querySelectorAll('link[data-wa-theme]')).toHaveLength(1);
  });

  it('shows the same people, labels, initials, follow ring and follow as today’s strip', async () => {
    const classic = await followAlice(false);
    const wa = await followAlice(true);

    const who = (s: ReturnType<typeof strip>) =>
      s.map(({ label, title, kind, following, initials }) => ({
        label,
        title,
        kind,
        following,
        initials: initials?.trim(),
      }));
    // A control: the strip has the reader, Alice and the agent, and the ring
    // moved — so equal lists are not two empty strips agreeing.
    expect(classic.before.map((c) => c.kind).sort()).toEqual(['agent', 'person', 'person']);
    expect(who(classic.after).filter((c) => c.following)).toHaveLength(1);

    expect(who(wa.before)).toEqual(who(classic.before));
    expect(who(wa.after)).toEqual(who(classic.after));
    expect(wa.navigations).toEqual(classic.navigations);
    expect(wa.navigations).toEqual([`/workspaces/${WS}/docs/saltmarsh-notes`]);
  });
});

describe('done-when 2: with the setting off, the page shows today’s strip', () => {
  it('draws today’s filled circles and loads no Web Awesome', async () => {
    for (const active of [false, undefined]) {
      recordSays(active);
      await bootTestBoard();
      await untilFace('classic');
      const circles = [...el('board-people').querySelectorAll('.board-presence-circle')];
      expect(circles.length).toBeGreaterThan(0);
      expect(el('board-people').querySelector('wa-avatar, .board-presence-wa')).toBeNull();
      expect(circles[0]?.querySelector('.board-presence-initials')).not.toBeNull();
      expect(document.querySelector('link[data-wa-theme]')).toBeNull();
    }
  });
});

describe('the setting is live', () => {
  /** Push one server frame at the feed the boot wired. */
  async function feed(event: string, data: unknown): Promise<void> {
    FakeEventSource.last().dispatchEvent(
      Object.assign(new Event(event), { data: JSON.stringify(data) }),
    );
    await settle();
  }

  it('swaps the strip on an open page when the owner flips it, both ways', async () => {
    recordSays(false);
    await bootTestBoard();
    await untilFace('classic');
    const people = () => strip().map((c) => c.label);
    const shown = people();

    await feed('collab-core.changed', {
      event: 'collab-core.changed',
      workspaceId: WS,
      active: true,
    });
    await untilFace('wa');
    expect(el('board-people').querySelector('.board-presence-circle')).toBeNull();
    expect(people()).toEqual(shown);

    await feed('collab-core.changed', {
      event: 'collab-core.changed',
      workspaceId: WS,
      active: false,
    });
    await untilFace('classic');
    expect(el('board-people').querySelector('wa-avatar')).toBeNull();
    expect(people()).toEqual(shown);
  });

  it('reads the record again when the stream comes back, for a flip it missed', async () => {
    recordSays(false);
    await bootTestBoard();
    await untilFace('classic');

    // The flip happened while the stream was down: no frame, only the record.
    // Only the Date is faked: the resync is held off for two seconds after
    // boot, and the strip's own load still needs real turns.
    vi.useFakeTimers({ toFake: ['Date'] });
    recordSays(true);
    const es = FakeEventSource.last();
    es.dispatchEvent(new Event('open'));
    es.dispatchEvent(new Event('error'));
    await settle();
    expect(
      el('board-people').querySelector('.board-presence-wa'),
      'no frame, no swap yet',
    ).toBeNull();
    vi.setSystemTime(Date.now() + LIVE_RESYNC_MIN_MS + 1);
    es.dispatchEvent(new Event('open'));
    await untilFace('wa');
  });
});
