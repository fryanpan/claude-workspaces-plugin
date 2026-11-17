#!/usr/bin/env bun
/**
 * CI's rotation of one Access service token's secret
 * (`.github/workflows/rotate-token.yml`), with no passkey tap and no step of
 * Bryan's. It replaces `bun run cf:rotate-token` (`rotate-token.ts`), which
 * did the same through the keeper on a tap.
 *
 *   bun infra/cloudflare/ci-credentials.ts --account-id -- \
 *     bun infra/cloudflare/ci-rotate-token.ts "<name>" [--force]
 *
 *   1. refuse a name that is not a service token name, and refuse before any
 *      rotation when `token-drop.pub` (the Mac's public key) is not in the
 *      repo;
 *   2. refuse when the token's last drop says it was rotated under 24 hours
 *      ago, unless `--force`: a second rotation inside the old secret's
 *      24 hours ends it at once;
 *   3. rotate it with Cloudflare's API (`keeper-rotate.ts`, the keeper's own
 *      call), the old secret kept for 24 hours;
 *   4. print `::add-mask::` for the new client id and secret before anything
 *      else, so GitHub hides them in the public log if anything later did;
 *   5. seal the pair to the Mac's public key and write it to the state bucket
 *      at `service-tokens/<slug>.sealed.json` (`token-drop-blob.ts`). Prod on
 *      the Mac takes it within 15 minutes (`token-drop-start.ts`).
 *
 * The secret exists in this process's memory and in the sealed box, and
 * nowhere else: never an argument, a file, a log line or `$GITHUB_ENV`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyRotate,
  rotateServiceToken,
} from '../../packages/server/src/keeper/keeper-rotate.ts';
import {
  dropKey,
  readEnvelope,
  sealDrop,
} from '../../packages/server/src/token-drop/token-drop-blob.ts';
import { DEFAULT_STATE_BUCKET } from './credentials.ts';

type Cf = (
  method: string,
  path: string,
  body: string | undefined,
) => Promise<{ status: number; body: string }>;

export interface CiRotateIo {
  cf: Cf;
  /** The Mac's public key as committed, or null when the file is absent. */
  publicKey: () => string | null;
  get: (key: string) => Promise<string | null>;
  put: (key: string, body: string) => Promise<void>;
  now: () => number;
  /** stdout: where the `::add-mask::` lines go. */
  out: (s: string) => void;
  err: (s: string) => void;
}

const DAY_MS = 24 * 60 * 60_000;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
export const PUBLIC_KEY_PATH = 'infra/cloudflare/token-drop.pub';

/** Exit code: 0 once the sealed pair is in the bucket. */
export async function ciRotate(argv: string[], io: CiRotateIo): Promise<number> {
  const force = argv.includes('--force');
  const name = argv.find((a) => a !== '--force') ?? '';
  if (classifyRotate(name).kind === 'refused') {
    io.err(
      'the name is not a service token name (letters, digits, spaces, dots, dashes); nothing was changed\n',
    );
    return 2;
  }
  const pub = io.publicKey()?.trim() ?? '';
  if (!PUBLIC_KEY.test(pub)) {
    io.err(
      `${PUBLIC_KEY_PATH} is missing or not a base64 X25519 public key, so there is nothing to seal the new secret to. Prod writes it at boot (token-drop.pub in its data dir); commit it by pull request. Nothing was rotated.\n`,
    );
    return 1;
  }
  const key = dropKey(name);
  const last = readEnvelope((await io.get(key)) ?? '');
  const since = last ? io.now() - Date.parse(last.rotatedAt) : Number.POSITIVE_INFINITY;
  if (since < DAY_MS && !force) {
    io.err(
      `"${name}" was rotated at ${last?.rotatedAt}, under 24 hours ago. Rotating again ends the secret that is still in use at once; dispatch with force to do it anyway. Nothing was rotated.\n`,
    );
    return 1;
  }
  const r = await rotateServiceToken(io.cf, name, io.now());
  let answer: {
    error?: string;
    clientId?: unknown;
    secret?: unknown;
    previousSecretExpiresAt?: string;
  } = {};
  try {
    answer = JSON.parse(r.body);
  } catch {}
  if (typeof answer.secret === 'string') io.out(`::add-mask::${answer.secret}\n`);
  if (typeof answer.clientId === 'string') io.out(`::add-mask::${answer.clientId}\n`);
  if (
    r.status !== 200 ||
    typeof answer.clientId !== 'string' ||
    typeof answer.secret !== 'string'
  ) {
    io.err(`${answer.error ?? `Cloudflare's rotation answered ${r.status}`}\n`);
    return 1;
  }
  const rotatedAt = new Date(io.now()).toISOString();
  let sealed: string;
  try {
    sealed = sealDrop({ name, clientId: answer.clientId, secret: answer.secret, rotatedAt }, pub);
    await io.put(key, sealed);
  } catch {
    // Never the caught message: it was raised next to the secret.
    io.err(
      `Rotated "${name}" but could not seal or upload the new secret; it is lost. The old secret works until ${answer.previousSecretExpiresAt}. Dispatch again with force for another one.\n`,
    );
    return 1;
  }
  io.out(
    `Rotated "${name}" and sealed the new pair to ${key}. Prod on the Mac stores it within 15 minutes; the old secret works until ${answer.previousSecretExpiresAt}.\n`,
  );
  return 0;
}

/** Cloudflare's API with the token in a header and nowhere else. */
export function cloudflareFetch(token: string, fetchImpl: typeof fetch = fetch): Cf {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
    });
    return { status: res.status, body: await res.text() };
  };
}

if (import.meta.main) {
  const env = process.env;
  const token = env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  if (!token || !/^[0-9a-f]{32}$/.test(account) || !env.AWS_ACCESS_KEY_ID) {
    process.stderr.write(
      'needs CLOUDFLARE_API_TOKEN, and CLOUDFLARE_ACCOUNT_ID and the state key from ci-credentials.ts --account-id; nothing was changed\n',
    );
    process.exit(2);
  }
  const s3 = new Bun.S3Client({
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    bucket: env.CF_TFSTATE_BUCKET?.trim() || DEFAULT_STATE_BUCKET,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    region: 'auto',
  });
  const pubPath = join(import.meta.dir, 'token-drop.pub');
  const code = await ciRotate(process.argv.slice(2), {
    cf: cloudflareFetch(token),
    publicKey: () => (existsSync(pubPath) ? readFileSync(pubPath, 'utf8') : null),
    get: async (key) => {
      const f = s3.file(key);
      return (await f.exists()) ? await f.text() : null;
    },
    put: async (key, body) => {
      await s3.write(key, body, { type: 'application/json' });
    },
    now: () => Date.now(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
