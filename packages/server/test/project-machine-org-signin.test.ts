/**
 * Each org's lead signs in with a Claude token of its own (re-review finding
 * H2): `machine:deploy` asks Bryan for one browser approval per org
 * (`claude setup-token`), sets the token it prints on that org's Fly app and
 * nowhere else, and the machine starts its lead only on a token made for its
 * own org (`entrypoint.sh`).
 *
 * Two orgs, Harborlight and Riverbend, are deployed end to end against
 * stand-ins: `fly`, `security`, `script` and `claude` on PATH are scripts that
 * answer from files in a temp folder and record every call, and the buckets'
 * lifecycle reads are a loopback server. The `claude` stand-in is the browser
 * approval: each call counts as one, and it prints the token the way
 * `claude setup-token` does. Nothing reaches Fly, Tigris, the Keychain or
 * Anthropic, and no browser opens.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  LEAD_TOKEN_ORG_SECRET,
  LEAD_TOKEN_SECRET,
  type Observed,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import { deployProject } from '../../../infra/project-machine/deploy.ts';
import { Redactor, testRefusal, tokenIn } from '../../../infra/project-machine/org-signin.ts';
import { lifecycleXml } from '../../../infra/project-machine/tigris.ts';
import { BASH, machineDir, machineEnv, readRecords, stubs } from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const HEAD = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

const ORGS = ['harborlight', 'riverbend'] as const;
type Org = (typeof ORGS)[number];
/** Each org's own token, as `claude setup-token` prints one; distinct, so a leak names itself. */
const TOKEN: Record<Org, string> = {
  harborlight: 'sk-ant-oat01-fixture-harborlight-lead-0Aa1Bb2Cc3',
  riverbend: 'sk-ant-oat01-fixture-riverbend-lead-4Dd5Ee6Ff7',
};
/** Bryan's own sign-in, which the Mac's walled lead uses and no org's lead may. */
const SHARED = 'sk-ant-oat01-fixture-saltmarsh-shared-8Gg9Hh';
const BOARD: Record<Org, string> = { harborlight: 'w-harbor', riverbend: 'w-river' };
const cfgOf = (org: Org, extra: Partial<Parameters<typeof projectConfig>[0]> = {}) =>
  projectConfig({
    project: org,
    imageLabel: HEAD,
    vmMemoryMb: 2048,
    leadBoard: BOARD[org],
    ...extra,
  });

const tmp = mkdtempSync(join(tmpdir(), 'pm-org-signin-'));
const bin = join(tmp, 'bin');
const kc = join(tmp, 'keychain');
const fs = join(tmp, 'fly');
const approvals = join(tmp, 'approvals');
const tokens = join(tmp, 'tokens');
const securityCalls = join(tmp, 'security-calls');

let server: ReturnType<typeof Bun.serve>;
const saved = { path: process.env.PATH, keeper: process.env.CW_KEEPER_URL };

const exe = (name: string, body: string) => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.searchParams.has('versioning'))
        return new Response(
          '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
        );
      return new Response(lifecycleXml('snapshots/', 30));
    },
  });
  mkdirSync(bin);
  mkdirSync(kc);
  mkdirSync(fs);
  // Answers `find-generic-password -s claude-workspaces-secret.<name> [-w]`
  // from the file `<name>`; records every call, so a write would show.
  exe(
    'security',
    `#!/bin/sh
echo "$*" >> "${securityCalls}"
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
  // One folder per app: <app>/secrets.json is what `secrets list` shows, and
  // <app>/imported is everything `secrets import` was handed on stdin.
  exe(
    'fly',
    `#!/bin/sh
echo "$*" >> "${fs}/calls"
app=""; prev=""
for a in "$@"; do [ "$prev" = "--app" ] && app="$a"; prev="$a"; done
case "$1 $2" in
  "apps list") echo '[{"Name":"cw-harborlight"},{"Name":"cw-riverbend"}]' ;;
  "volumes list") echo '[{"name":"cw_data","region":"sjc","state":"created"}]' ;;
  "secrets list") cat "${fs}/$app/secrets.json" ;;
  "machines list") echo '[{"id":"m1","state":"started","image_ref":{"tag":"${HEAD}"},"config":{"guest":{"memory_mb":2048}}}]' ;;
  "secrets import") cat >> "${fs}/$app/imported" ;;
esac
exit 0
`,
  );
  // macOS script(1), as far as the approval uses it: \`script -q /dev/null cmd…\`.
  exe(
    'script',
    '#!/bin/sh\n[ "$1" = -q ] && [ "$2" = /dev/null ] || exit 64\nshift 2\nexec "$@"\n',
  );
  // claude setup-token: one call is one browser approval. It prints the next
  // token in the queue the way the real one does, in two writes split inside
  // the token, or nothing at all once the queue is empty.
  exe(
    'claude',
    `#!/bin/sh
[ "$1" = setup-token ] || exit 64
echo approved >> "${approvals}"
n=$(wc -l < "${approvals}" | tr -d ' ')
tok=$(sed -n "\${n}p" "${tokens}" 2>/dev/null)
printf 'Opening your browser to approve a long-lived token...\\r\\n'
[ -n "$tok" ] || { printf 'Login failed\\r\\n'; exit 1; }
printf '\\033[32m✓\\033[0m Long-lived authentication token created successfully!\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n'
printf '%s' "$(printf '%s' "$tok" | cut -c1-20)"
printf '%s\\r\\n' "$(printf '%s' "$tok" | cut -c21-)"
printf '\\r\\nStore this token securely. You will not be able to see it again.\\r\\n'
`,
  );
  process.env.PATH = `${bin}:${saved.path ?? ''}`;
  Reflect.deleteProperty(process.env, 'CW_KEEPER_URL');
});

afterAll(() => {
  process.env.PATH = saved.path;
  if (saved.keeper !== undefined) process.env.CW_KEEPER_URL = saved.keeper;
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const keychain = (name: string, value: string) => writeFileSync(join(kc, name), value);
const flySecrets = (org: Org, names: readonly string[]) =>
  writeFileSync(
    join(fs, `cw-${org}`, 'secrets.json'),
    JSON.stringify(names.map((Name) => ({ Name }))),
  );
const imported = (org: Org): string[] => {
  const f = join(fs, `cw-${org}`, 'imported');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};
const approvalCount = () =>
  existsSync(approvals) ? readFileSync(approvals, 'utf8').split('\n').filter(Boolean).length : 0;
const queue = (...t: string[]) => writeFileSync(tokens, t.map((x) => `${x}\n`).join(''));
/** Every value set on the app, as the machine's environment would hold it. */
const appEnv = (org: Org): Record<string, string> =>
  Object.fromEntries(
    imported(org).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

let output: string[] = [];
let shown: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  rmSync(kc, { recursive: true, force: true });
  mkdirSync(kc);
  keychain('fly-org-token', 'fo-fixture-token');
  keychain('fly-org-slug', 'harborlight');
  // The Mac's own walled lead's sign-in is in the Keychain. No org gets it.
  keychain('claude-lead-oauth-token', `${SHARED}\n`);
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
    rmSync(join(fs, cfg.app), { recursive: true, force: true });
    mkdirSync(join(fs, cfg.app));
    flySecrets(org, requiredSecrets('quick'));
  }
  rmSync(approvals, { force: true });
  rmSync(securityCalls, { force: true });
  queue(TOKEN.harborlight, TOKEN.riverbend);
  output = [];
  shown = [];
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

/** No Terraform: no Access app, no tunnel, so the run is the lead's alone. */
const outputs = (): TfOutputs => ({ access: {}, accessTeamDomain: null, tunnels: {} });
const deploy = (
  org: Org,
  dryRun = false,
  extra: Partial<Parameters<typeof projectConfig>[0]> = {},
) => deployProject(cfgOf(org, extra), dryRun, { outputs, signInOutput: (t) => shown.push(t) });

describe('machine:deploy gives each org a sign-in of its own', () => {
  it('asks for one browser approval per org and sets each token on its own org’s app only', async () => {
    await deploy('harborlight');
    expect(approvalCount()).toBe(1);
    await deploy('riverbend');
    expect(approvalCount()).toBe(2);

    for (const [org, other] of [
      ['harborlight', 'riverbend'],
      ['riverbend', 'harborlight'],
    ] as const) {
      const env = appEnv(org);
      expect(env[LEAD_TOKEN_SECRET]).toBe(TOKEN[org]);
      expect(env[LEAD_TOKEN_ORG_SECRET]).toBe(org);
      expect(env.CW_LEAD_BOARD).toBe(BOARD[org]);
      // The other org's token, and Bryan's shared one, are nowhere on this app.
      const all = imported(org).join('\n');
      expect(all).not.toContain(TOKEN[other]);
      expect(all).not.toContain(SHARED);
    }
    // The token went on stdin and nowhere else: not an argument, not the
    // output, not the screen Bryan approves from, not the Mac's Keychain.
    const args = readFileSync(join(fs, 'calls'), 'utf8');
    const said = [...output, ...shown].join('\n');
    for (const t of Object.values(TOKEN)) {
      expect(args).not.toContain(t);
      expect(said).not.toContain(t);
      expect(said).not.toContain(t.slice(0, 20));
    }
    expect(shown.join('')).toContain('Your OAuth token (valid for 1 year)');
    expect(output.join('\n')).toContain('one browser approval');
    expect(readFileSync(securityCalls, 'utf8')).not.toMatch(/^-i|add-generic-password/m);
  });

  it('asks again for nothing once the org holds its own token', async () => {
    await deploy('riverbend');
    expect(approvalCount()).toBe(1);
    flySecrets('riverbend', [
      ...requiredSecrets('quick'),
      LEAD_TOKEN_SECRET,
      LEAD_TOKEN_ORG_SECRET,
      'CW_LEAD_BOARD',
    ]);
    rmSync(join(fs, 'cw-riverbend', 'imported'));
    expect(await deploy('riverbend', false, { leadBoard: undefined })).toEqual([]);
    expect(approvalCount()).toBe(1);
    expect(imported('riverbend')).toEqual([]);
  });

  it('replaces a sign-in the org did not get its own, such as the shared one', async () => {
    // Set before this change: a token, but no record it was made for this org.
    flySecrets('harborlight', [...requiredSecrets('quick'), LEAD_TOKEN_SECRET, 'CW_LEAD_BOARD']);
    await deploy('harborlight', false, { leadBoard: undefined });
    expect(approvalCount()).toBe(1);
    expect(appEnv('harborlight')[LEAD_TOKEN_SECRET]).toBe(TOKEN.harborlight);
    expect(appEnv('harborlight')[LEAD_TOKEN_ORG_SECRET]).toBe('harborlight');
  });

  it('a dry run asks for no approval and says one is due', async () => {
    const actions = await deploy('harborlight', true);
    expect(approvalCount()).toBe(0);
    expect(actions.find((a) => a.kind === 'set-secrets')).toMatchObject({
      names: expect.arrayContaining([LEAD_TOKEN_SECRET, LEAD_TOKEN_ORG_SECRET]),
    });
    expect(output.join('\n')).toContain('one browser approval');
  });

  it('sets nothing when the approval prints no token', async () => {
    queue();
    await expect(deploy('riverbend')).rejects.toThrow('printed no token');
    expect(approvalCount()).toBe(1);
    expect(imported('riverbend')).toEqual([]);
  });

  it('never plans an approval where nobody can give one (CI)', () => {
    const cfg = cfgOf('riverbend');
    const obs: Observed = {
      app: true,
      volumes: 1,
      keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
      lifecycle: true,
      versioning: true,
      secrets: new Set(requiredSecrets('quick')),
      machines: [{ id: 'm1', state: 'started', imageTag: HEAD, memoryMb: 2048 }],
      browser: false,
    };
    const set = plan(cfg, obs).find((a) => a.kind === 'set-secrets');
    expect(set?.kind === 'set-secrets' ? set.names : []).toEqual(['CW_LEAD_BOARD']);
    const atMac = plan(cfg, { ...obs, browser: true }).find((a) => a.kind === 'set-secrets');
    expect(atMac?.kind === 'set-secrets' ? atMac.names : []).toContain(LEAD_TOKEN_SECRET);
  });
});

describe('the approval’s screen never shows the token', () => {
  it('refuses, under test, a claude that is not a stand-in in a temp folder', () => {
    expect(testRefusal()).toBeNull();
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(testRefusal()).toContain('reached the real claude');
    } finally {
      process.env.PATH = path;
    }
  });

  it('holds back a token split across writes, and passes the rest through', () => {
    const r = new Redactor();
    const t = TOKEN.harborlight;
    const out = [
      r.push('Your OAuth token:\r\n\r\n'),
      r.push(t.slice(0, 4)),
      r.push(t.slice(4, 22)),
      r.push(`${t.slice(22)}\r\nStore this s`),
      r.push('ecurely.'),
      r.end(),
    ].join('');
    expect(out).not.toContain(t.slice(0, 10));
    expect(out).toContain('Your OAuth token:');
    expect(out).toContain('[token hidden]');
    expect(out).toContain('Store this securely.');
  });

  it('finds the one token in the screen, through colour codes and redraws', () => {
    const screen = `\x1b[2K\x1b[1G${TOKEN.riverbend}\r\n\x1b[2K${TOKEN.riverbend}\x1b[0m\r\n`;
    expect(tokenIn(screen)).toBe(TOKEN.riverbend);
    expect(tokenIn('Login failed')).toBeNull();
    expect(tokenIn(`${TOKEN.riverbend}\n${TOKEN.harborlight}`)).toBeNull();
  });
});

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
});

/** Riverbend's machine, booted with exactly what `machine:deploy` set on its app. */
function riverbendMachine(secrets: Record<string, string>) {
  const s = stubs(tmp, '0', ['mkdir', 'ln']);
  const homes = join(s.root, 'home');
  mkdirSync(join(homes, 'lead'), { recursive: true });
  const child = spawn(BASH as string, [join(machineDir, 'entrypoint.sh')], {
    env: {
      ...machineEnv(s.bin, s.volume),
      CW_MACHINE_HOME_ROOT: homes,
      FLY_APP_NAME: 'cw-riverbend',
      ...secrets,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  return { ...s, out };
}

describe.skipIf(BASH === null)('each org’s lead starts on its own token', () => {
  it('Riverbend’s lead signs in with Riverbend’s token, and Harborlight’s is nowhere on its machine', async () => {
    await deploy('harborlight');
    await deploy('riverbend');
    const m = riverbendMachine(appEnv('riverbend'));
    await waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('claude')), {
      timeout: 20_000,
      describe: 'Riverbend’s lead to start',
    });
    const { recs } = readRecords(m.log);
    const lead = recs.find((r) => r.argv.startsWith('claude'));
    expect(lead?.uid).toBe('lead');
    expect(lead?.env.get(LEAD_TOKEN_SECRET)).toBe(TOKEN.riverbend);
    // No process on Riverbend's machine, of any user, holds Harborlight's
    // token, and only the lead holds Riverbend's.
    const holding = (t: string) =>
      recs.filter((r) => [...r.env.values(), r.argv].some((v) => v.includes(t)));
    expect(holding(TOKEN.harborlight)).toEqual([]);
    expect(holding(TOKEN.riverbend).map((r) => r.uid)).toEqual(['lead']);
  }, 60_000);

  it('starts no lead on a token made for another org, or on one with no org', async () => {
    for (const marker of [{ [LEAD_TOKEN_ORG_SECRET]: 'harborlight' }, {}] as Record<
      string,
      string
    >[]) {
      const m = riverbendMachine({
        [LEAD_TOKEN_SECRET]: TOKEN.harborlight,
        CW_LEAD_BOARD: BOARD.riverbend,
        ...marker,
      });
      await waitFor(() => m.out.join('').includes('no lead agent runs'), {
        timeout: 20_000,
        describe: 'the entrypoint to refuse the lead',
      });
      expect(m.out.join('')).toContain('not made for riverbend');
      await waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('cloudflared')), {
        timeout: 20_000,
        describe: 'the tunnel to start',
      });
      expect(readRecords(m.log).recs.filter((r) => r.argv.startsWith('claude'))).toEqual([]);
    }
  }, 60_000);
});
