/**
 * The presence strip as a Preact island — the deck of people that
 * `renderPresence` used to rebuild from scratch on every paint.
 *
 * Three families of properties under test:
 *
 *  1. The island contract: an unchanged participant survives a signal update
 *     as the IDENTICAL node object, disposal is render(null, el), and the
 *     island owns a wrapper rather than the host.
 *
 *  2. The defect the migration exists for, in the form it takes HERE. A
 *     circle carries a 550ms long-press and the strip repaints under it — on
 *     awareness updates, on SSE agent refreshes, on a 30s tick. When the node
 *     was rebuilt mid-press, the `pointerup` meant to cancel the follow
 *     arrived on a replacement whose disarm closure knew nothing about the
 *     armed timer, and the follow fired anyway. Pinned below.
 *
 *  3. The strip as design F: a deck of circles that opens into a list of
 *     two groups (here with you, elsewhere), rows that open a card on a tap and
 *     follow on a hold or on Follow, liveness classes and the long-form chip.
 *
 * The card a row opens and the Following bar are `presence-card.test.tsx`;
 * the drift notices the same module mounts are `presence-drift-island.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceChip } from '../src/board/board-presence-model.ts';
import {
  type PresenceHandlers,
  mountPresenceIsland,
  presenceData,
} from '../src/board/presence-island.tsx';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Comfortably past the 550ms long-press threshold. */
const LONG_ENOUGH = 700;

const person = (name: string, over: Partial<PresenceChip> = {}): PresenceChip => ({
  key: `p-${name}`,
  label: name,
  kind: 'person',
  where: 'board',
  title: `${name} · in board · just now`,
  docId: 'doc-1',
  ...over,
});

const agent = (id: string, over: Partial<PresenceChip> = {}): PresenceChip => ({
  key: `a-${id}`,
  label: id,
  kind: 'agent',
  where: 'active',
  title: `${id} · active · last tool call just now`,
  state: 'active',
  ...over,
});

const noop = (): PresenceHandlers => ({ onTap: vi.fn(), onLongPress: vi.fn() });

let dispose: Array<() => void> = [];

/** The page's own sheets, in the order the board shell loads them, so any test
 *  here may read a computed value. Installing a stylesheet changes no text and
 *  no structure, so the behavioural cases either side are unaffected. */
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
  vi.useRealTimers();
});

/** The deck's circles, in order. */
const deckCircles = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('.board-presence-deck .board-presence-circle'),
];
/** The elements `sel` matches that the page draws at the current width. */
const shownIn = (host: HTMLElement, sel: string) =>
  [...host.querySelectorAll<HTMLElement>(sel)].filter((c) => styleOf(c).display !== 'none');
/** Open the list, as a tap on the deck does, and settle the render. */
async function openList(host: HTMLElement): Promise<void> {
  host.querySelector<HTMLButtonElement>('.board-presence-deck')?.click();
  await tick();
}
/** Each row's "who" button, in order. */
const rowButtons = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>('.board-presence-who'),
];

function mountPeople(
  chips: PresenceChip[],
  handlers: PresenceHandlers = noop(),
  opts: { compact?: boolean; followedKey?: string | null } = {},
) {
  const host = document.createElement('div');
  host.className = 'board-presence board-people';
  document.body.appendChild(host);
  presenceData.value = { chips, followedKey: opts.followedKey ?? null };
  dispose.push(mountPresenceIsland(host, handlers, { compact: opts.compact ?? true }));
  return { host, handlers };
}

describe('presence island contract', () => {
  it('keeps an unchanged participant as the IDENTICAL node object when another changes', async () => {
    const { host } = mountPeople([person('Alice Riverbend'), agent('task-list-ux')]);
    const circles = deckCircles(host);
    expect(circles).toHaveLength(2);
    const anasCircle = circles[0] as HTMLElement;

    // The agent's liveness moves — the commonest real update on this strip.
    presenceData.value = {
      chips: [
        person('Alice Riverbend'),
        agent('task-list-ux', {
          state: 'unresponsive',
          title: 'task-list-ux · process up, agent unresponsive · last tool call 40m ago',
        }),
      ],
      followedKey: null,
    };
    await tick();

    const after = deckCircles(host);
    expect(after[1]?.classList.contains('board-presence-unresponsive')).toBe(true);
    // The identity property the migration exists for: same object, not a
    // recreated equal.
    expect(after[0]).toBe(anasCircle);
  });

  it('keeps the node when only the person’s own reading changes', async () => {
    // The 30s tick rewrites every title ("just now" → "40s ago") and nothing
    // else. Under the vanilla renderer that alone rebuilt the whole strip.
    const { host } = mountPeople([person('Alice Riverbend'), person('Bob Saltmarsh')]);
    await openList(host);
    const [a, b] = rowButtons(host);

    presenceData.value = {
      chips: [
        person('Alice Riverbend', { line: 'On Library' }),
        person('Bob Saltmarsh', { line: 'On Library' }),
      ],
      followedKey: null,
    };
    await tick();

    const after = rowButtons(host);
    expect(after[0]).toBe(a);
    expect(after[1]).toBe(b);
    expect(after[0]?.getAttribute('title')).toBe('Alice Riverbend · On Library');
  });

  it('a focused row keeps focus across a signal update', async () => {
    const { host } = mountPeople([person('Alice Riverbend'), person('Bob Saltmarsh')]);
    await openList(host);
    const ben = rowButtons(host)[1] as HTMLButtonElement;
    ben.focus();
    expect(document.activeElement).toBe(ben);

    presenceData.value = {
      chips: [
        person('Alice Riverbend', { title: 'Alice Riverbend · in doc-2 · just now' }),
        person('Bob Saltmarsh'),
      ],
      followedKey: null,
    };
    await tick();
    expect(document.activeElement).toBe(ben);
  });

  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.appendChild(host);

    presenceData.value = { chips: [person('Alice Riverbend')], followedKey: null };
    const unmount = mountPresenceIsland(host, noop(), { compact: true });

    const wrapper = host.querySelector('[data-preact-island="presence"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.board-presence-deck')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // render(null, el) ran before el.remove(): teardown, not bare removal.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="presence"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so the deck stays a direct flex item', () => {
    // Without `display: contents` on the island's wrapper the whole strip
    // becomes ONE flex item of `.board-presence`, and the 430px fit, the gap and
    // `.board-drift`'s own-line rule all stop applying.
    //
    // Measured off the mounted island rather than read out of the stylesheet:
    // the rule is `.board-presence > [data-preact-island]`, so it only holds if
    // the wrapper Preact creates is a DIRECT child of a `.board-presence` host —
    // which is the half a text read cannot see. happy-dom lays nothing out, so
    // this is the `display` the browser would use, not the row it produces.
    const { host } = mountPeople([
      person('Alice Riverbend', { here: true }),
      person('Bob Saltmarsh', { here: true }),
    ]);
    const wrapper = host.querySelector('[data-preact-island="presence"]') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(styleOf(wrapper).display).toBe('contents');
    // Positive control: the sheets are attached and the host really is the
    // strip the rule is scoped to — an unstyled element reads `''` for every
    // property, which would make "not a box" true of nothing.
    //
    // The circle is checked by VALUE for the same reason. `not.toBe('')` was
    // satisfied by any rule at all reaching the element, including one that
    // had stopped making it a circle; `50%` and `28px` are what
    // `.board-presence-circle` sets.
    expect(styleOf(host).display).toBe('flex');
    const circle = styleOf(host.querySelector('.board-presence-circle') as HTMLElement);
    expect(circle.borderRadius).toBe('50%');
    expect(circle.width).toBe('28px');
  });
});

describe('presence island — a repaint under a live press', () => {
  it('does not fire the follow when the press was released across a repaint', async () => {
    // THE defect, in the form it took here. Vanilla rebuilt every circle on
    // every paint, so a repaint between pointerdown and pointerup left the
    // armed timer pointing at a node the reader was no longer touching: the
    // pointerup landed on the REPLACEMENT, whose disarm closure knew nothing
    // about the running timer, and the follow fired on a released press.
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Alice Riverbend'), person('Bob Saltmarsh')], handlers);
    host.querySelector<HTMLButtonElement>('.board-presence-deck')?.click();
    await vi.advanceTimersByTimeAsync(0);
    const ana = rowButtons(host)[0] as HTMLButtonElement;

    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(200);

    // A 30s tick / awareness update lands mid-press.
    presenceData.value = {
      chips: [
        person('Alice Riverbend'),
        person('Bob Saltmarsh', { title: 'Bob Saltmarsh · in doc-9 · just now' }),
      ],
      followedKey: null,
    };
    await vi.advanceTimersByTimeAsync(0);

    // The release goes to whatever node is under the finger NOW — which is
    // the whole point: it must be the same node that armed the timer. (Asking
    // the DOM rather than reusing `ana` is what makes this a regression test;
    // dispatching on the captured reference would pass even against a
    // renderer that had replaced the node the reader is touching.)
    const underTheFinger = rowButtons(host)[0] as HTMLButtonElement;
    expect(underTheFinger).toBe(ana);
    underTheFinger.dispatchEvent(new Event('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(LONG_ENOUGH);
    expect(handlers.onLongPress).not.toHaveBeenCalled();
  });

  it('still follows when the press is genuinely held through a repaint', async () => {
    // The positive control for the case above: the repaint must not swallow
    // a real long-press either.
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Alice Riverbend')], handlers);
    host.querySelector<HTMLButtonElement>('.board-presence-deck')?.click();
    await vi.advanceTimersByTimeAsync(0);
    const ana = rowButtons(host)[0] as HTMLButtonElement;

    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    presenceData.value = {
      chips: [person('Alice Riverbend', { title: 'Alice Riverbend · in board · 40s ago' })],
      followedKey: null,
    };
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(LONG_ENOUGH);

    expect(handlers.onLongPress).toHaveBeenCalledTimes(1);
    // …and the click that follows a completed long-press must not ALSO jump.
    ana.dispatchEvent(new Event('click', { bubbles: true }));
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('a cancelled press disarms — one scroll must not wedge the strip', async () => {
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Alice Riverbend')], handlers);
    host.querySelector<HTMLButtonElement>('.board-presence-deck')?.click();
    await vi.advanceTimersByTimeAsync(0);
    const ana = rowButtons(host)[0] as HTMLButtonElement;
    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    ana.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    vi.advanceTimersByTime(LONG_ENOUGH);
    expect(handlers.onLongPress).not.toHaveBeenCalled();
  });
});

describe('presence island — the deck and its list (design F)', () => {
  it('draws one deck button whose circles carry initials, and no long-form chip', () => {
    const { host } = mountPeople([person('Alice Riverbend'), agent('task-list-ux')]);
    expect(host.querySelectorAll('button.board-presence-deck')).toHaveLength(1);
    expect(host.querySelector('.board-presence-chip')).toBeNull();
    const [p, a] = deckCircles(host);
    expect(p?.querySelector('.board-presence-initials')?.textContent).toBe('AR');
    expect(a?.classList.contains('board-presence-agent')).toBe(true);
    expect(a?.querySelector('.board-presence-initials')?.textContent).toBe('TL');
    // Closed: no list yet.
    expect(host.querySelector('.board-presence-list')).toBeNull();
  });

  it('opens into two groups: here with you on this page, elsewhere in the workspace', async () => {
    const { host } = mountPeople([
      person('Alice Riverbend', { here: true, line: 'At “Tides”' }),
      person('Bob Saltmarsh', { here: false, line: 'On Riverbend launch plan' }),
      agent('task-list-ux', { here: false, line: 'On Tasks' }),
    ]);
    presenceData.value = { ...presenceData.value, page: 'Quay', app: 'Harborlight' };
    await tick();
    const deck = host.querySelector<HTMLButtonElement>('.board-presence-deck');
    expect(deck?.getAttribute('aria-label')).toBe('1 here with you, 2 elsewhere');
    expect(deck?.getAttribute('aria-expanded')).toBe('false');
    // Here first, full size; the rest after it, small.
    expect(deckCircles(host).map((c) => c.classList.contains('board-presence-here'))).toEqual([
      true,
      false,
      false,
    ]);
    await openList(host);
    expect(deck?.getAttribute('aria-expanded')).toBe('true');
    const list = host.querySelector('.board-presence-list');
    const lines = [...(list?.children ?? [])].map((el) =>
      el.classList.contains('board-presence-group')
        ? `# ${el.textContent}`
        : `${el.querySelector('b')?.textContent} / ${el.querySelector('small')?.textContent}`,
    );
    expect(lines).toEqual([
      '# Here with you · Quay',
      'Alice Riverbend / At “Tides”',
      '# Elsewhere in Harborlight',
      'Bob Saltmarsh / On Riverbend launch plan',
      'task-list-ux / On Tasks',
    ]);
  });

  it('says "Only you" under the first group when nobody shares the page', async () => {
    const { host } = mountPeople([person('Bob Saltmarsh', { here: false, line: 'On Tasks' })]);
    await openList(host);
    expect(host.querySelector('.board-presence-only')?.textContent).toBe('Only you');
  });

  it('a row opens its card and closes the list; Follow on the row follows', async () => {
    const chip = person('Bob Saltmarsh', { here: false, line: 'On Tasks' });
    const handlers = noop();
    const { host } = mountPeople([chip], handlers);
    await openList(host);
    rowButtons(host)[0]?.click();
    await tick();
    expect(handlers.onTap).not.toHaveBeenCalled();
    expect(host.querySelector('.board-presence-deck')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.board-presence-card')?.getAttribute('aria-label')).toBe(
      'Bob Saltmarsh',
    );
    await openList(host);
    expect(host.querySelector('.board-presence-card')).toBeNull();
    const follow = host.querySelector<HTMLButtonElement>('.board-presence-follow');
    expect(follow?.textContent).toBe('Follow');
    expect(follow?.getAttribute('aria-label')).toBe('Follow Bob Saltmarsh');
    follow?.click();
    expect(handlers.onLongPress).toHaveBeenCalledWith(chip);
  });

  it('marks who is followed, on the deck and in the list, with Stop on their row', async () => {
    const chip = agent('quill', { state: 'unresponsive' });
    const { host } = mountPeople([chip], noop(), { followedKey: chip.key });
    const [circle] = deckCircles(host);
    expect(circle?.classList.contains('board-presence-unresponsive')).toBe(true);
    expect(circle?.classList.contains('board-following')).toBe(true);
    await openList(host);
    expect(host.querySelector('.board-presence-follow')?.textContent).toBe('Stop');
    expect(rowButtons(host)[0]?.getAttribute('title')).toContain('· following');
  });

  it('holds at most four marks in the deck, the last counting the rest; the list names everyone', async () => {
    const chips = ['Alice', 'Bob', 'Harborlight', 'Riverbend', 'Saltmarsh'].map((n) => person(n));
    const { host } = mountPeople(chips);
    // Three circles and "+2": the marks add up to all five.
    expect(deckCircles(host)).toHaveLength(3);
    expect(shownIn(host, '.board-presence-more').map((m) => m.textContent)).toEqual(['+2']);
    expect(host.querySelector('.board-presence-names')?.textContent).toBe(
      'Alice, Bob, Harborlight',
    );
    await openList(host);
    expect(rowButtons(host)).toHaveLength(5);
  });

  it('holds three marks on a phone, so its slot stays narrow', () => {
    const chips = ['Alice', 'Bob', 'Harborlight', 'Riverbend', 'Saltmarsh'].map((n) => person(n));
    const { host } = mountPeople(chips);
    setViewport(PHONE);
    expect(shownIn(host, '.board-presence-deck .board-presence-circle')).toHaveLength(2);
    expect(shownIn(host, '.board-presence-more').map((m) => m.textContent)).toEqual(['+3']);
    expect(shownIn(host, '.board-presence-names')).toHaveLength(0);
  });

  it('draws everybody when they fit, with no count', () => {
    const { host } = mountPeople(['Alice', 'Bob', 'Riverbend', 'Saltmarsh'].map((n) => person(n)));
    expect(deckCircles(host)).toHaveLength(4);
    expect(shownIn(host, '.board-presence-more')).toHaveLength(0);
  });

  it('closes on Escape and on a tap outside the strip', async () => {
    const { host } = mountPeople([person('Alice Riverbend')]);
    const deck = host.querySelector<HTMLButtonElement>('.board-presence-deck');
    await openList(host);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(deck?.getAttribute('aria-expanded')).toBe('false');
    await openList(host);
    expect(deck?.getAttribute('aria-expanded')).toBe('true');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();
    expect(deck?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when keyboard focus leaves the strip, and stays open while it moves inside', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { host } = mountPeople([person('Alice')]);
    const deck = host.querySelector<HTMLButtonElement>('.board-presence-deck');
    await openList(host);
    const follow = host.querySelector<HTMLButtonElement>('.board-presence-follow');
    rowButtons(host)[0]?.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: follow }),
    );
    await tick();
    expect(deck?.getAttribute('aria-expanded')).toBe('true');
    follow?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await tick();
    expect(deck?.getAttribute('aria-expanded')).toBe('false');
  });

  it('draws the followed participant first, and names the follow on the deck', async () => {
    const chips = ['Alice', 'Bob', 'Harborlight', 'Riverbend', 'Saltmarsh'].map((n) =>
      person(n, { here: true }),
    );
    const { host } = mountPeople(chips, noop(), { followedKey: 'p-Saltmarsh' });
    // Fifth in the room, so without the rule the deck would not draw it.
    expect(deckCircles(host)[0]?.dataset.key).toBe('p-Saltmarsh');
    expect(host.querySelector('.board-presence-deck')?.getAttribute('aria-label')).toBe(
      '5 here with you, 0 elsewhere, following Saltmarsh',
    );
  });

  it('titles a row with the words it shows, never the chip’s doc id', async () => {
    const chip = person('Bob', { title: 'Bob · in d-123 · 3s ago', line: 'On Riverbend plan' });
    const { host } = mountPeople([chip]);
    await openList(host);
    expect(rowButtons(host)[0]?.getAttribute('title')).toBe('Bob · On Riverbend plan');
  });

  it('renders the long form when compact is off — the name and the surface, spelled out', () => {
    const { host } = mountPeople([person('Alice Riverbend')], noop(), { compact: false });
    const chip = host.querySelector('.board-presence-chip');
    expect(chip?.textContent).toContain('Alice Riverbend');
    expect(chip?.querySelector('.board-presence-where')?.textContent).toBe('board');
    expect(host.querySelector('.board-presence-deck')).toBeNull();
  });

  it('hides the host when nobody but the reader is here, and unhides when somebody arrives', async () => {
    const { host } = mountPeople([person('Me', { self: true })]);
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.querySelector('.board-presence-deck')).toBeNull();

    presenceData.value = {
      chips: [person('Me', { self: true }), person('Alice Riverbend')],
      followedKey: null,
    };
    await tick();
    expect(host.classList.contains('hidden')).toBe(false);
    // The reader is never one of the circles.
    expect(deckCircles(host)).toHaveLength(1);
  });
});
