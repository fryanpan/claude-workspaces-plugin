/**
 * The meeting's connection with no page around it (`meeting-link.ts`): the
 * order a connection sends things in, the bank across a drop, and the retry
 * that asks for the same meeting back. The doc strip's own tests cover the
 * same behaviour through the strip; these pin it for the lead chat's meeting,
 * which drives the link directly.
 */
import { describe, expect, it } from 'vitest';
import { type MeetingSocket, createMeetingLink } from '../src/meeting-link.ts';

class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  frames(): unknown[] {
    return this.sent.map((d) => (typeof d === 'string' ? JSON.parse(d) : (d as Int16Array)[0]));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const waits: Array<{ fn: () => void; ms: number }> = [];
  let t = 0;
  const events: string[] = [];
  const link = createMeetingLink({
    url: () => '/workspaces/w-1/docs/d-1/audio',
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: () => t,
    schedule: (fn, ms) => {
      const w = { fn, ms };
      waits.push(w);
      return () => waits.splice(waits.indexOf(w), 1);
    },
    startFrame: (c) => ({ type: 'start', ...c }),
    message: (data) => events.push(`message:${String(data)}`),
    dropped: () => events.push('dropped'),
  });
  return {
    link,
    sockets,
    waits,
    events,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('a meeting link', () => {
  it('sends the start frame first, then audio, banking it until the server answers', () => {
    const { link, sockets } = setup();
    link.connect();
    const s = sockets[0] as FakeSocket;
    s.onopen?.();
    link.audio(Int16Array.of(1));
    expect(s.frames()).toEqual([{ type: 'start', heldMs: 0 }, 1]);
    expect(link.hasMeeting).toBe(false);
    expect(link.ready()).toBe(false);
    expect(link.hasMeeting).toBe(true);
  });

  it('replays what was banked during a drop, after a start that asks to resume', () => {
    const { link, sockets, waits, events, tick } = setup();
    link.connect();
    (sockets[0] as FakeSocket).onopen?.();
    link.ready();
    (sockets[0] as FakeSocket).onclose?.();
    expect(events).toEqual(['dropped']);
    // Spoken while the socket is down: banked, not sent.
    link.audio(Int16Array.of(7));
    tick(50);
    link.audio(Int16Array.of(8));
    expect(link.retry('m-1', () => true)).toBe('retrying');
    expect(waits).toHaveLength(1);
    waits[0]?.fn();
    const again = sockets[1] as FakeSocket;
    again.onopen?.();
    expect(again.frames()).toEqual([{ type: 'start', resume: 'm-1', heldMs: 50 }, 7, 8]);
    expect(link.resuming).toBe(true);
    expect(link.ready()).toBe(true);
    expect(link.resuming).toBe(false);
  });

  it('does not reconnect when the meeting is no longer wanted by the time the wait ends', () => {
    const { link, sockets, waits } = setup();
    link.connect();
    (sockets[0] as FakeSocket).onclose?.();
    link.retry('m-1', () => false);
    waits[0]?.fn();
    expect(sockets).toHaveLength(1);
  });

  it('closes without reporting a drop', () => {
    const { link, sockets, events } = setup();
    link.connect();
    const s = sockets[0] as FakeSocket;
    s.onopen?.();
    link.close();
    expect(s.closed).toBe(true);
    expect(s.onclose).toBeNull();
    expect(events).toEqual([]);
    expect(link.open).toBe(false);
  });
});
