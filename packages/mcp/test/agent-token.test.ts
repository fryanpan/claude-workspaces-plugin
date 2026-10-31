/**
 * The client half of the agent-stream proof.
 *
 * Everything here is about the MCP child NOT breaking. The server's gate is
 * the thing that closes a door; this store's job is to fetch a token once and
 * then get out of the way, and every case below pins a way it could fail to
 * do that: minting on every call, dying when the server is old or down, or
 * clinging to a token the server has stopped honouring.
 *
 * All fixtures synthetic; no network, no server, no real agent names.
 */
import { describe, expect, it } from 'vitest';
import { createAgentTokenStore, pathNeedsAgentToken } from '../src/agent-token.ts';

const AGENT = 'agent-mira';

interface Call {
  url: string;
}

function store(
  respond: (call: number) => Response,
  over: { identityIsShared?: boolean } = {},
): {
  headers: () => Promise<Record<string, string>>;
  headersFor: (path: string) => Promise<Record<string, string>>;
  forget: () => void;
  calls: Call[];
} {
  const calls: Call[] = [];
  const s = createAgentTokenStore({
    agentId: AGENT,
    resolveBaseUrl: () => 'http://localhost:9999',
    fetch: async (url) => {
      calls.push({ url });
      return respond(calls.length);
    },
    log: () => {},
    identityIsShared: over.identityIsShared ?? false,
  });
  return {
    headers: () => s.headers(),
    headersFor: (path) => s.headersFor(path),
    forget: () => s.forget(),
    calls,
  };
}

const okToken = (token: string): Response =>
  new Response(JSON.stringify({ agentId: AGENT, token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the MCP agent-token store', () => {
  it('asks the right route and puts the token on the header', async () => {
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.macbytes' });
    expect(s.calls[0]?.url).toBe('http://localhost:9999/api/agents/agent-mira/token');
  });

  it('mints once however many callers ask', async () => {
    // The restore, the first watch and the stream open within milliseconds
    // of each other at session start. Without single-flight that is three
    // mints racing.
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    const [a, b, c] = await Promise.all([s.headers(), s.headers(), s.headers()]);
    expect([a, b, c].every((h) => h.authorization !== undefined)).toBe(true);
    expect(s.calls).toHaveLength(1);
    await s.headers();
    expect(s.calls).toHaveLength(1);
  });

  it('sends no header after a 404, and asks again on the next call', async () => {
    // A 404 used to be remembered for the life of the process. On a current
    // server one bad answer -- a restart window, the wrong listener -- then
    // left the session tokenless until it restarted, and locked out of its
    // own feed once the server requires the token.
    const s = store((n) =>
      n === 1 ? new Response('not found', { status: 404 }) : okToken('at1.agent-mira.later'),
    );
    expect(await s.headers()).toEqual({});
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.later' });
    expect(s.calls).toHaveLength(2);
  });

  it('takes its token from an injected minter instead of the route', async () => {
    // The shared server's hosted sessions: their REST calls come from the
    // server's own process, which the mint route refuses.
    const calls: string[] = [];
    const s = createAgentTokenStore({
      agentId: AGENT,
      resolveBaseUrl: () => 'http://localhost:9999',
      fetch: async (url) => {
        calls.push(url);
        return okToken('at1.agent-mira.overhttp');
      },
      log: () => {},
      identityIsShared: false,
      mint: async () => 'at1.agent-mira.inprocess',
    });
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.inprocess' });
    expect(calls).toHaveLength(0);
  });

  it('sends no header when the server is down, and retries later', async () => {
    // The opposite of the 404 case: a throw is transient — the supervisor
    // restarts under us routinely — so the next call must try again.
    const s = store((n) => {
      if (n === 1) throw new Error('ECONNREFUSED');
      return okToken('at1.agent-mira.later');
    });
    expect(await s.headers()).toEqual({});
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.later' });
  });

  it('sends no header when the answer is a refusal rather than a token', async () => {
    const s = store(() => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    expect(await s.headers()).toEqual({});
  });

  it('never mints for the shared identity', async () => {
    // `known-agent` is every anonymous session at once, so a token over it
    // is a token all of them hold. The server refuses; this spares the trip.
    const s = store(() => okToken('at1.known-agent.macbytes'), { identityIsShared: true });
    expect(await s.headers()).toEqual({});
    expect(s.calls).toHaveLength(0);
  });

  it('mints again after the token is forgotten', async () => {
    // What a key rotation on the server looks like from here: the held
    // token stops verifying, the loop drops it, and the next attempt gets a
    // live one instead of redialling a dead value forever.
    const s = store((n) => okToken(n === 1 ? 'at1.agent-mira.old' : 'at1.agent-mira.new'));
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.old' });
    s.forget();
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.new' });
    expect(s.calls).toHaveLength(2);
  });
});

describe('which paths carry the bearer', () => {
  it('carries it on the durable watch set, the spoken answer, the inbox post, the plan lead’s rank, and nothing else', () => {
    expect(pathNeedsAgentToken('/api/agents/agent-mira/watches')).toBe(true);
    expect(pathNeedsAgentToken('/inbox/rows')).toBe(true);
    expect(pathNeedsAgentToken('/api/review-queue/rank')).toBe(true);
    expect(pathNeedsAgentToken('/api/review-queue')).toBe(false);
    // Bryan's own taps are not an agent's to make; they carry no bearer.
    expect(pathNeedsAgentToken('/inbox/rows/ib-abcdefghijkl/state')).toBe(false);
    expect(pathNeedsAgentToken('/api/agents/agent-mira/watches?x=1')).toBe(true);
    // The merge route has its own operator gate and asks for no token; the
    // mint route is fetched by the store itself, not through `http`.
    expect(pathNeedsAgentToken('/api/agents/agent-mira/merge')).toBe(false);
    expect(pathNeedsAgentToken('/api/agents/agent-mira/token')).toBe(false);
    // The bulk of the surface. Every one of these used to trigger a mint.
    expect(pathNeedsAgentToken('/workspaces/w-1/goals')).toBe(false);
    expect(pathNeedsAgentToken('/api/docs/d-1/threads')).toBe(false);
    // Not a prefix match: a path that merely starts the same way is not it.
    expect(pathNeedsAgentToken('/api/agents/agent-mira/watches/extra')).toBe(false);
    expect(pathNeedsAgentToken('/workspaces/w-1/voice-queue/vq-1/answer')).toBe(true);
    // The lead's line into a meeting is said as the lead: only its token speaks.
    expect(pathNeedsAgentToken('/workspaces/w-1/lead-chat/meeting/say')).toBe(true);
    expect(pathNeedsAgentToken('/workspaces/w-1/lead-chat/meeting')).toBe(false);
    expect(pathNeedsAgentToken('/workspaces/w-1/voice-queue/vq-1/ack')).toBe(false);
  });

  it('mints nothing for a path that does not need one', async () => {
    // The regression this predicate exists for: an unrelated tool call must
    // not wait on, or record, a token request.
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    expect(await s.headersFor('/workspaces/w-1/goals')).toEqual({});
    expect(s.calls).toHaveLength(0);
  });

  it('mints for the watch set', async () => {
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    expect(await s.headersFor('/api/agents/agent-mira/watches')).toEqual({
      authorization: 'Bearer at1.agent-mira.macbytes',
    });
    expect(s.calls).toHaveLength(1);
  });
});
