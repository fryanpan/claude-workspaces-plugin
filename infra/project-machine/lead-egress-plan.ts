/**
 * The lead's network wall, pure half: the allowlist file's format, the
 * iptables rules, and how the boot probe's answers are judged.
 * `lead-egress.ts` applies the rules; `lead-proxy.ts` enforces the list.
 * Tested in `packages/server/test/project-machine-lead-egress.test.ts`.
 *
 * Two layers. The firewall: one chain, CW-LEAD-EGRESS, in the filter table of
 * each address family, which OUTPUT enters by owner match on each walled
 * uid. It accepts loopback and rejects everything else, DNS included. The
 * proxy: `lead-proxy.ts`, on loopback as its own user (which the firewall
 * does not hold), opens a connection only to a host name on the list, on a
 * listed port. So the list is checked against names, never addresses: a host
 * behind a CDN admits that host and not every site sharing its addresses.
 */

export const CHAIN = 'CW-LEAD-EGRESS';

/** The users the wall holds: `lead` and `cwdev`, fixed in the Dockerfile. */
export const WALLED_UIDS: readonly number[] = [10004, 10005];

/** Where the proxy listens. The lead and the dev server get it as HTTPS_PROXY. */
export const PROXY_HOST = '127.0.0.1';
export const PROXY_PORT = 3128;
export const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

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
    if (fields.length !== 2) throw new Error(`line ${line}: want "<host> tcp/<port>[,...]"`);
    const [host = '', portList = ''] = fields;
    if (!HOST.test(host))
      throw new Error(`line ${line}: ${JSON.stringify(host)} is not a host name`);
    if (seen.has(host)) throw new Error(`line ${line}: ${host} is listed twice`);
    seen.add(host);
    const ports = portList.split(',').map((p) => {
      // A CONNECT proxy carries TCP only.
      const m = /^tcp\/(\d{1,5})$/.exec(p);
      const n = Number(m?.[1]);
      if (!m || n < 1 || n > 65535)
        throw new Error(`line ${line}: ${JSON.stringify(p)} is not tcp/<port>`);
      return { proto: 'tcp' as const, port: n };
    });
    out.push({ host, ports, why, line });
  });
  return out;
}

/** The entry that admits host:port, or null. Host names compare without case or a trailing dot. */
export function admits(entries: AllowEntry[], host: string, port: number): AllowEntry | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  return entries.find((e) => e.host === h && e.ports.some((p) => p.port === port)) ?? null;
}

/**
 * `iptables-restore --noflush` input for one family: loopback, then reject.
 * Declaring the chain empties it, so applying twice leaves one copy; OUTPUT is
 * never flushed, and its jumps are added once, outside this text
 * (`jumpArgs`).
 */
export function rulesFor(family: Family): string {
  return [
    '*filter',
    `:${CHAIN} - [0:0]`,
    `-A ${CHAIN} -o lo -j ACCEPT`,
    // A refused TCP connection fails at once rather than waiting out a timeout.
    `-A ${CHAIN} -p tcp -j REJECT --reject-with tcp-reset`,
    `-A ${CHAIN} -j REJECT --reject-with ${family === 4 ? 'icmp-port-unreachable' : 'icmp6-port-unreachable'}`,
    'COMMIT',
    '',
  ].join('\n');
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
 * What `iptables -S CW-LEAD-EGRESS` must print for the wall to hold: loopback
 * is the only accept, and the chain ends in the reject, so nothing falls
 * through to OUTPUT's accept-all policy. Returns why it does not, or null.
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
  const accepts = rules.filter((r) => r.includes('-j ACCEPT'));
  if (accepts.length !== 1 || !accepts[0]?.includes('-o lo')) {
    return `IPv${family} chain ${CHAIN} accepts more than loopback`;
  }
  return null;
}

/**
 * The boot probe, run as the lead once the rules and the proxy are up. Each
 * refused target is a way out the wall must stop; reaching the model API
 * through the proxy is the positive control, without which a machine with no
 * network at all would read as a wall that holds.
 */
export const PROBE_DIRECT: readonly { host: string; port: number; what: string }[] = [
  { host: '1.1.1.1', port: 443, what: 'a public IPv4 address' },
  { host: '2606:4700:4700::1111', port: 443, what: 'a public IPv6 address' },
];
export const PROBE_UNLISTED_NAME = 'example.com';
export const PROBE_ALLOWED = { host: 'api.anthropic.com', port: 443 };

export type ProbeOutcome = 'connected' | 'refused';

export interface ProbeResult {
  direct: { target: string; outcome: ProbeOutcome }[];
  /** Whether a name not on the list resolved for the lead. */
  unlistedResolved: boolean;
  /** What the proxy answered a CONNECT to the unlisted name. */
  proxyUnlisted: ProbeOutcome;
  /** Whether an HTTPS request to the allowed host through the proxy got an answer. */
  allowed: ProbeOutcome;
}

/** 0: the wall holds and the allowed host answers. 3: it holds, but the control failed. 1: it does not hold. */
export function judgeProbe(r: ProbeResult): { code: 0 | 1 | 3; line: string } {
  const through = r.direct.filter((x) => x.outcome === 'connected').map((x) => x.target);
  if (r.unlistedResolved) through.push(`DNS for ${PROBE_UNLISTED_NAME}`);
  if (r.proxyUnlisted === 'connected') through.push(`the proxy, to ${PROBE_UNLISTED_NAME}:443`);
  if (through.length > 0) return { code: 1, line: `the wall let through: ${through.join(', ')}` };
  const refused = `refused ${r.direct.map((x) => x.target).join(', ')}, DNS for ${PROBE_UNLISTED_NAME} and the proxy to ${PROBE_UNLISTED_NAME}`;
  const target = `https://${PROBE_ALLOWED.host} through the proxy`;
  if (r.allowed !== 'connected') {
    return {
      code: 3,
      line: `${refused}, but ${target} did not answer either, so this boot did not prove the wall`,
    };
  }
  return { code: 0, line: `${refused}; ${target} answered` };
}
