/**
 * The credentials a Terraform run needs, and where each comes from. CI hands
 * them in as environment variables (GitHub secrets); on the Mac each falls
 * back to its Keychain entry. Pure apart from the sources it is handed.
 *
 *   CLOUDFLARE_API_TOKEN                        Keychain `cloudflare-api-token`
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY    Keychain `cloudflare-r2-tfstate`,
 *                                               JSON {accessKeyId, secretAccessKey}
 *
 * The R2 pair is the state bucket's S3 credential, an R2 API token scoped to
 * that one bucket. Every value goes into terraform's environment and nowhere
 * else; an error names the source, never any part of a value.
 */

export const TOKEN_ENTRY = 'cloudflare-api-token';
export const STATE_ENTRY = 'cloudflare-r2-tfstate';
export const DEFAULT_STATE_BUCKET = 'claude-workspaces-tfstate';

export interface CredentialSources {
  env: Record<string, string | undefined>;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}

export interface TfCredentials {
  /** terraform's environment: the token and the state bucket's credential. */
  env: Record<string, string>;
  /** The token alone, for the account reads before terraform runs. */
  token: string;
}

const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

function fromKeychain(src: CredentialSources, entry: string, envName: string): string {
  if (!src.keychainHas(entry)) {
    throw new Error(
      `neither ${envName} nor the Keychain entry ${entry} is set; nothing was changed`,
    );
  }
  return src.keychainRead(entry).trim();
}

/** The state bucket's credential, as terraform's S3 backend reads it. */
export function stateCredentials(src: CredentialSources): Record<string, string> {
  const id = src.env.AWS_ACCESS_KEY_ID;
  const secret = src.env.AWS_SECRET_ACCESS_KEY;
  if (set(id) && set(secret)) return { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret };
  const raw = fromKeychain(src, STATE_ENTRY, 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
  let pair: { accessKeyId?: unknown; secretAccessKey?: unknown };
  try {
    pair = JSON.parse(raw);
  } catch {
    throw new Error(`the Keychain entry ${STATE_ENTRY} is not JSON`);
  }
  if (typeof pair.accessKeyId !== 'string' || typeof pair.secretAccessKey !== 'string') {
    throw new Error(`the Keychain entry ${STATE_ENTRY} has no accessKeyId and secretAccessKey`);
  }
  return { AWS_ACCESS_KEY_ID: pair.accessKeyId, AWS_SECRET_ACCESS_KEY: pair.secretAccessKey };
}

export function tfCredentials(src: CredentialSources): TfCredentials {
  const token = set(src.env.CLOUDFLARE_API_TOKEN)
    ? src.env.CLOUDFLARE_API_TOKEN.trim()
    : fromKeychain(src, TOKEN_ENTRY, 'CLOUDFLARE_API_TOKEN');
  return { token, env: { CLOUDFLARE_API_TOKEN: token, ...stateCredentials(src) } };
}

/**
 * The -backend-config file: the bucket, one key per environment, and the
 * account's R2 endpoint. Not a credential, but it names the account, so it is
 * written to the gitignored `state/<env>/` at mode 600 and never committed.
 */
export function backendConfig(env: string, accountId: string, bucket: string): string {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('the account id is not 32 hex digits');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('CF_TFSTATE_BUCKET is not an R2 bucket name');
  }
  return [
    `bucket    = "${bucket}"`,
    `key       = "cloudflare/${env}.tfstate"`,
    `endpoints = { s3 = "https://${accountId}.r2.cloudflarestorage.com" }`,
    '',
  ].join('\n');
}
