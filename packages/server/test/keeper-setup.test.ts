/**
 * `keeper-setup.ts`, the one command that finishes the keeper's setup, run
 * against stand-ins: `sudo`, `fly`, `security` and `launchctl` on a PATH in
 * a temp dir, a fake keeper behind the fake `sudo`, and a fake `fetch` for
 * Cloudflare and the keeper's HTTP API. Every stand-in writes one line to a
 * shared log, so a test reads the order the steps ran in. Nothing here
 * touches a real Keychain, Fly, Cloudflare or launchd.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfPermissionsStamp, manualTokenSteps } from '../src/keeper/keeper-setup-cloudflare.ts';
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
      'keeper import cloudflare-token-permissions',
      'keeper import cloudflare-account-id',
      'fly apps list --json --org harborlight-org',
      'keeper adopt cw-harborlight',
      'keeper adopt cw-riverbend',
      'launchctl print gui/501/com.example.board',
      'launchctl bootout',
      'launchctl bootstrap',
      'fetch GET localhost:45678/v1/github-status',
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
    expect(cred(w, 'cloudflare-token-permissions')).toBe(cfPermissionsStamp());
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

    expect(r.out).toContain('GitHub holds the CI credentials already');
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
      // The one Cloudflare call left is the CI step's read of which tokens are active.
      if (c !== 'fetch GET api.cloudflare.com/client/v4/user/tokens')
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

  it("makes the keeper's token again when it was made without Access: Service Tokens Edit", async () => {
    expect((await run(w)).status).toBe(0);
    // The token the setup made before Edit was in the list.
    const before = CF_TOKEN_PERMISSIONS.filter((p) => p.api !== 'Access: Service Tokens Write');
    writeFileSync(join(w.state, 'cred-cloudflare-token-permissions'), cfPermissionsStamp(before));
    const r = await run(w);
    expect(r.status).toBe(0);
    expect(r.confirms).toBe(1);
    expect(r.out).toContain("the keeper's lacks this release's permissions; a new one is made");
    // The account is read through the keeper's current token, then a new one is made.
    const order = [
      'fetch GET localhost:45678/v1/cloudflare/accounts',
      'fetch POST api.cloudflare.com/client/v4/user/tokens',
      'keeper import cloudflare-api-token',
      'keeper import cloudflare-token-permissions',
      'keeper import cloudflare-account-id',
    ];
    const idx = order.map((p) => at(r.calls, p));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(JSON.stringify(r.cf.minted[0])).toContain(
      `"pg${CF_TOKEN_PERMISSIONS.findIndex((p) => p.api === 'Access: Service Tokens Write')}"`,
    );
    expect(cred(w, 'cloudflare-api-token')).toBe(NEW_CF);
    expect(cred(w, 'cloudflare-token-permissions')).toBe(cfPermissionsStamp());
    expect(r.out).toContain("The keeper's previous Cloudflare token is no longer used");
    // Fly and the apps were done already and are left alone.
    expect(r.calls.some((c) => /^(fly tokens|keeper import fly|keeper adopt)/.test(c))).toBe(false);
    for (const s of SECRETS) expect(r.out).not.toContain(s);
    // And the run after that has nothing to make.
    const again = await run(w);
    expect(again.calls.some((c) => c.startsWith('keeper import'))).toBe(false);
  });

  it('treats a token stored before the fingerprint existed as one to make again', async () => {
    expect((await run(w)).status).toBe(0);
    rmSync(join(w.state, 'cred-cloudflare-token-permissions'));
    const dry = await run(w, { dryRun: true });
    expect(dry.out).toContain("would replace the keeper's token, made without these permissions");
    expect(dry.out).toContain('- Access: Service Tokens Edit');
    expect(dry.calls.some((c) => c.startsWith('keeper import') || c.startsWith('fetch'))).toBe(
      false,
    );
    const r = await run(w, { cf: { canMint: false, minted: [] }, pasted: PASTED_CF });
    expect(r.status).toBe(0);
    expect(r.asked).toBe(1);
    expect(cred(w, 'cloudflare-api-token')).toBe(PASTED_CF);
    expect(cred(w, 'cloudflare-token-permissions')).toBe(cfPermissionsStamp());
  });

  it("makes the token again even when the keeper's old one can no longer read the account", async () => {
    expect((await run(w)).status).toBe(0);
    rmSync(join(w.state, 'cred-cloudflare-token-permissions'));
    // The keeper's agent API stays up; its Cloudflare read now fails.
    const r = await run(w, { keeperAccountsFail: true });
    expect(r.status).toBe(0);
    // The account is confirmed after the new token is made, before it is stored.
    expect(r.confirms).toBe(2);
    expect(r.out).toContain(`Cloudflare account: ${ACCOUNT_NAME}`);
    expect(cred(w, 'cloudflare-api-token')).toBe(NEW_CF);
    expect(cred(w, 'cloudflare-token-permissions')).toBe(cfPermissionsStamp());
  });

  it('an earlier run that stored the token and its fingerprint only adds the account id', async () => {
    expect((await run(w)).status).toBe(0);
    rmSync(join(w.state, 'cred-cloudflare-account-id'));
    const r = await run(w);
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('keeper import'))).toEqual([
      'keeper import cloudflare-account-id',
    ]);
    const cfCalls = r.calls.filter((c) => c.includes('api.cloudflare.com'));
    expect(cfCalls).toEqual(['fetch GET api.cloudflare.com/client/v4/user/tokens']);
    expect(cred(w, 'cloudflare-account-id')).toBe(ACCOUNT);
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

describe("the keeper's Cloudflare permission list", () => {
  it('grants Access: Service Tokens Edit on the account, and the dashboard steps name it', () => {
    expect(CF_TOKEN_PERMISSIONS).toContainEqual({
      dashboard: 'Access: Service Tokens Edit',
      api: 'Access: Service Tokens Write',
      scope: 'account',
    });
    expect(manualTokenSteps()).toContain('       - Access: Service Tokens Edit');
    // Still no API Tokens permission of any kind.
    expect(CF_TOKEN_PERMISSIONS.some((p) => p.api.startsWith('API Tokens'))).toBe(false);
  });

  it('fingerprints the list without regard to order, and changes when it changes', () => {
    expect(cfPermissionsStamp([...CF_TOKEN_PERMISSIONS].reverse())).toBe(cfPermissionsStamp());
    expect(cfPermissionsStamp(CF_TOKEN_PERMISSIONS.slice(1))).not.toBe(cfPermissionsStamp());
    expect(cfPermissionsStamp()).toMatch(/^[0-9a-f]{16}$/);
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
