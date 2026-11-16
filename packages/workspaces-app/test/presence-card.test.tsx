/**
 * The two surfaces design F adds beside the presence deck (Bryan,
 * 2026-11-15; `presence-card.tsx`): the card a tap on a row opens, with Go
 * there and Follow, and the bar that says who the reader is following, with
 * Stop. Mounted through the same island as the deck
 * (`presence-island.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceChip } from '../src/board/board-presence-model.ts';
import {
  type PresenceHandlers,
  mountPresenceIsland,
  presenceData,
} from '../src/board/presence-island.tsx';
import { IPAD, installSheets, setViewport } from './css-harness.ts';

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const person = (name: string, over: Partial<PresenceChip> = {}): PresenceChip => ({
  key: `p-${name}`,
  label: name,
  kind: 'person',
  where: 'board',
  title: `${name} · in board · just now`,
  docId: 'doc-1',
  ...over,
});

const noop = (): PresenceHandlers => ({ onTap: vi.fn(), onLongPress: vi.fn() });

let dispose: Array<() => void> = [];
let sheets = () => {};
beforeEach(() => {
  setViewport(IPAD);
  sheets = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  sheets();
  for (const d of dispose) d();
  dispose = [];
  document.body.replaceChildren();
});

function mountPeople(
  chips: PresenceChip[],
  handlers: PresenceHandlers = noop(),
  opts: { followedKey?: string | null } = {},
) {
  const host = document.createElement('div');
  host.className = 'board-presence board-people';
  document.body.appendChild(host);
  presenceData.value = { chips, followedKey: opts.followedKey ?? null };
  dispose.push(mountPresenceIsland(host, handlers, { compact: true }));
  return { host, handlers };
}

/** Open a person's card, as a tap on their row in the open list does. */
async function openCard(host: HTMLElement, index = 0): Promise<void> {
  host.querySelector<HTMLButtonElement>('.board-presence-deck')?.click();
  await tick();
  host.querySelectorAll<HTMLButtonElement>('.board-presence-who')[index]?.click();
  await tick();
}
/** The open card's buttons: Go there (or Show me), then Follow. */
const cardButtons = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>('.board-presence-card .board-presence-act'),
];

describe('the presence card and the Following bar (design F)', () => {
  it('the card says where they are and offers Go there and Follow', async () => {
    const chip = person('Bob Saltmarsh', {
      here: false,
      line: 'On Riverbend launch plan',
      place: 'On Riverbend launch plan, reading “Tides”',
      page: 'Riverbend launch plan',
    });
    const handlers = noop();
    const { host } = mountPeople([chip], handlers);
    presenceData.value = { ...presenceData.value, app: 'Harborlight' };
    await openCard(host);
    const card = host.querySelector<HTMLElement>('.board-presence-card');
    expect(card?.querySelector('.board-presence-card-tag')?.textContent).toBe(
      'Elsewhere in Harborlight',
    );
    expect(card?.querySelector('.board-presence-card-where')?.textContent).toContain(
      'reading “Tides”',
    );
    const [go, follow] = cardButtons(host);
    expect(go?.textContent).toBe('Go there');
    expect(follow?.textContent).toBe('Follow');
    go?.click();
    expect(handlers.onTap).toHaveBeenCalledWith(chip);
    follow?.click();
    expect(handlers.onLongPress).toHaveBeenCalledWith(chip);
  });

  it('the card says Show me for someone here, Stop following for the followed', async () => {
    const chip = person('Alice Riverbend', { here: true, line: 'On Tasks' });
    const { host } = mountPeople([chip], noop(), { followedKey: chip.key });
    await openCard(host);
    expect(host.querySelector('.board-presence-card-tag')?.textContent).toBe('Here with you');
    expect(cardButtons(host).map((b) => b.textContent)).toEqual(['Show me', 'Stop following']);
  });

  it('the card closes on Escape and on a tap outside', async () => {
    const { host } = mountPeople([person('Alice Riverbend')]);
    await openCard(host);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(host.querySelector('.board-presence-card')).toBeNull();
    await openCard(host);
    expect(host.querySelector('.board-presence-card')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();
    expect(host.querySelector('.board-presence-card')).toBeNull();
  });

  it('a mouse over the bar leaves the list shut; over the deck it opens it', async () => {
    const bob = person('Bob Saltmarsh', { line: 'On Tasks', page: 'Tasks' });
    const { host } = mountPeople([bob], noop(), { followedKey: bob.key });
    // A browser fires pointerenter on the element the pointer comes onto and
    // on each of its ancestors it was not already inside.
    const enter = (target: string) => {
      for (let el = host.querySelector(target); el && el !== host; el = el.parentElement) {
        el.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      }
    };
    enter('.board-follow-bar');
    await tick();
    expect(host.querySelector('.board-presence-list')).toBeNull();
    // CONTROL: the same on the deck opens it.
    enter('.board-presence-deck');
    await tick();
    expect(host.querySelector('.board-presence-list')).not.toBeNull();
  });

  it('a follow shows a bar naming who and their page, whose Stop ends it', async () => {
    const bob = person('Bob Saltmarsh', { line: 'On Tasks', page: 'Tasks' });
    const handlers = noop();
    const { host } = mountPeople([bob], handlers);
    // CONTROL: no follow, no bar.
    expect(host.querySelector('.board-follow-bar')).toBeNull();
    presenceData.value = { chips: [bob], followedKey: bob.key };
    await tick();
    const bar = host.querySelector<HTMLElement>('.board-follow-bar');
    expect(bar?.getAttribute('aria-label')).toBe('Following Bob Saltmarsh');
    expect(bar?.querySelector('small')?.textContent).toBe('Tasks');
    const stop = bar?.querySelector<HTMLButtonElement>('button');
    expect(stop?.getAttribute('aria-label')).toBe('Stop following Bob Saltmarsh');
    stop?.click();
    expect(handlers.onLongPress).toHaveBeenCalledWith(bob);
  });
});
