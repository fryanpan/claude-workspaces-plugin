/**
 * `keeper-setup.ts` against the stand-ins in `keeper-setup-harness.ts`: the
 * fixes from PR 1462's review. Prod's restart is judged from the running job,
 * Bryan confirms the org and account before anything is made, the slug and
 * account id are validated, and a token made but not stored is named for
 * revoking.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKeeperSetup } from '../src/keeper/keeper-setup.ts';
import {
  FLY_TOKEN,
  LABEL,
  PASTED_CF,
  SECRETS,
  type World,
  fakeFetch,
  run,
  world,
} from './keeper-setup-harness.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-setup-'));
afterAll(() => {
  // The locked store folder has to be opened again before it can be removed.
  try {
    chmodSync(join(tmp, 'w', 'root', 'state'), 0o700);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

let w: World;
beforeEach(() => {
  w = world(tmp);
});

describe('keeper-setup, the review fixes', () => {
  it('reruns the restart when the plist is written but prod is not loaded', async () => {
    expect((await run(w)).status).toBe(0);
    // A restart cut short: the file is right and launchd holds no job.
    writeFileSync(join(w.state, 'unloaded'), '');
    const r = await run(w);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(true);
    expect(r.out).toContain('runs with CW_KEEPER_URL');
    expect(r.confirms).toBe(0);
  });

  it('restarts prod when it runs on its old environment', async () => {
    expect((await run(w)).status).toBe(0);
    rmSync(join(w.state, 'job-env'));
    const dry = await run(w, { dryRun: true });
    expect(dry.out).toContain('would restart prod (it is running without it)');
    const r = await run(w);
    expect(r.calls.some((c) => c.startsWith('launchctl bootout'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(true);
  });

  it('makes and stores nothing when Bryan does not confirm', async () => {
    const r = await run(w, { answer: 'n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Fly org:            harborlight-org');
    expect(r.out).toContain('nothing was made or stored');
    for (const c of r.calls) {
      expect(c).not.toMatch(/^(fly tokens|keeper import|fetch POST)/);
    }
  });

  it('a dry run shows the org without asking', async () => {
    const r = await run(w, { dryRun: true });
    expect(r.confirms).toBe(0);
    expect(r.out).toContain('Fly org:            harborlight-org');
    expect(r.out).toContain('would ask you to confirm these');
  });

  it('stops before any fly call when the Keychain has no slug, even with a token held', async () => {
    writeFileSync(join(w.state, 'cred-fly-org-token'), FLY_TOKEN);
    const r = await run(w, { env: { FAKE_SLUG: '' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('fly-org-slug');
    expect(r.calls.some((c) => c.startsWith('fly'))).toBe(false);
  });

  it('refuses a slug that could read as a flag', async () => {
    const r = await run(w, { env: { FAKE_SLUG: '-x' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('is not a slug');
    expect(r.calls.some((c) => c.startsWith('fly'))).toBe(false);
  });

  it('refuses a Cloudflare account id that is not 32 hex characters', async () => {
    const f = fakeFetch(w, { canMint: true, minted: [] });
    const r = await runKeeperSetup({
      root: w.root,
      user: 'cw-relay',
      home: w.home,
      uid: 501,
      label: LABEL,
      env: w.env,
      dryRun: false,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith('/accounts')
          ? new Response(JSON.stringify({ success: true, result: [{ id: 'abc', name: 'x' }] }))
          : f(input, init)) as typeof fetch,
      readSecret: async () => PASTED_CF,
      readLine: async () => 'y',
      print: () => {},
    });
    expect(r).toBe(1);
    expect(existsSync(join(w.state, 'cred-cloudflare-api-token'))).toBe(false);
  });

  it('names the Fly token to revoke when fly prints none it recognises', async () => {
    const r = await run(w, { env: { FAKE_FLY_GARBLED: '1' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('fly tokens list --org harborlight-org');
    expect(r.out).toContain('fly tokens revoke');
  });

  it('names the Cloudflare token to delete when the keeper refuses it', async () => {
    const r = await run(w, { env: { FAKE_IMPORT_FAILS: 'cloudflare-api-token' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Delete the token "claude-workspaces keeper ');
    expect(r.out).toContain('My Profile > API Tokens');
    for (const s of SECRETS) expect(r.out).not.toContain(s);
  });
});
