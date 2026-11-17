/**
 * The sign-in test app's deploy (infra/signin-test/deploy.ts) and its Resend
 * calls (resend.ts): the order of the steps, where each value goes, what is
 * made once, and that the smoke key never outlives the smoke. A fake Resend,
 * Cloudflare, terraform and wrangler; nothing leaves the process. What the
 * Terraform root makes is `infra/cloudflare/apps/signin-test/tests/`; the
 * smoke and the Worker run against a local D1 in `infra/signin-test/test/`.
 */
import { describe, expect, it } from 'bun:test';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';
import { APP, type DeployIo, deploy, wranglerConfig } from '../../../infra/signin-test/deploy.ts';
import {
  type ResendApi,
  type ResendDomain,
  ensureDomain,
  mailRecordsFor,
  resendApi,
  verifyDomain,
} from '../../../infra/signin-test/resend.ts';

const ACCOUNT = 'a'.repeat(32);
const VALUES = {
  CLOUDFLARE_API_TOKEN: 'fixture-cf-Riverbend',
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  AWS_ACCESS_KEY_ID: 'fixture-r2-id-Harborlight',
  AWS_SECRET_ACCESS_KEY: 'fixture-r2-secret-Saltmarsh',
  RESEND_API_KEY: 'fixture-resend-full-Alice',
  SIGNIN_TEST_GOOGLE_CLIENT_ID: 'fixture-google-id-Bob',
  SIGNIN_TEST_GOOGLE_CLIENT_SECRET: 'fixture-google-secret-Riverbend',
};
const TURNSTILE_SECRET = 'fixture-turnstile-secret-Harborlight';
const SEND_TOKEN = 're_fixture_send_Saltmarsh';

const RECORDS = [
  { record: 'DKIM', name: 'resend._domainkey.mail', type: 'TXT', value: 'p=fixture' },
  {
    record: 'SPF',
    name: 'send.mail',
    type: 'MX',
    value: 'feedback-smtp.example.test',
    priority: 10,
  },
  { record: 'SPF', name: 'send.mail', type: 'TXT', value: 'v=spf1 include:example.test ~all' },
];

interface World {
  domainExists: boolean;
  status: string[];
  keys: { id: string; name: string }[];
  secrets: string[];
  calls: string[];
  cfBodies: Record<string, unknown>[];
}

function fakeResend(w: World): ResendApi {
  return (async (method: string, path: string, body?: unknown) => {
    w.calls.push(`resend ${method} ${path}`);
    const domain = {
      id: 'd-1',
      name: APP.mailDomain,
      status: w.status[0] ?? 'verified',
      records: RECORDS,
    };
    if (method === 'GET' && path === '/domains') {
      return { data: w.domainExists ? [{ id: 'd-1', name: APP.mailDomain }] : [] };
    }
    if (method === 'POST' && path === '/domains') return { ...domain, status: 'not_started' };
    if (method === 'GET' && path === '/domains/d-1') {
      const s = w.status.length > 1 ? (w.status.shift() as string) : (w.status[0] ?? 'verified');
      return { ...domain, status: s };
    }
    if (method === 'POST' && path === '/domains/d-1/verify') return {};
    if (method === 'POST' && path === '/api-keys') {
      expect(body).toEqual({ name: APP.name, permission: 'sending_access', domain_id: 'd-1' });
      w.keys.push({ id: 'k-new', name: APP.name });
      return { id: 'k-new', token: SEND_TOKEN };
    }
    if (method === 'GET' && path === '/api-keys') return { data: w.keys };
    if (method === 'DELETE' && path.startsWith('/api-keys/')) return {};
    throw new Error(`unexpected Resend ${method} ${path}`);
  }) as ResendApi;
}

function fakeCf(w: World): CloudflareApi {
  const api = (async (method: string, path: string, body?: unknown) => {
    const secrets = `/accounts/${ACCOUNT}/workers/scripts/${APP.name}/secrets`;
    if (method === 'GET' && path === secrets) return w.secrets.map((name) => ({ name }));
    if (method === 'PUT' && path === secrets) {
      const b = body as { name: string };
      w.calls.push(`cf PUT ${b.name}`);
      w.cfBodies.push(body as Record<string, unknown>);
      return {};
    }
    if (method === 'DELETE' && path.startsWith(`${secrets}/`)) {
      w.calls.push(`cf DELETE ${path.slice(secrets.length + 1)}`);
      return {};
    }
    throw new Error(`unexpected Cloudflare ${method} ${path}`);
  }) as CloudflareApi;
  api.all = (async () => []) as CloudflareApi['all'];
  return api;
}

const OUTPUT = JSON.stringify({
  script_name: { value: APP.name },
  d1_database_id: { value: '11111111-2222-3333-4444-555555555555' },
  turnstile_sitekey: { value: '0x4AAAAAAAfixture' },
  turnstile_secret: { value: TURNSTILE_SECRET, sensitive: true },
});

function run(
  over: Partial<World> = {},
  opts: {
    env?: Record<string, string | undefined>;
    smoke?: DeployIo['smoke'];
    wranglerFails?: string;
  } = {},
) {
  const w: World = {
    domainExists: true,
    status: ['verified'],
    keys: [
      { id: 'k-old', name: APP.name },
      { id: 'k-other', name: 'another-app' },
    ],
    secrets: [],
    calls: [],
    cfBodies: [],
    ...over,
  };
  const tfEnvs: Record<string, string>[] = [];
  const wranglerEnvs: Record<string, string>[] = [];
  const files: Record<string, string> = {};
  let printed = '';
  let n = 0;
  const io: DeployIo = {
    env: { ...VALUES, ...opts.env },
    resend: fakeResend(w),
    cf: fakeCf(w),
    terraform: (args, env) => {
      w.calls.push(`terraform ${args.join(' ')}`);
      tfEnvs.push(env);
      if (args[0] === 'show')
        return { status: 0, stdout: JSON.stringify({ resource_changes: [] }) };
      if (args[0] === 'output') return { status: 0, stdout: OUTPUT };
      return { status: 0, stdout: `terraform said ${TURNSTILE_SECRET}` };
    },
    wrangler: (args, env) => {
      w.calls.push(`wrangler ${args.slice(0, 2).join(' ')}`);
      wranglerEnvs.push(env);
      return args[0] === opts.wranglerFails ? 1 : 0;
    },
    writePrivate: (name, content) => {
      files[name] = content;
      return `/private/run/${name}`;
    },
    smoke:
      opts.smoke ??
      (async () => {
        w.calls.push('smoke');
        return { ok: true, lines: ['ok health'] };
      }),
    randomKey: () => `fixture-random-${++n}-Alice`,
    sleep: async () => {},
    verifyTimeoutMs: 30_000,
    out: (s) => {
      printed += s;
    },
  };
  return { io, w, tfEnvs, wranglerEnvs, files, printed: () => printed };
}

const secretValues = [...Object.values(VALUES), TURNSTILE_SECRET, SEND_TOKEN];

describe('signin-test deploy', () => {
  it('changes nothing without its credentials, and names what is missing', async () => {
    const r = run({}, { env: { RESEND_API_KEY: undefined } });
    expect(await deploy(r.io)).toBe(1);
    expect(r.w.calls).toEqual([]);
    expect(r.printed()).toContain('RESEND_API_KEY not set; nothing was changed');
  });

  it('runs every step in order on a first deploy, and prints no value', async () => {
    const r = run({ domainExists: false, status: ['not_started', 'pending', 'verified'] });
    expect(await deploy(r.io)).toBe(0);
    expect(r.w.calls).toEqual([
      'resend GET /domains',
      'resend POST /domains',
      'terraform init -input=false -lockfile=readonly -reconfigure -backend-config=/private/run/backend.hcl',
      'terraform plan -input=false -out=/private/run/signin-test.tfplan',
      'terraform show -json /private/run/signin-test.tfplan',
      'terraform apply -input=false /private/run/signin-test.tfplan',
      'terraform output -json',
      'cf PUT GOOGLE_CLIENT_ID',
      'cf PUT GOOGLE_CLIENT_SECRET',
      'cf PUT TURNSTILE_SECRET_KEY',
      'cf PUT BETTER_AUTH_SECRET',
      'resend POST /api-keys',
      'cf PUT RESEND_API_KEY',
      'resend GET /api-keys',
      'resend DELETE /api-keys/k-old',
      'wrangler d1 migrations',
      'wrangler deploy --config',
      'resend GET /domains/d-1',
      'resend POST /domains/d-1/verify',
      'resend GET /domains/d-1',
      'resend GET /domains/d-1',
      'cf PUT SMOKE_KEY',
      'smoke',
      'cf DELETE SMOKE_KEY',
    ]);
    const shown = [r.printed(), ...r.w.calls].join('\n');
    for (const s of secretValues) expect(shown).not.toContain(s);
    // The private files hold the account id (the state endpoint) and nothing secret.
    const files = Object.values(r.files).join('\n');
    for (const s of secretValues.filter((v) => v !== ACCOUNT)) expect(files).not.toContain(s);
    expect(r.printed()).toContain(`live at https://${APP.hostname}`);
  });

  it('puts each value where it belongs and nowhere else', async () => {
    const r = run();
    await deploy(r.io);
    const tfEnv = r.tfEnvs[0] ?? {};
    expect(tfEnv.CLOUDFLARE_API_TOKEN).toBe(VALUES.CLOUDFLARE_API_TOKEN);
    expect(tfEnv.AWS_SECRET_ACCESS_KEY).toBe(VALUES.AWS_SECRET_ACCESS_KEY);
    expect(tfEnv.RESEND_API_KEY).toBeUndefined();
    expect(JSON.parse(tfEnv.TF_VAR_mail_records ?? '[]')).toEqual([
      {
        key: 'dkim-txt',
        type: 'TXT',
        name: `resend._domainkey.${APP.mailDomain}`,
        content: 'p=fixture',
      },
      {
        key: 'spf-mx',
        type: 'MX',
        name: `send.${APP.mailDomain}`,
        content: 'feedback-smtp.example.test',
        priority: 10,
      },
      {
        key: 'spf-txt',
        type: 'TXT',
        name: `send.${APP.mailDomain}`,
        content: 'v=spf1 include:example.test ~all',
      },
    ]);
    expect(r.wranglerEnvs[0]).toEqual({
      CLOUDFLARE_API_TOKEN: VALUES.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    });
    const byName = Object.fromEntries(r.w.cfBodies.map((b) => [b.name, b.text]));
    expect(byName.GOOGLE_CLIENT_SECRET).toBe(VALUES.SIGNIN_TEST_GOOGLE_CLIENT_SECRET);
    expect(byName.TURNSTILE_SECRET_KEY).toBe(TURNSTILE_SECRET);
    expect(byName.RESEND_API_KEY).toBe(SEND_TOKEN);
    expect(r.w.cfBodies.every((b) => b.type === 'secret_text')).toBe(true);
    expect(r.files['backend.hcl']).toContain('key       = "cloudflare/signin-test.tfstate"');
    const config = JSON.parse(r.files['wrangler.json'] ?? '{}');
    expect(config.d1_databases[0].database_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(config.vars).toEqual({
      BETTER_AUTH_URL: `https://${APP.hostname}`,
      TURNSTILE_SITE_KEY: '0x4AAAAAAAfixture',
      MAIL_FROM: APP.mailFrom,
    });
  });

  it('keeps the session secret and the mail key a Worker already has', async () => {
    const r = run({ secrets: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] });
    expect(await deploy(r.io)).toBe(0);
    expect(r.w.calls).not.toContain('cf PUT BETTER_AUTH_SECRET');
    expect(r.w.calls).not.toContain('resend POST /api-keys');
  });

  it('makes a new mail key on request, deleting only the older one of its name', async () => {
    const r = run(
      { secrets: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] },
      { env: { SIGNIN_TEST_ROTATE_MAIL_KEY: '1' } },
    );
    expect(await deploy(r.io)).toBe(0);
    expect(r.w.calls.filter((c) => c.includes('api-keys'))).toEqual([
      'resend POST /api-keys',
      'resend GET /api-keys',
      'resend DELETE /api-keys/k-old',
    ]);
  });

  it('deletes the smoke key when the smoke fails, and fails the run', async () => {
    const r = run({}, { smoke: async () => ({ ok: false, lines: ['FAIL magic link: no mail'] }) });
    expect(await deploy(r.io)).toBe(1);
    expect(r.w.calls.at(-1)).toBe('cf DELETE SMOKE_KEY');
    expect(r.printed()).toContain('FAIL magic link: no mail');
    expect(r.printed()).toContain('the smoke test failed');
  });

  it('deletes the smoke key when the smoke throws', async () => {
    const r = run({}, { smoke: async () => Promise.reject(new Error(`boom ${TURNSTILE_SECRET}`)) });
    expect(await deploy(r.io)).toBe(1);
    expect(r.w.calls.at(-1)).toBe('cf DELETE SMOKE_KEY');
    expect(r.printed()).not.toContain(TURNSTILE_SECRET);
  });

  it('stops before the smoke while Resend has not verified the domain', async () => {
    const r = run({ status: ['pending'] });
    expect(await deploy(r.io)).toBe(1);
    expect(r.w.calls).not.toContain('cf PUT SMOKE_KEY');
    expect(r.printed()).toContain('Resend reports the mail domain pending, not verified');
  });

  it('stops at a failed wrangler deploy, before Resend is asked to verify', async () => {
    const r = run({}, { wranglerFails: 'deploy' });
    expect(await deploy(r.io)).toBe(1);
    expect(r.w.calls).not.toContain('resend POST /domains/d-1/verify');
    expect(r.printed()).toContain('wrangler deploy failed');
  });

  it('writes a wrangler config that leaves the custom domain to Terraform', () => {
    const c = wranglerConfig({ d1_database_id: 'db', turnstile_sitekey: 'sk' });
    expect(c.workers_dev).toBe(false);
    expect('routes' in c).toBe(false);
    expect(c.main.endsWith('/infra/signin-test/src/worker.ts')).toBe(true);
    expect(c.d1_databases[0]?.migrations_dir.endsWith('/templates/signin/migrations')).toBe(true);
  });
});

describe("Resend's records as DNS records", () => {
  const domain = (records: ResendDomain['records']): ResendDomain => ({
    id: 'd',
    name: 'mail.harborlight.test',
    status: 'not_started',
    records,
  });
  const one = (name: string) => [{ record: 'DKIM', name, type: 'TXT', value: 'p=x' }];

  it('qualifies a name given relative to the zone, the domain, or already qualified', () => {
    for (const name of [
      'resend._domainkey.mail',
      'resend._domainkey',
      'resend._domainkey.mail.harborlight.test.',
    ]) {
      expect(mailRecordsFor(domain(one(name)), 'harborlight.test')[0]?.name).toBe(
        'resend._domainkey.mail.harborlight.test',
      );
    }
  });

  it('refuses a record outside the sending domain, and a domain that is the zone', () => {
    expect(() => mailRecordsFor(domain(one('harborlight.test.')), 'harborlight.test')).toThrow(
      'outside mail.harborlight.test',
    );
    expect(() =>
      mailRecordsFor({ ...domain([]), name: 'harborlight.test' }, 'harborlight.test'),
    ).toThrow('must be a subdomain');
  });

  it('gives two records of one kind their own keys', () => {
    const keys = mailRecordsFor(
      domain([...one('a.mail'), ...one('b.mail')]),
      'harborlight.test',
    ).map((r) => r.key);
    expect(keys).toEqual(['dkim-txt', 'dkim-txt-2']);
  });
});

describe('the Resend client', () => {
  it('finds an existing domain by name rather than making a second', async () => {
    const calls: string[] = [];
    const api = (async (m: string, p: string) => {
      calls.push(`${m} ${p}`);
      if (p === '/domains')
        return {
          data: [
            { id: 'x', name: 'other.test' },
            { id: 'd', name: 'mail.harborlight.test' },
          ],
        };
      return { id: 'd', name: 'mail.harborlight.test', status: 'verified', records: [] };
    }) as ResendApi;
    const { created } = await ensureDomain(api, 'mail.harborlight.test');
    expect(created).toBe(false);
    expect(calls).toEqual(['GET /domains', 'GET /domains/d']);
  });

  it('gives up waiting at the timeout and says the last status', async () => {
    let gets = 0;
    const api = (async (m: string) => {
      if (m === 'GET') gets++;
      return { status: 'pending' };
    }) as ResendApi;
    expect(
      await verifyDomain(api, 'd', {
        sleep: async () => {},
        timeoutMs: 45_000,
        intervalMs: 15_000,
      }),
    ).toBe('pending');
    expect(gets).toBe(4);
  });

  it("sends the key in the header alone, and an error carries Resend's message, not the key", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return Response.json({ message: 'The domain is invalid' }, { status: 422 });
    }) as typeof fetch;
    const api = resendApi('re_fixture_Bob', fetcher);
    const err = await api('POST', '/domains', { name: 'x' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Resend POST /domains failed (422): The domain is invalid');
    expect(new Headers(seen[0]?.headers).get('authorization')).toBe('Bearer re_fixture_Bob');
    expect(String(seen[0]?.body)).not.toContain('re_fixture_Bob');
  });
});
