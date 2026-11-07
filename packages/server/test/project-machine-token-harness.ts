/**
 * Stand-ins for the token list's tests. `fly`, `security`, `script` and
 * `claude` on PATH are scripts answering from files in a temp folder, and each
 * records its calls. `claude` is the browser approval: a test that means none
 * asserts the count stayed 0. Nothing reaches Fly, the Keychain or Anthropic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { projectConfig, requiredSecrets } from '../../../infra/project-machine/deploy-plan.ts';
import { deployProject } from '../../../infra/project-machine/deploy.ts';
import { tokenSlot } from '../../../infra/project-machine/token-list.ts';
import { BASH, machineDir, machineEnv, readRecords, stubs } from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
export const HEAD = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

const pad = (s: string) => `${s}-${'x'.repeat(108 - s.length - 1)}`;
export const FIRST = pad('sk-ant-oat01-fixture-harborlight-list-0Aa1Bb2');
export const SECOND = pad('sk-ant-oat01-fixture-riverbend-list-3Cc4Dd5');
/** The Mac's walled lead's sign-in, which no org's lead may hold. */
export const SHARED = pad('sk-ant-oat01-fixture-saltmarsh-shared-8Gg9Hh');
export const APPROVED = pad('sk-ant-oat01-fixture-approved-by-browser-1Zz');

export const ORGS = ['harborlight', 'riverbend'] as const;
export type Org = (typeof ORGS)[number];
export const BOARD: Record<Org, string> = { harborlight: 'w-harbor', riverbend: 'w-river' };
export const cfgOf = (org: Org, extra: Partial<Parameters<typeof projectConfig>[0]> = {}) =>
  projectConfig({
    project: org,
    imageLabel: HEAD,
    vmMemoryMb: 2048,
    leadBoard: BOARD[org],
    ...extra,
  });

export const tmp = mkdtempSync(join(tmpdir(), 'pm-token-list-'));
const bin = join(tmp, 'bin');
export const kc = join(tmp, 'keychain');
export const fs = join(tmp, 'fly');
export const approvals = join(tmp, 'approvals');
const saved = { path: process.env.PATH, keeper: process.env.CW_KEEPER_URL };

const exe = (name: string, body: string) => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};

let server: ReturnType<typeof Bun.serve>;
const children: ChildProcess[] = [];

export function useTokenStandIns(): void {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        if (new URL(req.url).searchParams.has('metadata')) return Response.json({ type: 1 });
        return new Response('not found', { status: 404 });
      },
    });
    // Both test files share this module when one process runs them, so each
    // makes the folders again after the other's afterAll removed them.
    mkdirSync(bin, { recursive: true });
    mkdirSync(kc, { recursive: true });
    mkdirSync(fs, { recursive: true });
    // Reads answer from the file <name>; `-i` takes the add line on stdin.
    exe(
      'security',
      `#!/bin/sh
if [ "$1" = -i ]; then
  line=$(cat)
  svc=$(printf '%s' "$line" | sed -n 's/.* -s claude-workspaces-secret\\.\\([^ ]*\\) .*/\\1/p')
  val=$(printf '%s' "$line" | sed -n 's/.* -w "\\(.*\\)"$/\\1/p')
  printf '%s' "$val" | base64 --decode > "${kc}/$svc"
  exit 0
fi
svc=""; want=0; prev=""
for a in "$@"; do
  [ "$prev" = "-s" ] && svc="$a"
  [ "$a" = "-w" ] && want=1
  prev="$a"
done
f="${kc}/\${svc#claude-workspaces-secret.}"
[ -f "$f" ] || exit 44
[ "$want" = 1 ] && base64 < "$f" | tr -d '\\n'
exit 0
`,
    );
    // One folder per app. <app>/ssh-out is what \`ssh console\` answers, unless
    // <app>/ssh-fails exists; every argv goes to <fs>/calls.
    exe(
      'fly',
      `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${fs}/argv"; done
echo "$*" >> "${fs}/calls"
app=""; prev=""
for a in "$@"; do [ "$prev" = "--app" ] && app="$a"; prev="$a"; done
case "$1 $2" in
  "apps list") cat "${fs}/apps.json" ;;
  "volumes list") echo '[{"name":"cw_data","region":"sjc","state":"created"}]' ;;
  "secrets list") cat "${fs}/$app/secrets.json" ;;
  "machines list") cat "${fs}/$app/machines.json" ;;
  "secrets import") cat >> "${fs}/$app/imported"; echo "$*" >> "${fs}/$app/imports" ;;
  "ssh console")
    [ -e "${fs}/$app/ssh-fails" ] && { echo 'no machine answered' >&2; exit 1; }
    cat "${fs}/$app/ssh-out" ;;
esac
exit 0
`,
    );
    exe(
      'script',
      '#!/bin/sh\n[ "$1" = -q ] && [ "$2" = /dev/null ] || exit 64\nshift 2\nexec "$@"\n',
    );
    exe(
      'claude',
      `#!/bin/sh
[ "$1" = setup-token ] || exit 64
echo approved >> "${approvals}"
printf 'Your OAuth token (valid for 1 year):\\r\\n\\r\\n%s\\r\\n' '${APPROVED}'
`,
    );
    process.env.PATH = `${bin}:${saved.path ?? ''}`;
    Reflect.deleteProperty(process.env, 'CW_KEEPER_URL');
  });

  afterAll(() => {
    for (const c of children.splice(0)) {
      try {
        if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
      } catch {
        // Its group has gone already.
      }
    }
    process.env.PATH = saved.path;
    if (saved.keeper !== undefined) process.env.CW_KEEPER_URL = saved.keeper;
    server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(kc, { recursive: true, force: true });
    mkdirSync(kc);
    keychain('fly-org-token', 'fo-fixture-token');
    keychain('fly-org-slug', 'harborlight');
    keychain('claude-lead-oauth-token', `${SHARED}\n`);
    rmSync(join(fs, 'argv'), { force: true });
    rmSync(join(fs, 'calls'), { force: true });
    rmSync(approvals, { force: true });
    writeFileSync(
      join(fs, 'apps.json'),
      '[{"Name":"cw-harborlight"},{"Name":"cw-riverbend"},{"Name":"other-app"}]',
    );
    for (const org of ORGS) {
      const cfg = cfgOf(org);
      keychain(cfg.keychain.identity, 'AGE-SECRET-KEY-FIXTURE');
      keychain(
        cfg.keychain.bucketAdmin,
        JSON.stringify({
          endpoint: `http://127.0.0.1:${server.port}`,
          accessKeyId: 'a',
          secretAccessKey: 'b',
        }),
      );
      keychain(cfg.keychain.writer, JSON.stringify({ accessKeyId: 'w', secretAccessKey: 'w' }));
      rmSync(appDir(org), { recursive: true, force: true });
      mkdirSync(appDir(org));
      flySecrets(org, requiredSecrets('quick'));
      setMachines(org, HEAD);
    }
    output.length = 0;
    const record = (...a: unknown[]) => {
      output.push(a.join(' '));
    };
    spies = [
      spyOn(console, 'log').mockImplementation(record),
      spyOn(console, 'error').mockImplementation(record),
    ];
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });
}

export const keychain = (name: string, value: string) => writeFileSync(join(kc, name), value);
export const listed = (slot: number, label: string, token: string) =>
  keychain(tokenSlot(slot), JSON.stringify({ label, token, added: '2026-11-07' }));
export const appDir = (org: Org) => join(fs, `cw-${org}`);
export const flySecrets = (org: Org, names: readonly string[]) =>
  writeFileSync(join(appDir(org), 'secrets.json'), JSON.stringify(names.map((Name) => ({ Name }))));
export const setMachines = (org: Org, tag: string) =>
  writeFileSync(
    join(appDir(org), 'machines.json'),
    JSON.stringify([
      { id: 'm1', state: 'started', image_ref: { tag }, config: { guest: { memory_mb: 2048 } } },
    ]),
  );
export const imported = (org: Org): string[] => {
  const f = join(appDir(org), 'imported');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};
export const appEnv = (org: Org): Record<string, string> =>
  Object.fromEntries(
    imported(org).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
export const flyArgv = () =>
  existsSync(join(fs, 'argv')) ? readFileSync(join(fs, 'argv'), 'utf8') : '';
export const flyCalls = () =>
  existsSync(join(fs, 'calls')) ? readFileSync(join(fs, 'calls'), 'utf8') : '';
export const approvalCount = () =>
  existsSync(approvals) ? readFileSync(approvals, 'utf8').split('\n').filter(Boolean).length : 0;

/** What the run printed, cleared before each test. */
export const output: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

export const outputs = (): TfOutputs => ({ access: {}, accessTeamDomain: null, tunnels: {} });
export const deploy = (
  org: Org,
  extra: Partial<Parameters<typeof projectConfig>[0]> = {},
  dry = false,
) => deployProject(cfgOf(org, extra), dry, { outputs, signInOutput: (t) => output.push(t) });

/** No token value in anything a person, a transcript or `ps` could see. */
export function expectNoTokenShown(...tokens: string[]) {
  const seen = `${output.join('\n')}\n${flyArgv()}`;
  for (const t of tokens) {
    expect(seen).not.toContain(t);
    expect(seen).not.toContain(t.slice(0, 40));
  }
}

export function bootMachine(org: Org, secrets: Record<string, string>) {
  const s = stubs(tmp, '0', ['mkdir', 'ln'], {
    // Off the Mac it is /usr/bin's; here it sits in /sbin, off the test's PATH.
    sha256sum:
      'for c in /usr/bin/sha256sum /sbin/sha256sum; do [ -x "$c" ] && exec "$c"; done; exit 127',
  });
  const homes = join(s.root, 'home');
  mkdirSync(join(homes, 'lead'), { recursive: true });
  const child = spawn(BASH as string, [join(machineDir, 'entrypoint.sh')], {
    env: {
      ...machineEnv(s.bin, s.volume),
      CW_MACHINE_HOME_ROOT: homes,
      FLY_APP_NAME: `cw-${org}`,
      ...secrets,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  return { ...s, out, homes };
}

export const leadStarted = (m: { log: string }) =>
  waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('claude')), {
    timeout: 20_000,
    describe: 'the lead to start',
  });
