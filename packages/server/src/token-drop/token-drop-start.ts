/**
 * Prod's wiring for the token drop (`token-drop-pull.ts`): the real Keychain,
 * the real bucket, and the timer. Prod only (`bin.ts` starts it when the
 * server was started with `--deploy`, on macOS, off a project machine), so a
 * staging or dev server never writes the Keychain.
 *
 * At boot it makes this Mac's key pair if the Keychain has none, writes the
 * public half to `<dataDir>/token-drop.pub` and logs it; that public key goes
 * into the repo as `infra/cloudflare/token-drop.pub` by pull request, once.
 * Then it pulls at boot and every 15 minutes.
 *
 * Every `security` call is async and killed after 10s (`spawnCommand`), so a
 * locked Keychain or a consent dialog delays this and never the server.
 *
 * The bucket is the Terraform state bucket, read with the state key the Mac
 * already holds in the secret store (`infra/cloudflare/credentials.ts`); its
 * endpoint needs the account id, from CLOUDFLARE_ACCOUNT_ID or the secret
 * store's `cloudflare-account-id`. When either is missing it says so once
 * and pulls nothing.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';
import {
  DEFAULT_STATE_BUCKET,
  STATE_CARD_ID_ENTRY,
  STATE_CARD_SECRET_ENTRY,
  STATE_ENTRY,
  stateCredentials,
} from '../../../../infra/cloudflare/credentials.ts';
import { keychainAddLine } from '../../../../infra/cloudflare/service-tokens.ts';
import { type SecretRunner, spawnCommand } from '../secret-store.ts';
import { keychainLookups } from '../share/keychain.ts';
import {
  type KeyIo,
  type PullIo,
  ensureDropKeys,
  pullDrops,
  readDropKeys,
} from './token-drop-pull.ts';

/** The Keychain service holding this Mac's drop private key. */
export const PRIVATE_KEY_SERVICE = 'cw-token-drop-private-key';
export const PULL_INTERVAL_MS = 15 * 60_000;
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;
const ACCOUNT_ENTRY = 'cloudflare-account-id';

/** A Keychain value by service: this user's entry, then any account's. */
export async function readService(run: SecretRunner, service: string): Promise<string | null> {
  for (const args of keychainLookups(service, process.env.USER)) {
    const r = await run('security', args, '');
    if (r.code === 0) return r.stdout.replace(/\n$/, '');
  }
  return null;
}

export function keyIo(run: SecretRunner): KeyIo {
  const args = ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', PRIVATE_KEY_SERVICE, '-w'];
  return {
    readPrivate: async () => {
      const r = await run('security', args, '');
      const v = r.stdout.trim();
      return r.code === 0 && KEY_B64.test(v) ? v : null;
    },
    storePrivate: async (b64) => {
      if (!KEY_B64.test(b64)) return false;
      const line = `add-generic-password -a ${SECRET_ACCOUNT} -s ${PRIVATE_KEY_SERVICE} -w "${b64}"\n`;
      return (await run('security', ['-i'], line)).code === 0;
    },
  };
}

/** The bucket's coordinates and key, or the names of what is missing. */
export async function bucketConfig(
  run: SecretRunner,
  env: Record<string, string | undefined>,
): Promise<
  | { ok: true; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
  | { ok: false; missing: string }
> {
  const entries = new Map<string, string>();
  for (const name of [STATE_ENTRY, STATE_CARD_ID_ENTRY, STATE_CARD_SECRET_ENTRY, ACCOUNT_ENTRY]) {
    const r = await run(
      'security',
      ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', storedSecretService(name), '-w'],
      '',
    );
    if (r.code === 0) entries.set(name, Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
  }
  let creds: Record<string, string>;
  try {
    creds = stateCredentials({
      env: {},
      keychainHas: (n) => entries.has(n),
      keychainRead: (n) => entries.get(n) ?? '',
    });
  } catch (e) {
    return { ok: false, missing: (e as Error).message };
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim() || entries.get(ACCOUNT_ENTRY)?.trim() || '';
  if (!/^[0-9a-f]{32}$/.test(account)) {
    return {
      ok: false,
      missing: `no account id: set CLOUDFLARE_ACCOUNT_ID or the secret ${ACCOUNT_ENTRY}`,
    };
  }
  return {
    ok: true,
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    bucket: env.CF_TFSTATE_BUCKET?.trim() || DEFAULT_STATE_BUCKET,
    accessKeyId: creds.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: creds.AWS_SECRET_ACCESS_KEY ?? '',
  };
}

/** The real pull io, over one bucket. */
export function pullIo(
  run: SecretRunner,
  s3: Bun.S3Client,
  dataDir: string,
  log: (line: string) => void,
): PullIo {
  const appliedPath = join(dataDir, 'token-drop-applied.json');
  const readApplied = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(appliedPath, 'utf8'));
    } catch {
      return {};
    }
  };
  const keys = keyIo(run);
  return {
    list: async (prefix) => {
      const page = await s3.list({ prefix });
      return (page.contents ?? []).map((o) => o.key);
    },
    get: async (key) => {
      const f = s3.file(key);
      return (await f.exists()) ? await f.text() : null;
    },
    keys: () => readDropKeys(keys),
    keychainRead: (service) => readService(run, service),
    replaceToken: async (services, clientId, secret) => {
      for (const [service, value, kind] of [
        [services.clientId, clientId, 'id'],
        [services.secret, secret, 'secret'],
      ] as const) {
        const r = await run('security', ['-i'], keychainAddLine(service, value, kind, true));
        if (r.code !== 0) throw new Error(`could not store ${service} in the Keychain`);
      }
    },
    applied: readApplied,
    recordApplied: (name, rotatedAt) => {
      writeFileSync(appliedPath, `${JSON.stringify({ ...readApplied(), [name]: rotatedAt })}\n`, {
        mode: 0o600,
      });
      chmodSync(appliedPath, 0o600);
    },
    log,
  };
}

export interface StartOptions {
  dataDir: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  run?: SecretRunner;
  /** Builds the bucket client; a test hands in a fake. */
  s3?: (c: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) => Bun.S3Client;
}

/** One boot-or-timer pass: the key, then the pull. Never throws. */
export async function tokenDropPass(opts: StartOptions, said: Set<string>): Promise<void> {
  const run = opts.run ?? spawnCommand;
  const once = (line: string) => {
    if (!said.has(line)) opts.log(line);
    said.add(line);
  };
  try {
    const keys = await ensureDropKeys(keyIo(run));
    if (!keys) return once('could not read or make the private key in the Keychain; will retry');
    const pubPath = join(opts.dataDir, 'token-drop.pub');
    if (keys.created || !existsSync(pubPath)) writeFileSync(pubPath, `${keys.publicKeyB64}\n`);
    once(
      `public key ${keys.publicKeyB64} (in ${pubPath}); CI seals to infra/cloudflare/token-drop.pub, which must match`,
    );
    const cfg = await bucketConfig(run, opts.env);
    if (!cfg.ok) return once(`not pulling: ${cfg.missing}`);
    const { ok: _ok, ...c } = cfg;
    const s3 = opts.s3 ? opts.s3(c) : new Bun.S3Client({ ...c, region: 'auto' });
    await pullDrops(pullIo(run, s3, opts.dataDir, opts.log));
  } catch {
    // Never the caught message: a bucket or Keychain error may sit next to a value.
    once('a pull failed; will retry on the next pass');
  }
}

/** Pull now and every 15 minutes; the timer never holds the process open. */
export function startTokenDrop(opts: StartOptions): { stop: () => void } {
  const said = new Set<string>();
  void tokenDropPass(opts, said);
  const timer = setInterval(() => void tokenDropPass(opts, said), PULL_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
