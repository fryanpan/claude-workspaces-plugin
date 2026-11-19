/**
 * `cf:rotate-token` without the keeper (`infra/cloudflare/rotate-token.ts`):
 * on the Mac it dispatches cf-rotate-token.yml with `gh`; in that workflow it
 * rotates and seals the new pair to the Mac for `handoff:pull`, which puts it
 * over the old one. A stand-in `gh` and a stand-in rotation; nothing leaves.
 */
import { describe, expect, it } from 'bun:test';
import {
  ROTATE_WORKFLOW,
  cloudflareCaller,
  dispatchRotation,
  rotateInCi,
} from '../../../infra/cloudflare/rotate-token.ts';
import { HandoffSink, openItems } from '../../../infra/handoff/items.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';

const SECRET = 'feedface'.repeat(8);

describe('cf:rotate-token on the Mac', () => {
  it('dispatches the workflow on main with the name as an input, and taps nothing', () => {
    const calls: string[][] = [];
    const said: string[] = [];
    const code = dispatchRotation('agent moi', {
      gh: (a) => {
        calls.push(a);
        return { status: 0, stderr: '' };
      },
      out: (s) => said.push(s),
      err: (s) => said.push(s),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(['workflow', 'run', ROTATE_WORKFLOW]);
    expect(calls[0]).toContain('--ref');
    expect(calls[0]?.[calls[0].indexOf('--ref') + 1]).toBe('main');
    expect(calls[0]?.slice(-2)).toEqual(['-f', 'name=agent moi']);
    expect(said.join('')).toContain('handoff:pull');
    expect(said.join('')).toContain('a second rotation ends the old secret at once');
  });

  it('refuses a name that is not a token name before gh runs, and reports a failed dispatch', () => {
    const calls: string[][] = [];
    const io = (status: number) => ({
      gh: (a: string[]) => {
        calls.push(a);
        return { status, stderr: 'HTTP 404' };
      },
      out: () => {},
      err: () => {},
    });
    expect(dispatchRotation('-f name=x', io(0))).toBe(2);
    expect(calls).toEqual([]);
    expect(dispatchRotation('agent moi', io(1))).toBe(1);
  });
});

describe('cf-rotate-token.yml', () => {
  function world(answer: { status: number; body: unknown }, macKey?: string) {
    const sealed: string[] = [];
    const sink = new HandoffSink('mac', '/out/handoff.json');
    const flush = sink.flush.bind(sink);
    sink.flush = (key) => flush(key, (_p, t) => sealed.push(t));
    const said: string[] = [];
    const rotated: string[] = [];
    const io = {
      rotate: async (n: string) => {
        rotated.push(n);
        return { status: answer.status, body: JSON.stringify(answer.body) };
      },
      sink,
      macKey: () => {
        if (!macKey) throw new Error('recipients.json has no key for mac');
        return macKey;
      },
      out: (s: string) => said.push(s),
      err: (s: string) => said.push(s),
    };
    return { io, sealed, said, rotated };
  }

  it('seals the new pair to the Mac as a replacement, and prints no secret', async () => {
    const mac = generateHandoffKeys();
    const w = world(
      {
        status: 200,
        body: { clientId: 'c0ffee.access', secret: SECRET, previousSecretExpiresAt: 'later' },
      },
      mac.publicKey,
    );
    expect(await rotateInCi('agent moi', w.io)).toBe(0);
    expect(w.sealed).toHaveLength(1);
    expect(openItems(mac.privateKey, w.sealed[0] ?? '').items).toEqual([
      {
        kind: 'service-token',
        name: 'agent moi',
        clientId: 'c0ffee.access',
        secret: SECRET,
        replace: true,
      },
    ]);
    expect(w.said.join('')).not.toContain(SECRET);
    expect(w.said.join('')).toContain('later');
  });

  it('rotates nothing when the pair could not be sealed: no Mac key, or no sink', async () => {
    const noKey = world({ status: 200, body: {} });
    expect(await rotateInCi('agent moi', noKey.io)).toBe(1);
    expect(noKey.rotated).toEqual([]);
    const noSink = world({ status: 200, body: {} }, generateHandoffKeys().publicKey);
    expect(await rotateInCi('agent moi', { ...noSink.io, sink: null })).toBe(1);
    expect(noSink.rotated).toEqual([]);
  });

  it("prints Cloudflare's refusal and seals nothing", async () => {
    const w = world(
      { status: 404, body: { error: 'no token named that' } },
      generateHandoffKeys().publicKey,
    );
    expect(await rotateInCi('agent moi', w.io)).toBe(1);
    expect(w.sealed).toEqual([]);
    expect(w.said.join('')).toContain('no token named that');
  });

  it('calls Cloudflare with the token in a header only', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"success":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const cf = cloudflareCaller('fixture-cf-token', fake);
    expect(await cf('GET', '/accounts', undefined)).toEqual({
      status: 200,
      body: '{"success":true}',
    });
    expect(seen[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts');
    expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-cf-token',
    );
  });
});
