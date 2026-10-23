/**
 * A deploy approved on a keeper whose uid is this process's own, with the
 * build folder made by another user, as in production: the keeper is
 * `cw-relay` and the agent is Bryan. Every other keeper test gives the keeper
 * a uid nobody has, because there the test's files and the keeper's copies
 * share one owner; that hid a keeper refusing its own staged copy, so every
 * real deploy with a config failed at approval.
 *
 * Writing files as another user takes `sudo`, which only CI may use without a
 * password, so this runs only where `CW_KEEPER_SUDO_TESTS=1` (ci.yml's server
 * step), like `keeper-store-other-user.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const ENABLED = process.env.CW_KEEPER_SUDO_TESTS === '1';
if (!ENABLED)
  console.error('[keeper] other-user deploy test skipped: CW_KEEPER_SUDO_TESTS is not 1');

const asNobody = (script: string) =>
  spawnSync('sudo', ['-n', '-u', 'nobody', 'sh', '-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });

describe.skipIf(!ENABLED)('a deploy on a keeper that is this process', () => {
  const tmp = ENABLED ? mkdtempSync(join(tmpdir(), 'keeper-other-deploy-')) : '';
  let ctx = '';
  const configs: string[] = [];
  const exec: Executors = {
    fly: async (args) => {
      const c = args.indexOf('--config');
      configs.push(readFileSync(args[c + 1] ?? '', 'utf8'));
      return { status: 0, stdout: 'ok\n', stderr: '' };
    },
    cloudflare: async () => ({ status: 200, body: '{}' }),
  };
  const owner = new TestPasskey();
  let keeper: RunningKeeper;
  let base = '';
  const post = (path: string, body: unknown, agent = false) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(agent ? { 'x-cw-keeper': '1' } : { origin: keeper.origin }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    // The agent's folder, made and owned by `nobody`, readable by the keeper.
    const made = asNobody(
      'umask 022; d=$(mktemp -d /tmp/keeper-agent-XXXXXX) && chmod 755 "$d" && ' +
        `printf '# the agent wrote this\\napp = "cw-harborlight"\\nprimary_region = "sjc"\\n' > "$d/fly.toml" && ` +
        `printf 'FROM scratch\\n' > "$d/Dockerfile" && echo "$d"`,
    );
    expect(made.status, made.stderr).toBe(0);
    ctx = made.stdout.trim();
    const dir = join(tmp, 'store');
    mkdirSync(dir, { mode: 0o700 });
    const store = openKeeperStore(dir);
    if ('error' in store) throw new Error(store.error);
    keeper = serveKeeper({ store, exec, port: 0, keeperUid: process.getuid?.() ?? -1 });
    base = `http://127.0.0.1:${keeper.port}`;
    store.saveEnroll({
      tokenHash: hashToken('link'),
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const o = (await (await post('/v1/enroll/options', { token: 'link' })).json()) as {
      challenge: string;
      session: string;
    };
    const reg = owner.register({
      challenge: o.challenge,
      origin: keeper.origin,
      rpId: 'localhost',
    });
    expect((await post('/v1/enroll', { token: 'link', session: o.session, ...reg })).status).toBe(
      200,
    );
  });

  afterAll(async () => {
    await keeper?.stop();
    if (ctx) asNobody(`rm -r '${ctx}'`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs fly on the cleaned config once the owner approves', async () => {
    const args = [
      'deploy',
      ctx,
      '--app',
      'cw-harborlight',
      '--config',
      join(ctx, 'fly.toml'),
      '--yes',
    ];
    const r = await post('/v1/fly', { args }, true);
    expect(r.status).toBe(202);
    const id = String(((await r.json()) as { id: string }).id);
    const html = await (await fetch(`${base}/approve/${id}`)).text();
    const page = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
    const c = (await (await post(`/v1/requests/${id}/challenge`, { page })).json()) as {
      challenge: string;
    };
    const a = await post(`/v1/requests/${id}/approve`, {
      page,
      ...owner.assert({ challenge: c.challenge, origin: keeper.origin, rpId: 'localhost' }),
    });
    expect(a.status).toBe(200);
    expect(keeper.requests.get(id)?.error).toBeUndefined();
    expect(configs).toEqual(['app = "cw-harborlight"\nprimary_region = "sjc"\n']);
    // CONTROL: the agent's folder was nobody's, so this keeper could copy it.
    expect(existsSync(join(ctx, 'fly.toml'))).toBe(true);
  });
});
