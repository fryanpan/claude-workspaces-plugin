import { describe, expect, it, mock } from 'bun:test';
import type { WebhookPayload } from '@claude-workspaces/core';
import { createPublicFetch } from '../src/outbound-fetch.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from '../src/webhooks.ts';

const samplePayload: WebhookPayload = {
  event: 'thread.created',
  docId: 'd1',
  threadId: 't1',
  thread: {
    id: 't1',
    status: 'open',
    anchor: {
      kind: 'element',
      fingerprint: {
        tag: 'BUTTON',
        stableAttrs: {},
        classes: [],
        text: 'x',
        path: 'BUTTON[0]',
        dataAttrs: {},
      },
      snippet: { text: 'x' },
    },
    commentCount: 1,
    lastActivity: 1,
    createdBy: { id: 'u', name: 'U', kind: 'anon', color: '#000' },
    comments: [
      { id: 'c', author: { id: 'u', name: 'U', kind: 'anon', color: '#000' }, text: 'x', ts: 1 },
    ],
  },
  doc: { docId: 'd1', type: 'markdown', createdAt: 1 },
  seq: 1,
};

describe('webhook dispatcher', () => {
  it('posts the payload as JSON', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const d = createWebhookDispatcher({ fetchImpl: fetchMock as unknown as typeof fetch });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    const init = call?.[1];
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.event).toBe('thread.created');
  });

  it('retries on 5xx', async () => {
    let n = 0;
    const fetchMock = mock(async () => {
      n++;
      return n < 2 ? new Response('err', { status: 503 }) : new Response('ok', { status: 200 });
    });
    const d = createWebhookDispatcher({
      fetchImpl: fetchMock as unknown as typeof fetch,
      retries: 2,
    });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    const fetchMock = mock(async () => new Response('bad', { status: 400 }));
    const d = createWebhookDispatcher({
      fetchImpl: fetchMock as unknown as typeof fetch,
      retries: 2,
    });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs failures', async () => {
    const logs: unknown[] = [];
    const fetchMock = mock(async () => {
      throw new Error('net fail');
    });
    const d = createWebhookDispatcher({
      fetchImpl: fetchMock as unknown as typeof fetch,
      retries: 0,
      onLog: (e) => logs.push(e),
    });
    await d.send('http://example/hook', samplePayload);
    expect(logs).toHaveLength(1);
    expect((logs[0] as { ok: boolean }).ok).toBe(false);
  });

  it('refuses a webhook URL on this machine by default, and delivers it when loopback is permitted', async () => {
    const hits: unknown[] = [];
    const sink = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        hits.push(await req.json());
        return new Response('ok');
      },
    });
    try {
      const url = `http://127.0.0.1:${sink.port}/hook`;
      const refused: WebhookLogEntry[] = [];
      await createWebhookDispatcher({ retries: 0, onLog: (e) => refused.push(e) }).send(
        url,
        samplePayload,
      );
      expect(hits).toEqual([]);
      expect(refused.map((e) => [e.ok, e.status])).toEqual([[false, 0]]);
      expect(refused[0]?.error).toContain('outbound request refused');

      // Control: the same sink, reached through a guard that permits loopback.
      await createWebhookDispatcher({
        retries: 0,
        fetchImpl: createPublicFetch({ permit: new Set(['loopback']) }),
      }).send(url, samplePayload);
      expect(hits).toHaveLength(1);
    } finally {
      sink.stop(true);
    }
  });
});
