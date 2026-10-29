/**
 * The deploy scripts once the keeper holds the Cloudflare token: their
 * Cloudflare calls go through the keeper with no Keychain read, a read that
 * answers with a credential is refused, and a file the keeper's `fly` must
 * upload is staged where only this user and the keeper's user can read it.
 *
 * The keeper here is a real listener with a stand-in Cloudflare. The
 * Keychain is never read: `security` on PATH is a stand-in that records
 * being called. The keeper's user is this one, so no user is created.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { cloudflareClient, keeperStage } from '../../../infra/project-machine/mac-ops.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pm-keeper-'));
const bin = join(tmp, 'bin');
const securityCalls = join(tmp, 'security-calls');
const cloudflareCalls: string[] = [];
const exec: Executors = {
  fly: async () => ({ status: 0, stdout: '', stderr: '' }),
  cloudflare: async (method, path) => {
    cloudflareCalls.push(`${method} ${path}`);
    return { status: 200, body: '{"success":true,"result":[{"id":"z1"}]}' };
  },
};

let keeper: RunningKeeper;
const saved = {
  url: process.env.CW_KEEPER_URL,
  user: process.env.CW_KEEPER_USER,
  path: process.env.PATH,
};
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, 'security'), `#!/bin/sh\necho "$@" >> ${securityCalls}\nexit 1\n`);
  chmodSync(join(bin, 'security'), 0o755);
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const store = openKeeperStore(dir);
  if ('error' in store) throw new Error(store.error);
  keeper = serveKeeper({ store, exec, port: 0, keeperUid: 4_000_000 });
  process.env.PATH = `${bin}:${saved.path ?? ''}`;
  process.env.CW_KEEPER_URL = `http://127.0.0.1:${keeper.port}`;
});

afterAll(async () => {
  restore('CW_KEEPER_URL', saved.url);
  restore('CW_KEEPER_USER', saved.user);
  restore('PATH', saved.path);
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the deploy scripts' Cloudflare calls", () => {
  it('go through the keeper and read nothing from the Keychain', async () => {
    const api = cloudflareClient('test');
    const zones = await api<Array<{ id: string }>>('GET', '/zones?name=example.com');
    expect(zones).toEqual([{ id: 'z1' }]);
    expect(cloudflareCalls).toContain('GET /zones?name=example.com');
    expect(existsSync(securityCalls)).toBe(false);
  });

  it("a tunnel's token is refused, and no credential reaches the caller", async () => {
    const api = cloudflareClient('test');
    await expect(api('GET', '/accounts/abc/cfd_tunnel/t1/token')).rejects.toThrow('403');
    expect(cloudflareCalls.some((c) => c.includes('/token'))).toBe(false);
  });
});

/** The ACL entries `ls -le` prints for a path, one per line. */
const aclOf = (path: string): string => {
  const r = spawnSync('ls', ['-lde', path], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .join('\n');
};

describe.skipIf(process.platform !== 'darwin')('a file staged for the keeper', () => {
  const me = userInfo().username;

  it("is readable by this user and the keeper's alone, never by everyone", () => {
    process.env.CW_KEEPER_USER = me;
    const stage = keeperStage('cw-harborlight-restore-');
    try {
      expect(stage.dir.startsWith(tmpdir())).toBe(false);
      expect(statSync(stage.dir).mode & 0o777).toBe(0o700);
      expect(aclOf(stage.dir)).toContain(`user:${me} allow`);
      const tgz = join(stage.dir, 'data.tgz');
      writeFileSync(tgz, 'backup bytes', { mode: 0o644 });
      stage.share(tgz);
      expect(statSync(tgz).mode & 0o777).toBe(0o600);
      expect(aclOf(tgz)).toContain(`user:${me} allow read`);
    } finally {
      stage.done();
    }
    expect(existsSync(stage.dir)).toBe(false);
  });

  it('stops before anything is made when the keeper user does not exist', () => {
    process.env.CW_KEEPER_USER = 'cw-no-such-user-here';
    const before = readdirSync('/tmp').filter((n) => n.startsWith('cw-riverbend-restore-'));
    expect(() => keeperStage('cw-riverbend-restore-')).toThrow('cw-no-such-user-here');
    const after = readdirSync('/tmp').filter((n) => n.startsWith('cw-riverbend-restore-'));
    expect(after).toEqual(before);
  });

  it('CONTROL: without the keeper, it stays in this user’s own temp folder with no ACL', () => {
    const url = process.env.CW_KEEPER_URL;
    restore('CW_KEEPER_URL', undefined);
    try {
      const stage = keeperStage('cw-saltmarsh-restore-');
      try {
        expect(stage.dir.startsWith(tmpdir())).toBe(true);
        expect(aclOf(stage.dir)).toBe('');
      } finally {
        stage.done();
      }
    } finally {
      process.env.CW_KEEPER_URL = url;
    }
  });
});
