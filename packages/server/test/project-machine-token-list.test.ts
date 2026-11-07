/**
 * The central list of long-lived Claude tokens: a new project's deploy takes
 * one with no sign-in, one step moves a project to another listed token, and
 * an agent reads each token's usage with no token printed.
 *
 * `fly`, `security`, `script` and `claude` on PATH are stand-ins answering
 * from files in a temp folder, and each records its calls. `claude` here is
 * the browser approval: a test that means none asserts the count stayed 0.
 * The entrypoint runs under the stand-ins of `project-machine-harness.ts`.
 * Nothing reaches Fly, the Keychain or Anthropic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  LEAD_TOKEN_ORG_SECRET,
  LEAD_TOKEN_SECRET,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import { deployProject } from '../../../infra/project-machine/deploy.ts';
import { foldUsage, parseUsageFile } from '../../../infra/project-machine/lead-usage.ts';
import {
  addToken,
  readTokenList,
  tokenMarker,
  tokenSlot,
} from '../../../infra/project-machine/token-list.ts';
import {
  imageHasTokenList,
  moveProject,
  waitForLabelCommand,
} from '../../../infra/project-machine/token-move.ts';
import {
  leadReadCommand,
  parseLeadRead,
  renderUsage,
  usageReport,
} from '../../../infra/project-machine/token-usage.ts';
import { HELP, runTokens } from '../../../infra/project-machine/tokens.ts';
import { classifyFly } from '../src/keeper/keeper-policy.ts';
import { BASH, machineDir, machineEnv, readRecords, stubs } from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const HEAD = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

const pad = (s: string) => `${s}-${'x'.repeat(108 - s.length - 1)}`;
const FIRST = pad('sk-ant-oat01-fixture-harborlight-list-0Aa1Bb2');
const SECOND = pad('sk-ant-oat01-fixture-riverbend-list-3Cc4Dd5');
/** The Mac's walled lead's sign-in, which no org's lead may hold. */
const SHARED = pad('sk-ant-oat01-fixture-saltmarsh-shared-8Gg9Hh');
const APPROVED = pad('sk-ant-oat01-fixture-approved-by-browser-1Zz');

const ORGS = ['harborlight', 'riverbend'] as const;
type Org = (typeof ORGS)[number];
const BOARD: Record<Org, string> = { harborlight: 'w-harbor', riverbend: 'w-river' };
const cfgOf = (org: Org, extra: Partial<Parameters<typeof projectConfig>[0]> = {}) =>
  projectConfig({
    project: org,
    imageLabel: HEAD,
    vmMemoryMb: 2048,
    leadBoard: BOARD[org],
    ...extra,
  });

const tmp = mkdtempSync(join(tmpdir(), 'pm-token-list-'));
const bin = join(tmp, 'bin');
const kc = join(tmp, 'keychain');
const fs = join(tmp, 'fly');
const approvals = join(tmp, 'approvals');
const saved = { path: process.env.PATH, keeper: process.env.CW_KEEPER_URL };

const exe = (name: string, body: string) => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).searchParams.has('metadata')) return Response.json({ type: 1 });
      return new Response('not found', { status: 404 });
    },
  });
  mkdirSync(bin);
  mkdirSync(kc);
  mkdirSync(fs);
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

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
  process.env.PATH = saved.path;
  if (saved.keeper !== undefined) process.env.CW_KEEPER_URL = saved.keeper;
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const keychain = (name: string, value: string) => writeFileSync(join(kc, name), value);
const listed = (slot: number, label: string, token: string) =>
  keychain(tokenSlot(slot), JSON.stringify({ label, token, added: '2026-11-07' }));
const appDir = (org: Org) => join(fs, `cw-${org}`);
const flySecrets = (org: Org, names: readonly string[]) =>
  writeFileSync(join(appDir(org), 'secrets.json'), JSON.stringify(names.map((Name) => ({ Name }))));
const setMachines = (org: Org, tag: string) =>
  writeFileSync(
    join(appDir(org), 'machines.json'),
    JSON.stringify([
      { id: 'm1', state: 'started', image_ref: { tag }, config: { guest: { memory_mb: 2048 } } },
    ]),
  );
const imported = (org: Org): string[] => {
  const f = join(appDir(org), 'imported');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};
const appEnv = (org: Org): Record<string, string> =>
  Object.fromEntries(
    imported(org).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const flyArgv = () => (existsSync(join(fs, 'argv')) ? readFileSync(join(fs, 'argv'), 'utf8') : '');
const flyCalls = () =>
  existsSync(join(fs, 'calls')) ? readFileSync(join(fs, 'calls'), 'utf8') : '';
const approvalCount = () =>
  existsSync(approvals) ? readFileSync(approvals, 'utf8').split('\n').filter(Boolean).length : 0;

let output: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

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
  output = [];
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

const outputs = (): TfOutputs => ({ access: {}, accessTeamDomain: null, tunnels: {} });
const deploy = (org: Org, extra: Partial<Parameters<typeof projectConfig>[0]> = {}, dry = false) =>
  deployProject(cfgOf(org, extra), dry, { outputs, signInOutput: (t) => output.push(t) });

/** No token value in anything a person, a transcript or `ps` could see. */
function expectNoTokenShown(...tokens: string[]) {
  const seen = `${output.join('\n')}\n${flyArgv()}`;
  for (const t of tokens) {
    expect(seen).not.toContain(t);
    expect(seen).not.toContain(t.slice(0, 40));
  }
}

function bootMachine(org: Org, secrets: Record<string, string>) {
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

const leadStarted = (m: { log: string }) =>
  waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('claude')), {
    timeout: 20_000,
    describe: 'the lead to start',
  });

describe('a new project takes a token from the list', () => {
  it('sets the first listed token with no browser approval, and prints no value', async () => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    await deploy('harborlight');
    expect(approvalCount()).toBe(0);
    const env = appEnv('harborlight');
    expect(env[LEAD_TOKEN_SECRET]).toBe(FIRST);
    expect(env[LEAD_TOKEN_ORG_SECRET]).toBe(tokenMarker('harborlight', 'first-account', FIRST));
    expect(output.join('\n')).toContain('first-account');
    expectNoTokenShown(FIRST, SECOND);
  });

  it('takes the label --claude-token names', async () => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    await deploy('riverbend', { claudeToken: 'second-account' });
    expect(appEnv('riverbend')[LEAD_TOKEN_SECRET]).toBe(SECOND);
    expect(approvalCount()).toBe(0);
  });

  it('refuses a label that is not listed before anything changes', async () => {
    listed(1, 'first-account', FIRST);
    await expect(deploy('riverbend', { claudeToken: 'no-such-account' })).rejects.toThrow(
      'no-such-account',
    );
    expect(imported('riverbend')).toEqual([]);
    expect(approvalCount()).toBe(0);
  });

  it('leaves a project that already has a token alone', async () => {
    listed(1, 'first-account', FIRST);
    flySecrets('riverbend', [
      ...requiredSecrets('quick'),
      LEAD_TOKEN_SECRET,
      LEAD_TOKEN_ORG_SECRET,
      'CW_LEAD_BOARD',
    ]);
    await deploy('riverbend');
    expect(imported('riverbend').some((l) => l.startsWith(`${LEAD_TOKEN_SECRET}=`))).toBe(false);
  });

  it('asks for the browser approval only when the list is empty', async () => {
    await deploy('harborlight');
    expect(approvalCount()).toBe(1);
    expect(appEnv('harborlight')[LEAD_TOKEN_SECRET]).toBe(APPROVED);
    expect(appEnv('harborlight')[LEAD_TOKEN_ORG_SECRET]).toBe('harborlight');
  });

  it('a dry run names the label and sets nothing', async () => {
    listed(1, 'first-account', FIRST);
    await deploy('harborlight', {}, true);
    expect(imported('harborlight')).toEqual([]);
    expect(output.join('\n')).toContain('first-account');
    expectNoTokenShown(FIRST);
  });
});

describe.skipIf(BASH === null)('the machine checks the marker', () => {
  const secretsFor = (org: Org, token: string, marker: string | undefined) => ({
    [LEAD_TOKEN_SECRET]: token,
    CW_LEAD_BOARD: BOARD[org],
    ...(marker !== undefined ? { [LEAD_TOKEN_ORG_SECRET]: marker } : {}),
  });

  it('two projects on one listed token each start a lead', async () => {
    for (const org of ORGS) {
      const m = bootMachine(org, secretsFor(org, FIRST, tokenMarker(org, 'first-account', FIRST)));
      await leadStarted(m);
      const { recs } = readRecords(m.log);
      const lead = recs.find((r) => r.argv.startsWith('claude'));
      expect(lead?.uid).toBe('lead');
      expect(lead?.env.get(LEAD_TOKEN_SECRET)).toBe(FIRST);
      expect(lead?.env.get('CW_LEAD_TOKEN_LABEL')).toBe('first-account');
      // Only the root supervisor reads the marker: it binds the token, so the
      // server's user does not hold it.
      const holding = recs.filter((r) => r.env.has(LEAD_TOKEN_ORG_SECRET));
      expect(holding.map((r) => r.uid)).toEqual([]);
      expect(readFileSync(join(m.volume, 'lead', 'token-label'), 'utf8').trim()).toBe(
        'first-account',
      );
      const settings = JSON.parse(
        readFileSync(join(m.homes, 'lead', '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.statusLine.command).toContain('lead-usage.ts');
    }
  }, 60_000);

  const refused: Array<[string, () => Record<string, string>]> = [
    [
      'a stale token under a marker made for another token',
      () => secretsFor('riverbend', SHARED, tokenMarker('riverbend', 'first-account', FIRST)),
    ],
    [
      'a marker copied from another project',
      () => secretsFor('riverbend', FIRST, tokenMarker('harborlight', 'first-account', FIRST)),
    ],
    ['a token with no marker', () => secretsFor('riverbend', SHARED, undefined)],
    [
      'a label changed in the marker',
      () =>
        secretsFor(
          'riverbend',
          FIRST,
          tokenMarker('riverbend', 'first-account', FIRST).replace('first', 'other'),
        ),
    ],
    ['a marker of the wrong shape', () => secretsFor('riverbend', FIRST, 'listed:x')],
  ];
  it.each(refused)(
    'starts no lead on %s',
    async (_name, secrets) => {
      const values = secrets();
      const m = bootMachine('riverbend', values);
      await waitFor(() => m.out.join('').includes('no lead agent runs'), {
        timeout: 20_000,
        describe: 'the entrypoint to refuse the lead',
      });
      await waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('cloudflared')), {
        timeout: 20_000,
        describe: 'the tunnel to start',
      });
      expect(readRecords(m.log).recs.filter((r) => r.argv.startsWith('claude'))).toEqual([]);
      // The log carries no digest and no token.
      const log = m.out.join('');
      expect(log).not.toContain(values[LEAD_TOKEN_ORG_SECRET] ?? '\0');
      expect(log).not.toContain(values[LEAD_TOKEN_SECRET] as string);
    },
    30_000,
  );
});

describe('one step moves a project to another listed token', () => {
  beforeEach(() => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    flySecrets('riverbend', [...requiredSecrets('quick'), 'CW_LEAD_BOARD', LEAD_TOKEN_SECRET]);
    writeFileSync(join(appDir('riverbend'), 'ssh-out'), 'cw-token-label=second-account\n');
  });
  const ready = () => true;

  it('imports the token and its marker in one call that restarts the machine', async () => {
    const r = moveProject('riverbend', 'second-account', { imageReady: ready });
    expect(r.confirmed).toBe(true);
    const env = appEnv('riverbend');
    expect(env[LEAD_TOKEN_SECRET]).toBe(SECOND);
    expect(env[LEAD_TOKEN_ORG_SECRET]).toBe(tokenMarker('riverbend', 'second-account', SECOND));
    const imports = readFileSync(join(appDir('riverbend'), 'imports'), 'utf8')
      .trim()
      .split('\n');
    expect(imports).toEqual(['secrets import --app cw-riverbend']);
    expectNoTokenShown(FIRST, SECOND);
  });

  it('the keeper holds that exact import, unchanged', () => {
    const v = classifyFly(['secrets', 'import', '--app', 'cw-riverbend'], ['cw-riverbend']);
    expect(v).toMatchObject({ kind: 'held', hold: 'token.move' });
  });

  it.skipIf(BASH === null)(
    'the machine booted from what the move set runs its lead on the new token',
    async () => {
      moveProject('riverbend', 'second-account', { imageReady: ready });
      const m = bootMachine('riverbend', {
        ...appEnv('riverbend'),
        CW_LEAD_BOARD: BOARD.riverbend,
      });
      await leadStarted(m);
      const lead = readRecords(m.log).recs.find((r) => r.argv.startsWith('claude'));
      expect(lead?.env.get(LEAD_TOKEN_SECRET)).toBe(SECOND);
      expect(lead?.env.get('CW_LEAD_TOKEN_LABEL')).toBe('second-account');
    },
    30_000,
  );

  it('confirms by waiting on the machine, in one shell, as the lead', () => {
    const root = mkdtempSync(join(tmp, 'wait-'));
    writeFileSync(join(root, 'token-label'), 'second-account\n');
    const stub = mkdtempSync(join(tmp, 'stub-'));
    writeFileSync(
      join(stub, 'setpriv'),
      `#!/bin/sh\necho "$*" > "${root}/setpriv"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(stub, 'setpriv'), 0o755);
    const r = spawnSync(
      'sh',
      ['-c', waitForLabelCommand('second-account', root, `${stub}:/usr/bin:/bin`)],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    expect(r.stdout.trim()).toBe('cw-token-label=second-account');
    expect(readFileSync(join(root, 'setpriv'), 'utf8')).toContain('--reuid=lead');
  });

  it('says so when the machine does not confirm', () => {
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    expect(moveProject('riverbend', 'second-account', { imageReady: ready }).confirmed).toBe(false);
    rmSync(join(appDir('riverbend'), 'ssh-fails'));
    writeFileSync(join(appDir('riverbend'), 'ssh-out'), 'cw-token-label=first-account\n');
    expect(moveProject('riverbend', 'second-account', { imageReady: ready }).confirmed).toBe(false);
  });

  it('refuses before any change: an unlisted label, no lead, no project, an old image', () => {
    expect(() => moveProject('riverbend', 'no-such', { imageReady: ready })).toThrow('no-such');
    expect(() => moveProject('Not A Project', 'second-account', { imageReady: ready })).toThrow();
    flySecrets('harborlight', requiredSecrets('quick'));
    expect(() => moveProject('harborlight', 'second-account', { imageReady: ready })).toThrow(
      'no lead',
    );
    expect(() => moveProject('riverbend', 'second-account', { imageReady: () => false })).toThrow(
      'machine:deploy',
    );
    expect(imported('riverbend')).toEqual([]);
    expect(imported('harborlight')).toEqual([]);
  });

  it('reads an image’s readiness from the commit it was built from', () => {
    const repo = mkdtempSync(join(tmp, 'repo-'));
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', repo, '-c', 'user.name=Alice', '-c', 'user.email=alice', ...a], {
        encoding: 'utf8',
      }).stdout.trim();
    git('init', '-q');
    mkdirSync(join(repo, 'infra', 'project-machine'), { recursive: true });
    writeFileSync(join(repo, 'README'), 'x');
    git('add', '.');
    git('commit', '-qm', 'before');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'infra', 'project-machine', 'token-list.ts'), '');
    git('add', '.');
    git('commit', '-qm', 'after');
    const after = git('rev-parse', 'HEAD');
    expect(imageHasTokenList(after, repo)).toBe(true);
    expect(imageHasTokenList(before, repo)).toBe(false);
    expect(imageHasTokenList('', repo)).toBe(false);
    expect(imageHasTokenList('0'.repeat(40), repo)).toBe(false);
  });
});

describe('the list', () => {
  it('stores a label and a token in the next free slot, and reads them back', () => {
    addToken('first-account', FIRST, '2026-11-07');
    addToken('second-account', SECOND, '2026-11-08');
    expect(existsSync(join(kc, tokenSlot(1)))).toBe(true);
    expect(existsSync(join(kc, tokenSlot(2)))).toBe(true);
    expect(readTokenList().map((t) => [t.label, t.token])).toEqual([
      ['first-account', FIRST],
      ['second-account', SECOND],
    ]);
  });

  it('skips a slot that was emptied', () => {
    listed(3, 'third-account', SECOND);
    expect(readTokenList().map((t) => t.label)).toEqual(['third-account']);
  });

  it('refuses a repeated label, a repeated token, the Mac’s own sign-in and a non-token', () => {
    addToken('first-account', FIRST, '2026-11-07');
    expect(() => addToken('first-account', SECOND, '2026-11-07')).toThrow('first-account');
    expect(() => addToken('other', FIRST, '2026-11-07')).toThrow('already');
    expect(() => addToken('other', SHARED, '2026-11-07')).toThrow('claude-lead-oauth-token');
    expect(() => addToken('other', 'sk-ant-api03-short', '2026-11-07')).toThrow('setup-token');
    expect(() => addToken('other', `${SECOND}\nCW_LEAD_BOARD=x`, '2026-11-07')).toThrow();
    expect(() => addToken('Has Spaces', SECOND, '2026-11-07')).toThrow('label');
    expect(() => addToken('alice@harborlight', SECOND, '2026-11-07')).toThrow('label');
    expect(readTokenList()).toHaveLength(1);
  });

  it('names a damaged entry and shows none of its value', () => {
    keychain(tokenSlot(1), `{"label":"x","token":"${SECOND}\\nA=b"}`);
    let message = '';
    try {
      readTokenList();
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain(tokenSlot(1));
    expect(message).not.toContain(SECOND.slice(0, 20));
  });
});

describe('machine:tokens', () => {
  it('the help says the list is the owner’s own accounts only, and why', async () => {
    expect(HELP).toContain('accounts Bryan owns');
    expect(HELP).toContain('another person');
    expect(await runTokens(['help'])).toBe(0);
    expect(output.join('\n')).toContain('accounts Bryan owns');
    expect(await runTokens(['nonsense'])).toBe(2);
  });

  it('add takes the token from one approval, shows none of it, and list shows the label', async () => {
    expect(
      await runTokens(['add', '--label', 'first-account'], { show: (t) => output.push(t) }),
    ).toBe(0);
    expect(approvalCount()).toBe(1);
    expect(readTokenList()[0]?.token).toBe(APPROVED);
    output = [];
    expect(await runTokens(['list'])).toBe(0);
    expect(output.join('\n')).toContain('first-account');
    expect(output.join('\n')).toMatch(/expires about 20\d\d-\d\d-\d\d/);
    expectNoTokenShown(APPROVED);
  });

  it('add --stdin takes a token made elsewhere and asks for no approval', async () => {
    const code = await runTokens(['add', '--label', 'first-account', '--stdin'], {
      stdin: async () => `${FIRST}\n`,
    });
    expect(code).toBe(0);
    expect(approvalCount()).toBe(0);
    expect(readTokenList()[0]?.token).toBe(FIRST);
    expectNoTokenShown(FIRST);
  });

  it('move reports a failed confirmation with a non-zero exit', async () => {
    listed(1, 'first-account', FIRST);
    flySecrets('riverbend', [...requiredSecrets('quick'), 'CW_LEAD_BOARD']);
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    const code = await runTokens(['move', '--project', 'riverbend', '--to', 'first-account'], {
      imageReady: () => true,
    });
    expect(code).toBe(1);
    expect(output.join('\n')).toContain('not confirmed');
  });
});

describe('the status line writes a reading', () => {
  const INPUT = {
    session_id: 'private-session-id',
    cwd: '/data/lead/work',
    transcript_path: '/home/lead/.claude/projects/x.jsonl',
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 40, resets_at: 1_800_100_000 },
    },
  };
  const script = join(machineDir, 'lead-usage.ts');
  const run = (root: string, input: string) =>
    spawnSync(process.execPath, [script], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CW_LEAD_ROOT: root, CW_LEAD_TOKEN_LABEL: 'first-account' },
    });

  it('keeps the numbers and the label and nothing else from what it was handed', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    const r = run(root, JSON.stringify(INPUT));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('12');
    const raw = readFileSync(join(root, 'usage.json'), 'utf8');
    expect(raw).not.toContain('private-session-id');
    expect(raw).not.toContain('transcript');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const f = parseUsageFile(raw);
    expect(f?.label).toBe('first-account');
    expect(f?.fiveHour).toEqual({ usedPercent: 12.5, resetsAt: 1_800_000_000 });
    expect(f?.sevenDay?.usedPercent).toBe(40);
  });

  it('records that it ran when no rate_limits came, keeping an earlier reading', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    run(root, JSON.stringify({ session_id: 'x' }));
    const empty = parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'));
    expect(empty?.seenAt).toBeGreaterThan(0);
    expect(empty?.fiveHour).toBeNull();
    run(root, JSON.stringify(INPUT));
    run(root, JSON.stringify({ session_id: 'x' }));
    const kept = parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'));
    expect(kept?.fiveHour?.usedPercent).toBe(12.5);
  });

  it('an earlier reading of another token is not carried over', () => {
    const before = { label: 'old', seenAt: 1, readAt: 1, fiveHour: null, sevenDay: null };
    const next = foldUsage(
      { ...before, fiveHour: { usedPercent: 99, resetsAt: 5 } },
      {},
      'first-account',
      100,
    );
    expect(next.fiveHour).toBeNull();
    expect(next.label).toBe('first-account');
  });

  it('survives input that is not JSON, and refuses values that are not numbers', () => {
    const root = mkdtempSync(join(tmp, 'usage-'));
    expect(run(root, 'not json').status).toBe(0);
    const bad = { rate_limits: { five_hour: { used_percentage: '<b>', resets_at: 1 } } };
    run(root, JSON.stringify(bad));
    expect(parseUsageFile(readFileSync(join(root, 'usage.json'), 'utf8'))?.fiveHour).toBeNull();
  });
});

describe('the report', () => {
  const NOW = 1_800_000_000_000;
  const usageLine = (label: string, five: number, ageMs = 60_000) =>
    JSON.stringify({
      label,
      seenAt: NOW - ageMs,
      readAt: NOW - ageMs,
      fiveHour: { usedPercent: five, resetsAt: NOW / 1000 + 3600 },
      sevenDay: { usedPercent: 30, resetsAt: NOW / 1000 + 86_400 },
    });
  const lead = (label: string, usage: string) => `connecting\ncw-usage-start\n${label}\n${usage}\n`;

  it('reads as the lead, so a link in the lead’s folder reaches nothing of root’s', () => {
    const root = mkdtempSync(join(tmp, 'read-'));
    const secret = join(tmp, 'root-only');
    writeFileSync(secret, 'ROOT_SECRET=1');
    symlinkSync(secret, join(root, 'usage.json'));
    writeFileSync(join(root, 'token-label'), 'first-account\n');
    const stub = mkdtempSync(join(tmp, 'stub-'));
    writeFileSync(
      join(stub, 'setpriv'),
      `#!/bin/sh\necho "$*" > "${root}/setpriv"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(stub, 'setpriv'), 0o755);
    const r = spawnSync('sh', ['-c', leadReadCommand(root, `${stub}:/usr/bin:/bin`)], {
      encoding: 'utf8',
    });
    expect(readFileSync(join(root, 'setpriv'), 'utf8')).toContain('--reuid=lead');
    // What a planted file holds never parses into a reading.
    expect(parseLeadRead(r.stdout).usage).toBeNull();
    expect(parseLeadRead(r.stdout).label).toBe('first-account');
  });

  it('gives each listed token its newest reading and the projects on it', () => {
    const lines = renderUsage(
      ['first-account', 'second-account'],
      [
        {
          project: 'harborlight',
          ...parseLeadRead(lead('first-account', usageLine('first-account', 12, 600_000))),
        },
        {
          project: 'riverbend',
          ...parseLeadRead(lead('first-account', usageLine('first-account', 20))),
        },
      ],
      NOW,
    ).join('\n');
    expect(lines).toContain('first-account');
    expect(lines).toContain('harborlight');
    expect(lines).toContain('riverbend');
    expect(lines).toContain('20%');
    expect(lines).not.toContain('12%');
    expect(lines).toMatch(/second-account.*no reading/);
  });

  it('says plainly why there is no reading, in each of the three cases', () => {
    const noFile = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', ...parseLeadRead(lead('first-account', '')) }],
      NOW,
    ).join('\n');
    expect(noFile).toContain('status line has not run');
    const ran = JSON.stringify({
      label: 'first-account',
      seenAt: NOW - 1000,
      readAt: null,
      fiveHour: null,
      sevenDay: null,
    });
    const noLimits = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', ...parseLeadRead(lead('first-account', ran)) }],
      NOW,
    ).join('\n');
    expect(noLimits).toContain('no rate_limits');
    const failed = renderUsage(
      ['first-account'],
      [{ project: 'riverbend', label: null, usage: null, error: 'could not read the machine' }],
      NOW,
    ).join('\n');
    expect(failed).toContain('riverbend');
    expect(failed).toContain('could not read');
    expect(noFile).toContain('unproven');
  });

  it('marks a window that has ended, and shows a project on its own sign-in', () => {
    const ended = JSON.stringify({
      label: '',
      seenAt: NOW - 90_000_000,
      readAt: NOW - 90_000_000,
      fiveHour: { usedPercent: 88, resetsAt: NOW / 1000 - 100 },
      sevenDay: { usedPercent: 30, resetsAt: NOW / 1000 + 100 },
    });
    const lines = renderUsage(
      [],
      [{ project: 'riverbend', ...parseLeadRead(lead('', ended)) }],
      NOW,
    ).join('\n');
    expect(lines).toContain('own sign-in');
    expect(lines).toContain('riverbend');
    expect(lines).toContain('ended');
  });

  it('refuses what a steered lead wrote: nothing but a label and numbers is printed', () => {
    const planted = JSON.stringify({
      label: 'first-account',
      seenAt: NOW,
      readAt: NOW,
      fiveHour: { usedPercent: `${SECOND}`, resetsAt: 1 },
      sevenDay: null,
    });
    const r = parseLeadRead(lead(`${SECOND}\u001b[2J`, planted));
    expect(r.label).toBeNull();
    expect(r.usage).toBeNull();
    const lines = renderUsage([], [{ project: 'riverbend', ...r }], NOW).join('\n');
    expect(lines).not.toContain(SECOND);
  });

  it('usageReport reads every cw- app, or only the projects named, and prints no token', async () => {
    listed(1, 'first-account', FIRST);
    for (const org of ORGS)
      writeFileSync(
        join(appDir(org), 'ssh-out'),
        lead('first-account', usageLine('first-account', 7)),
      );
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    const all = usageReport([]);
    expect(all.map((r) => r.project)).toEqual(['harborlight', 'riverbend']);
    expect(all[0]?.usage?.fiveHour?.usedPercent).toBe(7);
    expect(all[1]?.error).toContain('could not read');
    rmSync(join(fs, 'calls'));
    expect(usageReport(['harborlight']).map((r) => r.project)).toEqual(['harborlight']);
    expect(flyCalls()).not.toContain('cw-riverbend');
    expect(await runTokens(['usage', '--project', 'harborlight'])).toBe(0);
    expectNoTokenShown(FIRST);
  });
});
