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

const APPS = ['cw-harbor'];
const tmp = mkdtempSync(join(tmpdir(), 'keeper-units-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fly policy', () => {
  it.each([
    [['machine', 'restart', 'm1', '--app', 'cw-harbor']],
    [['machine', 'start', 'm1', '--app=cw-harbor']],
    [['machines', 'stop', 'm1', '-a', 'cw-harbor']],
    [['machines', 'list', '--app', 'cw-harbor', '--json']],
    [['status', '--app', 'cw-harbor']],
    [['logs', '--app', 'cw-harbor', '--no-tail']],
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
      ['secrets', 'import', '--app', 'cw-harbor'],
      ['secrets', 'set', 'A=b', '--app', 'cw-harbor'],
      ['ssh', 'console', '--app', 'cw-harbor'],
    ]) {
      expect(classifyFly(args, APPS)).toMatchObject({ kind: 'held', hold: 'token.move' });
    }
    expect(
      classifyFly(['machine', 'destroy', 'm1', '--app', 'cw-harbor'], APPS),
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
      ['apps', 'move', 'cw-harbor'],
      ['machine', 'restart', 'm1', '--app', 'cw-harbor', '--access-token', 'x'],
      ['status', '-t', 'x', '--app', 'cw-harbor'],
      ['machine', 'restart', 'm1', '--app', 'cw-harbor', '--app', 'cw-riverbend'],
      ['machine', 'restart', 'm1', '--app=cw-harbor', '-a', 'cw-riverbend'],
    ]) {
      expect(classifyFly(args, APPS).kind).toBe('refused');
    }
    expect(classifyFly('apps list', APPS).kind).toBe('refused');
    expect(classifyFly(['status', '--app', '../etc'], APPS).kind).toBe('refused');
  });
});

describe('fly argv is parsed strictly', () => {
  const verdict = (args: string[]) => classifyFly(args, APPS).kind;

  it.each([
    // A joined short flag: pflag reads -aprod as --app prod, and keeps the last.
    [['machine', 'stop', 'm1', '-a', 'cw-harbor', '-aprod']],
    [['machine', 'list', '-acw-riverbend']],
    [['status', '-tTOKEN', '--app', 'cw-harbor']],
    [['machine', 'stop', 'm1', '-a=cw-riverbend']],
    [['machine', 'stop', 'm1', '--app', 'cw-harbor', '--', '-a', 'cw-riverbend']],
    [['status', '-', '--app', 'cw-harbor']],
    [['status', '--app']],
  ])('refuses the flag shape in %j', (args) => {
    expect(verdict(args)).toBe('refused');
  });

  it.each([
    // A leading flag hides the command from a check that reads argv[0].
    [['--debug', 'tokens', 'create', 'deploy', '-a', 'cw-harbor']],
    [['-a', 'cw-harbor', 'status']],
    // So does a flag between a command and its subcommand.
    [['ssh', '-a', 'cw-harbor', 'issue']],
    [['wireguard', 'create', 'org', 'iad', 'peer', '-a', 'cw-harbor']],
    [['organizations', 'invite', 'alice@example.test']],
    // Debug output may carry the Authorization header.
    [['status', '--app', 'cw-harbor', '--debug']],
    [['status', '--app', 'cw-harbor', '--verbose']],
    [['logs', '--app', 'cw-harbor', '--no-tail', '--debug=true']],
  ])('refuses %j', (args) => {
    expect(verdict(args)).toBe('refused');
  });

  it('runs a routine command only when every flag is one it names', () => {
    // --signal takes a value, so fly reads "-a" as the signal and takes the
    // app from the config file: this must not run as a restart of ours.
    expect(
      verdict(['machine', 'stop', 'm1', '--signal', '-a', 'cw-harbor', '--config', 'x.toml']),
    ).not.toBe('routine');
    expect(
      verdict(['machine', 'stop', 'm1', '--app', 'cw-harbor', '--config', 'x.toml']),
    ).toBe('refused');
    // CONTROL: the plain form still runs.
    expect(verdict(['machine', 'stop', 'm1', '--app', 'cw-harbor'])).toBe('routine');
  });
});

describe('fly deploy', () => {
  it('is held, never routine and never on a grant, with the flags the deploy script uses', () => {
    const v = classifyFly(
      [
        'deploy',
        '/tmp/ctx',
        '--app',
        'cw-harbor',
        '--config',
        '/tmp/ctx/fly.toml',
        '--dockerfile',
        '/tmp/ctx/Dockerfile',
        '--remote-only',
        '--ha=false',
        '--no-public-ips',
        '--image-label',
        'abc',
        '--yes',
      ],
      APPS,
    );
    expect(v).toMatchObject({ kind: 'held', hold: 'other' });
    expect('setup' in v && v.setup).toBeFalsy();
  });

  it.each([
    // A flag outside the deploy script's list may name another path to read.
    [['deploy', '/tmp/ctx', '--app', 'cw-harbor', '--build-secret', 'A=/x']],
    [['deploy', '/tmp/ctx', '--app', 'cw-harbor', '--file-local', '/m=/x']],
    // No folder named: fly builds the keeper's own working folder.
    [['deploy', '--app', 'cw-harbor']],
    // No --config: fly would look for one in the build folder or the keeper's own.
    [['deploy', '/tmp/ctx', '--app', 'cw-harbor', '--remote-only']],
  ])('refuses %j', (args) => {
    expect(classifyFly(args, APPS).kind).toBe('refused');
  });

  // A held command runs only as written below; any flag or command outside
  // the list is refused, so no flag that reads a local file can reach fly.
  it.each([
    ['machine', 'run', 'img', '--app', 'cw-harbor'],
    ['machine', 'run', 'img', '--app', 'cw-harbor', '--file-local', '/m=/x'],
    ['machine', 'update', 'm1', '--app', 'cw-harbor', '--file-local=/m=/x'],
    ['console', '--app', 'cw-harbor', '--file-local', '/m=/x'],
    ['launch', '--path', '/x'],
    ['secrets', 'import', '--app', 'cw-harbor', '--env-file', '/x'],
    ['secrets', 'set', 'A=b', '--app', 'cw-harbor', '--config', '/x/fly.toml'],
    ['ssh', 'console', '--app', 'cw-harbor', '--pty'],
    ['ssh', 'sftp', 'shell', '--app', 'cw-harbor'],
    ['apps', 'create', 'cw-saltmarsh', '--org', 'x', '--generate-name'],
    ['storage', 'create', '--org', 'x', '--name', 'b', '--public'],
    ['machine', 'destroy', 'm1', '--app', 'cw-harbor', '--image', 'x'],
    ['certs', 'add', 'example.test', '--app', 'cw-harbor'],
  ])('refuses a command or flag the held list does not name: %j', (...args) => {
    expect(classifyFly(args, APPS)).toMatchObject({ kind: 'refused' });
  });

  it("CONTROL: every held command the scripts send is held, with the scripts' flags", () => {
    for (const args of [
      ['apps', 'create', 'cw-saltmarsh', '--org', 'x', '--network', 'n'],
      ['storage', 'create', '--org', 'x', '--name', 'b', '--yes'],
      ['secrets', 'import', '--app', 'cw-harbor', '--stage'],
      [
        'volumes',
        'create',
        'cw_data',
        '--app',
        'cw-riverbend',
        '--region',
        'sjc',
        '--size',
        '1',
        '--yes',
      ],
      ['ssh', 'console', '--app', 'cw-harbor', '--command', "sh -c 'true'"],
      ['ssh', 'sftp', 'put', '/tmp/a.tgz', '/data/a.tgz', '--app', 'cw-harbor'],
      ['machine', 'restart', 'm1', '--app', 'cw-riverbend'],
      ['machine', 'destroy', 'm1', '--app', 'cw-harbor', '--force'],
      ['volumes', 'destroy', 'v1', '--app', 'cw-harbor', '--yes'],
    ]) {
      expect({ args, kind: classifyFly(args, APPS).kind }).toEqual({ args, kind: 'held' });
    }
  });
});

describe('cloudflare policy', () => {
  it('runs the reads its callers make, holds writes, and holds a new Access application as access.open', () => {
    expect(classifyCloudflare('GET', '/accounts/abc/access/apps?page=1').kind).toBe('routine');
    expect(classifyCloudflare('POST', '/accounts/abc/access/apps')).toMatchObject({
      kind: 'held',
      hold: 'access.open',
    });
    expect(classifyCloudflare('POST', '/zones/z1/dns_records')).toMatchObject({
      kind: 'held',
      hold: 'other',
    });
  });

  it('CONTROL: every read the sharing, tunnel and router callers make is routine', () => {
    for (const path of [
      '/accounts/abc/access/apps?domain=share.example.com',
      '/accounts/abc/access/apps?page=2&per_page=50',
      '/zones?name=example.com',
      '/zones/z1/dns_records?name=%2A.example.com',
      '/zones/z1/ssl/certificate_packs?status=all',
      '/accounts/abc/cfd_tunnel?name=cw-harbor&is_deleted=false',
      '/accounts/abc/cfd_tunnel/0f1e-2d3c/configurations',
    ]) {
      expect({ path, kind: classifyCloudflare('GET', path).kind }).toEqual({
        path,
        kind: 'routine',
      });
    }
  });

  it('refuses a read that answers with a credential, and holds a read no caller makes', () => {
    for (const path of [
      '/accounts/abc/cfd_tunnel/0f1e-2d3c/token',
      '/accounts/abc/warp_connector/0f1e/token',
      '/accounts/abc/token',
    ]) {
      expect({ path, kind: classifyCloudflare('GET', path).kind }).toEqual({
        path,
        kind: 'refused',
      });
    }
    expect(classifyCloudflare('GET', '/accounts/abc/workers/scripts')).toMatchObject({
      kind: 'held',
      hold: 'other',
    });
    expect(classifyCloudflare('GET', '/user/tokens')).toMatchObject({ kind: 'held' });
  });

  it('revokes an Access application the keeper opened, and its policies, without a tap', () => {
    const ours = ['123'];
    expect(classifyCloudflare('DELETE', '/accounts/abc/access/apps/123', ours).kind).toBe(
      'routine',
    );
    expect(
      classifyCloudflare('DELETE', '/accounts/abc/access/apps/123/policies/p9', ours).kind,
    ).toBe('routine');
    // Deleting an application it did not open can expose whatever that one guarded.
    expect(classifyCloudflare('DELETE', '/accounts/abc/access/apps/456', ours)).toMatchObject({
      kind: 'held',
      hold: 'other',
    });
    expect(classifyCloudflare('DELETE', '/accounts/abc/access/apps/123')).toMatchObject({
      kind: 'held',
    });
    // Only a delete: changing the application's policy is still held.
    expect(classifyCloudflare('PUT', '/accounts/abc/access/apps/123/policies/p9', ours).kind).toBe(
      'held',
    );
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

  it("CONTROL: a setup grant covers the project's own volume, secrets and image", () => {
    for (const args of [
      ['secrets', 'import', '--app', 'cw-saltmarsh', '--stage'],
      ['volumes', 'create', 'data', '--app', 'cw-saltmarsh', '--region', 'iad', '--size', '1'],
    ]) {
      expect({ args, covered: grantCovers(fly, 'fly', held(args), null, now) }).toEqual({
        args,
        covered: true,
      });
    }
  });

  it('covers only the commands on its list, and only the app it was opened on', () => {
    for (const args of [
      // A shell, an org-level bucket, a destroy: each is its own tap.
      ['ssh', 'console', '--app', 'cw-saltmarsh'],
      ['storage', 'create', '--org', 'x', '--name', 'cw-saltmarsh-backups', '--yes'],
      ['machine', 'destroy', 'm1', '--app', 'cw-saltmarsh', '--force'],
      // An app the keeper never created, named under the granted one.
      ['secrets', 'import', '--app', 'cw-saltmarsh-prod'],
      // An image built from an agent-chosen folder: always its own tap.
      ['deploy', '/tmp/ctx', '--app', 'cw-saltmarsh', '--config', '/tmp/ctx/fly.toml', '--yes'],
    ]) {
      expect({ args, covered: grantCovers(fly, 'fly', held(args), null, now) }).toEqual({
        args,
        covered: false,
      });
    }
    // A listed command with a flag the list does not name is not even held.
    expect(
      classifyFly(['secrets', 'import', '--app', 'cw-saltmarsh', '--config', 'other.toml'], APPS)
        .kind,
    ).toBe('refused');
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
    store.addApp('cw-harbor');
    expect(store.credentials().fly?.orgToken).toBe('test-fly-token');
    expect(store.apps()).toEqual(['cw-harbor']);
    store.addAccessApp('0f1e-2d3c');
    expect(store.accessApps()).toEqual(['0f1e-2d3c']);
    expect(() => store.addAccessApp('../x')).toThrow();
    for (const f of ['credentials.json', 'apps.json', 'access.json']) {
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
