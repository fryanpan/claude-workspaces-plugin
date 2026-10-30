/**
 * `machine:deploy`'s per-project settings (`infra/project-machine/settings.ts`):
 * the owner's address, the public address, and the Cloudflare Access
 * application in front of it, set as Fly secrets so a new board needs no
 * hand-typed `fly secrets set`.
 *
 * `deployProject` runs here end to end against stand-ins: `fly` and
 * `security` on PATH are scripts that answer from files in a temp folder and
 * record every call, and Cloudflare (and the bucket's lifecycle read) is a
 * loopback server. Nothing reaches Fly, Cloudflare, Tigris or the Keychain.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
import { cloudflareApi } from '../../../infra/project-machine/cloudflare.ts';
import {
  LEAD_TOKEN_ENTRY,
  type Observed,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import { deployProject } from '../../../infra/project-machine/deploy.ts';
import { SETTING_NAMES } from '../../../infra/project-machine/settings.ts';
import { lifecycleXml } from '../../../infra/project-machine/tigris.ts';
import { storedSecretService } from '../../../packages/core/src/secret-name.ts';
import { TOKEN_SERVICE } from '../../../scripts/lead-sandbox-token.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const HEAD = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const cfg = projectConfig({ project: 'riverbend', imageLabel: HEAD });

const ACCOUNT = 'c'.repeat(32);
const TOKEN = 'cfat-fixture-Riverbend-0001';
const AUD = 'aud-fixture-riverbend-5f2c9e';
const TEAM = 'harborlight.cloudflareaccess.com';
const HOST = 'riverbend-workspaces.harborlight.test';
const ALT_HOST = 'riverbend.harborlight.test';
const OWNER = 'alice@harborlight.test';
const ORG_KEY = 'sk-ant-fixture-riverbend-org';
const LEAD_TOKEN = 'sk-ant-oat-fixture-riverbend-lead';

const tmp = mkdtempSync(join(tmpdir(), 'pm-deploy-settings-'));
const bin = join(tmp, 'bin');
const kc = join(tmp, 'keychain');
const state = join(tmp, 'fly');
const flyCalls = join(tmp, 'fly-calls');
const imported = join(tmp, 'fly-imported');
const accessConfig = join(tmp, 'access.local.json');

/** Cloudflare's Access, and the bucket's lifecycle read, on loopback. */
const cloudflare = {
  apps: [] as Array<{ id: string; name: string; aud?: string }>,
  requests: [] as string[],
};
let server: ReturnType<typeof Bun.serve>;
const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result, result_info: { total_pages: 1 } });

const saved = { path: process.env.PATH, keeper: process.env.CW_KEEPER_URL };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      cloudflare.requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === `/${cfg.bucket}`) return new Response(lifecycleXml('snapshots/', 30));
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
      }
      const base = '/client/v4/accounts';
      if (req.method === 'GET' && url.pathname === base) return ok([{ id: ACCOUNT, name: 'h' }]);
      if (req.method === 'GET' && url.pathname === `${base}/${ACCOUNT}/access/apps`)
        return ok(cloudflare.apps);
      if (req.method === 'GET' && url.pathname === `${base}/${ACCOUNT}/access/organizations`)
        return ok({ auth_domain: TEAM, name: 'harborlight' });
      return Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 });
    },
  });
  mkdirSync(bin);
  mkdirSync(kc);
  mkdirSync(state);
  // Answers `find-generic-password -s claude-workspaces-secret.<name> [-w]`
  // from the file `<name>` in the stand-in Keychain folder.
  writeFileSync(
    join(bin, 'security'),
    `#!/bin/sh
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
  writeFileSync(
    join(bin, 'fly'),
    `#!/bin/sh
echo "$*" >> "${flyCalls}"
case "$1 $2" in
  "apps list") echo '[{"Name":"${cfg.app}"}]' ;;
  "volumes list") echo '[{"name":"cw_data","region":"sjc","state":"created"}]' ;;
  "secrets list") cat "${state}/secrets.json" ;;
  "machines list") cat "${state}/machines.json" ;;
  "secrets import") cat >> "${imported}" ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'security'), 0o755);
  chmodSync(join(bin, 'fly'), 0o755);
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
const flySecrets = (names: readonly string[]) =>
  writeFileSync(join(state, 'secrets.json'), JSON.stringify(names.map((Name) => ({ Name }))));
const flyCallLines = () =>
  existsSync(flyCalls) ? readFileSync(flyCalls, 'utf8').split('\n').filter(Boolean) : [];

let output: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  rmSync(kc, { recursive: true, force: true });
  mkdirSync(kc);
  keychain('fly-org-token', 'fo-fixture-token');
  keychain('fly-org-slug', 'harborlight');
  keychain(cfg.keychain.identity, 'AGE-SECRET-KEY-FIXTURE');
  keychain(
    cfg.keychain.bucketAdmin,
    JSON.stringify({
      endpoint: `http://127.0.0.1:${server.port}`,
      accessKeyId: 'tid_fixture',
      secretAccessKey: 'tsec_fixture',
    }),
  );
  keychain(cfg.keychain.writer, JSON.stringify({ accessKeyId: 'w', secretAccessKey: 'w' }));
  keychain('cw-board-owner-email', `${OWNER}\n`);
  flySecrets(requiredSecrets('quick'));
  writeFileSync(
    join(state, 'machines.json'),
    JSON.stringify([
      {
        id: 'm1',
        state: 'started',
        image_ref: { tag: HEAD },
        config: { guest: { memory_mb: 512 } },
      },
    ]),
  );
  writeFileSync(
    accessConfig,
    JSON.stringify({
      projects: {
        riverbend: { hosts: [HOST, ALT_HOST], emails: [OWNER] },
        saltmarsh: { hosts: ['saltmarsh-workspaces.harborlight.test'] },
      },
    }),
  );
  cloudflare.apps = [
    { id: 'app-s', name: 'board saltmarsh', aud: 'aud-saltmarsh' },
    { id: 'app-r', name: 'board riverbend', aud: AUD },
  ];
  cloudflare.requests = [];
  rmSync(flyCalls, { force: true });
  rmSync(imported, { force: true });
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

const run = (dryRun: boolean, path = accessConfig) =>
  deployProject(cfg, dryRun, undefined, {
    accessConfig: path,
    cloudflare: () => cloudflareApi(TOKEN, { base: `http://127.0.0.1:${server.port}/client/v4` }),
  });

const ALL = [
  'CW_OWNER_EMAIL',
  'CW_PUBLIC_BASE_URL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'CF_ACCESS_HOST_AUDS',
  'CW_PROXIED_TRUSTED_HOSTS',
];

describe('machine:deploy sets the project settings', () => {
  it('a dry run plans every setting, names where each comes from, and prints no value', async () => {
    const actions = await run(true);
    expect(actions).toEqual([{ kind: 'set-secrets', names: ALL }, { kind: 'deploy' }]);
    const text = output.join('\n');
    for (const name of ALL) expect(text).toContain(name);
    expect(text).toContain('Keychain cw-board-owner-email');
    expect(text).toContain('Access application "board riverbend"');
    expect(text).toContain('access.local.json');
    for (const value of [OWNER, AUD, TEAM, TOKEN, HOST]) expect(text).not.toContain(value);
    expect(flyCallLines().some((l) => l.startsWith('secrets import'))).toBe(false);
    expect(cloudflare.requests.every((r) => r.startsWith('GET '))).toBe(true);
  });

  it('a run puts each value on stdin, never in an argument or the output', async () => {
    await run(false);
    const lines = readFileSync(imported, 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual([
      `CW_OWNER_EMAIL=${OWNER}`,
      `CW_PUBLIC_BASE_URL=https://${HOST}`,
      `CF_ACCESS_TEAM_DOMAIN=${TEAM}`,
      `CF_ACCESS_AUD=${AUD}`,
      `CF_ACCESS_HOST_AUDS=${JSON.stringify({ [HOST]: AUD, [ALT_HOST]: AUD })}`,
      `CW_PROXIED_TRUSTED_HOSTS=${HOST},${ALT_HOST}`,
    ]);
    const args = flyCallLines().join('\n');
    const text = output.join('\n');
    for (const value of [OWNER, AUD, TEAM]) {
      expect(args).not.toContain(value);
      expect(text).not.toContain(value);
    }
  });

  it('sets only the settings the machine does not have yet', async () => {
    flySecrets([...requiredSecrets('quick'), ...ALL.filter((n) => n !== 'CF_ACCESS_AUD')]);
    expect(await run(true)).toEqual([
      { kind: 'set-secrets', names: ['CF_ACCESS_AUD'] },
      { kind: 'deploy' },
    ]);
    flySecrets([...requiredSecrets('quick'), ...ALL]);
    expect(await run(true)).toEqual([]);
  });

  it('sets the org key once, from the Keychain, beside the settings', async () => {
    keychain(cfg.keychain.orgKey, ORG_KEY);
    flySecrets([...requiredSecrets('quick'), ...ALL]);
    await run(false);
    expect(readFileSync(imported, 'utf8')).toBe(`CW_ORG_ANTHROPIC_API_KEY=${ORG_KEY}\n`);
  });

  it('sets the lead’s sign-in once, from the Keychain, and never prints it', async () => {
    keychain(LEAD_TOKEN_ENTRY, `${LEAD_TOKEN}\n`);
    flySecrets([...requiredSecrets('quick'), ...ALL]);
    expect(await run(true)).toEqual([
      { kind: 'set-secrets', names: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      { kind: 'deploy' },
    ]);
    await run(false);
    expect(readFileSync(imported, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${LEAD_TOKEN}\n`);
    expect(flyCallLines().join('\n')).not.toContain(LEAD_TOKEN);
    expect(output.join('\n')).not.toContain(LEAD_TOKEN);
    // Set once: a machine that has it is left alone.
    flySecrets([...requiredSecrets('quick', false, true), ...ALL]);
    expect(await run(true)).toEqual([]);
  });

  it('reads a labelled account’s sign-in, and refuses one that is not a token without quoting it', async () => {
    const labelled = projectConfig({
      project: 'riverbend',
      imageLabel: HEAD,
      claudeAccount: 'work',
    });
    expect(labelled.keychain.leadToken).toBe(`${LEAD_TOKEN_ENTRY}.work`);
    keychain(`${LEAD_TOKEN_ENTRY}.work`, `${LEAD_TOKEN}\n`);
    flySecrets([...requiredSecrets('quick'), ...ALL]);
    const opts = {
      accessConfig,
      cloudflare: () => cloudflareApi(TOKEN, { base: `http://127.0.0.1:${server.port}/client/v4` }),
    };
    await deployProject(labelled, false, undefined, opts);
    expect(readFileSync(imported, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${LEAD_TOKEN}\n`);

    rmSync(imported);
    keychain(`${LEAD_TOKEN_ENTRY}.work`, `${LEAD_TOKEN} riverbend`);
    const failed = await deployProject(labelled, false, undefined, opts).catch((e: Error) => e);
    expect(String(failed)).toContain(`${LEAD_TOKEN_ENTRY}.work does not hold a token`);
    expect(String(failed)).not.toContain(LEAD_TOKEN);
    expect(existsSync(imported)).toBe(false);
  });

  it('says no lead will run when the Keychain has no sign-in for one', async () => {
    await run(true);
    expect(output.join('\n')).toContain(
      `CLAUDE_CODE_OAUTH_TOKEN: the Keychain has no ${LEAD_TOKEN_ENTRY}, so no lead agent runs`,
    );
  });

  it('reads the same Keychain item the walled lead on the Mac signs in from', () => {
    expect(storedSecretService(LEAD_TOKEN_ENTRY)).toBe(TOKEN_SERVICE);
  });

  it('skips the Access settings, and says so, when the project has no Access application', async () => {
    cloudflare.apps = cloudflare.apps.filter((a) => a.name !== 'board riverbend');
    const actions = await run(true);
    expect(actions).toEqual([
      { kind: 'set-secrets', names: ['CW_OWNER_EMAIL', 'CW_PUBLIC_BASE_URL'] },
      { kind: 'deploy' },
    ]);
    expect(output.join('\n')).toContain('no Access application "board riverbend"');
  });

  it('asks Cloudflare nothing for a project access.local.json does not list', async () => {
    writeFileSync(
      accessConfig,
      JSON.stringify({ projects: { saltmarsh: { hosts: ['s.harborlight.test'] } } }),
    );
    expect(await run(true)).toEqual([
      { kind: 'set-secrets', names: ['CW_OWNER_EMAIL'] },
      { kind: 'deploy' },
    ]);
    expect(await run(true, join(tmp, 'missing.json'))).toEqual([
      { kind: 'set-secrets', names: ['CW_OWNER_EMAIL'] },
      { kind: 'deploy' },
    ]);
    expect(cloudflare.requests.filter((r) => r.includes('/client/v4/'))).toEqual([]);
    expect(output.join('\n')).toContain('no project riverbend');
  });

  it('leaves the owner address unset, and says so, when the Keychain has none', async () => {
    rmSync(join(kc, 'cw-board-owner-email'));
    const actions = await run(true);
    expect(actions[0]).toEqual({ kind: 'set-secrets', names: ALL.slice(1) });
    expect(output.join('\n')).toContain('the Keychain has no cw-board-owner-email');
  });

  it('stops before any change when two applications share the project name', async () => {
    cloudflare.apps.push({ id: 'app-r2', name: 'board riverbend', aud: 'aud-other' });
    await expect(run(false)).rejects.toThrow('two Access applications');
    expect(flyCallLines().some((l) => l.startsWith('secrets import'))).toBe(false);
  });
});

describe('plan, with the settings', () => {
  const complete = (): Observed => ({
    app: true,
    volumes: 1,
    keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
    lifecycle: true,
    secrets: new Set(requiredSecrets('quick')),
    machines: [{ id: 'm1', state: 'started', imageTag: HEAD, memoryMb: 512 }],
  });

  it('lists every setting deploy can derive', () => {
    expect<string[]>([...SETTING_NAMES]).toEqual(ALL);
  });

  it('sets a setting that is missing, and leaves one that exists', () => {
    expect(plan(cfg, complete(), [], ['CF_ACCESS_AUD'])).toEqual([
      { kind: 'set-secrets', names: ['CF_ACCESS_AUD'] },
      { kind: 'deploy' },
    ]);
    const obs = { ...complete(), secrets: new Set([...complete().secrets, 'CF_ACCESS_AUD']) };
    expect(plan(cfg, obs, [], ['CF_ACCESS_AUD'])).toEqual([]);
  });
});
