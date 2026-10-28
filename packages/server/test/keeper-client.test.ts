/**
 * The keeper client against a scripted keeper: how long it waits through a
 * hold and a run, that it withdraws a request it stops waiting on, and what
 * it makes of an answer that is neither a result nor a hold.
 */
import { describe, expect, it } from 'bun:test';
import { keeperFetch, keeperFly } from '../src/keeper/keeper-client.ts';

const ORIGIN = 'http://localhost:40123';
const HELD = {
  held: true,
  id: 'req1',
  pollToken: 'poll-token-1',
  hold: 'other',
  summary: 'fly deploy',
  approveUrl: `${ORIGIN}/approve/req1`,
};

interface Seen {
  method: string;
  url: string;
  poll: string | null;
}

/** A keeper that holds the call, then answers each poll from `polls` in turn. */
function scripted(polls: Array<Record<string, unknown>>, first?: () => Response) {
  const seen: Seen[] = [];
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    seen.push({ method, url, poll: headers.get('x-cw-keeper-poll') });
    if (url.endsWith('/v1/fly') || url.includes('/v1/cloudflare/')) {
      if (first) return first();
      return new Response(JSON.stringify(HELD), {
        status: 202,
        headers: { 'x-cw-keeper-held': '1' },
      });
    }
    if (method === 'DELETE') return new Response(JSON.stringify({ status: 'withdrawn' }));
    const view = polls[Math.min(n++, polls.length - 1)];
    return new Response(JSON.stringify(view));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const pending = { id: 'req1', status: 'pending' };
const running = { id: 'req1', status: 'running' };
const done = {
  id: 'req1',
  status: 'done',
  result: { status: 0, stdout: 'deployed\n', stderr: '' },
};

describe('waiting on a held call', () => {
  it('a command that is running is waited for past the tap wait', async () => {
    // Approved on the second poll, then running for far longer than the tap wait.
    const polls = [pending, ...Array.from({ length: 40 }, () => running), done];
    const k = scripted(polls);
    const r = await keeperFly(ORIGIN, ['deploy'], undefined, {
      fetchImpl: k.fetchImpl,
      waitMs: 30,
      pollMs: 2,
    });
    expect(r).toEqual({ status: 0, stdout: 'deployed\n', stderr: '' });
  });

  it('a run has a limit of its own, and says it ran past it', async () => {
    const k = scripted([running]);
    const r = await keeperFly(ORIGIN, ['deploy'], undefined, {
      fetchImpl: k.fetchImpl,
      waitMs: 5,
      runMs: 20,
      pollMs: 2,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('still running');
    // A running request cannot be withdrawn, so none is asked.
    expect(k.seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('a request nobody approved in time is withdrawn with its poll token', async () => {
    const k = scripted([pending]);
    const r = await keeperFly(ORIGIN, ['deploy'], undefined, {
      fetchImpl: k.fetchImpl,
      waitMs: 20,
      pollMs: 2,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('withdrawn');
    const del = k.seen.filter((s) => s.method === 'DELETE');
    expect(del).toEqual([
      { method: 'DELETE', url: `${ORIGIN}/v1/requests/req1`, poll: 'poll-token-1' },
    ]);
  });

  it('a Cloudflare call nobody approved in time is withdrawn too', async () => {
    const k = scripted([pending]);
    const f = keeperFetch(ORIGIN, { fetchImpl: k.fetchImpl, waitMs: 20, pollMs: 2 });
    const res = await f(`${ORIGIN}/v1/cloudflare/accounts/abc/access/apps`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(k.seen.filter((s) => s.method === 'DELETE')).toHaveLength(1);
  });
});

describe('an answer that is neither a result nor a hold', () => {
  it('is a failed command naming the status, never read as a result', async () => {
    for (const status of [400, 404, 423, 500, 503]) {
      const k = scripted([], () => new Response('starting', { status }));
      const r = await keeperFly(ORIGIN, ['apps', 'list'], undefined, { fetchImpl: k.fetchImpl });
      expect({ status, r }).toEqual({
        status,
        r: { status: 1, stdout: '', stderr: expect.stringContaining(String(status)) },
      });
    }
  });

  it('CONTROL: a 200 is the command result', async () => {
    const k = scripted(
      [],
      () => new Response(JSON.stringify({ status: 0, stdout: 'a\n', stderr: '' })),
    );
    const r = await keeperFly(ORIGIN, ['apps', 'list'], undefined, { fetchImpl: k.fetchImpl });
    expect(r).toEqual({ status: 0, stdout: 'a\n', stderr: '' });
  });
});
