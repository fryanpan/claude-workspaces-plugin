/**
 * Two connector sessions in one process share nothing.
 *
 * `connector-session.ts` is the per-process wiring `mcp.ts` used to hold as
 * module-level constants. It moved so the shared server can host one session
 * per agent in a single process, and the property that move has to keep is
 * that nothing in one session is visible to another:
 *
 *  - **The working directory.** `attach_markdown` sends it as `owner`, and the
 *    server records which checkout a bind came from. It used to be
 *    `process.cwd()`, which in a shared process is the server's directory for
 *    every agent.
 *  - **The dedup window.** The same event reaches two agents who both watch a
 *    doc. A window shared between them would forward it to whichever read it
 *    first and hide it from the other as a duplicate.
 *  - **The notification sink.** A frame on one agent's stream reaches that
 *    agent's session and nobody else's.
 *
 * Everything is faked at the fetch seam; nothing listens on a socket. Names
 * are fictional.
 */
import { describe, expect, it } from 'vitest';
import { resolveAgentAuthor } from '../src/author.ts';
import type { ChannelNotification } from '../src/channel-messages.ts';
import { type ConnectorSession, createConnectorSession } from '../src/connector-session.ts';

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A comment frame as the multiplexed stream carries it. */
function commentFrame(eid: string): string {
  const payload = {
    event: 'thread.replied',
    eid,
    docId: 'plan',
    watchKey: 'plan',
    threadId: 't1',
    comment: { author: { name: 'Saltmarsh Reviewer' }, text: 'tighten this' },
    thread: { anchor: { snippet: { text: 'the second paragraph' } } },
  };
  return `id: 1\nevent: thread.replied\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A stream that carries `frames` and then stays open until aborted. */
function openStream(frames: string[], signal: AbortSignal | undefined | null): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(':ok\n\n'));
      for (const f of frames) c.enqueue(enc.encode(f));
      signal?.addEventListener('abort', () => c.close(), { once: true });
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function build(name: string, cwd: string, frames: string[]) {
  const recorded: Recorded[] = [];
  const notified: ChannelNotification['params'][] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const session: ConnectorSession = createConnectorSession({
    author: resolveAgentAuthor({ CW_AGENT_NAME: name }),
    cwd,
    defaultWorkspaceId: () => '',
    pluginVersion: () => '0.0.0',
    processId: `process-${name}`,
    notify: async (n) => {
      notified.push(n.params);
    },
    resolveBaseUrl: () => 'http://127.0.0.1:1',
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const text = typeof init?.body === 'string' ? init.body : undefined;
      recorded.push({
        method: init?.method ?? 'GET',
        path,
        body: text ? JSON.parse(text) : undefined,
      });
      if (path.endsWith('/token')) return new Response('no such route', { status: 404 });
      if (path.endsWith('/watches')) return json({ watches: [] });
      return json({ ok: true, docId: 'plan' });
    },
    eventsFetch: async (_url, init) => openStream(frames, init?.signal),
    eventsNeedToken: false,
    log: () => {},
  });
  return { session, recorded, notified };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

describe('two connector sessions in one process', () => {
  it('each binds with its own working directory as the owner', async () => {
    const alpha = build('Riverbend Alpha', '/work/riverbend', []);
    const beta = build('Harborlight Beta', '/work/harborlight', []);
    try {
      for (const { session } of [alpha, beta]) {
        const res = await session.callTool({
          method: 'tools/call',
          params: {
            name: 'attach_markdown',
            arguments: {
              workspaceId: 'w-1',
              docId: 'plan',
              path: '/work/plan.md',
              subscribe: false,
            },
          },
        });
        expect(res.isError).not.toBe(true);
      }
      const ownerOf = (r: Recorded[]) =>
        r.find((x) => x.method === 'POST' && x.path.endsWith('/docs'))?.body?.owner;
      expect(ownerOf(alpha.recorded)).toBe('/work/riverbend');
      expect(ownerOf(beta.recorded)).toBe('/work/harborlight');
    } finally {
      alpha.session.stop();
      beta.session.stop();
    }
  });

  it('delivers the same event to both agents that watch it, once each', async () => {
    // One event, one eid, on both agents' streams — what a comment on a doc
    // two agents watch looks like.
    const alpha = build('Riverbend Alpha', '/work/riverbend', [commentFrame('e-1')]);
    const beta = build('Harborlight Beta', '/work/harborlight', [commentFrame('e-1')]);
    const quiet = build('Saltmarsh Gamma', '/work/saltmarsh', []);
    try {
      await alpha.session.openEvents();
      await beta.session.openEvents();
      await quiet.session.openEvents();
      await waitFor(() => alpha.notified.length > 0 && beta.notified.length > 0);
      // Let any second write land before counting.
      await new Promise((r) => setTimeout(r, 20));
      expect(alpha.notified.map((n) => n.content)).toEqual([
        '[replied] Saltmarsh Reviewer: tighten this',
      ]);
      expect(beta.notified.map((n) => n.content)).toEqual([
        '[replied] Saltmarsh Reviewer: tighten this',
      ]);
      expect(quiet.notified).toEqual([]);
    } finally {
      alpha.session.stop();
      beta.session.stop();
      quiet.session.stop();
    }
  });
});
