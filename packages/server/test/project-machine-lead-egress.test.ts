/**
 * The lead's network wall (`infra/project-machine/lead-egress*.ts`): the
 * allowlist's format, the rules built from it, how they are loaded and read
 * back, the /etc/hosts block, and how the boot probe is judged.
 *
 * Nothing here touches a firewall or the network: the commands are a fake
 * runner that records what it was asked and keeps the rules it was given,
 * and resolution and connection are injected. That the kernel enforces the
 * rules is `project-machine-lead-limits-container.test.ts`, in a container.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAIN,
  HOSTS_BEGIN,
  HOSTS_END,
  PROBE_ALLOWED,
  type Resolved,
  WALLED_UIDS,
  chainProblem,
  judgeProbe,
  parseAllowlist,
  rulesFor,
  spliceHosts,
} from '../../../infra/project-machine/lead-egress-plan.ts';
import { type Ran, type Runner, apply, probe } from '../../../infra/project-machine/lead-egress.ts';
import { machineDir } from './project-machine-harness.ts';

const SHIPPED = join(machineDir, 'lead-egress.allow');

describe('the allowlist file', () => {
  it('reads the shipped list: every entry has a reason, and DNS is not on it', () => {
    const entries = parseAllowlist(readFileSync(SHIPPED, 'utf8'));
    expect(entries.map((e) => e.host)).toEqual([
      'api.anthropic.com',
      'platform.claude.com',
      'claude.ai',
      'github.com',
    ]);
    expect(entries.every((e) => e.why.length > 10)).toBe(true);
    const github = entries.find((e) => e.host === 'github.com');
    expect(github?.ports).toEqual([{ proto: 'tcp', port: 22 }]);
    expect(entries.flatMap((e) => e.ports).some((p) => p.port === 53)).toBe(false);
  });

  it('refuses a line with no reason, a bad host, a bad port and a duplicate, naming the line', () => {
    const bad: [string, RegExp][] = [
      ['api.anthropic.com tcp/443\n', /line 1: every entry needs a reason/],
      ['# ok\n\nexample..com tcp/443 # x\n', /line 3: .* is not a host name/],
      ['203.0.113.7 tcp/443 # an address, not a name\n', /not a host name/],
      ['riverbend.test tcp/70000 # too big\n', /is not tcp\/<port>/],
      ['riverbend.test icmp/1 # wrong proto\n', /is not tcp\/<port>/],
      ['riverbend.test # no ports\n', /want "<host> <proto>/],
      [
        'riverbend.test tcp/443 # a\nriverbend.test tcp/22 # b\n',
        /line 2: riverbend.test is listed twice/,
      ],
    ];
    for (const [text, why] of bad) expect(() => parseAllowlist(text)).toThrow(why);
    // POSITIVE CONTROL: the same shapes, written correctly, parse.
    expect(parseAllowlist('riverbend.test tcp/443,udp/4433 # two ports\n')[0]?.ports).toEqual([
      { proto: 'tcp', port: 443 },
      { proto: 'udp', port: 4433 },
    ]);
  });
});

const ENTRIES = parseAllowlist(
  'api.riverbend.test tcp/443 # model\ngit.harborlight.test tcp/22 # git\ngone.saltmarsh.test tcp/443 # unresolved\n',
);
const RESOLVED: Resolved = new Map([
  ['api.riverbend.test', ['203.0.113.10', '2001:db8::10', '203.0.113.10']],
  ['git.harborlight.test', ['198.51.100.22']],
  ['gone.saltmarsh.test', []],
]);

describe('the rules', () => {
  it('allows loopback and each resolved address on its ports, in its own family, and rejects the rest', () => {
    expect(rulesFor(ENTRIES, RESOLVED, 4).split('\n')).toEqual([
      '*filter',
      `:${CHAIN} - [0:0]`,
      `-A ${CHAIN} -o lo -j ACCEPT`,
      `-A ${CHAIN} -d 203.0.113.10/32 -p tcp -m tcp --dport 443 -j ACCEPT`,
      `-A ${CHAIN} -d 198.51.100.22/32 -p tcp -m tcp --dport 22 -j ACCEPT`,
      `-A ${CHAIN} -p tcp -j REJECT --reject-with tcp-reset`,
      `-A ${CHAIN} -j REJECT --reject-with icmp-port-unreachable`,
      'COMMIT',
      '',
    ]);
    const v6 = rulesFor(ENTRIES, RESOLVED, 6);
    expect(v6).toContain(`-A ${CHAIN} -d 2001:db8::10/128 -p tcp -m tcp --dport 443 -j ACCEPT`);
    expect(v6).not.toContain('203.0.113.10');
    expect(v6.trim().split('\n').at(-2)).toBe(
      `-A ${CHAIN} -j REJECT --reject-with icmp6-port-unreachable`,
    );
  });

  it('reads a chain back as holding only when it ends in the reject', () => {
    const good = rulesFor(ENTRIES, RESOLVED, 4)
      .split('\n')
      .filter((l) => l.startsWith('-A'))
      .join('\n');
    expect(chainProblem(`-N ${CHAIN}\n${good}\n`, 4)).toBeNull();
    expect(chainProblem(`-N ${CHAIN}\n-A ${CHAIN} -o lo -j ACCEPT\n`, 4)).toMatch(
      /does not end in a reject/,
    );
    expect(chainProblem(`-N ${CHAIN}\n`, 6)).toMatch(/last rule: none/);
  });

  it('replaces only its own block in /etc/hosts', () => {
    const fly = '127.0.0.1 localhost\nfdaa::5 riverbend-machine\n';
    const once = spliceHosts(fly, ENTRIES, RESOLVED);
    expect(once).toBe(
      `${fly}${HOSTS_BEGIN}\n2001:db8::10 api.riverbend.test\n203.0.113.10 api.riverbend.test\n198.51.100.22 git.harborlight.test\n${HOSTS_END}\n`,
    );
    const moved: Resolved = new Map([['api.riverbend.test', ['203.0.113.99']]]);
    const twice = spliceHosts(once, ENTRIES, moved);
    expect(twice).toBe(`${fly}${HOSTS_BEGIN}\n203.0.113.99 api.riverbend.test\n${HOSTS_END}\n`);
  });
});

/** iptables as far as apply uses it: restore keeps the chain, -C/-I/-S read and change OUTPUT. */
function fakeTables(fail: Record<string, string> = {}) {
  const calls: string[] = [];
  const chain: Record<string, string[]> = {};
  const output: Record<string, string[]> = {};
  const run: Runner = (argv, stdin): Ran => {
    const [cmd = '', ...args] = argv;
    calls.push(argv.join(' '));
    const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' });
    if (fail[cmd]) return { status: 2, stdout: '', stderr: fail[cmd] };
    const tool = cmd.replace('-restore', '');
    if (cmd.endsWith('-restore')) {
      chain[tool] = (stdin ?? '').split('\n').filter((l) => l.startsWith('-A '));
      return ok();
    }
    const rule = args
      .slice(1)
      .filter((a) => a !== '1')
      .join(' ');
    output[tool] ??= [];
    if (args[0] === '-C')
      return { status: output[tool].includes(rule) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === '-I') {
      output[tool].unshift(rule);
      return ok();
    }
    if (args[0] === '-S') return ok(`-N ${CHAIN}\n${(chain[tool] ?? []).join('\n')}\n`);
    return { status: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  return { run, calls, chain, output };
}

function files(allow: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lead-egress-'));
  const allowPath = join(dir, 'allow');
  const hostsPath = join(dir, 'hosts');
  writeFileSync(allowPath, allow);
  writeFileSync(hostsPath, '127.0.0.1 localhost\n');
  return { dir, allowPath, hostsPath, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const resolve = async (h: string) => RESOLVED.get(h) ?? [];

describe('applying the wall', () => {
  it('loads both families, sends each walled uid in once, reads the chain back and pins the names', async () => {
    const f = files(
      'api.riverbend.test tcp/443 # model\ngone.saltmarsh.test tcp/443 # unresolved\n',
    );
    try {
      const t = fakeTables();
      const r = await apply({
        allowPath: f.allowPath,
        hostsPath: f.hostsPath,
        run: t.run,
        resolve,
      });
      expect(r).toEqual({
        ok: true,
        line: 'allowed: api.riverbend.test tcp/443 (2 addresses); gone.saltmarsh.test tcp/443 UNRESOLVED',
      });
      for (const tool of ['iptables', 'ip6tables']) {
        expect(t.output[tool]).toEqual(
          [...WALLED_UIDS].reverse().map((u) => `OUTPUT -m owner --uid-owner ${u} -j ${CHAIN}`),
        );
        expect(t.chain[tool]?.at(-1)).toContain('-j REJECT');
      }
      expect(readFileSync(f.hostsPath, 'utf8')).toContain('203.0.113.10 api.riverbend.test');
      // A refresh replaces the chain and adds no second jump.
      const again = await apply({
        allowPath: f.allowPath,
        hostsPath: f.hostsPath,
        run: t.run,
        resolve,
      });
      expect(again.ok).toBe(true);
      expect(t.output.iptables).toHaveLength(WALLED_UIDS.length);
      expect(t.calls.filter((c) => c.startsWith('iptables -I'))).toHaveLength(WALLED_UIDS.length);
    } finally {
      f.done();
    }
  });

  it('falls back to the legacy tools when nf_tables will not load', async () => {
    const f = files('api.riverbend.test tcp/443 # model\n');
    try {
      const t = fakeTables({ 'iptables-restore': "iptables-restore: Couldn't load match `owner'" });
      const r = await apply({
        allowPath: f.allowPath,
        hostsPath: f.hostsPath,
        run: t.run,
        resolve,
      });
      expect(r.ok).toBe(true);
      expect(t.calls).toContain('iptables-legacy-restore --noflush');
      expect(t.output['iptables-legacy']).toHaveLength(WALLED_UIDS.length);
    } finally {
      f.done();
    }
  });

  it('fails, with the reason, when a family cannot be loaded, and leaves /etc/hosts alone', async () => {
    const f = files('api.riverbend.test tcp/443 # model\n');
    try {
      const t = fakeTables({
        'ip6tables-restore': 'ip6tables-restore: unable to initialize table filter',
        'ip6tables-legacy-restore': 'ip6tables-legacy-restore: no such module',
      });
      const r = await apply({
        allowPath: f.allowPath,
        hostsPath: f.hostsPath,
        run: t.run,
        resolve,
      });
      expect(r.ok).toBe(false);
      expect(r.line).toBe(
        'IPv6 rules could not be loaded (ip6tables-restore: ip6tables-restore: unable to initialize table filter; ip6tables-legacy-restore: ip6tables-legacy-restore: no such module)',
      );
      expect(readFileSync(f.hostsPath, 'utf8')).toBe('127.0.0.1 localhost\n');
    } finally {
      f.done();
    }
  });

  it('fails when the owner match will not take', async () => {
    const f = files('api.riverbend.test tcp/443 # model\n');
    try {
      const t = fakeTables();
      const run: Runner = (argv, stdin) =>
        argv[1] === '-I'
          ? { status: 1, stdout: '', stderr: "Couldn't load match `owner'" }
          : t.run(argv, stdin);
      const r = await apply({ allowPath: f.allowPath, hostsPath: f.hostsPath, run, resolve });
      expect(r).toEqual({
        ok: false,
        line: `iptables: could not send uid ${WALLED_UIDS[0]} into ${CHAIN}: Couldn't load match \`owner'`,
      });
    } finally {
      f.done();
    }
  });

  it('fails on a list it cannot read, before running anything', async () => {
    const f = files('api.riverbend.test tcp/443\n');
    try {
      const t = fakeTables();
      const r = await apply({
        allowPath: f.allowPath,
        hostsPath: f.hostsPath,
        run: t.run,
        resolve,
      });
      expect(r.ok).toBe(false);
      expect(r.line).toContain('line 1: every entry needs a reason');
      expect(t.calls).toEqual([]);
    } finally {
      f.done();
    }
  });
});

describe('the boot probe', () => {
  const allowed = `${PROBE_ALLOWED.host}:${PROBE_ALLOWED.port}`;
  it('holds when every refused target is refused, the unlisted name does not resolve, and the model API answers', async () => {
    const r = await probe(
      async (host) => (host === PROBE_ALLOWED.host ? 'connected' : 'refused'),
      async () => false,
    );
    expect(r.code).toBe(0);
    expect(r.line).toContain(`${allowed} connected`);
  });

  it('does not hold when anything gets through', async () => {
    const through = await probe(
      async () => 'connected',
      async () => false,
    );
    expect(through.code).toBe(1);
    expect(through.line).toMatch(/^the wall let through: a public IPv4 address \(1\.1\.1\.1:443\)/);
    const dns = judgeProbe({ refused: [], unlistedResolved: true, allowed: 'connected' });
    expect(dns).toEqual({ code: 1, line: 'the wall let through: DNS for example.com' });
  });

  it('is unproven, not holding, when the allowed host fails too', async () => {
    const r = await probe(
      async () => 'refused',
      async () => false,
    );
    expect(r.code).toBe(3);
    expect(r.line).toContain(`but ${allowed} did not answer either`);
  });
});
