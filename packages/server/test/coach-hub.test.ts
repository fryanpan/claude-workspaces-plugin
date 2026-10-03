/**
 * The coach's stream: a page that connects while a moment is open gets it
 * at once, every open page gets the next one and its clearing, and a page
 * that goes away is dropped.
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
    expect(b.text()).toBe(':ok\n\nevent: coach\ndata: {"type":"clear","id":"cm-aaaaaaaaaaaa"}\n\n');
    await a.cancel();
    await waitFor(() => hub.size === 1);
    hub.close();
    expect(hub.size).toBe(0);
  });
});
