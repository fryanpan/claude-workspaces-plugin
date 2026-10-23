/**
 * What the keeper does with a request before any credential is touched:
 * run it now, hold it for Bryan's passkey, or refuse it.
 *
 * **Routine** (no passkey): reads, and starting, stopping or restarting a
 * machine of an app the keeper created. These cannot widen who reaches a
 * project, and an agent restarting a crashed machine must not wait for a
 * person.
 *
 * **Held** (a passkey on the approval page): everything else. Creating a Fly
 * app is `project.create`; setting a secret or opening a shell on a machine
 * is `token.move`, because a shell or a secret is how a token reaches a
 * machine; creating a Cloudflare Access application is `access.open`. The
 * default for a command this file does not name is held, not run.
 *
 * **Refused**: a request whose answer would hand a credential to the
 * requester, which no approval makes safe because the requester is an agent.
 * `fly auth` prints the token, `fly tokens` mints new ones, `fly orgs`
 * invites people to the whole org, `fly ssh issue` mints a certificate, and
 * `--access-token` would let the requester swap whose token runs. A
 * Cloudflare write under any `tokens` path mints an API token.
 */
import { APP_NAME } from './keeper-store.ts';

export type HoldKind = 'project.create' | 'token.move' | 'access.open' | 'other';

export type Verdict =
  | { kind: 'routine'; app: string | null; summary: string }
  | { kind: 'held'; hold: HoldKind; app: string | null; summary: string }
  | { kind: 'refused'; reason: string };

const MAX_ARGS = 64;
const MAX_ARG = 4096;

function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    for (const n of names) {
      if (a === n) return args[i + 1] ?? null;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
}

const REFUSED_COMMANDS = new Set(['auth', 'tokens', 'token', 'orgs', 'org', 'agent']);
const LIFECYCLE = new Set(['start', 'stop', 'restart']);
const READ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  machine: new Set(['list', 'status']),
  machines: new Set(['list', 'status']),
  volumes: new Set(['list']),
  volume: new Set(['list']),
  secrets: new Set(['list']),
  ips: new Set(['list']),
};

/** Classify one `fly` argv. `apps` is the keeper's own list. */
export function classifyFly(args: unknown, apps: readonly string[]): Verdict {
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS) {
    return { kind: 'refused', reason: `args must be 1-${MAX_ARGS} strings` };
  }
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG || a.includes('\0')) {
      return { kind: 'refused', reason: 'every arg must be a string without NUL' };
    }
  }
  const argv = args as string[];
  const [command = '', sub = ''] = argv;
  const summary = `fly ${argv.join(' ')}`;
  if (argv.some((a) => a === '-t' || a === '--access-token' || a.startsWith('--access-token='))) {
    return { kind: 'refused', reason: 'a request may not name its own Fly token' };
  }
  if (REFUSED_COMMANDS.has(command)) {
    return {
      kind: 'refused',
      reason: `fly ${command} would hand a credential or the org to the requester`,
    };
  }
  if (command === 'ssh' && sub === 'issue') {
    return { kind: 'refused', reason: 'fly ssh issue mints a certificate for the requester' };
  }
  if (command === 'apps' && sub === 'move') {
    return { kind: 'refused', reason: 'fly apps move takes an app out of the org' };
  }

  // fly takes the LAST of a repeated flag, and this reads the first, so a
  // second --app could aim a routine restart at an app the keeper did not make.
  const appFlags = argv.filter((a) => a === '--app' || a === '-a' || /^(--app|-a)=/.test(a));
  if (appFlags.length > 1) return { kind: 'refused', reason: 'name the app once' };
  const app = flagValue(argv, ['--app', '-a']);
  if (app !== null && !APP_NAME.test(app))
    return { kind: 'refused', reason: `"${app}" is not an app name` };
  const ours = app !== null && apps.includes(app);

  if (command === 'apps' && sub === 'list') return { kind: 'routine', app: null, summary };
  if (command === 'apps' && sub === 'create') {
    const name = flagValue(argv, ['--name']) ?? argv[2] ?? '';
    if (!APP_NAME.test(name)) return { kind: 'refused', reason: 'apps create needs an app name' };
    return { kind: 'held', hold: 'project.create', app: name, summary };
  }
  if (command === 'storage' && sub === 'create') {
    const name = flagValue(argv, ['--name', '-n']);
    return { kind: 'held', hold: 'other', app: name, summary };
  }
  if (ours) {
    if ((command === 'machine' || command === 'machines') && LIFECYCLE.has(sub)) {
      return { kind: 'routine', app, summary };
    }
    if (READ_SUBCOMMANDS[command]?.has(sub)) return { kind: 'routine', app, summary };
    if (command === 'status' || command === 'releases') return { kind: 'routine', app, summary };
    if (command === 'logs' && argv.includes('--no-tail')) return { kind: 'routine', app, summary };
  }
  if (command === 'secrets' || command === 'ssh' || command === 'sftp') {
    return { kind: 'held', hold: 'token.move', app, summary };
  }
  return { kind: 'held', hold: 'other', app, summary };
}

const CF_PATH = /^\/[A-Za-z0-9_.\-/]*$/;
const CF_QUERY = /^[A-Za-z0-9_.\-=&%,]*$/;

/**
 * Classify one Cloudflare API call. `path` is under `/client/v4`, with its
 * query string, if any, after a `?`.
 */
export function classifyCloudflare(method: string, path: string): Verdict {
  const [pathname = '', query = ''] = path.split('?', 2);
  if (!CF_PATH.test(pathname) || pathname.split('/').includes('..') || !CF_QUERY.test(query)) {
    return { kind: 'refused', reason: 'not a plain Cloudflare API path' };
  }
  const m = method.toUpperCase();
  const summary = `${m} ${path}`;
  if (m === 'GET') return { kind: 'routine', app: null, summary };
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    return { kind: 'refused', reason: `method ${m} is not a Cloudflare API method` };
  }
  if (pathname.split('/').includes('tokens')) {
    return { kind: 'refused', reason: 'a write under tokens mints a credential for the requester' };
  }
  if (m === 'POST' && /^\/accounts\/[A-Za-z0-9]+\/access\/apps\/?$/.test(pathname)) {
    return { kind: 'held', hold: 'access.open', app: null, summary };
  }
  return { kind: 'held', hold: 'other', app: null, summary };
}

/** A grant one approval opened: later held requests it covers run without a tap. */
export interface Grant {
  /** A Fly app (`fly`), or a Cloudflare path prefix (`cloudflare`). */
  scope: 'fly' | 'cloudflare';
  target: string;
  expiresAt: number;
}

export const SETUP_GRANT_MS = 30 * 60_000;
export const ACCESS_GRANT_MS = 10 * 60_000;

/** Whether a live grant covers this held request. */
export function grantCovers(
  grants: readonly Grant[],
  scope: 'fly' | 'cloudflare',
  verdict: Extract<Verdict, { kind: 'held' }>,
  cfPath: string | null,
  now: number,
): boolean {
  return grants.some((g) => {
    if (g.scope !== scope || g.expiresAt <= now) return false;
    if (scope === 'fly') {
      // A new app is always its own tap, even one named under a granted app.
      if (verdict.hold === 'project.create' || verdict.app === null) return false;
      return verdict.app === g.target || verdict.app.startsWith(`${g.target}-`);
    }
    // A grant on an Access app covers writes to that app and its policies,
    // never a new app: that is a new `access.open` and a new tap.
    const pathname = (cfPath ?? '').split('?', 1)[0] ?? '';
    return (
      verdict.hold !== 'access.open' &&
      (pathname === g.target || pathname.startsWith(`${g.target}/`))
    );
  });
}
