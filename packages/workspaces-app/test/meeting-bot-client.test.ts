/**
 * The doc's bot client is one endpoint and ONE stream: status and words both
 * arrive on the EventSource it already held, and each reaches its own
 * listeners. The subscribe seam stands in for the EventSource, exactly as
 * the fetch seam stands in for the server.
 */
import type { MeetingBotStatus, MeetingTranscriptEvent } from '@claude-workspaces/core';
import { describe, expect, it } from 'vitest';
import {
  type MeetingBotStreamHandlers,
  createMeetingBotClient,
} from '../src/meeting-bot-client.ts';

const status = (state: MeetingBotStatus['state']): MeetingBotStatus => ({
  botId: 'b-1',
  docId: 'doc-1',
  state,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
  speakers: ['Rowan Pike'],
  updatedAt: 1,
});

const frame = (turn: number, text: string, final: boolean): MeetingTranscriptEvent => ({
  event: 'meeting.transcript',
  docId: 'doc-1',
  meetingId: 'm-1',
  turn,
  text,
  final,
  speaker: 'p7',
  speakerName: 'Rowan Pike',
});

function configuredClient() {
  let handlers: MeetingBotStreamHandlers | null = null;
  let subscriptions = 0;
  let unsubscribed = 0;
  const client = createMeetingBotClient({
    docId: 'doc-1',
    fetchJson: () => Promise.resolve({ configured: true, bot: null }),
    subscribe: (_docId, h) => {
      handlers = h;
      subscriptions += 1;
      return () => {
        unsubscribed += 1;
      };
    },
  });
  return {
    client,
    stream: () => {
      if (!handlers) throw new Error('not subscribed');
      return handlers;
    },
    subscriptions: () => subscriptions,
    unsubscribed: () => unsubscribed,
  };
}

describe('the meeting bot client', () => {
  it('delivers live transcript frames from the one stream it holds, in order', async () => {
    const t = configuredClient();
    await t.client.ready;
    expect(t.subscriptions()).toBe(1);
    const seen: MeetingTranscriptEvent[] = [];
    t.client.onTranscript((f) => seen.push(f));
    t.stream().onTranscript(frame(0, 'so the', false));
    t.stream().onTranscript(frame(0, 'So the sync.', true));
    expect(seen.map((f) => [f.turn, f.text, f.final])).toEqual([
      [0, 'so the', false],
      [0, 'So the sync.', true],
    ]);
    expect(seen[0]?.speakerName).toBe('Rowan Pike');
  });

  it('POSITIVE CONTROL: a status frame on the same stream still moves the status', async () => {
    const t = configuredClient();
    await t.client.ready;
    let changes = 0;
    t.client.onChange(() => {
      changes += 1;
    });
    t.stream().onStatus(status('recording'));
    expect(changes).toBe(1);
    expect(t.client.live()?.state).toBe('recording');
    // One subscription carried both; nothing opened a second stream.
    expect(t.subscriptions()).toBe(1);
  });

  it('a cancelled listener hears nothing more; destroy hangs the stream up', async () => {
    const t = configuredClient();
    await t.client.ready;
    let heard = 0;
    const off = t.client.onTranscript(() => {
      heard += 1;
    });
    t.stream().onTranscript(frame(0, 'one', false));
    off();
    t.stream().onTranscript(frame(0, 'two', false));
    expect(heard).toBe(1);
    t.client.destroy();
    expect(t.unsubscribed()).toBe(1);
  });

  it('an unconfigured server opens no stream at all', async () => {
    let subscribed = 0;
    const client = createMeetingBotClient({
      docId: 'doc-1',
      fetchJson: () => Promise.resolve({ configured: false }),
      subscribe: () => {
        subscribed += 1;
        return () => {};
      },
    });
    await client.ready;
    expect(client.configured()).toBe(false);
    expect(subscribed).toBe(0);
  });
});

/**
 * THE DEFAULT SUBSCRIBE, which every test above replaces with a seam — and
 * which is exactly why a dead address in it survived: the injected stream
 * always worked. It subscribed to `/events/<docId>`, the pre-cutover doc
 * channel, so on a live server the EventSource 404'd and neither the bot's
 * state nor a single word ever reached the strip. A doc's stream is
 * `/workspaces/<ws>/docs/<docId>/events:stream`.
 */
describe("the bot client's own stream address", () => {
  class FakeEventSource {
    static opened: string[] = [];
    readonly listeners = new Map<string, EventListener[]>();
    closed = false;
    constructor(readonly url: string) {
      FakeEventSource.opened.push(url);
      FakeEventSource.last = this;
    }
    static last: FakeEventSource | null = null;
    addEventListener(type: string, fn: EventListener): void {
      const held = this.listeners.get(type) ?? [];
      held.push(fn);
      this.listeners.set(type, held);
    }
    removeEventListener(type: string, fn: EventListener): void {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    }
    close(): void {
      this.closed = true;
    }
    /** Deliver one server frame, as the browser would. */
    emit(type: string, data: unknown): void {
      const ev = { data: JSON.stringify(data) } as MessageEvent;
      for (const fn of this.listeners.get(type) ?? []) fn(ev as unknown as Event);
    }
  }

  async function subscribed(): Promise<{
    client: ReturnType<typeof createMeetingBotClient>;
    es: FakeEventSource;
    opened: string[];
  }> {
    FakeEventSource.opened = [];
    FakeEventSource.last = null;
    history.replaceState(null, '', '/workspaces/w-9/docs/doc-1');
    const prior = globalThis.EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    const client = createMeetingBotClient({
      docId: 'doc-1',
      fetchJson: () => Promise.resolve({ configured: true, bot: null }),
    });
    await client.ready;
    (globalThis as { EventSource?: unknown }).EventSource = prior;
    // Annotated because the `= null` above narrows the static to `null` for
    // the rest of the function, and the throw below would then make it never.
    const es: FakeEventSource | null = FakeEventSource.last;
    if (!es) throw new Error('no stream opened');
    return { client, es, opened: FakeEventSource.opened };
  }

  it("opens the doc's workspace-scoped event stream, not the deleted /events/<docId>", async () => {
    const { opened } = await subscribed();
    expect(opened).toEqual(['/workspaces/w-9/docs/doc-1/events:stream']);
  });

  it('carries the bot status and its words off that stream into the listeners', async () => {
    const { client, es } = await subscribed();
    const words: MeetingTranscriptEvent[] = [];
    client.onTranscript((f) => words.push(f));
    es.emit('meeting.bot', status('recording'));
    es.emit('meeting.transcript', frame(0, 'So the sync.', true));
    expect(client.status()?.state).toBe('recording');
    expect(client.live()?.state).toBe('recording');
    expect(words.map((f) => f.text)).toEqual(['So the sync.']);
  });
});
