/**
 * `bun run deploy:staging` in an app made by `bun run new-app`: the machine
 * new-app renders, and the commands the deploy runs, driven against a stand-in
 * `fly` (and a stand-in `security`) on the PATH. Nothing here reaches Fly, the
 * network or the Keychain. That the health check's path answers 200 on a
 * running app is in `app-kit.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
import { makeApp } from '../../../scripts/new-app.ts';
import { credentials } from '../../../templates/app-kit/scripts/deploy-staging.ts';
import { SECRET_ACCOUNT, storedSecretService } from '../../core/src/secret-name.ts';

const FAKE_TOKEN = 'stub-token-riverbend';

let parent: string;
let appDir: string;
let bin: string;
let emptyKeychainBin: string;

/** A stand-in for `fly`: logs each call's arguments, its stdin and whether
 *  it saw the token, and answers each list from STUB_<KIND>. */
const FLY_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/fly-args"
if [ "$FLY_API_TOKEN" = "${FAKE_TOKEN}" ]; then echo token >> "$STUB_DIR/fly-env"; fi
case "$1 $2" in
  "apps list") echo "\${STUB_APPS:-[]}" ;;
  "volumes list") echo "\${STUB_VOLUMES:-[]}" ;;
  "secrets list") echo "\${STUB_SECRETS:-[]}" ;;
  "orgs list") echo "\${STUB_ORGS:-[]}" ;;
  "secrets import") cat >> "$STUB_DIR/fly-stdin" ;;
esac
exit 0
`;

/** A stand-in for `security`: records that it ran, answers base64 of its -s. */
const SECURITY_STUB = `#!/bin/sh
echo "$*" >> "$STUB_DIR/security-args"
service=""
while [ $# -gt 0 ]; do [ "$1" = "-s" ] && service="$2"; shift; done
printf '%s' "value-of-$service" | base64
`;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'app-kit-staging-'));
  appDir = makeApp(join(parent, 'riverbend-notes')).dir;
  bin = join(parent, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [
    ['fly', FLY_STUB],
    ['security', SECURITY_STUB],
    // A Keychain with no such entry: `security` exits 44.
    ['security-empty', '#!/bin/sh\nexit 44\n'],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  // The same fly, with a Keychain that holds nothing: a Mac whose org is not stored.
  emptyKeychainBin = join(parent, 'bin-empty-keychain');
  mkdirSync(emptyKeychainBin);
  for (const [name, body] of [
    ['fly', FLY_STUB],
    ['security', '#!/bin/sh\nexit 44\n'],
  ] as const) {
    writeFileSync(join(emptyKeychainBin, name), body);
    chmodSync(join(emptyKeychainBin, name), 0o755);
  }
}, 120_000);

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

/** A fresh folder for one run's stub logs. */
function stubDir(): string {
  return mkdtempSync(join(parent, 'run-'));
}

function read(dir: string, file: string): string {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Run the made app's script. Async, so this process's health server can answer it. */
async function deploy(args: string[], dir: string, env: Record<string, string> = {}) {
  // Never the caller's own Fly credentials: a run without them must not find any.
  const { FLY_API_TOKEN: _token, FLY_ORG: _org, ...base } = process.env;
  const child = Bun.spawn(['bun', 'run', 'deploy:staging', ...args], {
    cwd: appDir,
    env: { ...base, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, out: `${stdout}${stderr}` };
}

/** A local server that answers 503 `fails` times, then 200; counts requests. */
function health(fails: number) {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('', { status: hits++ < fails ? 503 : 200 }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/health`,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}

describe('the staging machine new-app renders', () => {
  it('names the Fly app after the made app, and serves the port it listens on', () => {
    const toml = Bun.TOML.parse(readFileSync(join(appDir, 'fly.toml'), 'utf8')) as {
      app: string;
      env: Record<string, string>;
      mounts: { source: string; destination: string };
      http_service: {
        internal_port: number;
        auto_stop_machines: string;
        min_machines_running: number;
        checks: Array<{ path: string }>;
      };
      vm: Array<{ size: string; memory: string }>;
    };
    expect(toml.app).toBe('riverbend-notes-staging');
    expect(toml.env.HOST).toBe('0.0.0.0');
    expect(toml.env.APP_ENV).toBe('staging');
    expect(toml.http_service.internal_port).toBe(Number(toml.env.PORT));
    expect(toml.mounts.destination).toBe(toml.env.DATA_DIR);
    expect(toml.http_service.auto_stop_machines).toBe('stop');
    expect(toml.http_service.min_machines_running).toBe(0);
    expect(toml.http_service.checks[0]?.path).toBe('/health');
    expect(toml.vm[0]?.size).toBe('shared-cpu-1x');
  });

  it('builds the image from the made app with bun, then starts it', () => {
    const lines = readFileSync(join(appDir, 'Dockerfile'), 'utf8')
      .split('\n')
      .filter((l) => /^(FROM|RUN|CMD)\b/.test(l));
    expect(lines[0]).toMatch(/^FROM oven\/bun:/);
    expect(lines.slice(1)).toEqual([
      'RUN bun install',
      'RUN bun run build',
      'CMD ["bun", "run", "start"]',
    ]);
  });
});

describe('deploy:staging --dry-run', () => {
  it('prints every fly command with the secret hidden, and runs none', async () => {
    const dir = stubDir();
    const probe = health(0);
    try {
      const r = await deploy(['--dry-run', '--url', probe.url], dir);
      expect(r.status).toBe(0);
      expect(r.out).toContain('fly apps create riverbend-notes-staging --org <org>');
      expect(r.out).toContain('fly volumes create app_data --app riverbend-notes-staging');
      expect(r.out).toContain(
        'fly secrets import --app riverbend-notes-staging --stage <<< AUTH_SECRET=<redacted>',
      );
      expect(r.out).toContain(
        'APP_URL=https://riverbend-notes-staging.fly.dev --env APP_ENV=staging',
      );
      // No fly, no Keychain, no request to the URL it would wait on.
      expect(read(dir, 'fly-args')).toBe('');
      expect(read(dir, 'security-args')).toBe('');
      expect(probe.hits()).toBe(0);
    } finally {
      probe.stop();
    }
  });

  it('deploys under the name it is given', async () => {
    const r = await deploy(['saltmarsh-demo', '--dry-run'], stubDir());
    expect(r.status).toBe(0);
    expect(r.out).toContain('fly deploy --app saltmarsh-demo');
    expect(r.out).not.toContain('riverbend-notes-staging');
  });

  it('refuses a name Fly would refuse', async () => {
    const r = await deploy(['Harborlight_App', '--dry-run'], stubDir());
    expect(r.status).toBe(1);
    expect(r.out).toContain('not a Fly app name');
  });
});

describe('deploy:staging', () => {
  it('makes what is missing, keeps the token and secret out of every argument, and waits for a 200', async () => {
    const dir = stubDir();
    const probe = health(1);
    try {
      const r = await deploy(['--url', probe.url], dir, {
        FLY_API_TOKEN: FAKE_TOKEN,
        FLY_ORG: 'harborlight',
      });
      expect(r.status).toBe(0);
      const calls = read(dir, 'fly-args').trim().split('\n');
      expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
        'apps list',
        'apps create',
        'volumes list',
        'volumes create',
        'secrets list',
        'secrets import',
        'deploy --app',
      ]);
      // Every fly call saw the token, in its environment.
      expect(read(dir, 'fly-env').trim().split('\n')).toHaveLength(calls.length);
      const secret = read(dir, 'fly-stdin').match(/^AUTH_SECRET=(\S{40,})$/m)?.[1];
      expect(secret).toBeDefined();
      for (const hidden of [FAKE_TOKEN, secret as string]) {
        expect(read(dir, 'fly-args')).not.toContain(hidden);
        expect(r.out).not.toContain(hidden);
      }
      expect(read(dir, 'security-args')).toBe('');
      expect(probe.hits()).toBe(2);
      expect(r.out).toMatch(/riverbend-notes-staging\.fly\.dev answers 200, \d+m\d\ds after/);
    } finally {
      probe.stop();
    }
  }, 30_000);

  it('on a second deploy makes nothing and leaves AUTH_SECRET alone', async () => {
    const dir = stubDir();
    const probe = health(0);
    try {
      const r = await deploy(['--url', probe.url], dir, {
        FLY_API_TOKEN: FAKE_TOKEN,
        FLY_ORG: 'harborlight',
        STUB_APPS: '[{"Name":"riverbend-notes-staging"}]',
        STUB_VOLUMES: '[{"id":"vol_1"}]',
        STUB_SECRETS: '[{"Name":"AUTH_SECRET"}]',
      });
      expect(r.status).toBe(0);
      const verbs = read(dir, 'fly-args')
        .trim()
        .split('\n')
        .map((c) => c.split(' ').slice(0, 2).join(' '));
      expect(verbs).toEqual(['apps list', 'volumes list', 'secrets list', 'deploy --app']);
      expect(read(dir, 'fly-stdin')).toBe('');
    } finally {
      probe.stop();
    }
  }, 30_000);
});

describe('credentials', () => {
  it('reads an unset token and org from the Keychain entries the repo stores, on a Mac', () => {
    const dir = stubDir();
    process.env.STUB_DIR = dir;
    try {
      const got = credentials({}, 'darwin', join(bin, 'security'));
      expect(got).toEqual({
        token: `value-of-${storedSecretService('fly-org-token')}`,
        org: `value-of-${storedSecretService('fly-org-slug')}`,
      });
      expect(read(dir, 'security-args')).toContain(`-a ${SECRET_ACCOUNT}`);
    } finally {
      process.env.STUB_DIR = '';
    }
  });

  it('takes the environment first, and off a Mac asks for what is missing', () => {
    expect(credentials({ FLY_API_TOKEN: 't', FLY_ORG: 'o' }, 'darwin', '/nonexistent')).toEqual({
      token: 't',
      org: 'o',
    });
    expect(() => credentials({ FLY_ORG: 'o' }, 'linux')).toThrow('set FLY_API_TOKEN');
    // CI: a token and no org is not an error here; the org is resolved from fly.
    expect(credentials({ FLY_API_TOKEN: 't' }, 'linux')).toEqual({ token: 't', org: undefined });
  });

  it('on a Mac with no Keychain entry, says deploys run from the workflow', () => {
    expect(() => credentials({}, 'darwin', join(bin, 'security-empty'))).toThrow(
      /no entry fly-org-token.*app-kit-staging workflow/,
    );
    expect(credentials({ FLY_API_TOKEN: 't' }, 'darwin', join(bin, 'security-empty'))).toEqual({
      token: 't',
      org: undefined,
    });
  });
});

describe('deploy:staging with no org named', () => {
  const run = (orgs: string, dir: string, url: string, extra: string[] = [], env = {}) =>
    deploy(['--url', url, ...extra], dir, {
      FLY_API_TOKEN: FAKE_TOKEN,
      STUB_ORGS: orgs,
      PATH: `${emptyKeychainBin}:${process.env.PATH}`,
      ...env,
    });

  it('deploys into the one org the token reaches, and times from --started-at', async () => {
    const dir = stubDir();
    const probe = health(0);
    const summary = join(dir, 'summary.md');
    try {
      // The timed run began 125s before this command did (new-app, bun install).
      const startedAt = String(Date.now() - 125_000);
      const r = await run(
        '{"harborlight":"Harborlight"}',
        dir,
        probe.url,
        ['--started-at', startedAt],
        {
          GITHUB_STEP_SUMMARY: summary,
        },
      );
      expect(r.status).toBe(0);
      const calls = read(dir, 'fly-args').trim().split('\n');
      expect(calls[0]).toBe('orgs list --json');
      expect(calls).toContain('apps create riverbend-notes-staging --org harborlight');
      expect(r.out).toMatch(/answers 200, 2m\d\ds after the command started/);
      expect(read(dir, 'summary.md')).toMatch(/answers 200, 2m\d\ds after/);
    } finally {
      probe.stop();
    }
  }, 30_000);

  it('refuses when the token reaches several orgs, or none, and makes nothing', async () => {
    for (const orgs of ['{"harborlight":"Harborlight","saltmarsh":"Saltmarsh"}', '{}']) {
      const dir = stubDir();
      const r = await run(orgs, dir, 'http://127.0.0.1:9/health');
      expect(r.status).toBe(1);
      expect(r.out).toContain('set FLY_ORG');
      expect(read(dir, 'fly-args').trim()).toBe('orgs list --json');
    }
  });

  it('refuses a --started-at that is not epoch milliseconds', async () => {
    const r = await deploy(['--dry-run', '--started-at', 'yesterday'], stubDir());
    expect(r.status).toBe(1);
    expect(r.out).toContain('--started-at takes epoch milliseconds');
  });
});
