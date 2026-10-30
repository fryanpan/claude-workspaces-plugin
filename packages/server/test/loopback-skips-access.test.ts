/**
 * `loopbackSkipsAccess`: in whole-server Access mode (an audience, no sharing
 * surface), a project machine's own loopback callers skip the token, and a
 * request through the Cloudflare edge still does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, exportJWK, generateKeyPair } from 'jose';
import { resolveServerConfig } from '../src/server-config.ts';
import { createServer } from '../src/server.ts';
import { seedBoardOnHandle } from './workspace-seed.ts';

const noArgs = (_name: string, fallback?: string) => fallback;

async function boot(loopbackSkipsAccess: boolean) {
  const { publicKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = 'k';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const dataDir = mkdtempSync(join(tmpdir(), 'loopback-skips-access-'));
  const handle = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: 'test.cloudflareaccess.com', audience: 'aud', jwks },
    loopbackSkipsAccess,
  });
  return { handle, dataDir, ws: seedBoardOnHandle(handle) };
}

describe('whole-server Access mode with loopbackSkipsAccess', () => {
  let on: Awaited<ReturnType<typeof boot>>;
  let off: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    on = await boot(true);
    off = await boot(false);
  });

  afterAll(async () => {
    for (const s of [on, off]) {
      await s.handle.stop();
      rmSync(s.dataDir, { recursive: true, force: true });
    }
  });

  it('serves the machine’s own loopback caller with no token', async () => {
    const r = await fetch(`http://127.0.0.1:${on.handle.port}/workspaces/${on.ws}?format=json`);
    expect(r.status).toBe(200);
  });

  it('still refuses a request that came through the Cloudflare edge', async () => {
    const r = await fetch(`http://127.0.0.1:${on.handle.port}/workspaces/${on.ws}?format=json`, {
      headers: { 'cf-ray': '8f00000000000000-SJC' },
    });
    expect(r.status).not.toBe(200);
  });

  it('is off by default: the same loopback caller needs a token', async () => {
    const r = await fetch(`http://127.0.0.1:${off.handle.port}/workspaces/${off.ws}?format=json`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe('missing_jwt');
  });

  it('is read from CW_LOOPBACK_SKIPS_ACCESS', () => {
    const at = (env: Record<string, string>) =>
      resolveServerConfig({ env, repoRoot: '/nonexistent-repo', arg: noArgs }).loopbackSkipsAccess;
    expect(at({ CW_DATA_DIR: '/nonexistent-data', CW_LOOPBACK_SKIPS_ACCESS: '1' })).toBe(true);
    expect(at({ CW_DATA_DIR: '/nonexistent-data' })).toBe(false);
  });
});
