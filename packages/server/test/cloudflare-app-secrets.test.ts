/**
 * `cf:app-secrets` (infra/cloudflare/app-secrets.ts): where each value is
 * found, what reaches terraform, what runs in which mode, and what prints. A
 * fake terraform and a fake Keychain; nothing leaves the process. What the
 * Terraform root itself writes is `infra/cloudflare/app-secrets/tests/apply.tftest.hcl`.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_SECRETS,
  type AppSecretsIo,
  USAGE,
  appSecrets,
  decodeCard,
  readKeychain,
} from '../../../infra/cloudflare/app-secrets.ts';

const GH_TOKEN = 'fixture-gh-token-Harborlight';
const RESEND = 'fixture-resend-Saltmarsh';
const CLIENT_ID = 'fixture-client-Harborlight';
const CLIENT_SECRET = 'fixture-secret-Riverbend';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const SHOW = JSON.stringify({
  resource_changes: [
    {
      address: 'github_actions_environment_secret.app["RESEND_API_KEY"]',
      change: { actions: ['create'] },
    },
  ],
});

interface Run {
  io: AppSecretsIo;
  calls: Array<{ args: string[]; env: Record<string, string> }>;
  printed: () => string;
  removed: string[];
  asked: string[];
}

function fake(
  env: Record<string, string | undefined>,
  opts: { fail?: string; show?: string; keychain?: Record<string, string> } = {},
): Run {
  const calls: Run['calls'] = [];
  const asked: string[] = [];
  const removed: string[] = [];
  let text = '';
  const io: AppSecretsIo = {
    env,
    keychain: (service) => {
      asked.push(service);
      return opts.keychain?.[service] ?? null;
    },
    stateDir: '/fixture/state/app-secrets',
    dataDir: '/fixture/state/app-secrets-data',
    terraform: (args, e) => {
      calls.push({ args, env: e });
      if (args[0] === opts.fail) return { status: 1, stdout: '' };
      return { status: 0, stdout: args[0] === 'show' ? (opts.show ?? SHOW) : '' };
    },
    removeFile: (p) => removed.push(p),
    out: (s) => {
      text += s;
    },
    err: (s) => {
      text += s;
    },
  };
  return { io, calls, printed: () => text, removed, asked };
}

const secretsOf = (r: Run): Record<string, string> =>
  JSON.parse(r.calls[0]?.env.TF_VAR_secrets ?? 'null') as Record<string, string>;

const PLAIN = {
  'resend-api-key': RESEND,
  'signin-test-google-client-id': CLIENT_ID,
  'signin-test-google-client-secret': CLIENT_SECRET,
};
const CARDS = {
  'claude-workspaces-secret.resend-api-key': b64(RESEND),
  'claude-workspaces-secret.signin-test-google-client-id': b64(CLIENT_ID),
  'claude-workspaces-secret.signin-test-google-client-secret': b64(`${CLIENT_SECRET}\n`),
};
const ALL = { RESEND_API_KEY: RESEND, SIGNIN_TEST_GOOGLE_CLIENT_ID: CLIENT_ID };

describe('cf:app-secrets', () => {
  it('runs nothing without a GitHub token, and needs no Cloudflare token', async () => {
    const none = fake({});
    expect(await appSecrets(['plan'], none.io)).toBe(1);
    expect(none.calls).toEqual([]);
    expect(none.printed()).toContain('GITHUB_TOKEN not set; nothing was run');

    const gh = fake({ GITHUB_TOKEN: GH_TOKEN }, { keychain: PLAIN });
    expect(await appSecrets(['plan'], gh.io)).toBe(0);
    expect(Object.keys(gh.calls[0]?.env ?? {}).some((k) => k.startsWith('CLOUDFLARE'))).toBe(false);
  });

  it('refuses an unknown mode or flag', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN });
    expect(await appSecrets(['destroy'], r.io)).toBe(2);
    expect(await appSecrets(['apply', '--force'], r.io)).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.printed()).toBe(USAGE + USAGE);
  });

  it('decodes each secret card when no plain Keychain item exists', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN }, { keychain: CARDS });
    expect(await appSecrets(['plan'], r.io)).toBe(0);
    expect(secretsOf(r)).toEqual({
      RESEND_API_KEY: RESEND,
      SIGNIN_TEST_GOOGLE_CLIENT_ID: CLIENT_ID,
      SIGNIN_TEST_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    });
    expect(r.printed()).toContain('RESEND_API_KEY: from the secret card');
  });

  it('takes the environment, then the plain item, then the card, asking only as far as it must', async () => {
    const r = fake(
      { GITHUB_TOKEN: GH_TOKEN, RESEND_API_KEY: 'fixture-env-Alice' },
      {
        keychain: {
          ...CARDS,
          'signin-test-google-client-id': 'fixture-plain-Bob',
        },
      },
    );
    await appSecrets(['plan'], r.io);
    expect(secretsOf(r)).toEqual({
      RESEND_API_KEY: 'fixture-env-Alice',
      SIGNIN_TEST_GOOGLE_CLIENT_ID: 'fixture-plain-Bob',
      SIGNIN_TEST_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    });
    expect(r.asked).toEqual([
      'signin-test-google-client-id',
      'signin-test-google-client-secret',
      'claude-workspaces-secret.signin-test-google-client-secret',
    ]);
    const out = r.printed();
    expect(out).toContain('RESEND_API_KEY: from the environment');
    expect(out).toContain('SIGNIN_TEST_GOOGLE_CLIENT_ID: from the keychain');
  });

  it('hands values to terraform in its environment only, and never prints one', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN }, { keychain: CARDS });
    expect(await appSecrets(['apply'], r.io)).toBe(0);
    const env = r.calls[0]?.env ?? {};
    expect(env.GITHUB_TOKEN).toBe(GH_TOKEN);
    expect(env.TF_VAR_environment).toBe('cloudflare-prod');
    expect(env.TF_DATA_DIR).toBe('/fixture/state/app-secrets-data');
    const args = r.calls.flatMap((c) => c.args).join(' ');
    const out = r.printed();
    for (const v of [GH_TOKEN, RESEND, CLIENT_ID, CLIENT_SECRET, ...Object.values(CARDS)]) {
      expect(args).not.toContain(v);
      expect(out).not.toContain(v);
    }
  });

  it('applies the saved plan it just made, then removes it', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN }, { keychain: PLAIN });
    expect(await appSecrets(['apply'], r.io)).toBe(0);
    const plan = '/fixture/state/app-secrets/app-secrets.tfplan';
    expect(r.calls.map((c) => c.args)).toEqual([
      [
        'init',
        '-input=false',
        '-lockfile=readonly',
        '-reconfigure',
        '-backend-config=path=/fixture/state/app-secrets/terraform.tfstate',
      ],
      ['plan', '-input=false', `-out=${plan}`],
      ['show', '-json', plan],
      ['apply', '-input=false', plan],
    ]);
    expect(r.removed).toEqual([plan, plan]);
  });

  it('plans without applying', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN, ...ALL });
    expect(await appSecrets(['plan'], r.io)).toBe(0);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan', 'show']);
    expect(r.printed()).toContain('`github_actions_environment_secret.app["RESEND_API_KEY"]`');
  });

  it('leaves out a value it cannot find, names where it looked, and does not write it empty', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN, ...ALL });
    await appSecrets(['plan'], r.io);
    expect(Object.keys(secretsOf(r))).toEqual(['RESEND_API_KEY', 'SIGNIN_TEST_GOOGLE_CLIENT_ID']);
    expect(r.printed()).toContain(
      'SIGNIN_TEST_GOOGLE_CLIENT_SECRET: not in the environment, the Keychain item signin-test-google-client-secret or its secret card',
    );
  });

  it('refuses an apply whose plan deletes a secret, and applies it with --drop', async () => {
    const show = JSON.stringify({
      resource_changes: [
        {
          address: 'github_actions_environment_secret.app["SIGNIN_TEST_GOOGLE_CLIENT_SECRET"]',
          change: { actions: ['delete'] },
        },
      ],
    });
    const refused = fake({ GITHUB_TOKEN: GH_TOKEN, ...ALL }, { show });
    expect(await appSecrets(['apply'], refused.io)).toBe(1);
    expect(refused.calls.map((c) => c.args[0])).toEqual(['init', 'plan', 'show']);
    expect(refused.printed()).toContain('SIGNIN_TEST_GOOGLE_CLIENT_SECRET');
    expect(refused.printed()).toContain('nothing was applied');
    expect(refused.removed).toHaveLength(2);

    const dropped = fake({ GITHUB_TOKEN: GH_TOKEN, ...ALL }, { show });
    expect(await appSecrets(['apply', '--drop'], dropped.io)).toBe(0);
    expect(dropped.calls.map((c) => c.args[0])).toContain('apply');
  });

  it('stops at a failed init without planning', async () => {
    const r = fake({ GITHUB_TOKEN: GH_TOKEN, ...ALL }, { fail: 'init' });
    expect(await appSecrets(['apply'], r.io)).toBe(1);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init']);
  });

  it('names each secret once, upper case, each with its own Keychain name', () => {
    const names = APP_SECRETS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(new Set(APP_SECRETS.map((s) => s.service)).size).toBe(names.length);
  });

  it('reads a card that decodes to nothing as absent', () => {
    expect(decodeCard(b64('  \n'))).toBeNull();
    expect(decodeCard(b64(RESEND))).toBe(RESEND);
  });

  it('reads the Keychain with the service name as the only varying argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-secrets-keychain-'));
    const bin = join(dir, 'security');
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$@" > "${dir}/args"\n[ "$5" = resend-api-key ] || exit 44\nprintf 'fixture-Bob\\n'\n`,
    );
    chmodSync(bin, 0o755);
    expect(readKeychain('resend-api-key', bin, 'darwin')).toBe('fixture-Bob');
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe(
      'find-generic-password -a claude-workspaces -s resend-api-key -w',
    );
    expect(readKeychain('signin-test-google-client-id', bin, 'darwin')).toBeNull();
    expect(readKeychain('resend-api-key', bin, 'linux')).toBeNull();
  });
});
