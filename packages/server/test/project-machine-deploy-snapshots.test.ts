/**
 * `machine:deploy` end to end on a bucket that is not yet a Tigris snapshot
 * bucket (security review L5): the dry run names both steps and changes
 * nothing, the real run converts the bucket and a second run leaves it alone,
 * and a refused conversion stops the run with Tigris's error code before any
 * later step.
 *
 * `fly` and `security` on PATH are scripts that answer from a temp folder
 * and record every call; the bucket is a loopback server that keeps its
 * type and lifecycle rule between requests. Nothing reaches Fly, Tigris or
 * the Keychain.
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
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { projectConfig, requiredSecrets } from '../../../infra/project-machine/deploy-plan.ts';
import { deployProject } from '../../../infra/project-machine/deploy.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const HEAD = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const cfg = projectConfig({ project: 'saltmarsh', imageLabel: HEAD });
const outputs = (): TfOutputs => ({ access: {}, accessTeamDomain: '', tunnels: {} });

const tmp = mkdtempSync(join(tmpdir(), 'pm-deploy-snapshots-'));
const bin = join(tmp, 'bin');
const kc = join(tmp, 'keychain');
const state = join(tmp, 'fly');
const flyCalls = join(tmp, 'fly-calls');

/** The stand-in bucket. */
const bucket = {
  type: 0,
  rule: true,
  refuse: null as string | null,
  writes: [] as string[],
};
let server: ReturnType<typeof Bun.serve>;
const savedPath = process.env.PATH;
const savedKeeper = process.env.CW_KEEPER_URL;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/${cfg.bucket}`) return new Response('', { status: 404 });
      if (req.method !== 'GET') bucket.writes.push(`${req.method} ${url.search}`);
      if (url.searchParams.has('metadata')) return Response.json({ type: bucket.type });
      if (url.searchParams.has('lifecycle')) {
        if (req.method === 'DELETE') {
          bucket.rule = false;
          return new Response('', { status: 204 });
        }
        return bucket.rule
          ? new Response(
              '<LifecycleConfiguration><Rule><ID>expire-snapshots</ID></Rule></LifecycleConfiguration>',
            )
          : new Response('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>', {
              status: 404,
            });
      }
      if (req.method === 'PATCH') {
        if (bucket.refuse)
          return new Response(`<Error><Code>${bucket.refuse}</Code></Error>`, { status: 403 });
        if (bucket.rule)
          return Response.json({ status: 'error', message: 'lifecycle rules' }, { status: 400 });
        bucket.type = (JSON.parse(await req.text()) as { type: number }).type;
        return Response.json({ status: 'success' });
      }
      return new Response('', { status: 400 });
    },
  });
  mkdirSync(bin);
  mkdirSync(kc);
  mkdirSync(state);
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
  "secrets import") cat > /dev/null ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'security'), 0o755);
  chmodSync(join(bin, 'fly'), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  Reflect.deleteProperty(process.env, 'CW_KEEPER_URL');
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedKeeper !== undefined) process.env.CW_KEEPER_URL = savedKeeper;
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const keychain = (name: string, value: string) => writeFileSync(join(kc, name), value);
const flyCallLines = () =>
  existsSync(flyCalls) ? readFileSync(flyCalls, 'utf8').split('\n').filter(Boolean) : [];
let output: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  Object.assign(bucket, { type: 0, rule: true, refuse: null, writes: [] });
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
  writeFileSync(
    join(state, 'secrets.json'),
    JSON.stringify(requiredSecrets('quick').map((Name) => ({ Name }))),
  );
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
  rmSync(flyCalls, { force: true });
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

const run = (dryRun: boolean) => deployProject(cfg, dryRun, { outputs });

describe('machine:deploy makes the backup bucket a snapshot bucket', () => {
  it('names both steps in a dry run and changes nothing', async () => {
    const actions = await run(true);
    expect(actions.map((a) => a.kind)).toEqual(['remove-lifecycle', 'enable-snapshots']);
    expect(output.join('\n')).toContain(`[deploy] ${cfg.app}: remove-lifecycle, enable-snapshots`);
    expect(bucket.writes).toEqual([]);
  });

  it('converts the bucket, and a second run reads it back and leaves it alone', async () => {
    await run(false);
    expect(bucket.writes).toEqual(['DELETE ?lifecycle=', 'PATCH ']);
    expect(bucket.type).toBe(1);
    bucket.writes = [];
    expect(await run(false)).toEqual([]);
    expect(bucket.writes).toEqual([]);
  });

  it('stops at a refused conversion with its error code, before any later step', async () => {
    bucket.refuse = 'AccessDenied';
    // A missing secret puts a set-secrets step after the conversion.
    writeFileSync(join(state, 'secrets.json'), JSON.stringify([]));
    const planned = (await run(true)).map((a) => a.kind);
    expect(planned.indexOf('set-secrets')).toBeGreaterThan(planned.indexOf('enable-snapshots'));
    await expect(run(false)).rejects.toThrow('HTTP 403: AccessDenied');
    expect(bucket.type).toBe(0);
    expect(flyCallLines().some((l) => l.startsWith('secrets import'))).toBe(false);
  });
});
