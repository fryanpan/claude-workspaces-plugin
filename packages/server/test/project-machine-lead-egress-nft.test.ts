/**
 * The lead's network wall as a native nftables table
 * (`infra/project-machine/lead-egress-nft.ts`), and the order `apply` tries
 * its backends in: nft first, iptables only when nft does not hold. The
 * iptables chain, the list and the probe are `project-machine-lead-egress.test.ts`.
 *
 * Nothing here touches a firewall: `nft` and `iptables` are a fake runner
 * that keeps what it was given. That a kernel enforces the table is
 * `project-machine-lead-limits-container.test.ts`, in a container.
 */
import { describe, expect, it } from 'bun:test';
import {
  NFT_TABLE,
  nftRuleset,
  nftTableProblem,
} from '../../../infra/project-machine/lead-egress-nft.ts';
import { CHAIN, WALLED_UIDS } from '../../../infra/project-machine/lead-egress-plan.ts';
import { type Ran, type Runner, apply } from '../../../infra/project-machine/lead-egress.ts';

const LIST = () => 'api.riverbend.test tcp/443 # model\n';

/** How nft 1.1 prints the table back: its own spelling of the default priority and reject. */
const PRINTED = `table inet cw_lead_egress {
\tchain output {
\t\ttype filter hook output priority filter; policy accept;
\t\tmeta skuid { 10004, 10005 } jump walled
\t}

\tchain walled {
\t\toifname "lo" accept
\t\tmeta l4proto tcp reject with tcp reset
\t\treject
\t}
}
`;

/** The table body of the ruleset, as an nft that echoes its input would list it. */
const echoed = (uids: readonly number[]) =>
  nftRuleset(uids).slice(nftRuleset(uids).indexOf(`table inet ${NFT_TABLE} {`));

describe('the nft ruleset', () => {
  it('replaces its own table in one transaction and walls every uid, loopback only', () => {
    expect(nftRuleset(WALLED_UIDS).trim().split('\n')).toEqual([
      `table inet ${NFT_TABLE}`,
      `delete table inet ${NFT_TABLE}`,
      `table inet ${NFT_TABLE} {`,
      '\tchain output {',
      '\t\ttype filter hook output priority 0; policy accept;',
      '\t\tmeta skuid { 10004, 10005 } jump walled',
      '\t}',
      '\tchain walled {',
      '\t\toifname "lo" accept',
      '\t\tmeta l4proto tcp reject with tcp reset',
      '\t\treject with icmpx type port-unreachable',
      '\t}',
      '}',
    ]);
    expect(() => nftRuleset([])).toThrow('no uids');
  });

  it('reads back as holding, in nft’s printed form and in the form it was written', () => {
    expect(nftTableProblem(PRINTED, WALLED_UIDS)).toBeNull();
    expect(nftTableProblem(echoed(WALLED_UIDS), WALLED_UIDS)).toBeNull();
    expect(nftTableProblem(PRINTED.replace('{ 10004, 10005 }', '10004'), [10004])).toBeNull();
  });

  it('reads back as not holding when any rule widens it, naming why', () => {
    const cases: [string, string][] = [
      [PRINTED.replace('\t\treject\n', ''), 'walled does not end in a reject'],
      [
        PRINTED.replace(
          '\t\toifname "lo" accept',
          '\t\toifname "lo" accept\n\t\tip daddr 203.0.113.9 accept',
        ),
        'walled holds more than loopback and rejects (ip daddr 203.0.113.9 accept)',
      ],
      [PRINTED.replace('\t\toifname "lo" accept\n', ''), 'does not accept loopback exactly once'],
      [PRINTED.replace('{ 10004, 10005 }', '10004'), 'uid 10005 is not sent into walled'],
      [
        PRINTED.replace('\t\tmeta skuid', '\t\ttcp dport 443 accept\n\t\tmeta skuid'),
        'output must hold only the skuid jump into walled',
      ],
      [
        PRINTED.replace('hook output', 'hook input'),
        'output is not a filter chain on the output hook',
      ],
      [PRINTED.replace('policy accept;', 'policy drop;'), 'output is not a filter chain'],
      [PRINTED.replace('chain walled', 'chain other'), 'has chains [other, output]'],
      ['', 'has chains []'],
    ];
    for (const [listing, why] of cases)
      expect(nftTableProblem(listing, WALLED_UIDS)).toContain(why);
  });
});

/** A fake nft that lists what it loaded (`printed` swaps in what the kernel says) and a fake iptables. */
function fakeHost(opts: { nft?: 'missing' | 'refuses' | 'loads'; printed?: string } = {}) {
  const calls: string[] = [];
  let table: string | null = null;
  const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr: string, status = 1): Ran => ({ status, stdout: '', stderr });
  const ipt = new Map<string, Set<string>>();
  const run: Runner = (argv, stdin) => {
    calls.push(argv.join(' '));
    const [cmd = '', ...args] = argv;
    if (cmd === 'nft') {
      if (opts.nft === 'missing') return fail('nft: command not found', 127);
      if (args[0] === '-f') {
        if (opts.nft === 'refuses')
          return fail('Error: Could not process rule: No such file or directory');
        table = opts.printed ?? echoed(WALLED_UIDS);
        expect(stdin).toBe(nftRuleset(WALLED_UIDS));
        return ok();
      }
      if (args[0] === 'list')
        return table === null ? fail('Error: No such file or directory') : ok(table);
      if (args[0] === 'delete') {
        table = null;
        return ok();
      }
    }
    // iptables: chain text by tool, jumps by tool.
    const tool = cmd.replace('-restore', '');
    const jumps = ipt.get(tool) ?? new Set<string>();
    ipt.set(tool, jumps);
    if (cmd.endsWith('-restore')) return ok();
    const rule = args
      .slice(1)
      .filter((a) => a !== '1')
      .join(' ');
    if (args[0] === '-C') return jumps.has(rule) ? ok() : fail('no rule');
    if (args[0] === '-I') return jumps.add(rule) && ok();
    if (args[0] === '-S') {
      const f = tool.startsWith('ip6') ? 'icmp6' : 'icmp';
      return ok(
        `-A ${CHAIN} -o lo -j ACCEPT\n-A ${CHAIN} -j REJECT --reject-with ${f}-port-unreachable\n`,
      );
    }
    return fail(`unexpected ${argv.join(' ')}`);
  };
  return { run, calls, table: () => table, ipt };
}

describe('the order apply tries the backends in', () => {
  it('uses nft first and touches no iptables tool when its table holds', () => {
    const h = fakeHost({ nft: 'loads', printed: PRINTED });
    const r = apply(h.run, WALLED_UIDS, LIST);
    expect(r).toEqual({
      ok: true,
      line: `uids 10004, 10005 reach loopback only, IPv4 and IPv6, by nft table inet ${NFT_TABLE}; out through http://127.0.0.1:3128 to the 1 hosts on lead-egress.allow`,
    });
    expect(h.calls).toEqual(['nft -f -', `nft list table inet ${NFT_TABLE}`]);
    // A second boot's apply replaces the table the same way.
    expect(apply(h.run, WALLED_UIDS, LIST).ok).toBe(true);
    expect(h.table()).toBe(PRINTED);
  });

  it('falls back to iptables when nft is missing or the kernel refuses the table, saying why', () => {
    for (const nft of ['missing', 'refuses'] as const) {
      const h = fakeHost({ nft });
      const r = apply(h.run, WALLED_UIDS, LIST);
      expect(r.ok).toBe(true);
      expect(r.line).toContain(`by iptables chain ${CHAIN}, because nft -f: `);
      expect(h.calls).toContain('iptables-restore --noflush');
      expect(h.calls).toContain('ip6tables-restore --noflush');
    }
  });

  it('deletes a table that loaded but does not read back as the wall, then falls back', () => {
    const widened = PRINTED.replace('\t\treject\n', '\t\taccept\n');
    const h = fakeHost({ nft: 'loads', printed: widened });
    const r = apply(h.run, WALLED_UIDS, LIST);
    expect(r.ok).toBe(true);
    expect(r.line).toContain(
      'because nft table inet cw_lead_egress: walled does not end in a reject',
    );
    expect(h.calls).toContain(`nft delete table inet ${NFT_TABLE}`);
    expect(h.table()).toBeNull();
  });

  it('fails closed, with both reasons, when neither nft nor iptables holds', () => {
    const h = fakeHost({ nft: 'refuses' });
    const run: Runner = (argv, stdin) =>
      argv[0]?.includes('tables')
        ? { status: 2, stdout: '', stderr: 'no module' }
        : h.run(argv, stdin);
    const r = apply(run, WALLED_UIDS, LIST);
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(
      /^nft -f: Error: Could not process rule.*; IPv4 rules could not be loaded \(iptables-restore: no module; iptables-legacy-restore: no module\)$/,
    );
  });
});
