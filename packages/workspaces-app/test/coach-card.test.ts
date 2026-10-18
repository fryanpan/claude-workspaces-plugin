/**
 * The coach on a page: it says what he is looking at when the page opens and
 * when he stops scrolling, sends a paragraph he wrote when he pauses or moves
 * on, and stops for anyone but the owner; a moment draws one card, escaped,
 * which stays until he answers it or the server clears it. The same card
 * shows on a board, a doc and the front page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_SETTLE_MS, WROTE_PAUSE_MS, mountCoachCard } from '../src/coach-card.ts';

type Posted = { url: string; body: Record<string, unknown> };
let posted: Posted[];
let status: number;

class FakeStream {
  static last: FakeStream | null = null;
  listeners: ((ev: MessageEvent) => void)[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeStream.last = this;
  }
  addEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(frame: unknown) {
    for (const fn of this.listeners) fn(new MessageEvent('coach', { data: JSON.stringify(frame) }));
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const card = () => document.querySelector('.coach-card-host')?.shadowRoot ?? null;
const MOMENT = {
  id: 'cm-aaaaaaaaaaaa',
  name: 'Saltmarsh',
  line: 'Hi, I’m noticing <b>hover</b> again. Back to the post?',
  goal: 'Hard work first',
};

/** Every card a test mounted, taken down after it so none listens on. */
let mounted: ReturnType<typeof mountCoachCard>[] = [];

function mount(extra: Partial<Parameters<typeof mountCoachCard>[0]> = {}) {
  const c = mountCoachCard({
    workspaceId: 'w-harbor',
    post: async (url, body) => {
      posted.push({ url, body: body as Record<string, unknown> });
      return status;
    },
    openStream: (url) => new FakeStream(url) as unknown as EventSource,
    ...extra,
  });
  mounted.push(c);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  posted = [];
  status = 200;
  FakeStream.last = null;
});

afterEach(() => {
  for (const c of mounted) c.destroy();
  mounted = [];
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const caretIn = (el: Element) => {
  const range = document.createRange();
  range.setStart(el.firstChild ?? el, 0);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
};

describe('what he is looking at and writing', () => {
  it('sends the view on open with the heading and passage, and again once scrolling settles', async () => {
    document.body.innerHTML =
      '<main id="ed" contenteditable="true"><h2>Greys</h2><p>The warm grey reads as beige.</p></main>';
    const c = mount({ docId: 'd-tokens', root: document.getElementById('ed') as HTMLElement });
    await flush();
    expect(posted).toEqual([
      {
        url: '/coach/here',
        body: expect.objectContaining({
          kind: 'view',
          workspaceId: 'w-harbor',
          docId: 'd-tokens',
          visible: true,
          heading: 'Greys',
          text: 'Greys The warm grey reads as beige.',
        }),
      },
    ]);
    document.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLL_SETTLE_MS - 1);
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(posted).toHaveLength(2);
    c.destroy();
  });

  it('the front page and the review walk say which page he is on, and when it hides, but not each scroll', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    for (const page of ['home', 'review'] as const) {
      posted = [];
      const c = mount({ workspaceId: undefined, page });
      await flush();
      expect(posted).toEqual([
        {
          url: '/coach/here',
          body: expect.objectContaining({ kind: 'view', page, visible: true }),
        },
      ]);
      expect(posted[0]?.body).not.toHaveProperty('workspaceId');
      document.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
      expect(posted).toHaveLength(1);
      vis.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(posted[1]?.body).toMatchObject({ kind: 'view', page, visible: false });
      vis.mockReturnValue('visible');
      c.destroy();
    }
    vis.mockRestore();
  });

  it('posts with keepalive, so the view a hiding phone sends outlives the page', async () => {
    const calls: RequestInit[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(init ?? {});
      return new Response(null, { status: 200 });
    });
    const c = mountCoachCard({
      workspaceId: 'w-harbor',
      openStream: (url) => new FakeStream(url) as unknown as EventSource,
    });
    mounted.push(c);
    await flush();
    expect(calls[0]).toMatchObject({ method: 'POST', keepalive: true });
    fetchSpy.mockRestore();
  });

  it('a background tab sends no view when it scrolls', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const c = mount({ docId: 'd-tokens' });
    await flush();
    expect(posted).toHaveLength(1);
    vis.mockReturnValue('hidden');
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
    expect(posted.filter((p) => p.body.visible === true)).toHaveLength(1);
    vis.mockRestore();
    c.destroy();
  });

  it('sends one more view once a doc that opened empty has its text', async () => {
    document.body.innerHTML = '<main id="ed" contenteditable="true"></main>';
    const ed = document.getElementById('ed') as HTMLElement;
    const c = mount({ docId: 'd-post', root: ed });
    await flush();
    expect(posted).toHaveLength(1);
    ed.innerHTML = '<h2>Why</h2><p>Paper books get wet.</p>';
    await flush();
    vi.advanceTimersByTime(SCROLL_SETTLE_MS);
    expect(posted.at(-1)?.body).toMatchObject({ kind: 'view', heading: 'Why' });
    ed.appendChild(document.createElement('p')).textContent = 'More.';
    await flush();
    vi.advanceTimersByTime(SCROLL_SETTLE_MS);
    expect(posted).toHaveLength(2);
    c.destroy();
  });

  it('sends a paragraph once when he pauses, and at once when he moves to another', async () => {
    document.body.innerHTML =
      '<main id="ed" contenteditable="true"><h2>Plan</h2><p id="a">Build the importer</p><p id="b">Ship</p></main>';
    const ed = document.getElementById('ed') as HTMLElement;
    const c = mount({ docId: 'd-plan', root: ed });
    await flush();
    const wrote = () => posted.filter((p) => p.body.kind === 'wrote');
    caretIn(document.getElementById('a') as HTMLElement);
    ed.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(WROTE_PAUSE_MS - 1);
    expect(wrote()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(wrote()).toEqual([
      {
        url: '/coach/here',
        body: expect.objectContaining({
          kind: 'wrote',
          docId: 'd-plan',
          heading: 'Plan',
          text: 'Build the importer',
        }),
      },
    ]);
    ed.dispatchEvent(new Event('input'));
    caretIn(document.getElementById('b') as HTMLElement);
    document.dispatchEvent(new Event('selectionchange'));
    expect(wrote()).toHaveLength(2);
    vi.advanceTimersByTime(WROTE_PAUSE_MS);
    expect(wrote()).toHaveLength(2);
    c.destroy();
  });

  it('a first ping answered 204 (not the owner) stops it: no stream, and no ping after', async () => {
    status = 204;
    mount();
    await flush();
    expect(FakeStream.last).toBeNull();
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLL_SETTLE_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toHaveLength(1);
  });
});

describe('the card', () => {
  it('draws the moment escaped, and a thumbs up answers it and takes it away', async () => {
    const c = mount();
    await flush();
    expect(FakeStream.last?.url).toBe('/coach/stream?workspaceId=w-harbor');
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    expect(card()?.querySelector('.cw-coach-who')?.textContent).toBe('Saltmarsh');
    expect(card()?.querySelector('.cw-coach-line')?.textContent).toBe(MOMENT.line);
    expect(card()?.querySelector('b')).toBeNull();
    card()?.querySelector<HTMLButtonElement>('[data-answer="up"]')?.click();
    await flush();
    expect(posted.at(-1)).toEqual({
      url: '/coach/moments/cm-aaaaaaaaaaaa/answer',
      body: { answer: 'up' },
    });
    expect(card()).toBeNull();
    c.destroy();
  });

  it('a failed answer keeps the card, with its buttons back', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    status = 0;
    card()?.querySelector<HTMLButtonElement>('[data-answer="up"]')?.click();
    await flush();
    expect(card()?.querySelector<HTMLButtonElement>('[data-answer="up"]')?.disabled).toBe(false);
  });

  it('stays however long he leaves it, and leaves on a clear for its own id', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(card()).not.toBeNull();
    FakeStream.last?.emit({ type: 'clear', id: 'cm-bbbbbbbbbbbb' });
    expect(card()).not.toBeNull();
    FakeStream.last?.emit({ type: 'clear', id: MOMENT.id });
    expect(card()).toBeNull();
  });

  it('Coach off for this board posts that board, and the card stays and says so; a failure keeps the switch', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    status = 0;
    card()?.querySelector<HTMLButtonElement>('.cw-coach-off')?.click();
    await flush();
    expect(posted.at(-1)).toEqual({
      url: '/coach/boards',
      body: { workspaceId: 'w-harbor', off: true },
    });
    expect(card()?.querySelector<HTMLButtonElement>('.cw-coach-off')?.disabled).toBe(false);
    status = 200;
    card()?.querySelector<HTMLButtonElement>('.cw-coach-off')?.click();
    await flush();
    expect(card()?.querySelector('.cw-coach-line')?.textContent).toBe(MOMENT.line);
    expect(card()?.querySelector('button.cw-coach-off')).toBeNull();
    expect(card()?.querySelector('.cw-coach-off')?.textContent).toBe('Coach is off for this board');
  });
});

describe('the card follows him', () => {
  it('a doc page names its board and doc to the stream', async () => {
    mount({ docId: 'd-post' });
    await flush();
    expect(FakeStream.last?.url).toBe('/coach/stream?workspaceId=w-harbor&docId=d-post');
  });

  it('on the front page it sends no view, opens the stream naming nowhere, and draws the same card without the board switch', async () => {
    const c = mount({ workspaceId: undefined });
    await flush();
    expect(posted).toEqual([]);
    expect(FakeStream.last?.url).toBe('/coach/stream');
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    expect(card()?.querySelector('.cw-coach-line')?.textContent).toBe(MOMENT.line);
    expect(card()?.querySelectorAll('[data-answer]')).toHaveLength(2);
    expect(card()?.querySelector('.cw-coach-off')).toBeNull();
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLL_SETTLE_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toEqual([]);
    card()?.querySelector<HTMLButtonElement>('[data-answer="up"]')?.click();
    await flush();
    expect(posted).toEqual([
      { url: '/coach/moments/cm-aaaaaaaaaaaa/answer', body: { answer: 'up' } },
    ]);
    expect(card()).toBeNull();
    c.destroy();
  });

  it('the moment told again keeps the card it drew, so nothing on it moves', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    const first = document.querySelector('.coach-card-host');
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: 1 } });
    expect(document.querySelectorAll('.coach-card-host')).toHaveLength(1);
    expect(document.querySelector('.coach-card-host')).toBe(first);
  });
});
