#!/usr/bin/env bun
/**
 * The lead's network wall on a project machine (`entrypoint.sh`).
 *
 *   bun lead-egress.ts apply   as root: load the loopback-only rules for IPv4
 *                              and IPv6 and read them back. Prints one line;
 *                              exit 1 and the reason when the wall is not in.
 *   bun lead-egress.ts probe   as the lead: try what the wall must refuse,
 *                              and the one host it must allow through the
 *                              proxy (judgeProbe's codes).
 *
 * The rules and the list are `lead-egress-plan.ts`; the proxy that enforces
 * the list is `lead-proxy.ts`.
 */
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  CHAIN,
  type Family,
  PROBE_ALLOWED,
  PROBE_DIRECT,
  PROBE_UNLISTED_NAME,
  PROXY_HOST,
  PROXY_PORT,
  PROXY_URL,
  type ProbeOutcome,
  WALLED_UIDS,
  chainProblem,
  judgeProbe,
  jumpArgs,
  parseAllowlist,
  rulesFor,
} from './lead-egress-plan.ts';

export const ALLOW_PATH = join(import.meta.dir, 'lead-egress.allow');

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
export type Runner = (argv: string[], stdin?: string) => Ran;

export const runCommand: Runner = (argv, stdin) => {
  try {
    const r = Bun.spawnSync(argv, { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) });
    return { status: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (err) {
    return { status: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

/** Each family's tools, nft first, then legacy for a kernel without nf_tables. */
const BACKENDS: Record<Family, readonly [restore: string, tool: string][]> = {
  4: [
    ['iptables-restore', 'iptables'],
    ['iptables-legacy-restore', 'iptables-legacy'],
  ],
  6: [
    ['ip6tables-restore', 'ip6tables'],
    ['ip6tables-legacy-restore', 'ip6tables-legacy'],
  ],
};

const firstLine = (r: Ran) => (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.status}`;

/** Loads one family's chain and jumps, then reads them back. Returns why it failed, or null. */
export function applyFamily(run: Runner, family: Family, uids: readonly number[]): string | null {
  const errors: string[] = [];
  for (const [restore, tool] of BACKENDS[family]) {
    const loaded = run([restore, '--noflush'], rulesFor(family));
    if (loaded.status !== 0) {
      errors.push(`${restore}: ${firstLine(loaded)}`);
      continue;
    }
    for (const uid of uids) {
      const [chain, ...match] = jumpArgs(uid);
      if (run([tool, '-C', chain as string, ...match]).status === 0) continue;
      const added = run([tool, '-I', chain as string, '1', ...match]);
      if (added.status !== 0)
        return `${tool}: could not send uid ${uid} into ${CHAIN}: ${firstLine(added)}`;
    }
    const listing = run([tool, '-S', CHAIN]);
    if (listing.status !== 0) return `${tool} -S ${CHAIN}: ${firstLine(listing)}`;
    const problem = chainProblem(listing.stdout, family);
    if (problem) return problem;
    for (const uid of uids) {
      const [chain, ...match] = jumpArgs(uid);
      if (run([tool, '-C', chain as string, ...match]).status !== 0) {
        return `${tool}: uid ${uid}'s jump into ${CHAIN} is missing after it was added`;
      }
    }
    return null;
  }
  return `IPv${family} rules could not be loaded (${errors.join('; ')})`;
}

/**
 * Reads the list first, because the proxy reads it too: a list it cannot
 * read leaves the lead with no way out, so it fails the wall here, loudly,
 * rather than as a proxy that exits on every start.
 */
export function apply(
  run: Runner = runCommand,
  uids: readonly number[] = WALLED_UIDS,
  readList: () => string = () => readFileSync(ALLOW_PATH, 'utf8'),
): { ok: boolean; line: string } {
  let hosts: number;
  try {
    hosts = parseAllowlist(readList()).length;
  } catch (err) {
    return { ok: false, line: `lead-egress.allow: ${err instanceof Error ? err.message : err}` };
  }
  for (const family of [4, 6] as const) {
    const problem = applyFamily(run, family, uids);
    if (problem) return { ok: false, line: problem };
  }
  return {
    ok: true,
    line: `uids ${uids.join(', ')} reach loopback only, IPv4 and IPv6; out through ${PROXY_URL} to the ${hosts} hosts on lead-egress.allow`,
  };
}

export interface ProbeDeps {
  /** A direct TCP connection. */
  direct: (host: string, port: number) => Promise<ProbeOutcome>;
  /** Whether a name resolves the way the lead's tools resolve it. */
  lookup: (host: string) => Promise<boolean>;
  /** A CONNECT to host:port through the proxy: `connected` on a 200. */
  viaProxy: (host: string, port: number) => Promise<ProbeOutcome>;
  /** An HTTPS request through the proxy: `connected` on any HTTP answer. */
  httpsViaProxy: (url: string) => Promise<ProbeOutcome>;
}

const TIMEOUT_MS = 4000;

const tcp = (host: string, port: number, onConnect?: (s: ReturnType<typeof connect>) => void) =>
  new Promise<ProbeOutcome>((done) => {
    const s = connect({ host, port, timeout: TIMEOUT_MS });
    const end = (o: ProbeOutcome) => {
      s.destroy();
      done(o);
    };
    s.once('timeout', () => end('refused'));
    s.once('error', () => end('refused'));
    s.once('connect', () => {
      if (!onConnect) return end('connected');
      let head = '';
      s.on('data', (d: Buffer) => {
        head += d.toString('latin1');
        if (head.includes('\r\n')) end(/^HTTP\/1\.[01] 200 /.test(head) ? 'connected' : 'refused');
      });
      onConnect(s);
    });
  });

export const realProbe: ProbeDeps = {
  direct: (host, port) => tcp(host, port),
  lookup: (host) =>
    Promise.race([
      dns.lookup(host).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => setTimeout(() => done(false), TIMEOUT_MS)),
    ]),
  viaProxy: (host, port) =>
    tcp(PROXY_HOST, PROXY_PORT, (s) => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\n\r\n`)),
  httpsViaProxy: async (url) => {
    try {
      await fetch(url, {
        proxy: PROXY_URL,
        method: 'HEAD',
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      return 'connected';
    } catch {
      return 'refused';
    }
  },
};

export async function probe(
  d: ProbeDeps = realProbe,
  pause: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<{ code: 0 | 1 | 3; line: string }> {
  // The proxy starts just before the probe: wait for it to listen, up to 10s.
  for (let i = 0; i < 20; i++) {
    if ((await d.direct(PROXY_HOST, PROXY_PORT)) === 'connected') break;
    await pause(500);
  }
  const direct = await Promise.all(
    PROBE_DIRECT.map(async (t) => ({
      target: `${t.what} (${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port})`,
      outcome: await d.direct(t.host, t.port),
    })),
  );
  const unlistedResolved = await d.lookup(PROBE_UNLISTED_NAME);
  const proxyUnlisted = await d.viaProxy(PROBE_UNLISTED_NAME, 443);
  const allowed = await d.httpsViaProxy(`https://${PROBE_ALLOWED.host}/`);
  return judgeProbe({ direct, unlistedResolved, proxyUnlisted, allowed });
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'apply') {
    const r = apply();
    console.log(r.line);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'probe') {
    const r = await probe();
    console.log(r.line);
    process.exit(r.code);
  } else {
    console.error('usage: lead-egress.ts apply|probe');
    process.exit(64);
  }
}
