/**
 * `bun run access:apply` (infra/access-apps/apply.ts) against a fake
 * Cloudflare served on a loopback port: a dry run writes nothing, a real run
 * creates or updates each project's application by name, a second run
 * writes nothing, every refusal fires before any write, and no token text
 * reaches stdout or stderr. No request leaves the machine.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../infra/access-apps/apply.ts';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cfat-Q7v9Zx2mK4pR8wL3nB6yT1';
const RIVER = 'riverbend-workspaces.example.test';
const HARBOR = 'harborlight-workspaces.example.test';
const SIGN_IN = 'workspaces.example.test';
const REPO = join(import.meta.dir, '..', '..', '..');

interface FakeApp {
  id: string;
  name: string;
  type: string;
  aud: string;
  domain?: string;
  self_hosted_domains?: string[];
  session_duration?: string;
  app_launcher_visible?: boolean;
  http_only_cookie_attribute?: boolean;
  same_site_cookie_attribute?: string;
  policies?: Array<{ id: string; name: string; decision: string; include: unknown[] }>;
}

/** A Cloudflare that answers the Access calls the script makes, and records each. */
function fakeCloudflare(seed: { apps?: FakeApp[]; tokens?: Array<{ id: string; name: string }> }) {
  const apps = new Map<string, FakeApp>((seed.apps ?? []).map((a) => [a.id, structuredClone(a)]));
  const tokens = seed.tokens ?? [
    { id: 'st-feed', name: 'home feed riverbend' },
    { id: 'st-relay', name: 'relay riverbend' },
  ];
  const requests: Array<{ method: string; path: string }> = [];
  let n = 0;
  const ok = (result: unknown) =>
    Response.json({ success: true, errors: [], result, result_info: { total_pages: 1 } });
  const withPolicyIds = (body: FakeApp): FakeApp['policies'] =>
    (body.policies ?? []).map((p) => ({ ...p, id: p.id ?? `pol-${++n}` }));
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname });
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json(
          { success: false, errors: [{ code: 10000, message: 'auth' }] },
          { status: 403 },
        );
      }
      const base = `/client/v4/accounts/${ACCOUNT}/access`;
      if (req.method === 'GET' && url.pathname === `${base}/service_tokens`) return ok(tokens);
      if (req.method === 'GET' && url.pathname === `${base}/apps`) return ok([...apps.values()]);
      if (req.method === 'POST' && url.pathname === `${base}/apps`) {
        const body = (await req.json()) as FakeApp;
        const id = `app-${++n}`;
        const app = { ...body, id, aud: `aud-${id}`, policies: withPolicyIds(body) };
        apps.set(id, app);
        return ok(app);
      }
      const one = url.pathname.match(new RegExp(`^${base}/apps/([^/]+)$`));
      const existing = one ? apps.get(one[1] as string) : undefined;
      if (existing && req.method === 'GET') return ok(existing);
      if (existing && req.method === 'PUT') {
        const body = (await req.json()) as FakeApp;
        const app = { ...body, id: existing.id, aud: existing.aud, policies: withPolicyIds(body) };
        apps.set(existing.id, app);
        return ok(app);
      }
      return Response.json(
        { success: false, errors: [{ code: 7003, message: 'no route' }] },
        { status: 404 },
      );
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}/client/v4`,
    apps,
    requests,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    stop: () => server.stop(true),
  };
}

const PROD_APP: FakeApp = {
  id: 'app-prod',
  name: 'Harborlight sign-in',
  type: 'self_hosted',
  aud: 'aud-prod',
  domain: SIGN_IN,
  self_hosted_domains: [SIGN_IN],
};

const CONFIG = {
  sessionDuration: '24h',
  projects: {
    riverbend: {
      hosts: [RIVER],
      emailDomains: ['riverbend.test'],
      serviceTokens: ['home feed riverbend', 'relay riverbend'],
    },
    harborlight: { hosts: [HARBOR], emails: ['alice@harborlight.test'] },
  },
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(seed: Parameters<typeof fakeCloudflare>[0], config: unknown = CONFIG) {
  const cf = fakeCloudflare(seed);
  const dir = mkdtempSync(join(tmpdir(), 'access-apply-'));
  const path = join(dir, 'access.local.json');
  writeFileSync(path, JSON.stringify(config));
  cleanups.push(cf.stop, () => rmSync(dir, { recursive: true, force: true }));
  const env = {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CW_CLOUDFLARE_API_BASE: cf.base,
  };
  const go = async (...flags: string[]) => {
    let out = '';
    let err = '';
    const code = await run({
      argv: [...flags, path],
      env,
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    });
    return { code, out, err };
  };
  return { cf, path, env, go };
}

describe('access:apply', () => {
  it('is a dry run by default: every GET, no write, and the plan printed', async () => {
    const { cf, go } = setup({ apps: [PROD_APP] });
    const r = await go();
    expect(r.code).toBe(0);
    expect(cf.writes()).toEqual([]);
    expect(cf.requests.length).toBeGreaterThan(0);
    expect(r.out).toContain('board riverbend: create');
    expect(r.out).toContain('board harborlight: create');
    expect(r.out).toMatch(/dry run/);
  });

  it('creates each application with its service tokens resolved, and prints each server its audiences', async () => {
    const { cf, go } = setup({ apps: [PROD_APP] });
    const r = await go('--apply');
    expect(r.code).toBe(0);
    expect(cf.writes().map((w) => w.method)).toEqual(['POST', 'POST']);
    const river = [...cf.apps.values()].find((a) => a.name === 'board riverbend');
    expect(river?.self_hosted_domains).toEqual([RIVER]);
    expect(river?.policies?.find((p) => p.decision === 'non_identity')?.include).toEqual([
      { service_token: { token_id: 'st-feed' } },
      { service_token: { token_id: 'st-relay' } },
    ]);
    const line = r.out.split('\n').find((l) => l.startsWith('riverbend: CF_ACCESS_HOST_AUDS='));
    const json = line?.slice('riverbend: CF_ACCESS_HOST_AUDS='.length).replace(/^'|'$/g, '');
    expect(JSON.parse(json ?? 'null')).toEqual({ [RIVER]: river?.aud });
    expect(r.out).toContain(`riverbend: CF_ACCESS_AUD=${river?.aud}`);
    expect(cf.apps.get('app-prod')).toEqual(PROD_APP);
  });

  it('updates the application with the same name rather than creating a second', async () => {
    const old: FakeApp = {
      id: 'app-old',
      name: 'board riverbend',
      type: 'self_hosted',
      aud: 'aud-old',
      domain: RIVER,
      self_hosted_domains: [RIVER],
      session_duration: '1h',
      policies: [{ id: 'pol-keep', name: 'riverbend people', decision: 'allow', include: [] }],
    };
    const { cf, go } = setup({ apps: [PROD_APP, old] });
    const r = await go('--apply');
    expect(r.code).toBe(0);
    expect(cf.writes()).toContainEqual({
      method: 'PUT',
      path: `/client/v4/accounts/${ACCOUNT}/access/apps/app-old`,
    });
    expect([...cf.apps.values()].filter((a) => a.name === 'board riverbend')).toHaveLength(1);
    const updated = cf.apps.get('app-old');
    expect(updated?.session_duration).toBe('24h');
    expect(updated?.policies?.find((p) => p.name === 'riverbend people')?.id).toBe('pol-keep');
    expect(r.out).toContain('riverbend: CF_ACCESS_AUD=aud-old');
  });

  it('makes no write on a second apply with no config change, and says so', async () => {
    const { cf, go } = setup({ apps: [PROD_APP] });
    expect((await go('--apply')).code).toBe(0);
    const before = cf.writes().length;
    const r = await go('--apply');
    expect(r.code).toBe(0);
    expect(cf.writes().length).toBe(before);
    expect(r.out).toContain('board riverbend: unchanged');
    expect(r.out).toMatch(/no write/);
    expect(r.out).toContain('riverbend: CF_ACCESS_HOST_AUDS=');
  });

  describe('refuses before any write', () => {
    const refused = async (seed: Parameters<typeof fakeCloudflare>[0], pattern: RegExp) => {
      const { cf, go } = setup(seed);
      const r = await go('--apply');
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(pattern);
      expect(cf.writes()).toEqual([]);
      return cf;
    };

    it('a project host an application the config does not own already covers', async () => {
      const prod = { ...PROD_APP, domain: RIVER, self_hosted_domains: [RIVER] };
      const cf = await refused(
        { apps: [prod] },
        /riverbend-workspaces\.example\.test.*Harborlight sign-in/,
      );
      expect(cf.apps.get('app-prod')).toEqual(prod);
    });

    it('a project host under a hostname another application covers', async () => {
      const apex = {
        ...PROD_APP,
        domain: '*.example.test',
        self_hosted_domains: ['*.example.test'],
      };
      await refused({ apps: [apex] }, /under .*Harborlight sign-in/);
      const bare = { ...PROD_APP, domain: 'example.test/sign-in', self_hosted_domains: undefined };
      await refused({ apps: [bare] }, /under .*Harborlight sign-in/);
    });

    it('a service token name that does not resolve', async () => {
      await refused(
        { apps: [PROD_APP], tokens: [{ id: 'st-feed', name: 'home feed riverbend' }] },
        /no service token is named "relay riverbend"/,
      );
    });

    it('an application the config owns by name that is not self_hosted', async () => {
      const odd: FakeApp = { id: 'app-odd', name: 'board riverbend', type: 'saas', aud: 'aud-odd' };
      await refused({ apps: [PROD_APP, odd] }, /board riverbend.*saas/);
    });

    it('two applications with the one name the config owns', async () => {
      const twin = (id: string): FakeApp => ({
        id,
        name: 'board riverbend',
        type: 'self_hosted',
        aud: `aud-${id}`,
        domain: RIVER,
        self_hosted_domains: [RIVER],
      });
      await refused({ apps: [PROD_APP, twin('app-1'), twin('app-2')] }, /2 applications named/);
    });
  });

  it('refuses a run with no token, or both --apply and --dry-run', async () => {
    const { cf, path, go } = setup({ apps: [PROD_APP] });
    let err = '';
    const code = await run({
      argv: ['--apply', path],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CW_CLOUDFLARE_API_BASE: cf.base },
      out: () => {},
      err: (s) => {
        err += s;
      },
    });
    expect(code).not.toBe(0);
    expect(err).toContain('CLOUDFLARE_API_TOKEN');
    expect((await go('--apply', '--dry-run')).code).not.toBe(0);
    expect(cf.requests).toEqual([]);
  });

  it('refuses an API base that is not a loopback address', async () => {
    const { env, path } = setup({ apps: [PROD_APP] });
    let err = '';
    const code = await run({
      argv: [path],
      env: { ...env, CW_CLOUDFLARE_API_BASE: 'https://api.example.test/client/v4' },
      out: () => {},
      err: (s) => {
        err += s;
      },
    });
    expect(code).not.toBe(0);
    expect(err).toMatch(/loopback/);
  });

  it('prints no part of the token on stdout or stderr, run as the CLI', async () => {
    const { env, path } = setup({ apps: [PROD_APP] });
    const refuse = setup({ apps: [{ ...PROD_APP, domain: RIVER, self_hosted_domains: [RIVER] }] });
    const runs = [
      [env, ['--apply', path]],
      [env, ['--apply', path]],
      [refuse.env, ['--apply', refuse.path]],
      [{ ...env, CLOUDFLARE_ACCOUNT_ID: 'not-an-account' }, [path]],
    ] as const;
    for (const [e, args] of runs) {
      const p = Bun.spawn(['bun', 'run', 'infra/access-apps/apply.ts', ...args], {
        cwd: REPO,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...e },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      await p.exited;
      expect(text.length).toBeGreaterThan(0);
      for (let i = 0; i + 6 <= TOKEN.length; i++) expect(text).not.toContain(TOKEN.slice(i, i + 6));
    }
  }, 60_000);
});
