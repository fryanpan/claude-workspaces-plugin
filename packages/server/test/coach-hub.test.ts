/**
 * The coach's stream: a page that connects while a moment is open gets it
 * at once, every open page gets the next one and its clearing, and a page
 * that goes away is dropped. Wherever he is, the front page included, the
 * moment shows, a board the coach is off for included, where it says so.
 */
import { describe, expect, it } from 'bun:test';
import { CoachHub } from '../src/coach/hub.ts';
import type { CoachFrame } from '../src/coach/moment.ts';
import { waitFor } from './wait-for.ts';

const MOMENT: CoachFrame = {
  type: 'moment',
  moment: {
    id: 'cm-aaaaaaaaaaaa',
    at: 1,
    name: 'Saltmarsh',
    line: 'Back to the post?',
    goal: 'Hard work first',
  },
};

function reader(res: Response) {
  const r = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = '';
  void (async () => {
    for (;;) {
      const { value, done } = await r.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += dec.decode(value);
    }
  })();
  return { text: () => text, cancel: () => r.cancel() };
}

describe('CoachHub', () => {
  it('opens as an event stream with the open moment first, then carries what follows', async () => {
    const hub = new CoachHub();
    const res = hub.open(MOMENT);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const a = reader(res);
    const b = reader(hub.open(null));
    await waitFor(() => a.text().includes('event: coach'));
    expect(a.text()).toBe(`:ok\n\nevent: coach\ndata: ${JSON.stringify(MOMENT)}\n\n`);
    hub.publish({ type: 'clear', id: 'cm-aaaaaaaaaaaa' });
    await waitFor(() => b.text().includes('"clear"'));
    expect(b.text()).toBe(
      ':ok\n\nevent: coach\ndata: {"type":"idle"}\n\nevent: coach\ndata: {"type":"clear","id":"cm-aaaaaaaaaaaa"}\n\n',
    );
    await a.cancel();
    await waitFor(() => hub.size === 1);
    hub.close();
    expect(hub.size).toBe(0);
  });
});

const ev = (f: CoachFrame) => `event: coach\ndata: ${JSON.stringify(f)}\n\n`;
const CLEAR: CoachFrame = { type: 'clear', id: 'cm-aaaaaaaaaaaa' };

describe('CoachHub, where his pages are', () => {
  const OFF: CoachFrame = { ...MOMENT, off: true } as CoachFrame;

  it('shows the open moment on a board, a doc, the front page and a board the coach is off for, marked off there', async () => {
    const off = new Set(['w-records']);
    const hub = new CoachHub({ offAt: (p) => off.has(p.workspaceId) });
    const board = reader(hub.open(MOMENT, { workspaceId: 'w-harbor' }));
    const doc = reader(hub.open(MOMENT, { workspaceId: 'w-river', docId: 'd-post' }));
    const front = reader(hub.open(MOMENT, null));
    const records = reader(hub.open(MOMENT, { workspaceId: 'w-records', docId: 'd-letters' }));
    for (const page of [board, doc, front]) {
      await waitFor(() => page.text().includes('event: coach'));
      expect(page.text()).toBe(`:ok\n\n${ev(MOMENT)}`);
    }
    await waitFor(() => records.text().includes('event: coach'));
    expect(records.text()).toBe(`:ok\n\n${ev(OFF)}`);
    hub.publish(MOMENT);
    hub.publish(CLEAR);
    await waitFor(() => front.text().includes('"clear"'));
    expect(front.text()).toBe(`:ok\n\n${ev(MOMENT)}${ev(MOMENT)}${ev(CLEAR)}`);
    await waitFor(() => records.text().includes('"clear"'));
    expect(records.text()).toBe(`:ok\n\n${ev(OFF)}${ev(OFF)}${ev(CLEAR)}`);
    hub.close();
  });

  it('reshow marks it off on a board just turned off and on again on one turned back on', async () => {
    const off = new Set<string>();
    const hub = new CoachHub({ offAt: (p) => off.has(p.workspaceId) });
    const harbor = reader(hub.open(MOMENT, { workspaceId: 'w-harbor' }));
    const front = reader(hub.open(MOMENT, null));
    await waitFor(() => harbor.text().includes('event: coach'));
    off.add('w-harbor');
    hub.reshow(MOMENT);
    await waitFor(() => harbor.text().includes('"off"'));
    expect(harbor.text()).toBe(`:ok\n\n${ev(MOMENT)}${ev(OFF)}`);
    off.delete('w-harbor');
    hub.reshow(MOMENT);
    await waitFor(() => harbor.text().split('event: coach').length === 4);
    expect(harbor.text()).toBe(`:ok\n\n${ev(MOMENT)}${ev(OFF)}${ev(MOMENT)}`);
    // Each page's stream drains on its own reader, so `harbor` holding its
    // third frame says nothing about `front`: wait on `front`'s own.
    await waitFor(() => front.text().split('event: coach').length === 4);
    expect(front.text()).toBe(`:ok\n\n${ev(MOMENT)}${ev(MOMENT)}${ev(MOMENT)}`);
    hub.reshow(null);
    hub.close();
  });

  it('counts a check that throws as off, and still shows the moment', async () => {
    const hub = new CoachHub({
      offAt: () => {
        throw new Error('privacy store unreadable');
      },
    });
    const page = reader(hub.open(null, { workspaceId: 'w-harbor' }));
    await waitFor(() => page.text().includes('idle'));
    hub.publish(MOMENT);
    await waitFor(() => page.text().includes('"off"'));
    expect(page.text()).toBe(`:ok\n\n${ev({ type: 'idle' })}${ev(OFF)}`);
    hub.close();
  });
});
