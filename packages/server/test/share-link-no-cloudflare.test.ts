/**
 * A server that holds no Cloudflare token answers the per-share Access mint
 * (`POST /api/share/link`, where no share hostname is configured) with 503
 * before it reads the audience, so it files no owner card for a mint that
 * cannot happen. The board server is that server since the keeper retired
 * (`server-deps.ts`). The control is the same request to a server handed a
 * Cloudflare client, which gets past the refusal.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CfApi } from '../src/share/cf-api.ts';
import { ACCESS_NOT_CONFIGURED } from '../src/share/shares.ts';

const CONFIG = { baseHostname: 'example.test', cfAccountId: 'acct', cfTeamDomain: 'team.example' };

/** Cloudflare, faked: every call succeeds with an app or a policy. */
function fakeCfApi(): CfApi {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    const result = { id: `id-${n}`, aud: `aud-${n}`, name: 'x', domain: 'x', decision: 'allow' };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return new CfApi({ accountId: 'acct', token: 'tok', fetchImpl });
}

let handle: ServerHandle | null = null;
let dataDir = '';
afterEach(async () => {
  await handle?.stop();
  handle = null;
  rmSync(dataDir, { recursive: true, force: true });
});

async function mintOn(cfApi: CfApi | undefined) {
  dataDir = mkdtempSync(join(tmpdir(), 'share-no-cf-'));
  handle = createServer({
    port: 0,
    dataDir,
    share: { config: CONFIG, ...(cfApi ? { cfApi } : {}) },
  });
  const local = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${handle?.port}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle?.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const board = await local('/workspaces', { name: 'Harborlight review' });
  const workspaceId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
  const r = await local('/api/share/link', { allowDomains: ['@riverbend.example'], workspaceId });
  return { status: r.status, body: (await r.json()) as { error?: string; hint?: string } };
}

describe('the per-share Access mint with no Cloudflare token', () => {
  it('is refused with 503 naming share_workspace', async () => {
    const r = await mintOn(undefined);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(ACCESS_NOT_CONFIGURED);
    expect(r.body.hint).toContain('share_workspace');
  });

  it('CONTROL: a server handed a Cloudflare client gets past the refusal', async () => {
    const r = await mintOn(fakeCfApi());
    expect(r.status).not.toBe(503);
    expect(r.body.error).not.toBe(ACCESS_NOT_CONFIGURED);
  });
});
