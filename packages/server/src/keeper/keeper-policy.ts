/**
 * What the keeper does with a request before any credential is touched:
 * run it now, hold it for Bryan's passkey, or refuse it.
 *
 * **Routine** (no passkey): reads, and starting, stopping or restarting a
 * machine of an app the keeper created, written exactly as listed below:
 * every flag named, each once, positionals before flags. These cannot widen who reaches a
 * project, and an agent restarting a crashed machine must not wait for a
 * person.
 *
 * **Held** (a passkey on the approval page): the commands in `HELD`, each
 * written exactly as listed, like a routine one. Creating a Fly app is
 * `project.create`; setting a secret or opening a shell on a machine is
 * `token.move`, because a shell or a secret is how a token reaches a
 * machine; creating a Cloudflare Access application is `access.open`. A fly
 * command or flag the list does not name is refused, not held: fly has flags
 * that read a local file as the keeper's user (`--file-local`, `--env-file`,
 * `--build-secret`), and a list of what may run cannot miss one the way a
 * list of what may not can. A Cloudflare call this file does not name is
 * held.
 *
 * **Refused**: a request whose answer would hand a credential to the
 * requester, which no approval makes safe because the requester is an agent.
 * `fly auth` prints the token, `fly tokens` mints new ones, `fly orgs`
 * invites people to the whole org, `fly ssh issue` mints a certificate, and
 * `--access-token` would let the requester swap whose token runs, and
 * `--debug` or `--verbose` may print the Authorization header. A
 * Cloudflare write under any `tokens` path mints an API token.
 */
import { APP_NAME } from './keeper-store.ts';

export type HoldKind = 'project.create' | 'token.move' | 'access.open' | 'other';

export type Verdict =
  | { kind: 'routine'; app: string | null; summary: string }
  | {
      kind: 'held';
      hold: HoldKind;
      app: string | null;
      summary: string;
      /** A project-setup command a setup grant on `app` may run without a tap. */
      setup?: boolean;
    }
  | { kind: 'refused'; reason: string };

const MAX_ARGS = 64;
const MAX_ARG = 4096;

const REFUSED_COMMANDS = new Set([
  'auth',
  'tokens',
  'token',
  'orgs',
  'org',
  'organizations',
  'agent',
  // A WireGuard peer is a credential to the whole org's private network.
  'wireguard',
  'wg',
]);
/** Top-level commands with no subcommands: only these may take a flag second. */
const LEAF_COMMANDS = new Set(['status', 'releases', 'logs', 'deploy']);
/** Flags whose output may carry the Authorization header, or that swap the token. */
const FORBIDDEN_FLAGS = new Set(['debug', 'verbose', 'access-token', '-t', '-v']);

/**
 * How one flag of a listed command is written: `value` takes the next arg or
 * `=value`, `bare` takes nothing, `bool` takes nothing or `=true|false`.
 */
type FlagKind = 'value' | 'bare' | 'bool';

/** A command the keeper runs without a tap, written exactly. */
interface Spec {
  path: readonly string[];
  /** How many positional args may follow the path, before any flag. */
  positionals: number;
  flags: Readonly<Record<string, FlagKind>>;
  required?: readonly string[];
}

const spec = (
  path: string,
  positionals: number,
  flags: Record<string, FlagKind>,
  required?: string[],
): Spec => ({ path: path.split(' '), positionals, flags, ...(required ? { required } : {}) });

/** The same spec under `machine` and `machines` (or `volume` and `volumes`). */
const both = (
  path: string,
  positionals: number,
  flags: Record<string, FlagKind>,
  required?: string[],
): Spec[] => [
  spec(path, positionals, flags, required),
  spec(path.replace(/^(machine|volume)\b/, '$1s'), positionals, flags, required),
];

/** Routine on an app the keeper created: lifecycle and reads. */
const ROUTINE_ON_OURS: readonly Spec[] = [
  ...both('machine start', 1, { app: 'value' }),
  ...both('machine stop', 1, { app: 'value' }),
  ...both('machine restart', 1, { app: 'value' }),
  ...both('machine list', 0, { app: 'value', json: 'bare' }),
  ...both('machine status', 1, { app: 'value', json: 'bare' }),
  ...both('volume list', 0, { app: 'value', json: 'bare' }),
  spec('secrets list', 0, { app: 'value', json: 'bare' }),
  spec('ips list', 0, { app: 'value', json: 'bare' }),
  spec('status', 0, { app: 'value', json: 'bare' }),
  spec('releases', 0, { app: 'value', json: 'bare' }),
  spec('logs', 0, { app: 'value', machine: 'value', 'no-tail': 'bare', json: 'bare' }, ['no-tail']),
];

/** Routine anywhere: names only. */
const ROUTINE_ANY: readonly Spec[] = [spec('apps list', 0, { json: 'bare', org: 'value' })];

/**
 * What a setup grant may run on the app it was opened on, and nothing else:
 * the project's volume and its secrets. An image (`deploy`), a shell, a
 * bucket (an org-level command), a destroy, and any flag not written here
 * are each a tap.
 */
const SETUP_ON_GRANTED: readonly Spec[] = [
  ...both('volume create', 1, {
    app: 'value',
    region: 'value',
    size: 'value',
    yes: 'bare',
    json: 'bare',
  }),
  spec('secrets import', 0, { app: 'value', stage: 'bare' }),
];

/**
 * `fly deploy`, which is always a tap, written only as the deploy script
 * writes it: one build folder, a --config (without one fly looks for a config
 * file on its own), and no flag that names another local path to read.
 */
const DEPLOY: Spec = spec(
  'deploy',
  1,
  {
    app: 'value',
    config: 'value',
    dockerfile: 'value',
    'remote-only': 'bare',
    ha: 'bool',
    'no-public-ips': 'bare',
    'image-label': 'value',
    yes: 'bare',
  },
  ['config'],
);

/**
 * Every other command the keeper will hold for a tap, written as the scripts
 * in `infra/project-machine/` write it. Lifecycle and reads on an app the
 * keeper did not create are the routine specs, held.
 */
const HELD: readonly { hold: HoldKind; specs: readonly Spec[] }[] = [
  {
    hold: 'project.create',
    specs: [spec('apps create', 1, { org: 'value', network: 'value', name: 'value' })],
  },
  {
    hold: 'token.move',
    specs: [
      spec('secrets import', 0, { app: 'value', stage: 'bare' }),
      spec('secrets set', 32, { app: 'value', stage: 'bare' }),
      spec('ssh console', 0, { app: 'value', command: 'value' }),
      spec('ssh sftp put', 2, { app: 'value' }),
      spec('ssh sftp get', 2, { app: 'value' }),
    ],
  },
  {
    hold: 'other',
    specs: [
      spec('storage create', 0, { org: 'value', name: 'value', yes: 'bare' }),
      ...SETUP_ON_GRANTED,
      ...both('machine destroy', 1, { app: 'value', force: 'bare' }),
      ...both('volume destroy', 1, { app: 'value', yes: 'bare' }),
      ...ROUTINE_ON_OURS,
    ],
  },
];

/** The flag an arg names (`app` for `-a`, `--app` and `--app=x`), or null for a word. */
function flagName(a: string): string | null {
  if (a === '-a') return 'app';
  if (a.startsWith('--')) return a.slice(2).split('=', 1)[0] ?? '';
  if (a.startsWith('-')) return a;
  return null;
}

/** Whether `argv` is exactly one of these commands, flag by flag. */
function matches(argv: readonly string[], specs: readonly Spec[]): boolean {
  return specs.some((sp) => {
    if (sp.path.some((w, i) => argv[i] !== w)) return false;
    let i = sp.path.length;
    let positionals = 0;
    while (i < argv.length && flagName(argv[i] as string) === null) {
      positionals++;
      i++;
    }
    if (positionals > sp.positionals) return false;
    const seen = new Set<string>();
    for (; i < argv.length; i++) {
      const a = argv[i] as string;
      const name = flagName(a);
      // A word after a flag is a positional fly would read and this would not.
      if (name === null || seen.has(name)) return false;
      const kind = sp.flags[name];
      if (!kind) return false;
      seen.add(name);
      const eq = a.indexOf('=');
      const inline = eq === -1 ? null : a.slice(eq + 1);
      if (kind === 'bare' && inline !== null) return false;
      if (kind === 'bool' && inline !== null && inline !== 'true' && inline !== 'false') {
        return false;
      }
      if (kind === 'value') {
        if (inline === '') return false;
        if (inline === null) {
          const v = argv[i + 1];
          if (v === undefined || flagName(v) !== null) return false;
          i++;
        }
      }
    }
    return (sp.required ?? []).every((r) => seen.has(r));
  });
}

type Scan =
  | { error: string }
  | { command: string; sub: string; words: string[]; app: string | null; summary: string };

/**
 * The checks every fly argv passes before its command is looked at. fly's
 * parser (cobra and pflag) finds the command past flags, joins a value onto a
 * short flag (`-aprod`), and takes the last of a repeated flag, so anything
 * this cannot read the way fly does is refused rather than guessed at.
 */
function scan(args: unknown): Scan {
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS) {
    return { error: `args must be 1-${MAX_ARGS} strings` };
  }
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG || a.includes('\0')) {
      return { error: 'every arg must be a string without NUL' };
    }
  }
  const argv = args as string[];
  if (flagName(argv[0] as string) !== null) return { error: 'start with the command, not a flag' };
  for (const a of argv) {
    if (a === '-' || a === '--') return { error: `"${a}" is not accepted` };
    if (a.startsWith('-') && !a.startsWith('--') && !/^-[A-Za-z]$/.test(a)) {
      return { error: 'write a short flag alone, with its value as the next arg' };
    }
    if (a.startsWith('--') && !/^--[a-z][a-z0-9-]*(=|$)/.test(a)) {
      return { error: `"${a.slice(0, 40)}" is not a flag shape fly takes` };
    }
    const name = flagName(a);
    if (name !== null && FORBIDDEN_FLAGS.has(name)) {
      return { error: `${a.split('=', 1)[0]} could print or replace the keeper's token` };
    }
  }
  const words: string[] = [];
  for (const a of argv) {
    if (flagName(a) !== null) break;
    words.push(a);
  }
  const [command = '', sub = ''] = words;
  if (words.length < 2 && words.length < argv.length && !LEAF_COMMANDS.has(command)) {
    return { error: 'name the subcommand before any flag' };
  }
  const appAt = argv.flatMap((a, i) => (flagName(a) === 'app' ? [i] : []));
  if (appAt.length > 1) return { error: 'name the app once' };
  let app: string | null = null;
  if (appAt.length === 1) {
    const i = appAt[0] as number;
    const a = argv[i] as string;
    app = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? '');
    if (!APP_NAME.test(app)) return { error: `"${app.slice(0, 64)}" is not an app name` };
  }
  return { command, sub, words, app, summary: `fly ${argv.join(' ')}` };
}

/** The value of a `--name`-style flag given once, or null. */
function onlyValue(argv: readonly string[], name: string): string | null | undefined {
  const at = argv.flatMap((a, i) => (flagName(a) === name ? [i] : []));
  if (at.length === 0) return null;
  if (at.length > 1) return undefined;
  const a = argv[at[0] as number] as string;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[(at[0] as number) + 1];
}

/** Classify one `fly` argv. `apps` is the keeper's own list. */
export function classifyFly(args: unknown, apps: readonly string[]): Verdict {
  const s = scan(args);
  if ('error' in s) return { kind: 'refused', reason: s.error };
  const argv = args as string[];
  const { command, sub, words, app, summary } = s;
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

  if (matches(argv, ROUTINE_ANY)) return { kind: 'routine', app: null, summary };
  if (command === 'deploy') {
    if (words.length !== 2 || !matches(argv, [DEPLOY])) {
      return {
        kind: 'refused',
        reason: `fly deploy takes one build folder and only --${Object.keys(DEPLOY.flags).join(', --')}`,
      };
    }
    return { kind: 'held', hold: 'other', app, summary, setup: false };
  }
  if (app !== null && apps.includes(app) && matches(argv, ROUTINE_ON_OURS)) {
    return { kind: 'routine', app, summary };
  }
  const held = HELD.find((h) => matches(argv, h.specs));
  if (!held) {
    return {
      kind: 'refused',
      reason: `fly ${words.slice(0, 3).join(' ')} is not written as a command the keeper holds; it takes only the flags its scripts use`,
    };
  }
  if (held.hold === 'project.create') {
    const flag = onlyValue(argv, 'name');
    const positional = words[2];
    if (flag === undefined || (flag !== null && positional !== undefined)) {
      return { kind: 'refused', reason: 'name the new app once' };
    }
    const name = flag ?? positional ?? '';
    if (!APP_NAME.test(name)) return { kind: 'refused', reason: 'apps create needs an app name' };
    return { kind: 'held', hold: 'project.create', app: name, summary };
  }
  const setup = app !== null && matches(argv, SETUP_ON_GRANTED);
  return { kind: 'held', hold: held.hold, app, summary, setup };
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
      // Only a listed setup command, on exactly the app the grant was opened on.
      return (
        verdict.setup === true && verdict.hold !== 'project.create' && verdict.app === g.target
      );
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
