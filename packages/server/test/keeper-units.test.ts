/**
 * The keeper's pure parts: which requests run, wait or are refused; what a
 * grant covers; the store's mode checks; and the start guard. Every token
 * here is made in the test.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StatFn, chainProblems, keeperStartProblems } from '../src/keeper/keeper-guard.ts';
import { classifyCloudflare, classifyFly, grantCovers } from '../src/keeper/keeper-policy.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const APPS = ['cw-harborlight'];
const tmp = mkdtempSync(join(tmpdir(), 'keeper-units-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fly policy', () => {
  it.each([
    [['machine', 'restart', 'm1', '--app', 'cw-harborlight']],
    [['machine', 'start', 'm1', '--app=cw-harborlight']],
    [['machines', 'stop', 'm1', '-a', 'cw-harborlight']],
    [['machines', 'list', '--app', 'cw-harborlight', '--json']],
    [['status', '--app', 'cw-harborlight']],
    [['logs', '--app', 'cw-harborlight', '--no-tail']],
    [['apps', 'list']],
  ])('runs %j with no passkey', (args) => {
    expect(classifyFly(args, APPS).kind).toBe('routine');
  });

  it('holds a start of a machine the keeper did not create', () => {
    const v = classifyFly(['machine', 'start', 'm1', '--app', 'cw-riverbend'], APPS);
    expect(v).toMatchObject({ kind: 'held', hold: 'other', app: 'cw-riverbend' });
  });

  it('holds creating a project and moving a token', () => {
    expect(classifyFly(['apps', 'create', 'cw-saltmarsh', '--org', 'x'], APPS)).toMatchObject({
      kind: 'held',
      hold: 'project.create',
      app: 'cw-saltmarsh',
    });
    for (const args of [
      ['secrets', 'import', '--app', 'cw-harborlight'],
      ['secrets', 'set', 'A=b', '--app', 'cw-harborlight'],
      ['ssh', 'console', '--app', 'cw-harborlight'],
    ]) {
      expect(classifyFly(args, APPS)).toMatchObject({ kind: 'held', hold: 'token.move' });
    }
    expect(
      classifyFly(['machine', 'destroy', 'm1', '--app', 'cw-harborlight'], APPS),
    ).toMatchObject({
      kind: 'held',
      hold: 'other',
    });
  });

  it('refuses whatever would hand the requester a credential or the org', () => {
    for (const args of [
      ['auth', 'token'],
      ['tokens', 'create', 'org'],
      ['orgs', 'invite', 'someone@example.test'],
      ['ssh', 'issue', '--org', 'x'],
      ['apps', 'move', 'cw-harborlight'],
      ['machine', 'restart', 'm1', '--app', 'cw-harborlight', '--access-token', 'x'],
      ['status', '-t', 'x', '--app', 'cw-harborlight'],
      ['machine', 'restart', 'm1', '--app', 'cw-harborlight', '--app', 'cw-riverbend'],
      ['machine', 'restart', 'm1', '--app=cw-harborlight', '-a', 'cw-riverbend'],
    ]) {
      expect(classifyFly(args, APPS).kind).toBe('refused');
    }
    expect(classifyFly('apps list', APPS).kind).toBe('refused');
    expect(classifyFly(['status', '--app', '../etc'], APPS).kind).toBe('refused');
  });
});

describe('cloudflare policy', () => {
  it('runs reads, holds writes, and holds a new Access application as access.open', () => {
    expect(classifyCloudflare('GET', '/accounts/abc/access/apps?page=1').kind).toBe('routine');
    expect(classifyCloudflare('POST', '/accounts/abc/access/apps')).toMatchObject({
      kind: 'held',
      hold: 'access.open',
    });
    expect(classifyCloudflare('DELETE', '/accounts/abc/access/apps/123')).toMatchObject({
      kind: 'held',
      hold: 'other',
    });
  });

  it('refuses minting a token and a path that is not plain', () => {
    expect(classifyCloudflare('POST', '/user/tokens').kind).toBe('refused');
    expect(classifyCloudflare('POST', '/accounts/abc/tokens').kind).toBe('refused');
    expect(classifyCloudflare('GET', '/accounts/../user').kind).toBe('refused');
    expect(classifyCloudflare('TRACE', '/zones').kind).toBe('refused');
  });
});

describe('grants', () => {
  const now = 1_000;
  const fly = [{ scope: 'fly' as const, target: 'cw-saltmarsh', expiresAt: now + 10 }];
  const held = (args: string[]) => {
    const v = classifyFly(args, []);
    if (v.kind !== 'held') throw new Error('expected held');
    return v;
  };

  it("CONTROL: a setup grant covers the project's own secrets and bucket", () => {
    expect(
      grantCovers(fly, 'fly', held(['secrets', 'import', '--app', 'cw-saltmarsh']), null, now),
    ).toBe(true);
    expect(
      grantCovers(
        fly,
        'fly',
        held(['storage', 'create', '--name', 'cw-saltmarsh-backups']),
        null,
        now,
      ),
    ).toBe(true);
  });

  it('covers no other app, no new app, and nothing once expired', () => {
    expect(
      grantCovers(fly, 'fly', held(['secrets', 'import', '--app', 'cw-riverbend']), null, now),
    ).toBe(false);
    expect(grantCovers(fly, 'fly', held(['apps', 'create', 'cw-saltmarsh-two']), null, now)).toBe(
      false,
    );
    expect(
      grantCovers(fly, 'fly', held(['secrets', 'import', '--app', 'cw-saltmarsh']), null, now + 10),
    ).toBe(false);
  });

  it('an Access grant covers its own application and never a new one', () => {
    const cf = [
      {
        scope: 'cloudflare' as const,
        target: '/accounts/abc/access/apps/123',
        expiresAt: now + 10,
      },
    ];
    const policy = classifyCloudflare('POST', '/accounts/abc/access/apps/123/policies');
    const fresh = classifyCloudflare('POST', '/accounts/abc/access/apps');
    const other = classifyCloudflare('POST', '/accounts/abc/access/apps/1234/policies');
    if (policy.kind !== 'held' || fresh.kind !== 'held' || other.kind !== 'held')
      throw new Error('held');
    expect(
      grantCovers(cf, 'cloudflare', policy, '/accounts/abc/access/apps/123/policies', now),
    ).toBe(true);
    expect(grantCovers(cf, 'cloudflare', fresh, '/accounts/abc/access/apps', now)).toBe(false);
    expect(
      grantCovers(cf, 'cloudflare', other, '/accounts/abc/access/apps/1234/policies', now),
    ).toBe(false);
  });
});

describe('store', () => {
  const me = process.getuid?.() ?? 0;

  it('CONTROL: a mode-700 folder opens, and every file it writes is 600', () => {
    const dir = join(tmp, 'ok');
    mkdirSync(dir, { mode: 0o700 });
    const store = openKeeperStore(dir);
    if ('error' in store) throw new Error(store.error);
    store.setCredential('fly-org-token', 'test-fly-token');
    store.addApp('cw-harborlight');
    expect(store.credentials().fly?.orgToken).toBe('test-fly-token');
    expect(store.apps()).toEqual(['cw-harborlight']);
    for (const f of ['credentials.json', 'apps.json']) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a folder others can open, a loose file, and a folder of another user', () => {
    const open = join(tmp, 'open');
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o755);
    expect(openKeeperStore(open)).toMatchObject({ error: expect.stringContaining('mode 755') });

    const loose = join(tmp, 'loose');
    mkdirSync(loose, { mode: 0o700 });
    writeFileSync(join(loose, 'credentials.json'), '{}', { mode: 0o644 });
    expect(openKeeperStore(loose)).toMatchObject({
      error: expect.stringContaining('credentials.json'),
    });

    const dir = join(tmp, 'ok');
    expect(openKeeperStore(dir, () => me + 1)).toMatchObject({
      error: expect.stringContaining('owned by uid'),
    });
  });
});

describe('start guard', () => {
  const fake =
    (table: Record<string, { uid: number; mode: number; dir?: boolean }>): StatFn =>
    (p) => {
      const e = table[p];
      if (!e) throw new Error(`no stat for ${p}`);
      return { uid: e.uid, mode: e.mode, isDirectory: e.dir ?? true };
    };
  const id = (p: string) => p;

  it("CONTROL: a chain owned by root and the keeper's user passes", () => {
    const stat = fake({
      '/': { uid: 0, mode: 0o755 },
      '/Users': { uid: 0, mode: 0o755 },
      '/Users/keeper': { uid: 501, mode: 0o700 },
      '/Users/keeper/bin': { uid: 501, mode: 0o755 },
      '/Users/keeper/bin/fly': { uid: 501, mode: 0o755, dir: false },
    });
    expect(chainProblems('/Users/keeper/bin/fly', 501, stat, id)).toEqual([]);
  });

  it("names a binary or folder Bryan's user owns, and a group-writable folder", () => {
    const stat = fake({
      '/': { uid: 0, mode: 0o755 },
      '/opt': { uid: 0, mode: 0o755 },
      '/opt/homebrew': { uid: 502, mode: 0o755 },
      '/opt/homebrew/bin': { uid: 0, mode: 0o775 },
      '/opt/homebrew/bin/fly': { uid: 502, mode: 0o755, dir: false },
    });
    const problems = chainProblems('/opt/homebrew/bin/fly', 501, stat, id);
    expect(problems).toContain('/opt/homebrew is owned by uid 502');
    expect(problems.some((p) => p.includes('writable by group'))).toBe(true);
  });

  it('allows a sticky world-writable folder, and not a plain one', () => {
    const base = { '/': { uid: 0, mode: 0o755 }, '/x/f': { uid: 501, mode: 0o644, dir: false } };
    const sticky = fake({ ...base, '/x': { uid: 0, mode: 0o1777 } });
    const plain = fake({ ...base, '/x': { uid: 0, mode: 0o777 } });
    expect(chainProblems('/x/f', 501, sticky, id)).toEqual([]);
    expect(chainProblems('/x/f', 501, plain, id)).toEqual([
      '/x is writable by group or others (mode 777)',
    ]);
  });

  it('walks every file under a source folder on the real disk', () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'keeper'), { recursive: true, mode: 0o755 });
    writeFileSync(join(src, 'keeper', 'a.ts'), '', { mode: 0o644 });
    const me = process.getuid?.() ?? 0;
    expect(keeperStartProblems({ sourceDirs: [src], files: [], keeperUid: me })).toEqual([]);
    chmodSync(join(src, 'keeper', 'a.ts'), 0o666);
    expect(keeperStartProblems({ sourceDirs: [src], files: [], keeperUid: me })).toEqual([
      expect.stringContaining('a.ts is writable by group or others'),
    ]);
  });
});
