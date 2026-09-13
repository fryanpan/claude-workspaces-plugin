import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLED_MS, stackColumn } from '../src/voice/voice-ui.ts';
import { box, comment, heights, rowAt, screen, setup } from './voice-ui-harness.ts';

/**
 * Where the view stands its cards: a column beside the page on a wide screen,
 * and on a phone one card at a time, docked clear of the page.
 */

beforeEach(() => {
  // The view places its cards every frame while any is up; the tests call
  // `place` themselves where placement is what they read.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a phone after Stop', () => {
  it('is a pin while recording, and after Stop shows the newest card for a moment', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(430);
    const t = setup();
    t.add(comment({ key: 'v1', final: true }));
    t.add(comment({ key: 'v2', final: true, text: 'The Save button hides.' }));
    t.view.place();
    expect(t.card('v1')?.hidden, 'no card over the page while talking').toBe(true);
    expect(t.card('v2')?.hidden).toBe(true);

    t.session.state = 'idle';
    t.view.render();
    t.view.place();
    expect(t.card('v1')?.hidden, 'the older one waits behind the newest').toBe(true);
    expect(t.card('v2')?.hidden).toBe(false);

    // Talking again straight away: the card gives the page back.
    t.session.state = 'recording';
    t.view.render();
    t.view.place();
    expect(t.card('v2')?.hidden, 'hidden again while talking').toBe(true);
    t.session.state = 'idle';
    t.view.render();
    t.view.place();
    expect(t.card('v2')?.hidden).toBe(false);

    t.card('v2')?.dispatchEvent(new Event('pointerenter'));
    t.advance(SETTLED_MS + 1);
    t.view.place();
    expect(t.card('v2'), 'kept while being read').not.toBeNull();
    t.card('v2')?.dispatchEvent(new Event('pointerleave'));
    t.advance(SETTLED_MS + 1);
    t.view.place();
    expect(t.card('v2')).toBeNull();
    expect(t.card('v1'), 'and the rest go with it').toBeNull();
  });

  it('steps back to the earlier cards from the recording, and forward again', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(430);
    const t = setup();
    for (const key of ['v1', 'v2', 'v3']) t.add(comment({ key, final: true, text: key }));
    t.session.state = 'idle';
    t.view.render();
    const shown = () => ['v1', 'v2', 'v3'].filter((k) => t.card(k)?.hidden === false);
    const tap = (key: string, cls: string) =>
      (t.card(key)?.querySelector(cls) as HTMLButtonElement).click();
    expect(shown()).toEqual(['v3']);
    expect(t.card('v3')?.querySelector('.vpager')?.textContent).toBe('‹3 of 3›');
    expect((t.card('v3')?.querySelector('.vnext') as HTMLButtonElement).disabled).toBe(true);

    tap('v3', '.vprev');
    t.view.place();
    expect(shown()).toEqual(['v2']);
    tap('v2', '.vprev');
    t.view.place();
    expect(shown()).toEqual(['v1']);
    expect((t.card('v1')?.querySelector('.vprev') as HTMLButtonElement).disabled).toBe(true);
    // Paging keeps the card up past the moment Stop gave it.
    t.advance(SETTLED_MS - 1);
    tap('v1', '.vnext');
    t.advance(SETTLED_MS - 1);
    t.view.place();
    expect(shown()).toEqual(['v2']);
  });

  it('pages through this recording’s cards only, not ones left up from the last', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(430);
    const t = setup();
    t.add(comment({ key: 'v1', final: true }));
    t.session.state = 'idle';
    t.view.render();
    // Recording again inside the moment the last card is up.
    t.session.state = 'recording';
    t.view.render();
    for (const key of ['2.v1', '2.v2']) t.add(comment({ key, take: 2, final: true, text: key }));
    t.session.state = 'idle';
    t.view.render();
    t.view.place();
    expect(t.card('2.v2')?.querySelector('.vpager')?.textContent).toBe('‹2 of 2›');
    (t.card('2.v2')?.querySelector('.vprev') as HTMLButtonElement).click();
    t.view.place();
    const prev = t.card('2.v1')?.querySelector('.vprev') as HTMLButtonElement;
    expect([t.card('2.v1')?.hidden, prev.disabled]).toEqual([false, true]);
    expect(t.card('v1')?.querySelector('.vpager'), 'the last recording’s card is alone').toBeNull();
  });

  it('CONTROL: a wide screen shows every card in its column, with no pager', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    for (const key of ['v1', 'v2']) t.add(comment({ key, final: true }));
    t.session.state = 'idle';
    t.view.render();
    t.view.place();
    expect(['v1', 'v2'].map((k) => t.card(k)?.hidden)).toEqual([false, false]);
    expect(t.card('v1')?.classList.contains('paged')).toBe(false);
  });
});

describe('the column of cards beside the page', () => {
  it('opening a card’s raw words moves the others instead of hiding one', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(100, 140));
    t.elements.set(4, rowAt(300, 340));
    t.elements.set(5, rowAt(500, 540));
    t.add(comment({ key: 'v1', target: 3, final: true }));
    t.add(comment({ key: 'v2', target: 4, final: true }));
    t.add(comment({ key: 'v3', target: 5, final: true }));
    t.view.place();
    expect(['v1', 'v2', 'v3'].map((k) => t.card(k)?.hidden)).toEqual([false, false, false]);

    (t.card('v2')?.querySelector('.vrawbtn') as HTMLElement).click();
    t.view.place();
    expect(
      ['v1', 'v2', 'v3'].map((k) => t.card(k)?.hidden),
      'all three still fit the column',
    ).toEqual([false, false, false]);
    const [a, b, c] = ['v1', 'v2', 'v3'].map((k) => box(t.card(k)));
    // In the order of their elements, overlapping nothing, above the buttons.
    expect(a.bottom).toBeLessThanOrEqual(b.top);
    expect(b.bottom).toBeLessThanOrEqual(c.top);
    expect(c.bottom).toBeLessThanOrEqual(820 - 8 - 190);
  });

  it('uses the height down to the mic before hiding a card', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    // The mic's top, as a wide screen stands it: 80px up, not 190.
    const mic = document.createElement('button');
    mic.className = 'fab-mic';
    t.shadow.append(mic);
    vi.spyOn(mic, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 1116, y: 740, width: 44, height: 44 }),
    );
    t.elements.set(3, rowAt(40, 80));
    t.elements.set(4, rowAt(200, 240));
    t.elements.set(5, rowAt(300, 340));
    t.add(comment({ key: 'v1', target: 4, final: true }));
    t.add(comment({ key: 'v2', target: 5, final: true }));
    for (const k of ['v1', 'v2']) (t.card(k)?.querySelector('.vrawbtn') as HTMLElement).click();
    // Talking on about the heading: the live card and two open cards, 690px.
    t.add(comment({ key: 'v3', target: 3 }));
    t.view.place();
    expect(['v1', 'v2'].map((k) => t.card(k)?.hidden)).toEqual([false, false]);
    expect(t.view.live.hidden).toBe(false);
    expect(Math.max(box(t.card('v1')).bottom, box(t.card('v2')).bottom)).toBeLessThanOrEqual(732);
  });

  it('stands cards in the order of their elements, so leader lines do not cross', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    // Said about the upper element first; the newer card is placed first.
    t.elements.set(3, rowAt(380, 420));
    t.elements.set(4, rowAt(400, 440));
    t.add(comment({ key: 'v1', target: 3, final: true }));
    t.add(comment({ key: 'v2', target: 4, final: true }));
    t.view.place();
    expect(box(t.card('v1')).bottom).toBeLessThanOrEqual(box(t.card('v2')).top);
  });
});

describe('stackColumn', () => {
  it('keeps the most important cards that fit together, and hides the rest', () => {
    // 600px of column; the third card would need 610.
    const ys = stackColumn(
      [
        { h: 300, want: 0 },
        { h: 200, want: 0 },
        { h: 100, want: 0 },
        { h: 50, want: 0 },
      ],
      0,
      600,
    );
    expect(ys.map((y) => y !== null)).toEqual([true, true, false, true]);
  });

  it('stands each card as near its element as its neighbours allow, inside the column', () => {
    expect(
      stackColumn(
        [
          { h: 100, want: 580 },
          { h: 100, want: 20 },
        ],
        10,
        600,
      ),
    ).toEqual([500, 20]);
    // Two that want the bottom share it: the upper one moves up.
    expect(
      stackColumn(
        [
          { h: 100, want: 550 },
          { h: 100, want: 560 },
        ],
        10,
        600,
      ),
    ).toEqual([390, 500]);
  });
});

describe('the live comment on a phone', () => {
  it('rests above the buttons rather than across the rows under its element', () => {
    screen(430, 932);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(78, 125));
    t.add(comment({ target: 3 }));
    t.view.place();
    const live = box(t.view.live);
    expect(live.bottom).toBe(932 - 8 - 190);
    // Nothing between the element and the buttons is covered.
    expect(live.top).toBeGreaterThan(125 + 8 + 150);
  });

  it('goes to the top when resting above the buttons would cover its element', () => {
    screen(430, 932);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(640, 700));
    t.add(comment({ target: 3 }));
    t.view.place();
    expect(box(t.view.live).top).toBe(8);
  });
});

describe('the live card attaching', () => {
  it('has its place the moment it attaches, not a frame later', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(100, 140));
    t.add(comment());
    t.add(comment({ target: 3 }));
    // No frame has run (rAF is stubbed): the render placed it.
    expect(t.view.live.style.left).toBe(`${1180 - 16 - 280}px`);
    expect(t.view.live.style.top).toBe('100px');
  });
});

describe('the element a phone’s live card is about', () => {
  it('is outlined while the card rests away from it', () => {
    screen(430, 932);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(78, 125));
    t.add(comment({ target: 3 }));
    t.view.place();
    const mark = t.shadow.querySelector('.vhl') as HTMLElement;
    expect(mark.hidden).toBe(false);
    expect([mark.style.top, mark.style.height]).toEqual(['75px', '53px']);
    t.session.state = 'idle';
    t.view.render();
    expect(mark.hidden, 'gone with the live card').toBe(true);
  });

  it('CONTROL: is not outlined on a wide screen, where a line joins them', () => {
    screen(1180, 820);
    heights();
    const t = setup();
    t.elements.set(3, rowAt(78, 125));
    t.add(comment({ target: 3 }));
    t.view.place();
    expect((t.shadow.querySelector('.vhl') as HTMLElement).hidden).toBe(true);
  });
});
