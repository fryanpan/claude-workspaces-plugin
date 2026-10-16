/**
 * The macOS-user script against a fake machine. Nothing here runs a real
 * command: `FakeMac` answers the reads and makes the changes in memory, and
 * throws on any command it does not model, so a new command cannot reach the
 * machine by slipping past the fake.
 */
import { describe, expect, it } from 'vitest';
import {
  CHMOD,
  CREATEHOMEDIR,
  type Change,
  DENY_RIGHTS,
  DSCL,
  DSEDITGROUP,
  LS,
  type LeadUsersConfig,
  SUDO,
  SYSADMINCTL,
  type System,
  apply,
  check,
  hasDeny,
  isAllowedChange,
  parseConfig,
  plan,
} from './mac-lead-users-lib.ts';

const OWNER_HOME = '/Users/saltmarsh';
const OWNER_TWIN = '/Volumes/Data/Users/saltmarsh';

class FakeMac implements System {
  users = new Map<string, { home: string; admin: boolean }>();
  dirs = new Set<string>([OWNER_HOME, OWNER_TWIN, `${OWNER_TWIN}/.claude`]);
  links = new Map<string, string>([[`${OWNER_HOME}/.claude`, `${OWNER_TWIN}/.claude`]]);
  acl = new Map<string, string[]>();
  root = true;
  /** Every command and every printed line, in the order they happened. */
  events: string[] = [];
  failOn: string | null = null;

  run(argv: readonly string[]) {
    this.events.push(`run ${argv.join(' ')}`);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const no = (stderr = '') => ({ status: 1, stdout: '', stderr });
    const [bin, ...a] = argv;
    if (this.failOn && argv.join(' ').includes(this.failOn)) return no('simulated failure');
    if (bin === DSCL && a[1] === '-read') {
      const u = this.users.get((a[2] ?? '').replace('/Users/', ''));
      return u ? ok(`NFSHomeDirectory: ${u.home}\n`) : no('eDSRecordNotFound');
    }
    if (bin === DSEDITGROUP && a[1] === 'checkmember') {
      const u = this.users.get(a[3] ?? '');
      return u?.admin ? ok(`yes ${a[3]} is a member of admin\n`) : no(`no ${a[3]} is NOT a member`);
    }
    if (bin === LS && a[0] === '-led') {
      const entries = this.acl.get(a[1] ?? '') ?? [];
      return ok(
        `drwxr-x---+ 40 owner staff 1280 Oct 16 10:00 ${a[1]}\n${entries.map((e, i) => ` ${i}: ${e}`).join('\n')}\n`,
      );
    }
    if (bin === SYSADMINCTL && a[0] === '-addUser') {
      const home = a[a.indexOf('-home') + 1] ?? '';
      this.users.set(a[1] ?? '', { home, admin: a.includes('-admin') });
      return ok();
    }
    if (bin === CREATEHOMEDIR) {
      const u = this.users.get(a[2] ?? '');
      if (u) this.dirs.add(u.home);
      return ok();
    }
    if (bin === CHMOD && a[0] === '+a') {
      const path = a[2] ?? '';
      this.acl.set(path, [...(this.acl.get(path) ?? []), a[1] ?? '']);
      return ok();
    }
    if (bin === SUDO && a[0] === '-n' && a[3] === LS) {
      const who = a[2] ?? '';
      const path = a[4] ?? '';
      const denied = (this.acl.get(path) ?? []).some((e) => e.startsWith(`user:${who} deny`));
      return this.dirs.has(path) && !denied ? ok() : no('Permission denied');
    }
    throw new Error(`FakeMac does not model: ${argv.join(' ')}`);
  }
  isRoot() {
    return this.root;
  }
  realpath(p: string) {
    return this.links.get(p) ?? p;
  }
  isDirectory(p: string) {
    return this.dirs.has(p) || this.links.has(p);
  }
  say = (line: string) => {
    this.events.push(`say ${line}`);
  };
}

const CONFIG: LeadUsersConfig = {
  users: [
    { name: 'cw-harborlight-lead', fullName: 'Harborlight lead' },
    { name: 'cw-riverbend-relay', fullName: 'Riverbend relay client' },
  ],
  protect: [OWNER_HOME, OWNER_TWIN, `${OWNER_HOME}/.claude`],
};

const WRITES = [SYSADMINCTL, CREATEHOMEDIR, CHMOD];
const writesIn = (events: string[]) =>
  events.filter((e) => WRITES.some((w) => e.startsWith(`run ${w} `)));

describe('the plan on a machine with neither user', () => {
  it('creates each user and its home, and denies each the protected folders and the other’s home', () => {
    const mac = new FakeMac();
    const p = plan(mac, CONFIG);
    expect(p.problems).toEqual([]);
    expect(p.changes.map((c) => c.says)).toEqual([
      'create standard user cw-harborlight-lead ("Harborlight lead"), home /Users/cw-harborlight-lead; you will be asked for its password',
      'create the home folder /Users/cw-harborlight-lead for cw-harborlight-lead',
      'create standard user cw-riverbend-relay ("Riverbend relay client"), home /Users/cw-riverbend-relay; you will be asked for its password',
      'create the home folder /Users/cw-riverbend-relay for cw-riverbend-relay',
      `deny cw-harborlight-lead reading or entering ${OWNER_HOME}`,
      `deny cw-harborlight-lead reading or entering ${OWNER_TWIN}`,
      `deny cw-harborlight-lead reading or entering ${OWNER_HOME}/.claude`,
      `deny cw-harborlight-lead reading or entering ${OWNER_TWIN}/.claude`,
      'deny cw-harborlight-lead reading or entering /Users/cw-riverbend-relay',
      `deny cw-riverbend-relay reading or entering ${OWNER_HOME}`,
      `deny cw-riverbend-relay reading or entering ${OWNER_TWIN}`,
      `deny cw-riverbend-relay reading or entering ${OWNER_HOME}/.claude`,
      `deny cw-riverbend-relay reading or entering ${OWNER_TWIN}/.claude`,
      'deny cw-riverbend-relay reading or entering /Users/cw-harborlight-lead',
    ]);
  });

  it('only reads the machine: planning runs no command that changes it', () => {
    const mac = new FakeMac();
    plan(mac, CONFIG);
    expect(mac.events.length).toBeGreaterThan(0);
    expect(writesIn(mac.events)).toEqual([]);
  });

  it('makes a standard user, never an admin, and asks for the password at the terminal', () => {
    const add = plan(new FakeMac(), CONFIG).changes[0] as Change;
    expect(add.argv).toEqual([
      SYSADMINCTL,
      '-addUser',
      'cw-harborlight-lead',
      '-fullName',
      'Harborlight lead',
      '-home',
      '/Users/cw-harborlight-lead',
      '-password',
      '-',
    ]);
    expect(add.interactive).toBe(true);
    const deny = plan(new FakeMac(), CONFIG).changes[4] as Change;
    expect(deny.argv).toEqual([
      CHMOD,
      '+a',
      `user:cw-harborlight-lead deny ${DENY_RIGHTS}`,
      OWNER_HOME,
    ]);
  });
});

describe('applying the plan', () => {
  it('prints every change before it makes it', () => {
    const mac = new FakeMac();
    const p = plan(mac, CONFIG);
    mac.events = [];
    expect(apply(mac, p.changes, mac.say)).toEqual({ ok: true, made: p.changes.length });
    const writes = mac.events.filter((e) => writesIn([e]).length > 0);
    expect(writes).toHaveLength(p.changes.length);
    for (const [i, c] of p.changes.entries()) {
      const ran = mac.events.indexOf(`run ${c.argv.join(' ')}`);
      expect(ran, c.says).toBeGreaterThan(mac.events.indexOf(`say → ${c.says}`));
      expect(mac.events.indexOf(`say → ${c.says}`), c.says).toBeGreaterThan(
        i === 0 ? -1 : mac.events.indexOf(`run ${(p.changes[i - 1] as Change).argv.join(' ')}`),
      );
    }
  });

  it('is idempotent: a second run plans nothing and changes nothing', () => {
    const mac = new FakeMac();
    apply(mac, plan(mac, CONFIG).changes, mac.say);
    mac.events = [];
    const again = plan(mac, CONFIG);
    expect(again.changes).toEqual([]);
    expect(apply(mac, again.changes, mac.say)).toEqual({ ok: true, made: 0 });
    expect(writesIn(mac.events)).toEqual([]);
  });

  it('adds only what is missing on a machine that is half done', () => {
    const mac = new FakeMac();
    mac.users.set('cw-harborlight-lead', { home: '/Users/cw-harborlight-lead', admin: false });
    mac.dirs.add('/Users/cw-harborlight-lead');
    mac.acl.set(OWNER_HOME, [`user:cw-harborlight-lead deny ${DENY_RIGHTS}`]);
    const says = plan(mac, CONFIG).changes.map((c) => c.says);
    expect(says.filter((s) => s.includes('create') && s.includes('cw-harborlight-lead '))).toEqual(
      [],
    );
    expect(says).not.toContain(`deny cw-harborlight-lead reading or entering ${OWNER_HOME}`);
    expect(says).toContain(`deny cw-harborlight-lead reading or entering ${OWNER_TWIN}`);
  });

  it('refuses to run without root, and runs nothing', () => {
    const mac = new FakeMac();
    const p = plan(mac, CONFIG);
    mac.root = false;
    mac.events = [];
    expect(apply(mac, p.changes, mac.say)).toEqual({ ok: false, made: 0 });
    expect(writesIn(mac.events)).toEqual([]);
  });

  it('stops at the first change that fails, and runs nothing after it', () => {
    const mac = new FakeMac();
    const p = plan(mac, CONFIG);
    mac.failOn = `${CREATEHOMEDIR} -c -u cw-riverbend-relay`;
    mac.events = [];
    const r = apply(mac, p.changes, mac.say);
    expect(r).toEqual({ ok: false, made: 3 });
    expect(writesIn(mac.events)).toHaveLength(4);
    expect(mac.events.at(-1)).toMatch(/failed \(exit 1\): simulated failure/);
  });
});

describe('what it will not do', () => {
  it('leaves an existing admin user alone and says why', () => {
    const mac = new FakeMac();
    mac.users.set('cw-harborlight-lead', { home: '/Users/cw-harborlight-lead', admin: true });
    mac.dirs.add('/Users/cw-harborlight-lead');
    const p = plan(mac, CONFIG);
    expect(p.problems.map((x) => x.user)).toEqual(['cw-harborlight-lead']);
    expect(p.changes.some((c) => c.argv.join(' ').includes('user:cw-harborlight-lead'))).toBe(
      false,
    );
  });

  it('runs only the three changes it makes: never a removal, a demotion or an admin', () => {
    const forbidden: string[][] = [
      [SYSADMINCTL, '-deleteUser', 'cw-harborlight-lead'],
      [SYSADMINCTL, '-addUser', 'cw-harborlight-lead', '-admin'],
      [CHMOD, '-a', `user:cw-harborlight-lead deny ${DENY_RIGHTS}`, OWNER_HOME],
      [CHMOD, '-R', '700', OWNER_HOME],
      [CHMOD, '+a', 'user:cw-harborlight-lead allow list', OWNER_HOME],
      ['/bin/rm', '-rf', '/Users/cw-harborlight-lead'],
      [DSCL, '.', '-delete', '/Users/cw-harborlight-lead'],
    ];
    for (const argv of forbidden)
      expect(isAllowedChange({ says: '', argv }), argv.join(' ')).toBe(false);
    const mac = new FakeMac();
    for (const c of plan(mac, CONFIG).changes) expect(isAllowedChange(c), c.says).toBe(true);
    mac.events = [];
    expect(
      apply(mac, [{ says: 'remove a user', argv: forbidden[0] as string[] }], mac.say).ok,
    ).toBe(false);
    expect(mac.events.filter((e) => e.startsWith('run '))).toEqual([]);
  });
});

describe('the config', () => {
  const users = [{ name: 'cw-harborlight-lead', fullName: 'Harborlight lead' }];
  it('takes the owner’s home when it names no protected folders', () => {
    const r = parseConfig({ users }, [OWNER_HOME]);
    expect(r.ok && r.config.protect).toEqual([OWNER_HOME]);
  });
  it.each([
    [{ users: [] }, 'at least one user'],
    [{ users: [{ name: 'Harborlight', fullName: 'x' }] }, 'cw- and lowercase'],
    [{ users: [{ name: 'cw-a;rm', fullName: 'x' }] }, 'cw- and lowercase'],
    [{ users: [{ name: 'cw-a', fullName: 'say "hi"' }] }, 'no quotes'],
    [{ users: [...users, ...users] }, 'listed twice'],
    [{ users, protect: ['relative/path'] }, 'absolute'],
    [{ users, protect: ['/'] }, 'one folder'],
    [{ users, protect: ['/Users/../etc'] }, 'one folder'],
  ])('refuses %j', (raw, why) => {
    const r = parseConfig(raw, [OWNER_HOME]);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(why);
  });
});

describe('the check', () => {
  it('passes once applied: each user lists its own home and no protected folder', () => {
    const mac = new FakeMac();
    apply(mac, plan(mac, CONFIG).changes, mac.say);
    const rows = check(mac, CONFIG);
    expect(rows.filter((r) => r.kind === 'own').map((r) => [r.user, r.readable])).toEqual([
      ['cw-harborlight-lead', true],
      ['cw-riverbend-relay', true],
    ]);
    expect(rows.filter((r) => r.kind === 'protected').length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('fails a protected folder a lead user can still list', () => {
    const mac = new FakeMac();
    apply(mac, plan(mac, CONFIG).changes, mac.say);
    mac.acl.set(OWNER_TWIN, []);
    const bad = check(mac, CONFIG).filter((r) => !r.ok);
    expect(bad.map((r) => [r.user, r.path])).toEqual([
      ['cw-harborlight-lead', OWNER_TWIN],
      ['cw-riverbend-relay', OWNER_TWIN],
    ]);
  });

  it('fails a user that does not exist, rather than reading it as walled off', () => {
    const rows = check(new FakeMac(), CONFIG);
    expect(rows.every((r) => !r.ok)).toBe(true);
  });
});

describe('reading an ACL', () => {
  it('finds a deny on list and search for the named user only', () => {
    const listing = [
      'drwxr-x---+ 40 owner staff 1280 Oct 16 10:00 /Users/saltmarsh',
      ' 0: group:everyone deny delete',
      ` 1: user:cw-riverbend-relay deny ${DENY_RIGHTS}`,
      ' 2: user:cw-harborlight-lead deny delete',
    ].join('\n');
    expect(hasDeny(listing, 'cw-riverbend-relay')).toBe(true);
    expect(hasDeny(listing, 'cw-harborlight-lead')).toBe(false);
    expect(hasDeny(listing, 'cw-riverbend')).toBe(false);
  });
});
