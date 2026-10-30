/**
 * `keeper-setup.ts`, the one command that finishes the keeper's setup, run
 * against stand-ins: `sudo`, `fly`, `security` and `launchctl` on a PATH in
 * a temp dir, a fake keeper behind the fake `sudo`, and a fake `fetch` for
 * Cloudflare and the keeper's HTTP API. Every stand-in writes one line to a
 * shared log, so a test reads the order the steps ran in. Nothing here
 * touches a real Keychain, Fly, Cloudflare or launchd.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CF_TOKEN_PERMISSIONS, runKeeperSetup } from '../src/keeper/keeper-setup.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-setup-'));
afterAll(() => {
  // The locked store folder has to be opened again before it can be removed.
  try {
    chmodSync(join(tmp, 'w', 'root', 'state'), 0o700);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const FLY_TOKEN = 'fm2_test-fly-Harborlight';
const OLD_CF = 'test-cf-old-Riverbend';
const NEW_CF = 'test-cf-new-Saltmarsh';
const PASTED_CF = 'test-cf-pasted-Alice';
const ACCOUNT = 'acct0123456789';
const PORT = '45678';
// The fake fetch answers it; nothing connects to it.
const KEEPER = 'http://localhost:45678';
const LABEL = 'com.example.board';
const SECRETS = [FLY_TOKEN, OLD_CF, NEW_CF, PASTED_CF, ACCOUNT];

const sh = (path: string, body: string) =>
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });

interface World {
  dir: string;
  root: string;
  home: string;
  log: string;
  state: string;
  env: Record<string, string>;
  plist: string;
  settings: string;
}

function world(): World {
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
    echo "store: ok, 1 passkeys, 0 apps" ;;
  port) echo ${PORT} ;;
  import) cat > "$S/cred-$arg"; echo "[keeper] stored $arg" ;;
  adopt) echo "$arg" >> "$S/apps"; echo "[keeper] $arg may now be started" ;;
  *) exit 9 ;;
esac\n`,
  );
  sh(
    join(bin, 'fly'),
    `echo "fly $*" >> "$FAKE_LOG"
case "$1 $2" in
  "tokens create") echo "FlyV1 ${FLY_TOKEN}" ;;
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
  claude-workspaces-secret.fly-org-slug) v=harborlight-org ;;
  claude-workspaces-secret.cloudflare-api-token) v=${OLD_CF} ;;
  *) exit 44 ;;
esac
[ $w = 1 ] && printf %s "$v" | base64; exit 0\n`,
  );
  // launchd: loaded until bootout, loaded again by bootstrap.
  sh(
    join(bin, 'launchctl'),
    `echo "launchctl $*" >> "$FAKE_LOG"
case "$1" in
  print) [ -f "$FAKE_STATE/unloaded" ] && exit 113; exit 0 ;;
  bootout) touch "$FAKE_STATE/unloaded" ;;
  bootstrap) rm -f "$FAKE_STATE/unloaded" ;;
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

interface Cf {
  canMint: boolean;
  minted: unknown[];
}

/** Cloudflare and the keeper's agent API, both logged to the same file. */
function fakeFetch(w: World, cf: Cf): typeof fetch {
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
      if (path === '/accounts') return json({ success: true, result: [{ id: ACCOUNT }] });
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

async function run(w: World, opts: { dryRun?: boolean; cf?: Cf; pasted?: string } = {}) {
  const lines: string[] = [];
  const cf = opts.cf ?? { canMint: true, minted: [] };
  let asked = 0;
  const status = await runKeeperSetup({
    root: w.root,
    user: 'cw-relay',
    home: w.home,
    uid: 501,
    label: LABEL,
    env: w.env,
    dryRun: opts.dryRun ?? false,
    fetch: fakeFetch(w, cf),
    readSecret: async () => {
      asked++;
      return opts.pasted ?? '';
    },
    print: (line) => lines.push(line),
  });
  const calls = readFileSync(w.log, 'utf8').trim().split('\n').filter(Boolean);
  writeFileSync(w.log, '');
  return { status, out: lines.join('\n'), calls, cf, asked };
}

const cred = (w: World, name: string) => readFileSync(join(w.state, `cred-${name}`), 'utf8');
/** Index of the first call that starts with `prefix`; fails the test when there is none. */
const at = (calls: string[], prefix: string) => {
  const i = calls.findIndex((c) => c.startsWith(prefix));
  if (i < 0) throw new Error(`no call starting "${prefix}" in:\n${calls.join('\n')}`);
  return i;
};

let w: World;
beforeEach(() => {
  w = world();
});

describe('keeper-setup', () => {
  it('runs every step in order, with one password prompt, and prints no secret', async () => {
    const r = await run(w);
    expect(r.status).toBe(0);
    const order = [
      'sudo -v',
      'keeper check',
      'keeper port',
      'fly tokens create org --org harborlight-org',
      'keeper import fly-org-token',
      'keeper import fly-org-slug',
      'fetch GET api.cloudflare.com/client/v4/accounts',
      'fetch POST api.cloudflare.com/client/v4/user/tokens',
      'keeper import cloudflare-api-token',
      'keeper import cloudflare-account-id',
      'fly apps list',
      'keeper adopt cw-harborlight',
      'keeper adopt cw-riverbend',
      'launchctl bootout',
      'launchctl bootstrap',
      'fetch POST localhost:45678/v1/fly',
      'fetch DELETE localhost:45678/v1/requests/req1',
    ];
    const idx = order.map((p) => at(r.calls, p));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(r.calls.filter((c) => c === 'sudo -v')).toHaveLength(1);

    // What the keeper was handed. The Fly token loses fly's `FlyV1 ` prefix,
    // which the keeper's import would refuse as whitespace.
    expect(cred(w, 'fly-org-token')).toBe(FLY_TOKEN);
    expect(cred(w, 'fly-org-slug')).toBe('harborlight-org');
    expect(cred(w, 'cloudflare-api-token')).toBe(NEW_CF);
    expect(cred(w, 'cloudflare-account-id')).toBe(ACCOUNT);
    expect(readFileSync(join(w.state, 'apps'), 'utf8')).toBe('cw-harborlight\ncw-riverbend\n');

    // The new Cloudflare token names every permission, on this one account.
    const minted = JSON.stringify(r.cf.minted[0]);
    for (const [i] of CF_TOKEN_PERMISSIONS.entries()) expect(minted).toContain(`"pg${i}"`);
    expect(minted).toContain(`com.cloudflare.api.account.${ACCOUNT}`);

    // Both callers point at the keeper; the rest of settings.json is kept.
    const settings = JSON.parse(readFileSync(w.settings, 'utf8'));
    expect(settings).toEqual({
      env: { KEEP: '1', CW_KEEPER_URL: KEEPER },
      theme: 'dark',
    });
    expect(statSync(w.plist).mode & 0o777).toBe(0o644);
    expect(readFileSync(w.plist, 'utf8')).toMatch(
      new RegExp(`<key>CW_KEEPER_URL</key>\\s*<string>${KEEPER}</string>`),
    );

    expect(r.out).toContain(`${KEEPER}/approve/req1`);
    expect(r.out).toContain('Permission denied');
    expect(r.out).toContain('The keeper is set up');
    // No value in any output or any argv.
    for (const s of SECRETS) {
      expect(r.out).not.toContain(s);
      expect(r.calls.join('\n')).not.toContain(s);
    }
  });

  it('a second run skips every step already done, and still checks', async () => {
    expect((await run(w)).status).toBe(0);
    const r = await run(w);
    expect(r.status).toBe(0);
    for (const c of r.calls) {
      expect(c).not.toMatch(/^(fly tokens|keeper import|keeper adopt|launchctl boot)/);
      expect(c).not.toContain('api.cloudflare.com');
    }
    expect(r.calls).toContain('fetch POST localhost:45678/v1/fly');
    expect(r.out).toContain('The keeper is set up');
  });

  it('a dry run prints every step, changes nothing and reads no secret', async () => {
    const plistBefore = readFileSync(w.plist, 'utf8');
    const settingsBefore = readFileSync(w.settings, 'utf8');
    const r = await run(w, { dryRun: true });
    expect(r.status).toBe(0);
    for (const step of ['1. ', '2. ', '3. ', '4. ', '5. ']) expect(r.out).toContain(`== ${step}`);
    expect(r.out).toContain('would adopt cw-harborlight, cw-riverbend');
    expect(r.out).toContain('Dry run: nothing was changed');
    for (const c of r.calls) {
      expect(c).not.toMatch(/^(fly tokens|keeper import|keeper adopt|launchctl boot|fetch)/);
      expect(c).not.toMatch(/cloudflare-api-token -w/);
    }
    expect(readFileSync(w.plist, 'utf8')).toBe(plistBefore);
    expect(readFileSync(w.settings, 'utf8')).toBe(settingsBefore);
    for (const s of SECRETS) expect(r.out).not.toContain(s);
  });

  it('when the current token cannot make tokens, prints the permissions and imports the pasted one', async () => {
    const r = await run(w, { cf: { canMint: false, minted: [] }, pasted: PASTED_CF });
    expect(r.status).toBe(0);
    expect(r.asked).toBe(1);
    expect(r.out).toContain('Access: Apps and Policies Read');
    expect(r.out).toContain('Access: Organizations, Identity Providers, and Groups Read');
    expect(cred(w, 'cloudflare-api-token')).toBe(PASTED_CF);
    expect(cred(w, 'cloudflare-account-id')).toBe(ACCOUNT);
    expect(r.out).not.toContain(PASTED_CF);
  });

  it('stops when this user can read the keeper store', async () => {
    chmodSync(join(w.root, 'state'), 0o700);
    const r = await run(w);
    expect(r.status).toBe(1);
    expect(r.out).toContain('STOP: ');
    expect(r.out).toContain('credentials.json');
    expect(r.calls).not.toContain('fetch POST localhost:45678/v1/fly');
  });

  it('stops before anything when the keeper reports an unsafe path', async () => {
    sh(
      join(w.root, 'bin', 'bun'),
      `echo "keeper $2" >> "$FAKE_LOG"; echo "unsafe: /x is writable"; exit 1\n`,
    );
    const r = await run(w);
    expect(r.status).toBe(1);
    expect(r.out).toContain('unsafe: /x is writable');
    expect(r.calls.some((c) => c.startsWith('fly'))).toBe(false);
  });
});

describe('keeper-setup-bin', () => {
  it('refuses to run from a checkout, before it reads or asks for anything', () => {
    const r = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../src/keeper/keeper-setup-bin.ts'), '--dry-run'],
      { env: { PATH: '/usr/bin:/bin', HOME: tmp } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("run this from the keeper's release");
  });
});
