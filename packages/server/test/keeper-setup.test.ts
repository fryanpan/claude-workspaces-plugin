/**
 * `keeper-setup.ts`, the one command that finishes the keeper's setup, run
 * against stand-ins: `sudo`, `fly`, `security` and `launchctl` on a PATH in
 * a temp dir, a fake keeper behind the fake `sudo`, and a fake `fetch` for
 * Cloudflare and the keeper's HTTP API. Every stand-in writes one line to a
 * shared log, so a test reads the order the steps ran in. Nothing here
 * touches a real Keychain, Fly, Cloudflare or launchd.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CF_TOKEN_PERMISSIONS } from '../src/keeper/keeper-setup.ts';
import {
  ACCOUNT,
  ACCOUNT_NAME,
  FLY_TOKEN,
  KEEPER,
  NEW_CF,
  PASTED_CF,
  SECRETS,
  type World,
  at,
  cred,
  run,
  sh,
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

describe('keeper-setup', () => {
  it('runs every step in order, with one password prompt, and prints no secret', async () => {
    const r = await run(w);
    expect(r.status).toBe(0);
    const order = [
      'sudo -v',
      'keeper check',
      'keeper port',
      'security find-generic-password -a claude-workspaces -s claude-workspaces-secret.fly-org-slug',
      'fetch GET api.cloudflare.com/client/v4/accounts',
      'fly tokens create org --org harborlight-org',
      'keeper import fly-org-token',
      'keeper import fly-org-slug',
      'fetch POST api.cloudflare.com/client/v4/user/tokens',
      'keeper import cloudflare-api-token',
      'keeper import cloudflare-account-id',
      'fly apps list --json --org harborlight-org',
      'keeper adopt cw-harborlight',
      'keeper adopt cw-riverbend',
      'launchctl print gui/501/com.example.board',
      'launchctl bootout',
      'launchctl bootstrap',
      'fetch POST localhost:45678/v1/fly',
      'fetch DELETE localhost:45678/v1/requests/req1',
    ];
    const idx = order.map((p) => at(r.calls, p));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(r.calls.filter((c) => c === 'sudo -v')).toHaveLength(1);
    // One y/N, after Bryan has seen the org and the account it is for.
    expect(r.confirms).toBe(1);
    expect(r.out).toContain('Fly org:            harborlight-org');
    expect(r.out).toContain(`Cloudflare account: ${ACCOUNT_NAME}`);

    // What the keeper was handed. The Fly token loses fly's `FlyV1 ` prefix,
    // which the keeper's import would refuse as whitespace.
    expect(cred(w, 'fly-org-token')).toBe(FLY_TOKEN);
    expect(cred(w, 'fly-org-slug')).toBe('harborlight-org');
    expect(cred(w, 'cloudflare-api-token')).toBe(NEW_CF);
    expect(cred(w, 'cloudflare-account-id')).toBe(ACCOUNT);
    expect(readFileSync(join(w.state, 'apps'), 'utf8')).toBe('cw-harborlight\ncw-riverbend\n');

    // The new Cloudflare token names every permission, on this one account.
    const minted = JSON.stringify(r.cf.minted[0]);
    for (const [i] of CF_TOKEN_PERMISSIONS.entries()) expect(minted).toContain(`"pg${i}"`);
    expect(minted).toContain(`com.cloudflare.api.account.${ACCOUNT}`);

    // Both callers point at the keeper; the rest of settings.json is kept.
    const settings = JSON.parse(readFileSync(w.settings, 'utf8'));
    expect(settings).toEqual({
      env: { KEEP: '1', CW_KEEPER_URL: KEEPER },
      theme: 'dark',
    });
    expect(statSync(w.plist).mode & 0o777).toBe(0o644);
    expect(readFileSync(w.plist, 'utf8')).toMatch(
      new RegExp(`<key>CW_KEEPER_URL</key>\\s*<string>${KEEPER}</string>`),
    );

    expect(r.out).toContain(`${KEEPER}/approve/req1`);
    expect(r.out).toContain('Permission denied');
    expect(r.out).toContain('The keeper is set up');
    // No value in any output or any argv.
    for (const s of SECRETS) {
      expect(r.out).not.toContain(s);
      expect(r.calls.join('\n')).not.toContain(s);
    }
  });

  it('a second run skips every step already done, and still checks', async () => {
    expect((await run(w)).status).toBe(0);
    const r = await run(w);
    expect(r.status).toBe(0);
    for (const c of r.calls) {
      expect(c).not.toMatch(/^(fly tokens|keeper import|keeper adopt|launchctl boot)/);
      expect(c).not.toContain('api.cloudflare.com');
    }
    expect(r.calls).toContain('fetch POST localhost:45678/v1/fly');
    expect(r.out).toContain('The keeper is set up');
  });

  it('a dry run prints every step, changes nothing and reads no secret', async () => {
    const plistBefore = readFileSync(w.plist, 'utf8');
    const settingsBefore = readFileSync(w.settings, 'utf8');
    const r = await run(w, { dryRun: true });
    expect(r.status).toBe(0);
    for (const step of ['1. ', '2. ', '3. ', '4. ', '5. ']) expect(r.out).toContain(`== ${step}`);
    expect(r.out).toContain('would adopt cw-harborlight, cw-riverbend');
    expect(r.out).toContain('Dry run: nothing was changed');
    for (const c of r.calls) {
      expect(c).not.toMatch(/^(fly tokens|keeper import|keeper adopt|launchctl boot|fetch)/);
      expect(c).not.toMatch(/cloudflare-api-token -w/);
    }
    expect(readFileSync(w.plist, 'utf8')).toBe(plistBefore);
    expect(readFileSync(w.settings, 'utf8')).toBe(settingsBefore);
    for (const s of SECRETS) expect(r.out).not.toContain(s);
  });

  it('when the current token cannot make tokens, prints the permissions and imports the pasted one', async () => {
    const r = await run(w, { cf: { canMint: false, minted: [] }, pasted: PASTED_CF });
    expect(r.status).toBe(0);
    expect(r.asked).toBe(1);
    expect(r.out).toContain('Access: Apps and Policies Read');
    expect(r.out).toContain('Access: Organizations, Identity Providers, and Groups Read');
    expect(cred(w, 'cloudflare-api-token')).toBe(PASTED_CF);
    expect(cred(w, 'cloudflare-account-id')).toBe(ACCOUNT);
    expect(r.out).not.toContain(PASTED_CF);
  });

  it('stops when this user can read the keeper store', async () => {
    chmodSync(join(w.root, 'state'), 0o700);
    const r = await run(w);
    expect(r.status).toBe(1);
    expect(r.out).toContain('STOP: ');
    expect(r.out).toContain('credentials.json');
    expect(r.calls).not.toContain('fetch POST localhost:45678/v1/fly');
  });

  it('stops before anything when the keeper reports an unsafe path', async () => {
    sh(
      join(w.root, 'bin', 'bun'),
      `echo "keeper $2" >> "$FAKE_LOG"; echo "unsafe: /x is writable"; exit 1\n`,
    );
    const r = await run(w);
    expect(r.status).toBe(1);
    expect(r.out).toContain('unsafe: /x is writable');
    expect(r.calls.some((c) => c.startsWith('fly'))).toBe(false);
  });
});

describe('keeper-setup-bin', () => {
  it('refuses to run from a checkout, before it reads or asks for anything', () => {
    const r = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../src/keeper/keeper-setup-bin.ts'), '--dry-run'],
      { env: { PATH: '/usr/bin:/bin', HOME: tmp } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("run this from the keeper's release");
  });
});
