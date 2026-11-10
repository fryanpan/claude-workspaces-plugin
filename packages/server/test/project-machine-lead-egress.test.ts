/**
 * The lead's network wall (`infra/project-machine/lead-egress*.ts`): the
 * allowlist's format, the loopback-only rules, how they are loaded and read
 * back, and how the boot probe is judged. The proxy that enforces the list is
 * `project-machine-lead-proxy.test.ts`.
 *
 * Nothing here touches a firewall or the network: the commands are a fake
 * runner that records what it was asked and keeps the rules it was given,
 * and every connection the probe makes is injected. That the kernel enforces
 * the rules is `project-machine-lead-limits-container.test.ts`, in a container.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAIN,
  PROBE_ALLOWED,
  PROXY_HOST,
  PROXY_PORT,
  type ProbeOutcome,
  WALLED_UIDS,
  admits,
  chainProblem,
  judgeProbe,
  parseAllowlist,
  rulesFor,
} from '../../../infra/project-machine/lead-egress-plan.ts';
import {
  type ProbeDeps,
  type Ran,
  type Runner,
  apply,
  probe,
} from '../../../infra/project-machine/lead-egress.ts';
import { machineDir } from './project-machine-harness.ts';

const SHIPPED = join(machineDir, 'lead-egress.allow');
const LIST = () => 'api.riverbend.test tcp/443 # model\n';

describe('the allowlist file', () => {
  it('reads the shipped list: names only, every entry with a reason, ssh to github.com alone', () => {
    const entries = parseAllowlist(readFileSync(SHIPPED, 'utf8'));
    expect(entries.map((e) => e.host)).toEqual([
      'api.anthropic.com',
      'platform.claude.com',
      'registry.npmjs.org',
      'github.com',
      'api.github.com',
      'codeload.github.com',
    ]);
    expect(entries.every((e) => e.why.length > 10)).toBe(true);
    const ports = (h: string) => entries.find((e) => e.host === h)?.ports.map((p) => p.port);
    expect(ports('github.com')).toEqual([443, 22]);
    expect(entries.filter((e) => e.ports.some((p) => p.port !== 443)).map((e) => e.host)).toEqual([
      'github.com',
    ]);
  });

  it('refuses a line with no reason, a bad host, a bad port and a duplicate, naming the line', () => {
    const bad: [string, RegExp][] = [
      ['api.anthropic.com tcp/443\n', /line 1: every entry needs a reason/],
      ['# ok\n\nexample..com tcp/443 # x\n', /line 3: .* is not a host name/],
      ['203.0.113.7 tcp/443 # an address, not a name\n', /not a host name/],
      ['riverbend.test tcp/70000 # too big\n', /is not tcp\/<port>/],
      ['riverbend.test udp/443 # a proxy carries tcp only\n', /is not tcp\/<port>/],
      ['riverbend.test # no ports\n', /want "<host> tcp/],
      [
        'riverbend.test tcp/443 # a\nriverbend.test tcp/22 # b\n',
        /line 2: riverbend.test is listed twice/,
      ],
    ];
    for (const [text, why] of bad) expect(() => parseAllowlist(text)).toThrow(why);
    // POSITIVE CONTROL: the same shapes, written correctly, parse.
    expect(parseAllowlist('riverbend.test tcp/443,tcp/22 # two ports\n')[0]?.ports).toEqual([
      { proto: 'tcp', port: 443 },
      { proto: 'tcp', port: 22 },
    ]);
  });

  it('admits a listed host on a listed port only, whatever its case or trailing dot', () => {
    const e = parseAllowlist('git.harborlight.test tcp/443,tcp/22 # git\n');
    expect(admits(e, 'GIT.Harborlight.test.', 22)?.host).toBe('git.harborlight.test');
    expect(admits(e, 'git.harborlight.test', 80)).toBeNull();
    expect(admits(e, 'harborlight.test', 443)).toBeNull();
    expect(admits(e, 'evil.git.harborlight.test', 443)).toBeNull();
  });
});

describe('the rules', () => {
  it('accept loopback and reject everything else, in each family', () => {
    expect(rulesFor(4).trim().split('\n')).toEqual([
      '*filter',
      `:${CHAIN} - [0:0]`,
      `-A ${CHAIN} -o lo -j ACCEPT`,
      `-A ${CHAIN} -p tcp -j REJECT --reject-with tcp-reset`,
      `-A ${CHAIN} -j REJECT --reject-with icmp-port-unreachable`,
      'COMMIT',
    ]);
    expect(rulesFor(6)).toContain('-j REJECT --reject-with icmp6-port-unreachable');
  });

  it('read a chain back as holding only when it ends in the reject and accepts loopback alone', () => {
    const listing = (f: 4 | 6) =>
      rulesFor(f)
        .split('\n')
        .filter((l) => l.startsWith('-A'))
        .join('\n');
    expect(chainProblem(listing(4), 4)).toBeNull();
    expect(chainProblem(listing(6), 6)).toBeNull();
    expect(chainProblem(`-N ${CHAIN}\n-A ${CHAIN} -o lo -j ACCEPT`, 4)).toContain(
      'does not end in a reject',
    );
    const widened = listing(4).replace(
      `-A ${CHAIN} -p tcp`,
      `-A ${CHAIN} -d 203.0.113.9/32 -j ACCEPT\n-A ${CHAIN} -p tcp`,
    );
    expect(chainProblem(widened, 4)).toBe(`IPv4 chain ${CHAIN} accepts more than loopback`);
  });
});

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

describe('applying the wall', () => {
  it('loads both families, sends each walled uid in once, and reads the chain back', () => {
    const t = fakeTables();
    expect(apply(t.run, WALLED_UIDS, LIST)).toEqual({
      ok: true,
      line: `uids ${WALLED_UIDS.join(', ')} reach loopback only, IPv4 and IPv6; out through http://127.0.0.1:3128 to the 1 hosts on lead-egress.allow`,
    });
    for (const tool of ['iptables', 'ip6tables']) {
      expect(t.output[tool]).toEqual(
        [...WALLED_UIDS].reverse().map((u) => `OUTPUT -m owner --uid-owner ${u} -j ${CHAIN}`),
      );
      expect(t.chain[tool]?.at(-1)).toContain('-j REJECT');
    }
    // A second boot's apply replaces the chain and adds no second jump.
    expect(apply(t.run, WALLED_UIDS, LIST).ok).toBe(true);
    expect(t.output.iptables).toHaveLength(WALLED_UIDS.length);
    expect(t.calls.filter((c) => c.startsWith('iptables -I'))).toHaveLength(WALLED_UIDS.length);
  });

  it('falls back to the legacy tools when nf_tables will not load', () => {
    const t = fakeTables({ 'iptables-restore': "iptables-restore: Couldn't load match `owner'" });
    expect(apply(t.run, WALLED_UIDS, LIST).ok).toBe(true);
    expect(t.calls).toContain('iptables-legacy-restore --noflush');
    expect(t.output['iptables-legacy']).toHaveLength(WALLED_UIDS.length);
  });

  it('fails, with the reason, when a family cannot be loaded', () => {
    const t = fakeTables({
      'ip6tables-restore': 'ip6tables-restore: unable to initialize table filter',
      'ip6tables-legacy-restore': 'ip6tables-legacy-restore: no such module',
    });
    expect(apply(t.run, WALLED_UIDS, LIST)).toEqual({
      ok: false,
      line: 'IPv6 rules could not be loaded (ip6tables-restore: ip6tables-restore: unable to initialize table filter; ip6tables-legacy-restore: ip6tables-legacy-restore: no such module)',
    });
  });

  it('fails when the owner match will not take', () => {
    const t = fakeTables();
    const run: Runner = (argv, stdin) =>
      argv[1] === '-I'
        ? { status: 1, stdout: '', stderr: "Couldn't load match `owner'" }
        : t.run(argv, stdin);
    expect(apply(run, WALLED_UIDS, LIST)).toEqual({
      ok: false,
      line: `iptables: could not send uid ${WALLED_UIDS[0]} into ${CHAIN}: Couldn't load match \`owner'`,
    });
  });

  it('fails on a list the proxy could not read, before running anything', () => {
    const t = fakeTables();
    const r = apply(t.run, WALLED_UIDS, () => 'api.riverbend.test tcp/443\n');
    expect(r).toEqual({
      ok: false,
      line: 'lead-egress.allow: line 1: every entry needs a reason after #',
    });
    expect(t.calls).toEqual([]);
  });
});

describe('the boot probe', () => {
  /** A machine where the wall and the proxy hold, with `over` changing what one check answers. */
  const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      direct: async (h, p) => {
        asked.push(`direct ${h}:${p}`);
        return h === PROXY_HOST && p === PROXY_PORT ? 'connected' : 'refused';
      },
      lookup: async () => false,
      viaProxy: async (): Promise<ProbeOutcome> => 'refused',
      httpsViaProxy: async (): Promise<ProbeOutcome> => 'connected',
      ...over,
    };
  };
  const noPause = async () => {};
  const allowed = `https://${PROBE_ALLOWED.host} through the proxy`;

  it('holds when the direct addresses, DNS and the proxy to an unlisted name are refused, and the model API answers', async () => {
    const r = await probe(deps(), noPause);
    expect(r).toEqual({
      code: 0,
      line: `refused a public IPv4 address (1.1.1.1:443), a public IPv6 address ([2606:4700:4700::1111]:443), DNS for example.com and the proxy to example.com; ${allowed} answered`,
    });
  });

  it('does not hold when anything gets through, naming each way out', async () => {
    const r = await probe(
      deps({
        direct: async () => 'connected',
        lookup: async () => true,
        viaProxy: async () => 'connected',
      }),
      noPause,
    );
    expect(r.code).toBe(1);
    expect(r.line).toBe(
      'the wall let through: a public IPv4 address (1.1.1.1:443), a public IPv6 address ([2606:4700:4700::1111]:443), DNS for example.com, the proxy, to example.com:443',
    );
    // One way out alone is enough.
    const proxyOnly = await probe(deps({ viaProxy: async () => 'connected' }), noPause);
    expect(proxyOnly).toEqual({
      code: 1,
      line: 'the wall let through: the proxy, to example.com:443',
    });
  });

  it('is unproven, not holding, when the allowed host fails too', async () => {
    const r = await probe(deps({ httpsViaProxy: async () => 'refused' }), noPause);
    expect(r.code).toBe(3);
    expect(r.line).toContain(`but ${allowed} did not answer either`);
  });

  it('waits for the proxy to listen before it judges anything, and no longer than ten seconds', async () => {
    let tries = 0;
    const pauses: number[] = [];
    const late = deps({
      direct: async (h, p) => {
        if (h === PROXY_HOST && p === PROXY_PORT) return ++tries >= 3 ? 'connected' : 'refused';
        return 'refused';
      },
    });
    expect((await probe(late, async (ms) => void pauses.push(ms))).code).toBe(0);
    expect(tries).toBe(3);
    expect(pauses).toEqual([500, 500]);
    const never = deps({ direct: async () => 'refused', httpsViaProxy: async () => 'refused' });
    const waited: number[] = [];
    expect((await probe(never, async (ms) => void waited.push(ms))).code).toBe(3);
    expect(waited.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('agrees with judgeProbe on a result built by hand', () => {
    expect(
      judgeProbe({
        direct: [],
        unlistedResolved: true,
        proxyUnlisted: 'refused',
        allowed: 'connected',
      }),
    ).toEqual({ code: 1, line: 'the wall let through: DNS for example.com' });
  });
});
