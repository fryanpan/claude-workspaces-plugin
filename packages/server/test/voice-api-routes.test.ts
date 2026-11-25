/**
 * Who may manage voice tokens, judged by the route alone: the owner, from
 * anywhere; a caller proving nobody, only when it did not come through
 * the tunnel.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchRow } from '../src/routes/row-dispatch.ts';
import { type VoiceApiRouteRequest, handleVoiceApiRoutes } from '../src/routes/voice-api.ts';
import { VoiceChat } from '../src/voice-api/chat.ts';
import { VoiceApiTokens, voiceApiTokenKey, voiceTokensPath } from '../src/voice-api/tokens.ts';
import { rowAt } from './route-row.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-voice-routes-'));
  dirs.push(dir);
  return {
    chat: new VoiceChat({ list: () => [], send: () => ({ kind: 'unknown' }) }),
    tokens: new VoiceApiTokens(voiceTokensPath(dir), () => voiceApiTokenKey('c'.repeat(64)), now),
    speakerName: () => 'Alice',
    mintSubject: () => 'known-alice',
    j: (status: number, body: unknown) => Response.json(body, { status }),
  };
}

function mint(over: Partial<VoiceApiRouteRequest>): VoiceApiRouteRequest {
  return {
    req: new Request('http://h/api/voice/tokens', { method: 'POST', body: '{"label":"Phone"}' }),
    row: rowAt('voice-api.ts', '/api/voice/tokens'),
    visitor: null,
    ownerProven: () => false,
    anyoneProven: () => false,
    mustSignIn: () => false,
    requestOrigin: () => 'http://h',
    viaTunnel: () => false,
    ...over,
  };
}

const status = async (rq: VoiceApiRouteRequest) => (await handleVoiceApiRoutes(ctx(), rq))?.status;

describe('the voice token routes', () => {
  it('mint for the owner from anywhere, and for an unproven caller off the tunnel', async () => {
    expect(
      await status(
        mint({ ownerProven: () => true, anyoneProven: () => true, viaTunnel: () => true }),
      ),
    ).toBe(201);
    expect(await status(mint({}))).toBe(201);
  });

  it('refuse an unproven caller through the tunnel, a non-owner, a visitor, and another origin', async () => {
    expect(await status(mint({ viaTunnel: () => true }))).toBe(403);
    expect(await status(mint({ anyoneProven: () => true }))).toBe(403);
    expect(await status(mint({ visitor: { scope: 'share' } }))).toBe(403);
    const cross = new Request('http://h/api/voice/tokens', {
      method: 'POST',
      headers: { origin: 'https://bob.example' },
      body: '{}',
    });
    expect(await status(mint({ req: cross }))).toBe(403);
  });

  it('claims no other path', async () => {
    expect(matchRow('voice-api.ts', '/api/voice/agents')).toBeNull();
    // A revoke whose id is not a token id's shape is not this route either.
    const short = rowAt('voice-api.ts', '/api/voice/tokens/short/revoke');
    expect(await handleVoiceApiRoutes(ctx(), mint({ row: short }))).toBeNull();
  });

  it('answer a minted value once: never in the list, and never logged', async () => {
    const said: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) =>
      spyOn(console, k).mockImplementation((...a: unknown[]) => {
        said.push(a.map(String).join(' '));
      }),
    );
    try {
      const c = ctx();
      const minted = (await (await handleVoiceApiRoutes(c, mint({})))?.json()) as {
        token: string;
      };
      const mac = minted.token.split('.').at(-1) ?? '?';
      const list = await handleVoiceApiRoutes(
        c,
        mint({ req: new Request('http://h/api/voice/tokens') }),
      );
      expect(await list?.text()).not.toContain(mac);
      expect(said.join('\n')).not.toContain(mac);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('refuse a revoked token on the very next request', async () => {
    let t = 5_000;
    const c = ctx(() => t);
    const minted = (await (await handleVoiceApiRoutes(c, mint({})))?.json()) as {
      id: string;
      token: string;
    };
    const models = () =>
      handleVoiceApiRoutes(
        c,
        mint({
          req: new Request('http://h/v1/models', {
            headers: { authorization: `Bearer ${minted.token}` },
          }),
          row: rowAt('voice-api.ts', '/v1/models'),
        }),
      );
    expect((await models())?.status).toBe(200);
    // Inside the minute its last use is cached for: revocation still bites.
    t += 1_000;
    const revoked = await handleVoiceApiRoutes(
      c,
      mint({
        req: new Request(`http://h/api/voice/tokens/${minted.id}/revoke`, { method: 'POST' }),
        row: rowAt('voice-api.ts', `/api/voice/tokens/${minted.id}/revoke`),
      }),
    );
    expect(revoked?.status).toBe(200);
    expect((await models())?.status).toBe(401);
  });
});
