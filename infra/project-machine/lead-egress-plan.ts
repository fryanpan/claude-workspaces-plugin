/**
 * The lead's network wall, pure half: the allowlist file's format, the
 * iptables rules and the /etc/hosts block built from it, and how the boot
 * probe's answers are judged. `lead-egress.ts` applies them on the machine.
 * Tested in `packages/server/test/project-machine-lead-egress.test.ts`.
 *
 * The wall is one chain, CW-LEAD-EGRESS, in the filter table of each address
 * family. OUTPUT sends every packet a walled user's socket sends into it, by
 * owner match on the uid. The chain accepts loopback and the allowed
 * addresses on their ports and rejects everything else, DNS included, so a
 * walled user resolves only the names pinned in /etc/hosts.
 */
import { isIP } from 'node:net';

export const CHAIN = 'CW-LEAD-EGRESS';

/** The users the wall holds: `lead` and `cwdev`, fixed in the Dockerfile. */
export const WALLED_UIDS: readonly number[] = [10004, 10005];

export type Family = 4 | 6;

export interface Port {
  proto: 'tcp' | 'udp';
  port: number;
}

export interface AllowEntry {
  host: string;
  ports: Port[];
  why: string;
  line: number;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Reads the allowlist. Throws on any line it cannot read, naming the line. */
export function parseAllowlist(text: string): AllowEntry[] {
  const out: AllowEntry[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const hash = trimmed.indexOf('#');
    const why = hash < 0 ? '' : trimmed.slice(hash + 1).trim();
    if (why === '') throw new Error(`line ${line}: every entry needs a reason after #`);
    const fields = trimmed.slice(0, hash).trim().split(/\s+/);
    if (fields.length !== 2) throw new Error(`line ${line}: want "<host> <proto>/<port>[,...]"`);
    const [host = '', portList = ''] = fields;
    if (!HOST.test(host))
      throw new Error(`line ${line}: ${JSON.stringify(host)} is not a host name`);
    if (seen.has(host)) throw new Error(`line ${line}: ${host} is listed twice`);
    seen.add(host);
    const ports = portList.split(',').map((p) => {
      const m = /^(tcp|udp)\/(\d{1,5})$/.exec(p);
      const n = Number(m?.[2]);
      if (!m || n < 1 || n > 65535)
        throw new Error(`line ${line}: ${JSON.stringify(p)} is not tcp/<port> or udp/<port>`);
      return { proto: m[1] as Port['proto'], port: n };
    });
    out.push({ host, ports, why, line });
  });
  return out;
}

/** Each entry's addresses, as root resolved them. A host with none is unreachable. */
export type Resolved = Map<string, string[]>;

const familyOf = (addr: string): Family | null => {
  const v = isIP(addr);
  return v === 4 || v === 6 ? v : null;
};

/**
 * `iptables-restore --noflush` input for one family. Declaring the chain
 * empties it, so a refresh replaces the whole list in one step; OUTPUT is
 * never flushed, and its jumps are added once, outside this text
 * (`jumpArgs`).
 */
export function rulesFor(entries: AllowEntry[], resolved: Resolved, family: Family): string {
  const lines = ['*filter', `:${CHAIN} - [0:0]`, `-A ${CHAIN} -o lo -j ACCEPT`];
  const bits = family === 4 ? 32 : 128;
  for (const e of entries) {
    const addrs = [...new Set(resolved.get(e.host) ?? [])].filter((a) => familyOf(a) === family);
    for (const addr of addrs.sort()) {
      for (const p of e.ports) {
        lines.push(
          `-A ${CHAIN} -d ${addr}/${bits} -p ${p.proto} -m ${p.proto} --dport ${p.port} -j ACCEPT`,
        );
      }
    }
  }
  // A refused TCP connection fails at once rather than waiting out a timeout.
  lines.push(`-A ${CHAIN} -p tcp -j REJECT --reject-with tcp-reset`);
  lines.push(
    `-A ${CHAIN} -j REJECT --reject-with ${family === 4 ? 'icmp-port-unreachable' : 'icmp6-port-unreachable'}`,
  );
  lines.push('COMMIT', '');
  return lines.join('\n');
}

/** The OUTPUT rule that sends one user's packets into the chain. */
export const jumpArgs = (uid: number): string[] => [
  'OUTPUT',
  '-m',
  'owner',
  '--uid-owner',
  String(uid),
  '-j',
  CHAIN,
];

/**
 * What `iptables -S CW-LEAD-EGRESS` must print for the wall to hold: the
 * chain ends in the two rejects, so nothing falls through to OUTPUT's
 * accept-all policy. Returns why it does not, or null.
 */
export function chainProblem(listing: string, family: Family): string | null {
  const rules = listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`-A ${CHAIN} `));
  const last = rules.at(-1) ?? '';
  const reject = family === 4 ? 'icmp-port-unreachable' : 'icmp6-port-unreachable';
  if (!last.includes('-j REJECT') || !last.includes(reject)) {
    return `IPv${family} chain ${CHAIN} does not end in a reject (last rule: ${last || 'none'})`;
  }
  return null;
}

export const HOSTS_BEGIN =
  '# BEGIN cw-lead-egress: written by lead-egress.ts; edit lead-egress.allow';
export const HOSTS_END = '# END cw-lead-egress';

/** /etc/hosts with this wall's block replaced, everything else kept. */
export function spliceHosts(current: string, entries: AllowEntry[], resolved: Resolved): string {
  const kept: string[] = [];
  let inside = false;
  for (const l of current.split('\n')) {
    if (l === HOSTS_BEGIN) inside = true;
    else if (l === HOSTS_END) inside = false;
    else if (!inside) kept.push(l);
  }
  while (kept.length > 0 && kept.at(-1) === '') kept.pop();
  const block = [HOSTS_BEGIN];
  for (const e of entries) {
    for (const addr of [...new Set(resolved.get(e.host) ?? [])].sort())
      block.push(`${addr} ${e.host}`);
  }
  block.push(HOSTS_END);
  return `${[...kept, ...block].join('\n')}\n`;
}

/** One summary line for the boot log. */
export function applySummary(entries: AllowEntry[], resolved: Resolved): string {
  const parts = entries.map((e) => {
    const n = new Set(resolved.get(e.host) ?? []).size;
    const ports = e.ports.map((p) => `${p.proto}/${p.port}`).join(',');
    return n === 0
      ? `${e.host} ${ports} UNRESOLVED`
      : `${e.host} ${ports} (${n} address${n === 1 ? '' : 'es'})`;
  });
  return `allowed: ${parts.join('; ')}`;
}

/**
 * The boot probe, run as the lead after the rules are in. Each refused target
 * is an address the wall must stop; the allowed target is the positive
 * control, without which a machine with no network at all would read as a
 * wall that holds.
 */
export const PROBE_REFUSED: readonly { host: string; port: number; what: string }[] = [
  { host: '1.1.1.1', port: 443, what: 'a public IPv4 address' },
  { host: '2606:4700:4700::1111', port: 443, what: 'a public IPv6 address' },
];
export const PROBE_UNLISTED_NAME = 'example.com';
export const PROBE_ALLOWED = { host: 'api.anthropic.com', port: 443 };

export type ProbeOutcome = 'connected' | 'refused';

export interface ProbeResult {
  refused: { target: string; outcome: ProbeOutcome }[];
  /** Whether a name not on the list resolved for the lead. */
  unlistedResolved: boolean;
  allowed: ProbeOutcome;
}

/** 0: the wall holds and the allowed host answers. 3: it holds, but the control failed. 1: it does not hold. */
export function judgeProbe(r: ProbeResult): { code: 0 | 1 | 3; line: string } {
  const through = r.refused.filter((x) => x.outcome === 'connected').map((x) => x.target);
  if (r.unlistedResolved) through.push(`DNS for ${PROBE_UNLISTED_NAME}`);
  if (through.length > 0) return { code: 1, line: `the wall let through: ${through.join(', ')}` };
  const refused = `refused ${r.refused.map((x) => x.target).join(', ')} and DNS for ${PROBE_UNLISTED_NAME}`;
  const target = `${PROBE_ALLOWED.host}:${PROBE_ALLOWED.port}`;
  if (r.allowed !== 'connected') {
    return {
      code: 3,
      line: `${refused}, but ${target} did not answer either, so this boot did not prove the wall`,
    };
  }
  return { code: 0, line: `${refused}; ${target} connected` };
}
