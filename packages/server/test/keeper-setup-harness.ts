/**
 * Stand-ins for `keeper-setup.ts`: `sudo`, `fly`, `security` and `launchctl`
 * on a PATH in a temp dir, a fake keeper behind the fake `sudo`, and a fake
 * `fetch` for Cloudflare and the keeper's HTTP API. Every stand-in writes one
 * line to a shared log, so a test reads the order the steps ran in. Nothing
 * here touches a real Keychain, Fly, Cloudflare or launchd.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CF_TOKEN_PERMISSIONS, runKeeperSetup } from '../src/keeper/keeper-setup.ts';

export const FLY_TOKEN = 'fm2_test-fly-Harborlight';
export const OLD_CF = 'test-cf-old-Riverbend';
export const NEW_CF = 'test-cf-new-Saltmarsh';
export const PASTED_CF = 'test-cf-pasted-Alice';
export const ACCOUNT = '0123456789abcdef0123456789abcdef';
export const ACCOUNT_NAME = 'Harborlight';
export const PORT = '45678';
// The fake fetch answers it; nothing connects to it.
export const KEEPER = 'http://localhost:45678';
export const LABEL = 'com.example.board';
export const SECRETS = [FLY_TOKEN, OLD_CF, NEW_CF, PASTED_CF, ACCOUNT];

export const sh = (path: string, body: string) =>
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });

export interface World {
  dir: string;
  root: string;
  home: string;
  log: string;
  state: string;
  env: Record<string, string>;
  plist: string;
  settings: string;
}

export function world(tmp: string): World {
  const dir = join(tmp, 'w');
  try {
    chmodSync(join(dir, 'root', 'state'), 0o700);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  const home = join(dir, 'home');
  const state = join(dir, 'fake-keeper');
  const log = join(dir, 'calls.log');
  for (const d of [bin, join(root, 'bin'), join(root, 'state'), state, join(home, '.claude')])
    mkdirSync(d, { recursive: true });
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(log, '');
  // `sudo -H -u <user> cmd...` runs cmd; `sudo -v` asks for the password.
  sh(
    join(bin, 'sudo'),
    `if [ "$1" = -v ]; then echo "sudo -v" >> "$FAKE_LOG"; exit 0; fi
[ "$1" = -H ] && [ "$2" = -u ] || { echo "fake sudo: unexpected $*" >&2; exit 9; }
shift 3; exec "$@"\n`,
  );
  // The keeper: `<root>/bin/bun <keeper-bin.ts> <command> [arg]`, its state in FAKE_STATE.
  sh(
    join(root, 'bin', 'bun'),
    `shift; cmd=$1; arg=$2; S="$FAKE_STATE"
echo "keeper $cmd $arg" >> "$FAKE_LOG"
case "$cmd" in
  check)
    creds=$(cd "$S" && ls cred-* 2>/dev/null | sed 's/^cred-//' | tr '\\n' ' ' | sed 's/ $//')
    apps=$(cat "$S/apps" 2>/dev/null | tr '\\n' ' ' | sed 's/ $//')
    echo "credentials: \${creds:-none}"; echo "apps: \${apps:-none}"
    echo "store: ok, 1 passkeys, 0 apps"; echo "bun: a warning on stderr" >&2 ;;
  port) echo ${PORT} ;;
  import) [ "$arg" = "$FAKE_IMPORT_FAILS" ] && { echo "refused" >&2; exit 1; }
    cat > "$S/cred-$arg"; echo "[keeper] stored $arg" ;;
  adopt) echo "$arg" >> "$S/apps"; echo "[keeper] $arg may now be started" ;;
  *) exit 9 ;;
esac\n`,
  );
  sh(
    join(bin, 'fly'),
    `echo "fly $*" >> "$FAKE_LOG"
case "$1 $2" in
  "tokens create") [ -n "$FAKE_FLY_GARBLED" ] && { echo "Token: ???"; exit 0; }; echo "FlyV1 ${FLY_TOKEN}" ;;
  "apps list") echo '[{"Name":"cw-harborlight"},{"Name":"cw-riverbend"},{"Name":"other-app"},{"Name":"cw-keeper-probe"}]' ;;
  *) exit 9 ;;
esac\n`,
  );
  // The Keychain: values stored base64, as the deploy scripts store them.
  sh(
    join(bin, 'security'),
    `echo "security $*" >> "$FAKE_LOG"
svc=""; w=0; prev=""
for a in "$@"; do [ "$prev" = -s ] && svc=$a; [ "$a" = -w ] && w=1; prev=$a; done
case "$svc" in
  claude-workspaces-secret.fly-org-slug) v=\${FAKE_SLUG-harborlight-org}; [ -n "$v" ] || exit 44 ;;
  claude-workspaces-secret.cloudflare-api-token) v=${OLD_CF} ;;
  *) exit 44 ;;
esac
[ $w = 1 ] && printf %s "$v" | base64; exit 0\n`,
  );
  // launchd: loaded until bootout, loaded again by bootstrap, which reads
  // the job's environment out of the plist it is given, as launchd does.
  sh(
    join(bin, 'launchctl'),
    `echo "launchctl $*" >> "$FAKE_LOG"
case "$1" in
  print) [ -f "$FAKE_STATE/unloaded" ] && exit 113
    echo "environment = {"; cat "$FAKE_STATE/job-env" 2>/dev/null; echo "}"; exit 0 ;;
  bootout) touch "$FAKE_STATE/unloaded" ;;
  bootstrap) rm -f "$FAKE_STATE/unloaded"
    u=$(tr -d '\\n' < "$3" | sed -n 's|.*<key>CW_KEEPER_URL</key> *<string>\\([^<]*\\)</string>.*|\\1|p')
    if [ -n "$u" ]; then echo "    CW_KEEPER_URL => $u" > "$FAKE_STATE/job-env"; else rm -f "$FAKE_STATE/job-env"; fi ;;
esac\n`,
  );
  const plist = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
    </dict>
</dict>
</plist>
`,
  );
  chmodSync(plist, 0o644);
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ env: { KEEP: '1' }, theme: 'dark' }, null, 2)}\n`);
  // The store as the keeper leaves it: a file this user cannot open.
  writeFileSync(join(root, 'state', 'credentials.json'), '{}');
  chmodSync(join(root, 'state'), 0o000);
  return {
    dir,
    root,
    home,
    log,
    state,
    plist,
    settings,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      FAKE_LOG: log,
      FAKE_STATE: state,
      BOOTOUT_SETTLE_DELAY: '0',
      BOOTSTRAP_RETRY_DELAY: '0',
    },
  };
}

export interface Cf {
  canMint: boolean;
  minted: unknown[];
}

/** Cloudflare and the keeper's agent API, both logged to the same file. */
export function fakeFetch(w: World, cf: Cf): typeof fetch {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    appendFileSync(w.log, `fetch ${method} ${url.host}${url.pathname}\n`);
    if (url.host === 'api.cloudflare.com') {
      const path = url.pathname.replace('/client/v4', '');
      const known = [OLD_CF, NEW_CF, PASTED_CF].some((t) => auth === `Bearer ${t}`);
      if (!known) return json({ success: false }, 401);
      if (path === '/accounts')
        return json({ success: true, result: [{ id: ACCOUNT, name: ACCOUNT_NAME }] });
      if (!cf.canMint) return json({ success: false, errors: [{ message: 'forbidden' }] }, 403);
      if (path === '/user/tokens/permission_groups') {
        return json({
          success: true,
          result: CF_TOKEN_PERMISSIONS.map((p, i) => ({ id: `pg${i}`, name: p.api })),
        });
      }
      if (path === '/user/tokens' && method === 'POST') {
        cf.minted.push(JSON.parse(String(init?.body)));
        return json({ success: true, result: { id: 'tok1', value: NEW_CF } });
      }
      return json({ success: false }, 404);
    }
    if (url.host === `localhost:${PORT}`) {
      if (new Headers(init?.headers).get('x-cw-keeper') !== '1') return json({}, 403);
      if (method === 'POST' && url.pathname === '/v1/fly') {
        return json(
          {
            id: 'req1',
            pollToken: 'poll1',
            hold: 'project.create',
            summary: 'fly apps create cw-keeper-probe',
            approveUrl: `${KEEPER}/approve/req1`,
          },
          202,
          { 'x-cw-keeper-held': '1' },
        );
      }
      if (method === 'DELETE' && url.pathname === '/v1/requests/req1') return json({ ok: true });
    }
    return json({}, 404);
  }) as typeof fetch;
}

export interface RunOpts {
  dryRun?: boolean;
  cf?: Cf;
  pasted?: string;
  /** What Bryan types at each y/N; "y" when unset. */
  answer?: string;
  env?: Record<string, string>;
}

export async function run(w: World, opts: RunOpts = {}) {
  const lines: string[] = [];
  const cf = opts.cf ?? { canMint: true, minted: [] };
  let asked = 0;
  let confirms = 0;
  const status = await runKeeperSetup({
    root: w.root,
    user: 'cw-relay',
    home: w.home,
    uid: 501,
    label: LABEL,
    env: { ...w.env, ...opts.env },
    dryRun: opts.dryRun ?? false,
    fetch: fakeFetch(w, cf),
    readSecret: async () => {
      asked++;
      return opts.pasted ?? '';
    },
    readLine: async (prompt) => {
      confirms++;
      lines.push(prompt);
      return opts.answer ?? 'y';
    },
    print: (line) => lines.push(line),
  });
  const calls = readFileSync(w.log, 'utf8').trim().split('\n').filter(Boolean);
  writeFileSync(w.log, '');
  return { status, out: lines.join('\n'), calls, cf, asked, confirms };
}

export const cred = (w: World, name: string) => readFileSync(join(w.state, `cred-${name}`), 'utf8');
/** Index of the first call that starts with `prefix`; fails the test when there is none. */
export const at = (calls: string[], prefix: string) => {
  const i = calls.findIndex((c) => c.startsWith(prefix));
  if (i < 0) throw new Error(`no call starting "${prefix}" in:\n${calls.join('\n')}`);
  return i;
};
