#!/usr/bin/env bun
/**
 * CI's Cloudflare credentials from one secret, CLOUDFLARE_API_TOKEN, so the
 * owner pastes one value into GitHub and nothing else (README.md, "CI").
 *
 *   bun infra/cloudflare/ci-credentials.ts [--account-id] -- <command> [args...]
 *
 * runs the command with three more variables in its environment:
 *
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  the state bucket's S3 key. From
 *       R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY when both are set; otherwise
 *       derived from the token the way Cloudflare documents it
 *       (developers.cloudflare.com/r2/api/tokens/): the key id is the API
 *       token's id, read from its verify endpoint, and the secret is the hex
 *       SHA-256 of the token's value. The token needs R2 write on the bucket.
 *   CLOUDFLARE_ACCOUNT_ID                     with `--account-id` only, for
 *       `terraform output` on a fresh runner (`outputs.ts`): the variable when
 *       set, else the one account the token reaches.
 *
 * Every derived value is printed first as a `::add-mask::` line, so GitHub
 * hides it in the public log before anything can print it. The values go
 * into the child's environment and nowhere else: no file, no argument, no
 * `$GITHUB_ENV`, so steps after this one never hold them.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';

export interface R2Key {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Cloudflare's documented S3 credential for an API token. */
export function r2KeyFromToken(tokenId: string, token: string): R2Key {
  return {
    accessKeyId: tokenId,
    secretAccessKey: createHash('sha256').update(token).digest('hex'),
  };
}

const value = (env: Record<string, string | undefined>, name: string): string =>
  env[name]?.trim() ?? '';

/** The account: CLOUDFLARE_ACCOUNT_ID when set, else the only one the token reaches. */
export async function accountIdOf(
  api: CloudflareApi,
  env: Record<string, string | undefined>,
): Promise<string> {
  const set = value(env, 'CLOUDFLARE_ACCOUNT_ID');
  const id = set || (await onlyAccount(api));
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('the account id is not 32 hex digits');
  return id;
}

async function onlyAccount(api: CloudflareApi): Promise<string> {
  const accounts = await api.all<{ id?: unknown }>('/accounts');
  const first = accounts[0];
  if (accounts.length !== 1 || typeof first?.id !== 'string') {
    throw new Error(
      `CLOUDFLARE_API_TOKEN reaches ${accounts.length} accounts; set the repository variable CLOUDFLARE_ACCOUNT_ID to the one to use`,
    );
  }
  return first.id;
}

interface Verified {
  id?: unknown;
  status?: unknown;
}

function checked(v: Verified): string {
  if (v.status !== 'active') throw new Error('CLOUDFLARE_API_TOKEN is not active');
  if (typeof v.id !== 'string' || !/^[0-9a-f]{32}$/.test(v.id)) {
    throw new Error("Cloudflare's verify answer carries no token id");
  }
  return v.id;
}

/**
 * The token's id. A user token answers `/user/tokens/verify`; an account
 * token answers only its account's `/accounts/<id>/tokens/verify`.
 */
export async function tokenIdOf(
  api: CloudflareApi,
  account: () => Promise<string>,
): Promise<string> {
  let userError: unknown;
  try {
    return checked(await api<Verified>('GET', '/user/tokens/verify'));
  } catch (e) {
    userError = e;
  }
  try {
    return checked(await api<Verified>('GET', `/accounts/${await account()}/tokens/verify`));
  } catch (e) {
    const why = (x: unknown) => (x instanceof Error ? x.message : String(x));
    throw new Error(
      `could not read CLOUDFLARE_API_TOKEN's id, as a user token (${why(userError)}) or an account token (${why(e)})`,
    );
  }
}

export interface CiCredentialIo {
  env: Record<string, string | undefined>;
  api: CloudflareApi;
  /** stdout: where the `::add-mask::` lines go. */
  out: (s: string) => void;
}

/** The variables to add to the child's environment. Masks each value it made. */
export async function ciCredentials(
  io: CiCredentialIo,
  opts: { accountId: boolean },
): Promise<Record<string, string>> {
  const token = value(io.env, 'CLOUDFLARE_API_TOKEN');
  if (token === '') throw new Error('CLOUDFLARE_API_TOKEN is not set; nothing was run');
  const mask = (v: string) => io.out(`::add-mask::${v}\n`);
  let account: Promise<string> | undefined;
  const accountOnce = () => {
    account ??= accountIdOf(io.api, io.env);
    return account;
  };
  const out: Record<string, string> = {};
  const id = value(io.env, 'R2_ACCESS_KEY_ID');
  const secret = value(io.env, 'R2_SECRET_ACCESS_KEY');
  if (id !== '' && secret !== '') {
    out.AWS_ACCESS_KEY_ID = id;
    out.AWS_SECRET_ACCESS_KEY = secret;
  } else if (id !== '' || secret !== '') {
    throw new Error(
      'only one of R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY is set: set both, or neither to derive the key from CLOUDFLARE_API_TOKEN; nothing was run',
    );
  } else {
    const key = r2KeyFromToken(await tokenIdOf(io.api, accountOnce), token);
    mask(key.accessKeyId);
    mask(key.secretAccessKey);
    out.AWS_ACCESS_KEY_ID = key.accessKeyId;
    out.AWS_SECRET_ACCESS_KEY = key.secretAccessKey;
  }
  if (opts.accountId) {
    const a = await accountOnce();
    mask(a);
    out.CLOUDFLARE_ACCOUNT_ID = a;
  }
  return out;
}

export const USAGE =
  'usage: bun infra/cloudflare/ci-credentials.ts [--account-id] -- <command> [args...]\n';

export interface MainIo extends CiCredentialIo {
  err: (s: string) => void;
  /** Run the command with `env` as its whole environment; its exit code. */
  spawn: (cmd: string[], env: Record<string, string | undefined>) => number;
}

/** Exit code: the command's, 1 when the credentials could not be made, 2 on bad usage. */
export async function main(argv: string[], io: MainIo): Promise<number> {
  // `bun file.ts -- cmd` hands the script argv WITHOUT the `--`: bun takes
  // the first one as its own end-of-options marker. So the separator is
  // optional here, and flags are the leading `--`-words before the command.
  // Read as required, it sent every CI run in cloudflare.yml to usage
  // (exit 2) before Terraform started (run 43620529801, 14 Nov).
  let i = 0;
  while (i < argv.length && argv[i] !== '--' && argv[i]?.startsWith('--')) i++;
  const flags = argv.slice(0, i);
  const cmd = argv[i] === '--' ? argv.slice(i + 1) : argv.slice(i);
  if (cmd.length === 0 || flags.some((f) => f !== '--account-id')) {
    io.err(USAGE);
    return 2;
  }
  let added: Record<string, string>;
  try {
    added = await ciCredentials(io, { accountId: flags.includes('--account-id') });
  } catch (e) {
    io.err(`[ci-credentials] ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const { R2_ACCESS_KEY_ID: _id, R2_SECRET_ACCESS_KEY: _secret, ...rest } = io.env;
  return io.spawn(cmd, { ...rest, ...added });
}

if (import.meta.main) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  main(process.argv.slice(2), {
    env: process.env,
    api: cloudflareApi(token),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    spawn: ([bin, ...args], env) =>
      spawnSync(bin as string, args, { stdio: 'inherit', env }).status ?? 1,
  }).then((code) => process.exit(code));
}
