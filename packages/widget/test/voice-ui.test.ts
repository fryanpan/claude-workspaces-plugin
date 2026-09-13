import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceComment, VoiceSession } from '../src/voice/voice-session.ts';
import { SETTLED_MS, VoiceView, clipLength, stackColumn } from '../src/voice/voice-ui.ts';

/**
 * What a recording looks like. The view reads a session's state and draws it,
 * so the session here is the state alone — the fields the view reads, set by
 * each test — and `setResolved` recorded.
 */

interface FakeSession {
  state: VoiceSession['state'];
  comments: Map<string, VoiceComment>;
  heard: string;
  pinned: number | null | undefined;
  note: string | null;
  setResolved: ReturnType<typeof vi.fn>;
}

const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=12.4,31';

function comment(over: Partial<VoiceComment> = {}): VoiceComment {
  return {
    key: 'v1',
    wire: 'v1',
    take: 1,
    text: 'The goal bar is too tall.',
    raw: 'um the goal bar is like too tall',
    clip: CLIP,
    target: null,
    final: false,
    ...over,
  };
}

function setup() {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  const goal = document.createElement('div');
  document.body.append(goal);
  const elements = new Map<number, HTMLElement>([[2, goal]]);
  const session: FakeSession = {
    state: 'recording',
    comments: new Map(),
    heard: '',
    pinned: undefined,
    note: null,
    setResolved: vi.fn(async () => {}),
  };
  const moved: string[] = [];
  let now = 1_000;
  const view = new VoiceView({
    session: session as unknown as VoiceSession,
    shadow,
    element: (t) => (t === null ? null : (elements.get(t) ?? null)),
    name: (t) => (t === 2 ? 'Goal bar' : `#${t}`),
    author: () => 'Ada <Admin>',
    clipUrl: (clip) => `http://host${clip}`,
    onMove: (key) => moved.push(key),
    now: () => now,
  });
  const add = (c: VoiceComment) => {
    session.comments.set(c.key, c);
    view.render();
  };
  const card = (key = 'v1') =>
    shadow.querySelector(`.vcard[data-key="${key}"]`) as HTMLElement | null;
  const where = () => view.live.querySelector('.vwhere') as HTMLElement;
  return {
    view,
    session,
    shadow,
    elements,
    moved,
    add,
    card,
    where,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  // The view places its cards every frame while any is up; the tests call
  // `place` themselves where placement is what they read.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the live comment', () => {
  it('is hidden while nothing is recording', () => {
    const t = setup();
    t.session.state = 'idle';
    t.view.render();
    expect(t.view.live.hidden).toBe(true);
    t.session.state = 'recording';
    t.view.render();
    expect(t.view.live.hidden, 'CONTROL: and shown once it is').toBe(false);
  });

  it('floats and listens while no element is named', () => {
    const t = setup();
    t.view.render();
    expect(t.view.live.classList.contains('float')).toBe(true);
    expect(t.view.live.classList.contains('attached')).toBe(false);
    expect(t.where().textContent).toBe('Listening…');
    expect(t.where().classList.contains('seeking')).toBe(true);
  });

  it('says it is starting while the socket connects', () => {
    const t = setup();
    t.session.state = 'connecting';
    t.view.render();
    expect(t.where().textContent).toBe('Starting…');
  });

  it('stands beside the element the comment is about, named', () => {
    const t = setup();
    t.add(comment({ target: 2 }));
    expect(t.view.live.classList.contains('attached')).toBe(true);
    expect(t.view.live.classList.contains('float')).toBe(false);
    expect(t.where().textContent).toBe('Goal bar');
    expect(t.where().classList.contains('seeking')).toBe(false);
  });

  it('floats again when the element it named is gone from the page', () => {
    const t = setup();
    t.add(comment({ target: 7 }));
    expect(t.view.live.classList.contains('float')).toBe(true);
    expect(t.where().textContent).toBe('Listening…');
  });

  it('stands beside a tapped element before any words arrive', () => {
    const t = setup();
    t.session.pinned = 2;
    t.view.render();
    expect(t.where().textContent).toBe('Goal bar');
  });

  it('shows the tidied words growing, and the raw words under them', () => {
    const t = setup();
    t.session.heard = 'like too tall';
    t.add(comment({ text: 'The goal bar' }));
    expect(t.view.live.querySelector('.vpol')?.textContent).toBe('The goal bar');
    expect(t.view.live.querySelector('.vraw span')?.textContent).toBe('like too tall');
  });

  it('asks for a tap while Move is choosing a place', () => {
    const t = setup();
    t.add(comment({ target: 2 }));
    (t.view.live.querySelector('.vmove') as HTMLElement).click();
    expect(t.moved).toEqual(['v1']);
    t.view.picking = 'v1';
    t.view.render();
    expect(t.view.live.classList.contains('picking')).toBe(true);
    expect(t.where().textContent).toBe('Tap where this belongs');
  });
});

describe('a settled comment’s card', () => {
  it('appears when the comment settles, with its clip’s length', () => {
    const t = setup();
    t.add(comment());
    expect(t.card(), 'no card while it is still growing').toBeNull();
    t.add(comment({ final: true }));
    expect(t.card()?.querySelector('.vtext')?.textContent).toBe('The goal bar is too tall.');
    expect(t.card()?.querySelector('.vplay')?.textContent).toBe('▶ 0:19');
    // The author's name is text, not markup.
    expect(t.card()?.querySelector('.vby')?.textContent).toBe('Ada <Admin> · by voice');
  });

  it('names the author the server recorded once the thread exists', () => {
    const t = setup();
    t.add(comment({ final: true }));
    expect(t.card()?.querySelector('.vby')?.textContent, 'CONTROL: the widget’s own name').toBe(
      'Ada <Admin> · by voice',
    );
    t.add(
      comment({
        final: true,
        posted: { threadId: 't1', commentId: 'c1', author: 'Reviewer' },
      }),
    );
    expect(t.card()?.querySelector('.vby')?.textContent).toBe('Reviewer · by voice');
  });

  it('plays the clip from the server', () => {
    const played: string[] = [];
    class FakeAudio {
      constructor(readonly src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
      pause() {}
    }
    vi.stubGlobal('Audio', FakeAudio);
    const t = setup();
    t.add(comment({ final: true }));
    (t.card()?.querySelector('.vplay') as HTMLElement).click();
    expect(played).toEqual([`http://host${CLIP}`]);
    vi.unstubAllGlobals();
  });

  it('shows and hides the raw words, and keeps them open as the card redraws', () => {
    const t = setup();
    t.add(comment({ final: true }));
    const raw = () => t.card()?.querySelector('.vrawtext') as HTMLElement;
    expect(raw().hidden).toBe(true);
    (t.card()?.querySelector('.vrawbtn') as HTMLElement).click();
    expect(raw().hidden).toBe(false);
    expect(raw().textContent).toBe('“um the goal bar is like too tall”');
    t.add(comment({ final: true, text: 'The goal bar is far too tall.' }));
    expect(raw().hidden, 'still open after the words changed').toBe(false);
    (t.card()?.querySelector('.vrawbtn') as HTMLElement).click();
    expect(raw().hidden).toBe(true);
  });

  it('offers Undo once the thread exists, and Redo after', () => {
    const t = setup();
    t.add(comment({ final: true }));
    expect(t.card()?.querySelector('.vundo'), 'nothing to undo before it is posted').toBeNull();
    const c = comment({ final: true, posted: { threadId: 't1', commentId: 'c1' } });
    t.add(c);
    const undo = t.card()?.querySelector('.vundo') as HTMLElement;
    expect(undo.textContent).toBe('Undo');
    undo.click();
    expect(t.session.setResolved).toHaveBeenCalledWith('v1', true);

    c.resolved = true;
    t.view.render();
    const redo = t.card()?.querySelector('.vundo') as HTMLElement;
    expect(redo.textContent).toBe('Redo');
    expect(t.card()?.classList.contains('undone')).toBe(true);
    redo.click();
    expect(t.session.setResolved).toHaveBeenLastCalledWith('v1', false);
  });

  it('keeps its buttons across a redraw that changed nothing on it', () => {
    const t = setup();
    t.add(comment({ final: true }));
    const play = t.card()?.querySelector('.vplay');
    t.session.heard = 'and another thing';
    t.view.render();
    expect(t.card()?.querySelector('.vplay'), 'the same button, not a copy').toBe(play);
    expect(play?.isConnected).toBe(true);
    t.add(comment({ final: true, text: 'Changed words.' }));
    expect(t.card()?.querySelector('.vplay'), 'CONTROL: a real change redraws it').not.toBe(play);
  });

  it('stays up through the recording, and a tap elsewhere after Stop puts it away', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1180);
    const t = setup();
    t.add(comment({ final: true }));
    t.advance(SETTLED_MS * 10);
    t.view.place();
    expect(t.card(), 'still up mid-recording').not.toBeNull();
    expect(t.card()?.hidden).toBe(false);

    t.session.state = 'idle';
    t.view.render();
    t.card()?.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    t.view.place();
    expect(t.card(), 'a tap on the card itself keeps it').not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(t.card(), 'a tap on the page puts it away').toBeNull();
    t.view.render();
    expect(t.card(), 'and the next render does not bring it back').toBeNull();
  });

  it('CONTROL: a tap on the page while recording leaves the cards up', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1180);
    const t = setup();
    t.add(comment({ final: true }));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(t.card()).not.toBeNull();
  });

  it('on a phone, is a pin while recording and shows only the newest after Stop', () => {
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
    expect(t.card('v1'), 'the older one waits as its pin').toBeNull();
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
  });
});

/** An element on the page standing at `top`..`bottom`, 600px wide from the left. */
function rowAt(top: number, bottom: number): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 24, y: top, width: 600, height: bottom - top }),
  );
  return el;
}

/** The page is 1180x820 or 430x932. */
function screen(width: number, height: number): void {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
  // The test DOM has no visual viewport, so the window is the screen.
  expect(window.visualViewport ?? null).toBeNull();
}

/** A card is 130px tall, 260px with its raw words open; the live card 150px. */
function heights(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('vlive')) return 150;
    return this.querySelector('.vrawtext:not([hidden])') ? 260 : 130;
  });
}

const box = (el: HTMLElement | null) => {
  const top = Number.parseFloat(el?.style.top ?? '');
  return { top, bottom: top + (el?.offsetHeight ?? 0) };
};

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

describe('clipLength', () => {
  it('reads the stretch from the media fragment', () => {
    expect(clipLength('/x/seg-1.wav#t=12.4,31')).toBe('0:19');
    expect(clipLength('/x/seg-1.wav#t=0,75')).toBe('1:15');
    expect(clipLength('/x/seg-1.wav')).toBe('0:00');
  });
});
