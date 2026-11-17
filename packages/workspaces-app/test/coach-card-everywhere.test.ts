/**
 * One moment, many tabs: a board, a doc and the list page each hold the
 * coach stream, all draw the card when the moment is raised, and his answer
 * in one takes it off the other two. The card answers with a thumbs up, or a
 * thumbs down that opens a box for why; a board the coach does not hear from
 * shows the card and says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCoachCard } from '../src/coach-card.ts';

/** A stand-in for the server's stream hub: every open stream gets each frame. */
class FakeHub {
  streams: FakeStream[] = [];
  open = (url: string) => {
    const s = new FakeStream(url, this);
    this.streams.push(s);
    return s as unknown as EventSource;
  };
  publish(frame: unknown) {
    for (const s of this.streams) if (!s.closed) s.emit(frame);
  }
}

class FakeStream {
  listeners: ((ev: MessageEvent) => void)[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly hub: FakeHub,
  ) {}
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

const MOMENT = {
  id: 'cm-aaaaaaaaaaaa',
  at: 1,
  name: 'Saltmarsh',
  line: 'Hi, I’m noticing hover again. Back to the post?',
  goal: 'Hard work first',
};

type Posted = { url: string; body: Record<string, unknown> };
let hub: FakeHub;
let posted: Posted[];
let mounted: ReturnType<typeof mountCoachCard>[];

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const cards = () =>
  [...document.querySelectorAll('.coach-card-host')].map((h) => h.shadowRoot as ShadowRoot);

/** One tab. Its answer, like the server's, clears the moment on every tab. */
function tab(place: { workspaceId?: string; docId?: string }) {
  const c = mountCoachCard({
    ...place,
    post: async (url, body) => {
      posted.push({ url, body: body as Record<string, unknown> });
      if (url.endsWith('/answer')) hub.publish({ type: 'clear', id: MOMENT.id });
      return 200;
    },
    openStream: hub.open,
  });
  mounted.push(c);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  hub = new FakeHub();
  posted = [];
  mounted = [];
});

afterEach(() => {
  for (const c of mounted) c.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const button = (root: ShadowRoot, answer: string) =>
  root.querySelector<HTMLButtonElement>(`[data-answer="${answer}"]`);

describe('every tab', () => {
  it('a board, a doc and the list page all draw the raised card, and a thumbs up in one clears the others', async () => {
    tab({ workspaceId: 'w-harbor' });
    tab({ workspaceId: 'w-harbor', docId: 'd-post' });
    tab({});
    await flush();
    expect(hub.streams.map((s) => s.url)).toEqual([
      '/coach/stream?workspaceId=w-harbor',
      '/coach/stream?workspaceId=w-harbor&docId=d-post',
      '/coach/stream',
    ]);
    expect(cards()).toHaveLength(0);
    hub.publish({ type: 'moment', moment: MOMENT });
    expect(cards()).toHaveLength(3);
    const doc = cards()[1] as ShadowRoot;
    button(doc, 'up')?.click();
    await flush();
    expect(posted.at(-1)).toEqual({
      url: '/coach/moments/cm-aaaaaaaaaaaa/answer',
      body: { answer: 'up' },
    });
    expect(cards()).toHaveLength(0);
  });

  it('a tab told nothing is open drops the card it drew', async () => {
    tab({ workspaceId: 'w-harbor' });
    await flush();
    hub.publish({ type: 'moment', moment: MOMENT });
    expect(cards()).toHaveLength(1);
    hub.publish({ type: 'idle' });
    expect(cards()).toHaveLength(0);
  });

  it('keeps on after a here it could not place, and stops only for someone who is not the owner', async () => {
    const stopped = mountCoachCard({
      workspaceId: 'w-harbor',
      post: async () => 204,
      openStream: hub.open,
    });
    const kept = mountCoachCard({
      workspaceId: 'w-harbor',
      docId: 'd-file',
      post: async () => 400,
      openStream: hub.open,
    });
    mounted.push(stopped, kept);
    await flush();
    expect(hub.streams.map((s) => s.url)).toEqual([
      '/coach/stream?workspaceId=w-harbor&docId=d-file',
    ]);
  });
});

describe('the answer', () => {
  it('thumbs down opens a box above the thumbs, which stay where they were, and sends what he wrote', async () => {
    tab({ workspaceId: 'w-harbor' });
    await flush();
    hub.publish({ type: 'moment', moment: MOMENT });
    const card = cards()[0] as ShadowRoot;
    const row = card.querySelector('.cw-coach-acts');
    expect(card.querySelector('textarea')).toBeNull();
    button(card, 'down')?.click();
    await flush();
    // Opening the box sends nothing.
    expect(posted.filter((p) => p.url.endsWith('/answer'))).toEqual([]);
    const box = card.querySelector('textarea') as HTMLTextAreaElement;
    expect(box).not.toBeNull();
    expect(
      box.compareDocumentPosition(row as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card.querySelector('.cw-coach-acts')).toBe(row);
    expect(button(card, 'down')?.textContent).toContain('Send');
    box.value = '  I was checking it for Alice.  ';
    button(card, 'down')?.click();
    await flush();
    expect(posted.at(-1)).toEqual({
      url: '/coach/moments/cm-aaaaaaaaaaaa/answer',
      body: { answer: 'down', text: 'I was checking it for Alice.' },
    });
    expect(cards()).toHaveLength(0);
  });

  it('a thumbs down sent with the box empty carries no text', async () => {
    tab({ workspaceId: 'w-harbor' });
    await flush();
    hub.publish({ type: 'moment', moment: MOMENT });
    const card = cards()[0] as ShadowRoot;
    button(card, 'down')?.click();
    button(card, 'down')?.click();
    await flush();
    expect(posted.at(-1)?.body).toEqual({ answer: 'down' });
  });
});

describe('a board the coach does not hear from', () => {
  it('shows the card, and says the coach is off there in place of the switch', async () => {
    tab({ workspaceId: 'w-records' });
    await flush();
    hub.publish({ type: 'moment', moment: MOMENT, off: true });
    const card = cards()[0] as ShadowRoot;
    expect(card.querySelector('.cw-coach-line')?.textContent).toBe(MOMENT.line);
    expect(card.querySelector('.cw-coach-off')?.textContent).toBe(
      'Coach is off for this board · Turn back on',
    );
    // Turned back on: the same card, now with the switch.
    const host = document.querySelector('.coach-card-host');
    hub.publish({ type: 'moment', moment: MOMENT });
    expect(document.querySelector('.coach-card-host')).toBe(host);
    expect(card.querySelector('button.cw-coach-off')?.textContent).toBe('Coach off for this board');
  });
});
