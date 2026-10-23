/**
 * What another local process cannot do to the keeper's pages: hold the
 * keeper's origin, use an enrollment link it read, replace a stored passkey,
 * spoil the owner's tap, or deny a request without the owner's passkey.
 *
 * Every case here runs against a real listener. An agent can send any
 * header, so these requests carry the page's own `Origin` throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-hardening-'));
/** A build folder outside the keeper's own folders, as the deploy script makes. */
const outside = mkdtempSync(join(tmpdir(), 'keeper-hardening-ctx-'));
writeFileSync(join(outside, 'Dockerfile'), 'FROM scratch\n');
writeFileSync(join(outside, 'server.ts'), '// app\n');
/** A config written only with keys the keeper accepts. */
const FLY_TOML = 'app = "cw-harborlight"\nprimary_region = "sjc"\n';
writeFileSync(join(outside, 'fly.toml'), FLY_TOML);
/** A user id nobody on this machine has, standing in for the keeper's. */
const KEEPER_UID = 4_000_000;
const ran: string[][] = [];
/** Whether each build folder fly was handed existed while it ran. */
const present: boolean[] = [];
/** The config file each deploy's fly would have read, as it read it. */
const configs: string[] = [];
const exec: Executors = {
  fly: async (args) => {
    ran.push(args);
    if (args[0] === 'deploy') {
      present.push(existsSync(join(args[1] ?? '', 'marker')));
      const c = args.indexOf('--config');
      configs.push(c > 0 ? readFileSync(args[c + 1] ?? '', 'utf8') : '');
    }
    return { status: 0, stdout: 'ok\n', stderr: '' };
  },
  cloudflare: async () => ({ status: 200, body: '{"success":true,"result":[]}' }),
};

let store: KeeperStore;
let keeper: RunningKeeper;
let base: string;
const owner = new TestPasskey();

const openStore = (name: string): KeeperStore => {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  return s;
};

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

const hold = async (args: string[]): Promise<string> => {
  const r = await fetch(`${base}/v1/fly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
    body: JSON.stringify({ args }),
  });
  expect(r.status).toBe(202);
  return String(((await r.json()) as { id: string }).id);
};

/** The page token an approval page carries, as its own script reads it. */
const pageTokenOf = async (id: string): Promise<string> => {
  const html = await (await fetch(`${base}/approve/${id}`)).text();
  return /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
};

const challengeFor = async (id: string, pageToken: string) => {
  const r = await post(`/v1/requests/${id}/challenge`, { page: pageToken });
  return { status: r.status, challenge: ((await r.json()) as { challenge?: string }).challenge };
};

const signed = (passkey: TestPasskey, challenge: string) =>
  passkey.assert({ challenge, origin: keeper.origin, rpId: 'localhost' });

/** Open a fresh enrollment link, as `keeper enroll` does. */
const openEnroll = (token: string, createdAt = Date.now()) =>
  store.saveEnroll({ tokenHash: hashToken(token), expiresAt: Date.now() + 60_000, createdAt });

const enrollOptions = async (token: string) => {
  const r = await post('/v1/enroll/options', { token });
  return {
    status: r.status,
    body: (await r.json()) as { challenge?: string; session?: string },
  };
};

beforeAll(async () => {
  store = openStore('store');
  store.addApp('cw-harborlight');
  // The test's files are this process's own, so the keeper here is another user.
  keeper = serveKeeper({ store, exec, port: 0, keeperUid: KEEPER_UID });
  base = `http://127.0.0.1:${keeper.port}`;
  openEnroll('owner-link');
  const o = await enrollOptions('owner-link');
  const reg = owner.register({
    challenge: o.body.challenge ?? '',
    origin: keeper.origin,
    rpId: 'localhost',
  });
  const done = await post('/v1/enroll', { token: 'owner-link', session: o.body.session, ...reg });
  expect(done.status).toBe(200);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('the keeper holds its origin on both loopback addresses', () => {
  it('serves the page on [::1] as well as 127.0.0.1', async () => {
    const r = await fetch(`http://[::1]:${keeper.port}/`, {
      headers: { host: `localhost:${keeper.port}` },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Waiting for your passkey');
  });

  it('while it runs, no other listener can take either address', () => {
    for (const hostname of ['127.0.0.1', '::1']) {
      let squatter: ReturnType<typeof Bun.serve> | undefined;
      try {
        squatter = Bun.serve({ hostname, port: keeper.port, fetch: () => new Response('x') });
      } catch {
        // refused, as it should be
      }
      const took = squatter !== undefined;
      squatter?.stop(true);
      expect({ hostname, took }).toEqual({ hostname, took: false });
    }
  });

  it('refuses to start when another process already listens on [::1] at its port', async () => {
    const squatter = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('impostor') });
    let started: RunningKeeper | undefined;
    let error: unknown;
    try {
      started = serveKeeper({ store: openStore('squatted'), exec, port: squatter.port as number });
    } catch (err) {
      error = err;
    }
    await started?.stop();
    squatter.stop(true);
    expect(started).toBeUndefined();
    expect(String(error)).toContain('::1');
  });
});

describe('enrollment links', () => {
  it('a link made before this keeper started opens nothing', async () => {
    // An impostor that read the link while no keeper ran would otherwise
    // hold it until the real keeper came back up.
    openEnroll('stale-link', Date.now() - 60 * 60_000);
    expect((await enrollOptions('stale-link')).status).toBe(403);
    store.saveEnroll(null);
  });

  it('the first options call spends the link, and only that caller can finish', async () => {
    openEnroll('raced-link');
    const first = await enrollOptions('raced-link');
    expect(first.status).toBe(200);
    // A second caller with the same link (an agent that read it) gets nothing.
    expect((await enrollOptions('raced-link')).status).toBe(403);
    const second = new TestPasskey();
    const reg = second.register({
      challenge: first.body.challenge ?? '',
      origin: keeper.origin,
      rpId: 'localhost',
    });
    // CONTROL: the caller that asked first still finishes.
    const done = await post('/v1/enroll', {
      token: 'raced-link',
      session: first.body.session,
      ...reg,
    });
    expect(done.status).toBe(200);
    expect(store.passkeys().map((p) => p.id)).toContain(second.credentialId);
  });

  it('refuses a credential id that is already stored, and leaves the stored key alone', async () => {
    const before = store.passkeys().find((p) => p.id === owner.credentialId);
    openEnroll('replace-link');
    const o = await enrollOptions('replace-link');
    const reg = owner.register({
      challenge: o.body.challenge ?? '',
      origin: keeper.origin,
      rpId: 'localhost',
    });
    const r = await post('/v1/enroll', { token: 'replace-link', session: o.body.session, ...reg });
    expect(r.status).toBe(409);
    expect(store.passkeys().find((p) => p.id === owner.credentialId)).toEqual(before);
  });
});

describe('the approval page', () => {
  it("another caller asking for a challenge does not spoil the owner's tap", async () => {
    const id = await hold(['apps', 'create', 'cw-saltmarsh']);
    const ownerPage = await pageTokenOf(id);
    const c = await challengeFor(id, ownerPage);
    expect(c.status).toBe(200);
    // An agent loads the same page and asks for a challenge of its own.
    const agentPage = await pageTokenOf(id);
    expect((await challengeFor(id, agentPage)).status).toBe(200);
    const ok = await post(`/v1/requests/${id}/approve`, {
      page: ownerPage,
      ...signed(owner, c.challenge ?? ''),
    });
    expect(ok.status).toBe(200);
    expect(ran).toContainEqual(['apps', 'create', 'cw-saltmarsh']);
  });

  it('gives no challenge without a page token the keeper served', async () => {
    const id = await hold(['apps', 'create', 'cw-riverbend']);
    expect((await challengeFor(id, '')).status).toBe(403);
    expect((await challengeFor(id, 'a-token-nobody-served')).status).toBe(403);
    // CONTROL: a served page's token gets one.
    expect((await challengeFor(id, await pageTokenOf(id))).status).toBe(200);
  });

  it("an agent opening many pages does not push the owner's page out", async () => {
    const id = await hold(['apps', 'create', 'cw-riverbend-two']);
    const ownerPage = await pageTokenOf(id);
    for (let i = 0; i < 8; i++) await pageTokenOf(id);
    // Past the cap a page is served with no token and no buttons.
    expect(await pageTokenOf(id)).toBe('');
    const c = await challengeFor(id, ownerPage);
    expect(c.status).toBe(200);
    const ok = await post(`/v1/requests/${id}/approve`, {
      page: ownerPage,
      ...signed(owner, c.challenge ?? ''),
    });
    expect(ok.status).toBe(200);
  });

  it('denies a request only with the passkey', async () => {
    const id = await hold(['apps', 'create', 'cw-harborlight-two']);
    const pageToken = await pageTokenOf(id);
    const bare = await post(`/v1/requests/${id}/deny`, { page: pageToken });
    expect(bare.status).toBe(403);
    expect(keeper.requests.get(id)?.status).toBe('pending');
    // CONTROL: the owner's passkey denies it.
    const c = await challengeFor(id, pageToken);
    const r = await post(`/v1/requests/${id}/deny`, {
      page: pageToken,
      ...signed(owner, c.challenge ?? ''),
    });
    expect(r.status).toBe(200);
    expect(keeper.requests.get(id)?.status).toBe('denied');
  });
});

describe('paths a fly call names', () => {
  const submit = async (args: string[]) => {
    const r = await fetch(`${base}/v1/fly`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
      body: JSON.stringify({ args }),
    });
    return { status: r.status, body: (await r.json()) as { id?: string; error?: string } };
  };
  const deploy = (ctx: string, more: string[] = []) => [
    'deploy',
    ctx,
    '--app',
    'cw-harborlight',
    '--remote-only',
    ...(more.some((m) => m.startsWith('--config')) ? [] : ['--config', join(ctx, 'fly.toml')]),
    ...more,
  ];

  it("refuses a deploy that would read the keeper's store, even before any tap", async () => {
    const before = ran.length;
    const linked = join(tmp, 'looks-harmless');
    symlinkSync(store.dir, linked);
    for (const args of [
      deploy(store.dir),
      deploy(join(store.dir, '..')),
      deploy(linked),
      deploy(outside, ['--dockerfile', join(store.dir, 'credentials.json')]),
      deploy(outside, [`--config=${join(linked, 'apps.json')}`]),
      deploy('relative/ctx'),
    ]) {
      const r = await submit(args);
      expect({ args, status: r.status }).toEqual({ args, status: 403 });
    }
    expect(ran.length).toBe(before);
  });

  it('checks the paths again when the owner approves, and runs fly on a copy', async () => {
    const swapped = mkdtempSync(join(tmpdir(), 'keeper-hardening-swap-'));
    const kept = mkdtempSync(join(tmpdir(), 'keeper-hardening-kept-'));
    writeFileSync(join(kept, 'marker'), 'x');
    writeFileSync(join(kept, 'fly.toml'), FLY_TOML);
    writeFileSync(join(swapped, 'fly.toml'), FLY_TOML);
    try {
      const approveNow = async (args: string[]) => {
        const r = await submit(args);
        expect(r.status).toBe(202);
        const id = r.body.id ?? '';
        return { id, page: await pageTokenOf(id) };
      };
      const tapped = async ({ id, page }: { id: string; page: string }) => {
        const c = await challengeFor(id, page);
        await post(`/v1/requests/${id}/approve`, { page, ...signed(owner, c.challenge ?? '') });
        return keeper.requests.get(id);
      };
      // The folder is clean when the agent asks, then becomes a link to the store.
      const a = await approveNow(deploy(swapped));
      rmSync(swapped, { recursive: true });
      symlinkSync(store.dir, swapped);
      const before = ran.length;
      expect((await tapped(a))?.error).toContain("reaches the keeper's own folders");
      expect(ran.length).toBe(before);
      // CONTROL: an unchanged folder runs, from a copy the keeper made and removed.
      expect((await tapped(await approveNow(deploy(kept))))?.error).toBeUndefined();
      const copy = ran.at(-1)?.[1] ?? '';
      expect(copy).not.toBe(realpathSync(kept));
      expect(basename(copy)).toBe(basename(kept));
      expect(present.at(-1)).toBe(true);
      expect(existsSync(copy)).toBe(false);
    } finally {
      rmSync(swapped, { force: true });
      rmSync(kept, { recursive: true, force: true });
    }
  });

  it('refuses a config that names a local path, in --config or in the build folder', async () => {
    const before = ran.length;
    const creds = join(store.dir, 'credentials.json');
    const bad = mkdtempSync(join(tmpdir(), 'keeper-hardening-badcfg-'));
    const inFolder = mkdtempSync(join(tmpdir(), 'keeper-hardening-rootcfg-'));
    try {
      writeFileSync(
        join(bad, 'fly.toml'),
        `${FLY_TOML}[[files]]\nguest_path = "/x"\nlocal_path = ${JSON.stringify(creds)}\n`,
      );
      writeFileSync(join(inFolder, 'fly.toml'), `[build]\ndockerfile = ${JSON.stringify(creds)}\n`);
      writeFileSync(join(inFolder, 'clean.toml'), FLY_TOML);
      for (const args of [
        deploy(bad),
        deploy(inFolder, ['--config', join(inFolder, 'clean.toml')]),
      ]) {
        const r = await submit(args);
        expect({ args, status: r.status }).toEqual({ args, status: 403 });
      }
      expect(ran.length).toBe(before);
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(inFolder, { recursive: true, force: true });
    }
  });

  it('a config changed after the tap reaches fly only through the allowlist', async () => {
    const ctx = mkdtempSync(join(tmpdir(), 'keeper-hardening-latecfg-'));
    try {
      writeFileSync(join(ctx, 'fly.toml'), FLY_TOML);
      const r = await submit(deploy(ctx));
      expect(r.status).toBe(202);
      const id = r.body.id ?? '';
      const page = await pageTokenOf(id);
      // After the owner saw it, the agent adds a path key.
      writeFileSync(join(ctx, 'fly.toml'), `${FLY_TOML}[build]\ndockerfile = "/etc/hosts"\n`);
      const c = await challengeFor(id, page);
      await post(`/v1/requests/${id}/approve`, { page, ...signed(owner, c.challenge ?? '') });
      expect(keeper.requests.get(id)?.error).toContain('not one the keeper accepts');
      // CONTROL: unchanged, fly reads the config rewritten from its keys.
      writeFileSync(join(ctx, 'fly.toml'), `# note\n${FLY_TOML}`);
      const ok = await submit(deploy(ctx));
      const okPage = await pageTokenOf(ok.body.id ?? '');
      const c2 = await challengeFor(ok.body.id ?? '', okPage);
      await post(`/v1/requests/${ok.body.id}/approve`, {
        page: okPage,
        ...signed(owner, c2.challenge ?? ''),
      });
      expect(keeper.requests.get(ok.body.id ?? '')?.error).toBeUndefined();
      expect(configs.at(-1)).toBe('app = "cw-harborlight"\nprimary_region = "sjc"\n');
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
  });

  it('holds a deploy from a clean folder, and the page shows the folder and what is in it', async () => {
    // CONTROL: the same deploy from a folder outside the keeper is held, not refused.
    const r = await submit(deploy(outside, ['--dockerfile', join(outside, 'Dockerfile')]));
    expect(r.status).toBe(202);
    const html = await (await fetch(`${base}/approve/${r.body.id}`)).text();
    expect(html).toContain(realpathSync(outside));
    expect(html).toContain('Dockerfile');
    expect(html).toContain('server.ts');
    // And what its config says.
    expect(html).toContain('primary_region = &#34;sjc&#34;');
  });
});

describe("a service worker on the keeper's origin", () => {
  const get = (path: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${keeper.port}`, ...headers } });
  const clear = () => store.saveAlarm(null);

  it("every response tells the browser to drop the origin's workers and cache, and to cache nothing", async () => {
    for (const r of [
      await get('/', {}),
      await get('/nowhere', {}),
      await post('/v1/enroll/options', { token: 'x' }),
    ]) {
      expect(r.headers.get('clear-site-data')).toBe('"cache", "storage"');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers a worker update check with a worker that removes itself, and stops approvals', async () => {
    const id = await hold(['apps', 'create', 'cw-saltmarsh-sw']);
    const pageToken = await pageTokenOf(id);
    const r = await get('/sw.js', {
      'service-worker': 'script',
      'sec-fetch-dest': 'serviceworker',
    });
    expect(r.headers.get('content-type')).toBe('text/javascript');
    expect(await r.text()).toContain('self.registration.unregister()');
    expect(store.alarm()?.reason).toContain('service worker script at /sw.js');
    // Stopped: no challenge, no enrollment, and the page explains why.
    expect((await challengeFor(id, pageToken)).status).toBe(423);
    openEnroll('link-during-alarm');
    expect((await enrollOptions('link-during-alarm')).status).toBe(423);
    expect(await (await fetch(`${base}/approve/${id}`)).text()).toContain('Approvals are stopped');
    // CONTROL: once the owner clears it, the same page token gets a challenge.
    clear();
    expect((await challengeFor(id, pageToken)).status).toBe(200);
  });

  it("raises the alarm on a navigation a worker passed on, not on the browser's own", async () => {
    await get('/approve/x', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    expect(store.alarm()).toBeNull();
    await get('/approve/x', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' });
    expect(store.alarm()?.reason).toContain('passed on a navigation');
    clear();
  });

  it("serves enrollment only under a link's own path, which nothing can have cached", async () => {
    expect((await get('/enroll', {})).status).toBe(404);
    const r = await get('/enroll/aHarborlightLink123', {});
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Register your passkey');
  });
});
