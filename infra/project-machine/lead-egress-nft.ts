/**
 * The lead's network wall as a native nftables table: the ruleset and how its
 * read-back is judged. `lead-egress.ts` loads it FIRST, before the iptables
 * chains in `lead-egress-plan.ts`, because Fly's kernel has no `xt_owner`:
 * iptables' `-m owner` match will not load there under either iptables-nft or
 * iptables-legacy, while nftables' own `meta skuid` does.
 * Tested in `packages/server/test/project-machine-lead-egress-nft.test.ts`.
 *
 * The policy is the iptables chain's, rule for rule, in one `inet` table that
 * covers IPv4 and IPv6 at once: a base chain on the output hook (priority 0,
 * where iptables' filter OUTPUT sits) sends each walled uid's packets into
 * `walled`, which accepts loopback, resets TCP and rejects everything else
 * with a port-unreachable of the packet's own family.
 */

export const NFT_TABLE = 'cw_lead_egress';
export const NFT_FAMILY = 'inet';
const WALLED = 'walled';

/**
 * Input for `nft -f -`. One transaction: declaring the table first makes the
 * delete succeed on a machine that has none yet, so applying twice leaves one
 * copy, and the kernel either takes the whole text or none of it.
 */
export function nftRuleset(uids: readonly number[]): string {
  if (uids.length === 0) throw new Error('nftRuleset: no uids to wall');
  const t = `${NFT_FAMILY} ${NFT_TABLE}`;
  return [
    `table ${t}`,
    `delete table ${t}`,
    `table ${t} {`,
    '\tchain output {',
    '\t\ttype filter hook output priority 0; policy accept;',
    `\t\tmeta skuid { ${uids.join(', ')} } jump ${WALLED}`,
    '\t}',
    `\tchain ${WALLED} {`,
    '\t\toifname "lo" accept',
    // A refused TCP connection fails at once rather than waiting out a timeout.
    '\t\tmeta l4proto tcp reject with tcp reset',
    // icmpx: port-unreachable in the packet's family, as the iptables rules send.
    '\t\treject with icmpx type port-unreachable',
    '\t}',
    '}',
    '',
  ].join('\n');
}

/** Each chain's lines from an `nft list table` listing, braces and blanks dropped. */
function chainsOf(listing: string): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of listing.split('\n')) {
    const line = raw.trim();
    const open = /^chain (\S+) \{$/.exec(line);
    if (open) {
      current = [];
      chains.set(open[1] as string, current);
    } else if (line === '}') current = null;
    else if (current && line !== '') current.push(line);
  }
  return chains;
}

const LOOPBACK = 'oifname "lo" accept';
const BARE_REJECT = /^reject( with icmpx (type )?port-unreachable)?$/;
const TCP_RESET = /^meta l4proto (tcp|6) reject with tcp reset$/;

/**
 * What `nft list table inet cw_lead_egress` must print for the wall to hold.
 * Output holds one rule, and it sends every walled uid into `walled` — any
 * other rule there could accept first. `walled` accepts loopback alone, holds
 * nothing but rejects otherwise, and ends in a reject with no match, so
 * nothing falls back to output's accept policy. Returns why not, or null.
 */
export function nftTableProblem(listing: string, uids: readonly number[]): string | null {
  const where = `nft table ${NFT_FAMILY} ${NFT_TABLE}`;
  const chains = chainsOf(listing);
  const names = [...chains.keys()].sort().join(', ');
  if (names !== `output, ${WALLED}`) return `${where} has chains [${names}], not output and walled`;
  const output = chains.get('output') ?? [];
  const [hook, ...outRules] = output;
  if (!hook || !/^type filter hook output priority (0|filter);( policy accept;)?$/.test(hook)) {
    return `${where}: output is not a filter chain on the output hook (${hook ?? 'none'})`;
  }
  const jump = /^meta skuid (?:\{ ([\d, ]+) \}|(\d+)) jump walled$/.exec(outRules[0] ?? '');
  if (outRules.length !== 1 || !jump) {
    return `${where}: output must hold only the skuid jump into walled (has: ${outRules.join(' | ') || 'none'})`;
  }
  const held = new Set((jump[1] ?? jump[2] ?? '').split(',').map((s) => Number(s.trim())));
  const missing = uids.filter((u) => !held.has(u));
  if (missing.length > 0) return `${where}: uid ${missing.join(', ')} is not sent into walled`;
  const walled = chains.get(WALLED) ?? [];
  const last = walled.at(-1) ?? '';
  if (!BARE_REJECT.test(last)) {
    return `${where}: walled does not end in a reject (last rule: ${last || 'none'})`;
  }
  const stray = walled.filter((r) => r !== LOOPBACK && !TCP_RESET.test(r) && !BARE_REJECT.test(r));
  if (stray.length > 0)
    return `${where}: walled holds more than loopback and rejects (${stray.join(' | ')})`;
  if (walled.filter((r) => r === LOOPBACK).length !== 1) {
    return `${where}: walled does not accept loopback exactly once`;
  }
  return null;
}
