/**
 * `createHonoFront` on its own: what it answers, and what it hands back to
 * the ordered chain as null.
 *
 * The server-level half — the gates running once before it, a share visitor
 * refused on a path it answers — is `hono-front-gates.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoFamily, HonoGateEnv } from '../src/hono-env.ts';
import { createHonoFront } from '../src/routes/hono-front.ts';

/** A stand-in for what the gates proved; the probe reads only `ownerProven`. */
const env = { ownerProven: () => true } as unknown as HonoGateEnv;

const probe: HonoFamily = (app) => {
  app.get('/probe', (c) => c.json({ owner: c.env.ownerProven() }));
  app.get('/own-404', (c) => c.json({ error: 'not-here' }, 404));
  app.get('/workspaces/:ws/y', (c) => c.text('claimed'));
  app.get('/throws', () => {
    throw new Error('probe failure');
  });
};

const at = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

describe('createHonoFront', () => {
  const front = createHonoFront([probe]);

  it('answers a path a family claims, with the gates’ result as env', async () => {
    const res = await front(at('/probe'), env);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ owner: true });
  });

  it('hands back null for a path no family claims, on every method', async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      expect(await front(at('/nobody-claims-this', { method }), env)).toBeNull();
    }
    // A claimed path on a method nobody registered falls through too.
    expect(await front(at('/probe', { method: 'POST' }), env)).toBeNull();
  });

  it('hands back null for a HEAD Hono turns into a GET miss', async () => {
    // Hono answers HEAD by dispatching a GET and copying the result into a
    // new Response; the miss must still be recognised.
    expect(await front(at('/nobody-claims-this', { method: 'HEAD' }), env)).toBeNull();
    expect((await front(at('/probe', { method: 'HEAD' }), env))?.status).toBe(200);
  });

  it('returns a family’s own 404 rather than reading it as a miss', async () => {
    const res = await front(at('/own-404'), env);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: 'not-here' });
  });

  it('never takes a websocket upgrade, even on a path a family claims', async () => {
    const plain = await front(at('/workspaces/w-1/y'), env);
    expect(await plain?.text()).toBe('claimed');
    const upgrade = at('/workspaces/w-1/y', {
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
    expect(await front(upgrade, env)).toBeNull();
  });

  it('rethrows a handler’s error instead of answering Hono’s 500', async () => {
    await expect(front(at('/throws'), env)).rejects.toThrow('probe failure');
  });

  it('with no families, claims nothing', async () => {
    const empty = createHonoFront([]);
    expect(await empty(at('/probe'), env)).toBeNull();
  });
});
