#!/usr/bin/env bun
/**
 * Puts the sign-in test app live, end to end, from CI
 * (`.github/workflows/signin-test.yml`; README.md beside this file):
 *
 *   1. Resend: the sending domain, made if missing, and the records it needs.
 *   2. Terraform (`infra/cloudflare/apps/signin-test`): the D1 database, the
 *      Turnstile widget, the Worker's custom domain and those mail records.
 *   3. The Worker's secrets, through the Cloudflare API: the Google client,
 *      the Turnstile secret, a session secret made once, and a send-only
 *      Resend key made once (or again with SIGNIN_TEST_ROTATE_MAIL_KEY=1).
 *   4. wrangler: the D1 migrations, then the Worker.
 *   5. Resend checks the records; the run waits for `verified`.
 *   6. The smoke test (`smoke.ts`), with a SMOKE_KEY made for this run and
 *      deleted after it, pass or fail.
 *
 * Run as `bun infra/cloudflare/ci-credentials.ts --account-id -- bun
 * infra/signin-test/deploy.ts`, which adds the state bucket's key and the
 * account id. From the environment: CLOUDFLARE_API_TOKEN, RESEND_API_KEY,
 * SIGNIN_TEST_GOOGLE_CLIENT_ID, SIGNIN_TEST_GOOGLE_CLIENT_SECRET, and
 * optionally CF_TFSTATE_BUCKET. Every value goes into a child's environment
 * or an API request body, never an argument, a file or a printed line. What
 * prints is the plan's addresses and verbs, step names and secret names.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_BUCKET, backendConfig } from '../cloudflare/credentials.ts';
import { planSummary } from '../cloudflare/plan-summary.ts';
import { APP_DIRS, type TfResult, spawnTerraform } from '../cloudflare/terraform.ts';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import {
  type ResendApi,
  createSendKey,
  deleteOtherKeys,
  ensureDomain,
  mailRecordsFor,
  resendApi,
  verifyDomain,
} from './resend.ts';
import { type SmokeConfig, resendMailReader, runSmoke } from './smoke.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** The app. Everything else is read from Cloudflare and Resend at deploy time. */
export const APP = {
  name: 'signin-test',
  zone: 'fryanpan.com',
  hostname: 'signin-test.fryanpan.com',
  mailDomain: 'mail.fryanpan.com',
  mailFrom: 'Sign-in test <signin@mail.fryanpan.com>',
  compatibilityDate: '2026-11-01',
} as const;

export const REQUIRED_ENV = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'RESEND_API_KEY',
  'SIGNIN_TEST_GOOGLE_CLIENT_ID',
  'SIGNIN_TEST_GOOGLE_CLIENT_SECRET',
] as const;

export interface DeployIo {
  env: Record<string, string | undefined>;
  resend: ResendApi;
  cf: CloudflareApi;
  /** terraform in the app's root, `env` added; stdout captured. */
  terraform: (args: string[], env: Record<string, string>) => TfResult;
  /** wrangler with `env` added; its exit code. Output goes to the log. */
  wrangler: (args: string[], env: Record<string, string>) => number;
  /** Writes a file only this run can read; returns its path. */
  writePrivate: (name: string, content: string) => string;
  smoke: (cfg: SmokeConfig) => Promise<{ ok: boolean; lines: string[] }>;
  randomKey: () => string;
  sleep: (ms: number) => Promise<void>;
  /** How long Resend gets to verify the domain. */
  verifyTimeoutMs?: number;
  out: (s: string) => void;
}

interface Outputs {
  script_name: string;
  d1_database_id: string;
  turnstile_sitekey: string;
  turnstile_secret: string;
}

/** The wrangler config deploy writes for this run; the D1 id comes from Terraform. */
export function wranglerConfig(o: Pick<Outputs, 'd1_database_id' | 'turnstile_sitekey'>) {
  return {
    name: APP.name,
    main: join(HERE, 'src', 'worker.ts'),
    compatibility_date: APP.compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    // Terraform owns the custom domain; wrangler deploys code alone.
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: 'DB',
        database_name: APP.name,
        database_id: o.d1_database_id,
        migrations_dir: join(REPO, 'templates', 'signin', 'migrations'),
      },
    ],
    vars: {
      BETTER_AUTH_URL: `https://${APP.hostname}`,
      TURNSTILE_SITE_KEY: o.turnstile_sitekey,
      MAIL_FROM: APP.mailFrom,
    },
  };
}

class Stop extends Error {}

export async function deploy(io: DeployIo): Promise<number> {
  const say = (s: string) => io.out(`[signin-test] ${s}\n`);
  const missing = REQUIRED_ENV.filter((n) => !io.env[n]?.trim());
  if (missing.length) {
    say(`${missing.join(', ')} not set; nothing was changed`);
    return 1;
  }
  const v = (n: (typeof REQUIRED_ENV)[number]) => io.env[n]?.trim() ?? '';
  const account = v('CLOUDFLARE_ACCOUNT_ID');
  const tf = (args: string[], env: Record<string, string>, what: string): TfResult => {
    const r = io.terraform(args, env);
    if (r.status !== 0) throw new Stop(`terraform ${what} exited ${r.status}`);
    return r;
  };
  try {
    // 1. Resend's domain and its records.
    const { domain, created } = await ensureDomain(io.resend, APP.mailDomain);
    const records = mailRecordsFor(domain, APP.zone);
    say(`Resend domain ${created ? 'made' : 'found'}; ${records.length} DNS records to hold`);

    // 2. Terraform.
    const work = io.writePrivate(
      'backend.hcl',
      backendConfig(APP.name, account, io.env.CF_TFSTATE_BUCKET?.trim() || DEFAULT_STATE_BUCKET),
    );
    const plan = join(dirname(work), 'signin-test.tfplan');
    const tfEnv: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: v('CLOUDFLARE_API_TOKEN'),
      AWS_ACCESS_KEY_ID: v('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: v('AWS_SECRET_ACCESS_KEY'),
      TF_INPUT: '0',
      TF_DATA_DIR: join(dirname(work), 'tf-data'),
      TF_VAR_account_id: account,
      TF_VAR_app_name: APP.name,
      TF_VAR_zone_name: APP.zone,
      TF_VAR_hostname: APP.hostname,
      TF_VAR_mail_domain: APP.mailDomain,
      TF_VAR_mail_records: JSON.stringify(records),
    };
    tf(
      ['init', '-input=false', '-lockfile=readonly', '-reconfigure', `-backend-config=${work}`],
      tfEnv,
      'init',
    );
    tf(['plan', '-input=false', `-out=${plan}`], tfEnv, 'plan');
    io.out(planSummary(tf(['show', '-json', plan], tfEnv, 'show').stdout, APP.name));
    tf(['apply', '-input=false', plan], tfEnv, 'apply');
    const raw = JSON.parse(tf(['output', '-json'], tfEnv, 'output').stdout) as Record<
      string,
      { value?: unknown }
    >;
    const out = Object.fromEntries(
      ['script_name', 'd1_database_id', 'turnstile_sitekey', 'turnstile_secret'].map((k) => {
        const value = raw[k]?.value;
        if (typeof value !== 'string' || value === '')
          throw new Stop(`terraform output ${k} is empty`);
        return [k, value];
      }),
    ) as unknown as Outputs;

    // 3. Secrets.
    const secretsPath = `/accounts/${account}/workers/scripts/${out.script_name}/secrets`;
    const put = (name: string, text: string) =>
      io.cf('PUT', secretsPath, { name, text, type: 'secret_text' });
    const has = new Set((await io.cf<{ name: string }[]>('GET', secretsPath)).map((s) => s.name));
    await put('GOOGLE_CLIENT_ID', v('SIGNIN_TEST_GOOGLE_CLIENT_ID'));
    await put('GOOGLE_CLIENT_SECRET', v('SIGNIN_TEST_GOOGLE_CLIENT_SECRET'));
    await put('TURNSTILE_SECRET_KEY', out.turnstile_secret);
    if (!has.has('BETTER_AUTH_SECRET')) await put('BETTER_AUTH_SECRET', io.randomKey());
    if (!has.has('RESEND_API_KEY') || io.env.SIGNIN_TEST_ROTATE_MAIL_KEY === '1') {
      const key = await createSendKey(io.resend, APP.name, domain.id);
      await put('RESEND_API_KEY', key.token);
      const gone = await deleteOtherKeys(io.resend, APP.name, key.id);
      say(`made a send-only Resend key; deleted ${gone} older`);
    }
    say('Worker secrets set');

    // 4. Migrations, then the code.
    const wEnv = {
      CLOUDFLARE_API_TOKEN: v('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: account,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    };
    const config = io.writePrivate(
      'wrangler.json',
      `${JSON.stringify(wranglerConfig(out), null, 2)}\n`,
    );
    if (
      io.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', config], wEnv) !== 0
    ) {
      throw new Stop('wrangler d1 migrations apply failed');
    }
    if (io.wrangler(['deploy', '--config', config], wEnv) !== 0)
      throw new Stop('wrangler deploy failed');

    // 5. Resend checks the records Terraform just wrote.
    const status = await verifyDomain(io.resend, domain.id, {
      sleep: io.sleep,
      timeoutMs: io.verifyTimeoutMs ?? 10 * 60_000,
    });
    if (status !== 'verified') {
      throw new Stop(
        `Resend reports the mail domain ${status}, not verified. DNS can take a while: dispatch the workflow again later`,
      );
    }
    say('mail domain verified');

    // 6. Smoke, with a key that exists only for it.
    const smokeKey = io.randomKey();
    await put('SMOKE_KEY', smokeKey);
    let result: { ok: boolean; lines: string[] };
    try {
      result = await io.smoke({
        origin: `https://${APP.hostname}`,
        smokeKey,
        googleClientId: v('SIGNIN_TEST_GOOGLE_CLIENT_ID'),
        label: `s${Date.now().toString(36)}`,
      });
    } finally {
      await io.cf('DELETE', `${secretsPath}/SMOKE_KEY`);
    }
    for (const l of result.lines) io.out(`  ${l}\n`);
    if (!result.ok) throw new Stop('the smoke test failed');
    say(`live at https://${APP.hostname}`);
    return 0;
  } catch (e) {
    // A Stop says what failed; anything else may have been raised beside a value.
    say(
      e instanceof Stop || (e instanceof Error && /^(Resend|GET|PUT|POST|DELETE) /.test(e.message))
        ? (e as Error).message
        : 'failed with an unexpected error',
    );
    return 1;
  }
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), 'signin-test-'));
  const env = process.env;
  const wranglerBin = join(REPO, 'templates', 'signin', 'node_modules', '.bin', 'wrangler');
  deploy({
    env,
    resend: resendApi(env.RESEND_API_KEY?.trim() ?? ''),
    cf: cloudflareApi(env.CLOUDFLARE_API_TOKEN?.trim() ?? ''),
    terraform: (args, e) => spawnTerraform(APP_DIRS['signin-test'], args, e, true, dir),
    wrangler: (args, e) =>
      spawnSync(wranglerBin, args, { stdio: 'inherit', env: { ...process.env, ...e } }).status ?? 1,
    writePrivate: (name, content) => {
      const p = join(dir, name);
      writeFileSync(p, content, { mode: 0o600 });
      return p;
    },
    smoke: (cfg) =>
      runSmoke(cfg, {
        fetch: (req) => fetch(req),
        mail: resendMailReader(env.RESEND_API_KEY?.trim() ?? ''),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
    randomKey: () => randomBytes(32).toString('base64url'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (s) => process.stdout.write(s),
  }).then((code) => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  });
}
