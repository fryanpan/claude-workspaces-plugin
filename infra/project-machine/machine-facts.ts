/**
 * What a project machine's walls are set to, read ON the machine by
 * `wall-probe.ts machine` for the daily wall report (`wall-drift.ts` judges
 * it on the Mac).
 *
 * Reads only, as root over `fly ssh console`:
 *
 *   the running board server's settings that decide who it admits
 *     (`SERVER_KEYS`, from its /proc environ; no other variable is kept)
 *   how cloudflared runs: `run` with the named tunnel's remote ingress, or a
 *     quick tunnel
 *   the machine's login users and their uids, for the loopback uid policy
 *   `git-push.json`'s rules, parsed the way the server parses them
 *   the PUBLIC half of the lead's deploy key (`ssh-keygen -y`), so the Mac
 *     can find it on GitHub and read its read-only flag
 *   which GitHub repos the lead's clones point at, from their `.git/config`
 *     text (no git runs here)
 *
 * The settings carried back are addresses, hostnames, audiences and uids: no
 * token, key or password. The report compares them and prints none.
 */
import { join } from 'node:path';
import { parsePolicy } from '../../packages/server/src/git-push/policy.ts';

export const SERVER_KEYS = [
  'CW_OWNER_EMAIL',
  'CW_PUBLIC_BASE_URL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'CF_ACCESS_HOST_AUDS',
  'CW_PROXIED_TRUSTED_HOSTS',
  'CW_PROXIED_TRUSTED_EMAILS',
  'CW_LOOPBACK_SKIPS_ACCESS',
  'CW_LOOPBACK_REFUSED_UIDS',
] as const;
export type ServerKey = (typeof SERVER_KEYS)[number];

export interface MachineFacts {
  /** The server's settings, by name; null when no server process was found. */
  server: Partial<Record<ServerKey, string>> | null;
  cloudflared: 'named' | 'quick' | 'none';
  users: Array<{ name: string; uid: number }>;
  gitPush:
    | { state: 'absent' | 'unparseable'; rules: [] }
    | { state: 'ok'; rules: Array<{ board: string; repo: string; approval: boolean }> };
  /** `<type> <base64>` of the lead's deploy key, or null when it has none. */
  deployKey: string | null;
  /** `owner/name` of each GitHub repo a clone of the lead's points at. */
  repos: string[];
}

export interface Proc {
  cmdline: string[];
  /** The process's environment; read lazily, so only the server's is opened. */
  environ: () => Record<string, string>;
}

export interface FactsIo {
  procs: () => Proc[];
  /** A file's text, or null when it is not there. */
  read: (path: string) => string | null;
  /** The full paths of the folders directly inside `path`. */
  dirs: (path: string) => string[];
  /** The public half of a private key file, or null. */
  publicKey: (path: string) => string | null;
}

export const PATHS = {
  data: '/data/cw',
  leadKey: '/home/lead/.ssh/github_deploy_key',
  leadWork: '/data/lead/work',
};

const GITHUB_URL =
  /url\s*=\s*(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\s*$/gm;

/** The GitHub repos one `.git/config` names. */
export function githubRepos(config: string): string[] {
  return [...config.matchAll(GITHUB_URL)].map((m) => m[1] ?? '').filter(Boolean);
}

/** Login users: uid 1000 and up, below `nobody`. */
export function loginUsers(passwd: string): Array<{ name: string; uid: number }> {
  return passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 3)
    .map((f) => ({ name: f[0] ?? '', uid: Number(f[2]) }))
    .filter((u) => Number.isInteger(u.uid) && u.uid >= 1000 && u.uid < 65534);
}

export function readFacts(io: FactsIo): MachineFacts {
  const procs = io.procs();
  const server = procs.find((p) => p.cmdline.some((a) => a.endsWith('packages/server/src/bin.ts')));
  let settings: MachineFacts['server'] = null;
  if (server) {
    const env = server.environ();
    settings = {};
    for (const k of SERVER_KEYS) if (env[k] !== undefined) settings[k] = env[k];
  }
  const tunnel = procs.find((p) => (p.cmdline[0] ?? '').endsWith('cloudflared'));
  const cloudflared = !tunnel
    ? 'none'
    : tunnel.cmdline.includes('--url')
      ? 'quick'
      : tunnel.cmdline.includes('run')
        ? 'named'
        : 'none';

  const policyText = io.read(join(PATHS.data, 'git-push.json'));
  let gitPush: MachineFacts['gitPush'] = { state: 'absent', rules: [] };
  if (policyText !== null) {
    const parsed = parsePolicy(policyText);
    gitPush = parsed
      ? {
          state: 'ok',
          rules: [...parsed].flatMap(([board, rules]) =>
            rules.map((r) => ({ board, repo: r.repo, approval: r.approval })),
          ),
        }
      : { state: 'unparseable', rules: [] };
  }

  const pub = io.publicKey(PATHS.leadKey);
  const deployKey = pub ? pub.trim().split(/\s+/).slice(0, 2).join(' ') : null;

  const repos = new Set<string>();
  for (const dir of [PATHS.leadWork, ...io.dirs(PATHS.leadWork)]) {
    const config = io.read(join(dir, '.git', 'config'));
    if (config) for (const r of githubRepos(config)) repos.add(r);
  }

  return {
    server: settings,
    cloudflared,
    users: loginUsers(io.read('/etc/passwd') ?? ''),
    gitPush,
    deployKey,
    repos: [...repos].sort(),
  };
}
