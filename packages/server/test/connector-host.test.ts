/**
 * The hosted connector's two tables and the protocol between them, driven
 * through `host.handle` with a fake connector per identity.
 *
 * What the fake stands in for is everything behind a push: here a test calls
 * an identity's `notify` directly, which is exactly the call the real
 * connector makes once a frame has been rendered. So each case below is about
 * where a push GOES — which agent, which of its connections, and whether it
 * survives a connection going away — not about how it was produced
 * (`connector-route.test.ts` drives the real chain end to end).
 *
 * "Nothing arrived" is never read off a silent stream: every negative is
 * paired with a keepalive observed on the same stream after the push, so the
 * stream is proven alive at the moment it was supposed to stay quiet.
 *
 * Names and paths are fictional.
 */
import { describe, expect, it } from 'bun:test';
import { SUPPORTED_PROTOCOL_VERSIONS as SDK_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { ChannelNotification } from '../../mcp/src/channel-messages.ts';
import type { ConnectorSession } from '../../mcp/src/connector-session.ts';
import { TOOL_LIST } from '../../mcp/src/tool-schemas.ts';
import {
  type ConnectorHost,
  type HostedSessionSpec,
  IDENTITY_IDLE_MS,
  SESSION_IDLE_MS,
  createConnectorHost,
} from '../src/connector/host.ts';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/connector/protocol.ts';
import {
  type Feed,
  type Send,
  identityHeaders,
  initialize,
  initializeBody,
  listen,
  openStream,
  rpc,
} from './connector-harness.ts';
import { waitFor } from './wait-for.ts';

const ALPHA = identityHeaders('Riverbend Alpha', '/work/riverbend');
const BETA = identityHeaders('Harborlight Beta', '/work/harborlight');

interface Made {
  spec: HostedSessionSpec;
  opened: number;
  restored: number;
  stopped: boolean;
}

function build(opts: { now?: () => number } = {}) {
  const made: Made[] = [];
  const createSession = (spec: HostedSessionSpec): ConnectorSession => {
    const rec: Made = { spec, opened: 0, restored: 0, stopped: false };
    made.push(rec);
    return {
      author: spec.author,
      listTools: () => TOOL_LIST,
      callTool: async (req) => ({ content: [{ type: 'text', text: `called ${req.params.name}` }] }),
      ensureWatchesRestored: async () => {
        rec.restored += 1;
      },
      openEvents: async () => {
        rec.opened += 1;
        return true;
      },
      stop: () => {
        rec.stopped = true;
      },
    };
  };
  const host: ConnectorHost = createConnectorHost({
    createSession,
    fallbackPluginVersion: () => '0.0.0',
    log: () => {},
    keepaliveMs: 10,
    sweepEveryMs: 0,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const send: Send = (method, headers, body) =>
    host.handle(
      new Request('http://127.0.0.1/mcp', {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const of = (name: string): Made => {
    const rec = made.find((m) => m.spec.author.name === name);
    if (!rec) throw new Error(`no hosted session for ${name}`);
    return rec;
  };
  const push = (name: string, content: string) =>
    of(name).spec.notify({
      method: 'notifications/claude/channel',
      params: { source: 'claude-workspaces', sent_at: '', content, meta: {} },
    } satisfies ChannelNotification);
  return { host, send, made, of, push };
}

/** Wait until the stream has been handed a keepalive it had not seen before. */
async function provenAlive(feed: Feed): Promise<void> {
  const seen = feed.comments;
  await waitFor(() => feed.comments > seen + 1, { describe: 'a keepalive on the quiet stream' });
}

describe('/mcp initialize', () => {
  it('speaks exactly the protocol versions the SDK does', () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([...SDK_VERSIONS]);
  });

  it('answers with a session id, the channel capability and the negotiated version', async () => {
    const { send } = build();
    const body = initializeBody();
    (body.params as Record<string, unknown>).protocolVersion = '2025-06-18';
    const res = await send('POST', ALPHA, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    const { result } = (await res.json()) as { result: Record<string, unknown> };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({
      tools: { listChanged: true },
      experimental: { 'claude/channel': {} },
    });
    expect(result.serverInfo).toEqual({ name: 'claude-workspaces', version: '0.1.999' });
  });

  it('refuses a session with no working directory', async () => {
    const { send } = build();
    const res = await send('POST', { 'x-cw-agent': 'Riverbend Alpha' }, initializeBody());
    expect(res.status).toBe(400);
  });

  it('hosts one connector per agent and directory, and one per session for an unnamed agent', async () => {
    const { send, made } = build();
    await initialize(send, ALPHA);
    await initialize(send, ALPHA);
    await initialize(send, identityHeaders('Riverbend Alpha', '/work/elsewhere'));
    expect(made.length).toBe(2);
    await initialize(send, identityHeaders(null, '/work/riverbend'));
    await initialize(send, identityHeaders(null, '/work/riverbend'));
    expect(made.length).toBe(4);
  });
});

describe('/mcp push routing', () => {
  it("delivers an agent's push to that agent's stream and no other", async () => {
    const { send, push } = build();
    const a = await initialize(send, ALPHA);
    const b = await initialize(send, BETA);
    const aFeed = listen(await openStream(send, a, ALPHA));
    const bFeed = listen(await openStream(send, b, BETA));
    try {
      await push('Riverbend Alpha', 'for alpha');
      await waitFor(() => aFeed.channelTexts().includes('for alpha'));
      await provenAlive(bFeed);
      expect(bFeed.channelTexts()).toEqual([]);
    } finally {
      aFeed.stop();
      bFeed.stop();
    }
  });

  it('sends a push to the newest session when a respawn overlaps the old one', async () => {
    const { host, send, push } = build();
    const old = await initialize(send, ALPHA);
    const oldFeed = listen(await openStream(send, old, ALPHA));
    const fresh = await initialize(send, ALPHA);
    const freshFeed = listen(await openStream(send, fresh, ALPHA));
    try {
      expect(host.counts()).toEqual({ identities: 1, sessions: 2, streams: 2 });
      await push('Riverbend Alpha', 'after the respawn');
      await waitFor(() => freshFeed.channelTexts().includes('after the respawn'));
      await provenAlive(oldFeed);
      expect(oldFeed.channelTexts()).toEqual([]);
      expect(freshFeed.channelTexts()).toEqual(['after the respawn']);
    } finally {
      oldFeed.stop();
      freshFeed.stop();
    }
  });

  it('keeps pushes for the newest session when the old one reconnects its stream', async () => {
    const { send, push } = build();
    const old = await initialize(send, ALPHA);
    const fresh = await initialize(send, ALPHA);
    const freshFeed = listen(await openStream(send, fresh, ALPHA));
    // The old session's stream connects LAST.
    const oldFeed = listen(await openStream(send, old, ALPHA));
    try {
      await push('Riverbend Alpha', 'still the new one');
      await waitFor(() => freshFeed.channelTexts().includes('still the new one'));
      await provenAlive(oldFeed);
      expect(oldFeed.channelTexts()).toEqual([]);
    } finally {
      oldFeed.stop();
      freshFeed.stop();
    }
  });
});

describe('/mcp replay', () => {
  it('holds a push made with no stream open and replays only what followed Last-Event-ID', async () => {
    const { host, send, push } = build();
    const sid = await initialize(send, ALPHA);
    const first = listen(await openStream(send, sid, ALPHA));
    await push('Riverbend Alpha', 'one');
    await push('Riverbend Alpha', 'two');
    await waitFor(() => first.channelTexts().length === 2);
    const lastId = first.events.filter((e) => e.message).at(-1)?.id;
    expect(lastId).toBeTruthy();
    first.stop();
    await waitFor(() => host.counts().streams === 0, { describe: 'the first stream to be gone' });

    await push('Riverbend Alpha', 'three');
    const second = listen(await openStream(send, sid, ALPHA, lastId as string));
    try {
      await waitFor(() => second.channelTexts().includes('three'));
      await provenAlive(second);
      expect(second.channelTexts()).toEqual(['three']);
      // The client is told to wait out a restart before it redials.
      expect(second.events[0]?.retry).toBe(15_000);
    } finally {
      second.stop();
    }
  });

  it('gives a client of the previous server process everything held', async () => {
    const { send, push } = build();
    const sid = await initialize(send, ALPHA);
    await push('Riverbend Alpha', 'while away');
    const feed = listen(await openStream(send, sid, ALPHA, 'some-other-epoch-41'));
    try {
      await waitFor(() => feed.channelTexts().includes('while away'));
    } finally {
      feed.stop();
    }
  });
});

describe('/mcp unknown session ids', () => {
  it('brings a session back on a GET, telling the client to refetch its tools', async () => {
    const { send, of } = build();
    const feed = listen(await openStream(send, 'held-by-the-previous-process', ALPHA));
    try {
      await waitFor(() => feed.events.length > 0);
      expect(feed.events[0]?.message).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      });
      await waitFor(() => of('Riverbend Alpha').restored > 0, {
        describe: 'the watch set to be restored',
      });
      const listed = await rpc(send, 'held-by-the-previous-process', ALPHA, 'tools/list');
      expect(listed.status).toBe(200);
      expect((listed.body.result as { tools: unknown[] }).tools.length).toBe(
        TOOL_LIST.tools.length,
      );
    } finally {
      feed.stop();
    }
  });

  it('answers a POST for an unknown session 404, so the client re-initializes', async () => {
    const { send } = build();
    const res = await rpc(send, 'never-issued', ALPHA, 'tools/list');
    expect(res.status).toBe(404);
    expect((res.body.error as { code: number }).code).toBe(-32001);
  });

  it('refuses to bring back a session whose headers do not say who it is', async () => {
    const { send } = build();
    const res = await openStream(send, 'held-by-the-previous-process', {
      'x-cw-agent': 'Riverbend Alpha',
    });
    expect(res.status).toBe(400);
  });
});

describe('/mcp lifecycle', () => {
  it('subscribes restored identities before returning, and skips unnamed or malformed ones', () => {
    const { host, made } = build();
    const opened = host.restore([
      { agent: 'Riverbend Alpha', cwd: '/work/riverbend', pluginVersion: '0.1.5' },
      { cwd: '/work/unnamed' },
      { agent: 'Harborlight Beta', cwd: 'relative/path' },
    ]);
    expect(opened).toBe(1);
    expect(made.map((m) => [m.spec.author.name, m.opened])).toEqual([['Riverbend Alpha', 1]]);
    expect(host.snapshot()).toEqual([
      { agent: 'Riverbend Alpha', cwd: '/work/riverbend', pluginVersion: '0.1.5' },
    ]);
  });

  it('retires an idle session, then stops an identity nobody has come back to', async () => {
    let clock = 1_000;
    const { host, send, made } = build({ now: () => clock });
    await initialize(send, ALPHA);
    clock += SESSION_IDLE_MS + 1;
    host.sweep();
    expect(host.counts()).toEqual({ identities: 1, sessions: 0, streams: 0 });
    expect(made[0]?.stopped).toBe(false);
    clock += IDENTITY_IDLE_MS + 1;
    host.sweep();
    expect(host.counts().identities).toBe(0);
    expect(made[0]?.stopped).toBe(true);
  });

  it('keeps a session whose stream is open, however long it has been quiet', async () => {
    let clock = 1_000;
    const { host, send } = build({ now: () => clock });
    const sid = await initialize(send, ALPHA);
    const feed = listen(await openStream(send, sid, ALPHA));
    try {
      await waitFor(() => host.counts().streams === 1);
      clock += SESSION_IDLE_MS + IDENTITY_IDLE_MS;
      host.sweep();
      expect(host.counts()).toEqual({ identities: 1, sessions: 1, streams: 1 });
    } finally {
      feed.stop();
    }
  });
});
