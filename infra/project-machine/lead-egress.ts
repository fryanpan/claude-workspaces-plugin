#!/usr/bin/env bun
/**
 * The lead's network wall on a project machine (`entrypoint.sh`).
 *
 *   bun lead-egress.ts apply   as root: resolve lead-egress.allow, load the
 *                              rules for IPv4 and IPv6, pin the names in
 *                              /etc/hosts. Prints one line; exit 1 and the
 *                              reason when the wall is not in place.
 *   bun lead-egress.ts probe   as the lead: try what the wall must refuse and
 *                              the one host it must allow (judgeProbe's codes).
 *
 * The rules and the file format are `lead-egress-plan.ts`. Names are resolved
 * over DNS, never through /etc/hosts, so a refresh sees a host's current
 * addresses rather than the ones this script pinned last time.
 */
import { promises as dns } from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  type AllowEntry,
  CHAIN,
  type Family,
  PROBE_ALLOWED,
  PROBE_REFUSED,
  PROBE_UNLISTED_NAME,
  type ProbeOutcome,
  type Resolved,
  WALLED_UIDS,
  applySummary,
  chainProblem,
  judgeProbe,
  jumpArgs,
  parseAllowlist,
  rulesFor,
  spliceHosts,
} from './lead-egress-plan.ts';

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
export type Runner = (argv: string[], stdin?: string) => Ran;
export type Resolver = (host: string) => Promise<string[]>;

export const runCommand: Runner = (argv, stdin) => {
  try {
    const r = Bun.spawnSync(argv, { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) });
    return { status: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (err) {
    return { status: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

/** Both families' addresses over DNS. A family with no answer is empty, not an error. */
export const resolveOverDns: Resolver = async (host) => {
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
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
export function applyFamily(
  run: Runner,
  family: Family,
  entries: AllowEntry[],
  resolved: Resolved,
  uids: readonly number[],
): string | null {
  const rules = rulesFor(entries, resolved, family);
  const errors: string[] = [];
  for (const [restore, tool] of BACKENDS[family]) {
    const loaded = run([restore, '--noflush'], rules);
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

export interface ApplyOptions {
  allowPath: string;
  hostsPath: string;
  uids?: readonly number[];
  run?: Runner;
  resolve?: Resolver;
}

export async function apply(o: ApplyOptions): Promise<{ ok: boolean; line: string }> {
  const run = o.run ?? runCommand;
  const resolve = o.resolve ?? resolveOverDns;
  let entries: AllowEntry[];
  try {
    entries = parseAllowlist(readFileSync(o.allowPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      line: `${o.allowPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const resolved: Resolved = new Map();
  for (const e of entries) resolved.set(e.host, await resolve(e.host));
  for (const family of [4, 6] as const) {
    const problem = applyFamily(run, family, entries, resolved, o.uids ?? WALLED_UIDS);
    if (problem) return { ok: false, line: problem };
  }
  try {
    writeFileSync(o.hostsPath, spliceHosts(readFileSync(o.hostsPath, 'utf8'), entries, resolved));
  } catch (err) {
    return {
      ok: false,
      line: `could not pin the names in ${o.hostsPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, line: applySummary(entries, resolved) };
}

export type Connector = (host: string, port: number) => Promise<ProbeOutcome>;
export type Lookup = (host: string) => Promise<boolean>;

const TIMEOUT_MS = 4000;

export const tcpConnect: Connector = (host, port) =>
  new Promise((done) => {
    const s = connect({ host, port, timeout: TIMEOUT_MS });
    const end = (o: ProbeOutcome) => {
      s.destroy();
      done(o);
    };
    s.once('connect', () => end('connected'));
    s.once('timeout', () => end('refused'));
    s.once('error', () => end('refused'));
  });

/** Resolves the way the lead's tools do: /etc/hosts, then DNS. */
export const systemLookup: Lookup = async (host) => {
  const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), TIMEOUT_MS));
  const lookup = dns.lookup(host).then(
    () => true,
    () => false,
  );
  return Promise.race([lookup, timeout]);
};

export async function probe(
  c: Connector = tcpConnect,
  lookup: Lookup = systemLookup,
): Promise<{ code: 0 | 1 | 3; line: string }> {
  const refused = await Promise.all(
    PROBE_REFUSED.map(async (t) => ({
      target: `${t.what} (${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port})`,
      outcome: await c(t.host, t.port),
    })),
  );
  const unlistedResolved = await lookup(PROBE_UNLISTED_NAME);
  const allowed = await c(PROBE_ALLOWED.host, PROBE_ALLOWED.port);
  return judgeProbe({ refused, unlistedResolved, allowed });
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'apply') {
    const r = await apply({
      allowPath: join(import.meta.dir, 'lead-egress.allow'),
      hostsPath: '/etc/hosts',
    });
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
