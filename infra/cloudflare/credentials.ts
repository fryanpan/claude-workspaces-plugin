/**
 * The credentials a Terraform run needs, and where each comes from. CI hands
 * them in as environment variables (GitHub secrets); on the Mac each falls
 * back to its Keychain entry. Pure apart from the sources it is handed.
 *
 *   CLOUDFLARE_API_TOKEN                        Keychain `cloudflare-api-token`
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY    Keychain `cloudflare-r2-tfstate`,
 *                                               JSON {accessKeyId, secretAccessKey};
 *                                               else the board secret card's two
 *                                               entries `r2-tfstate-access-key-id`
 *                                               and `r2-tfstate-secret-access-key`
 *
 * The sources are the Keychain readers in `infra/project-machine/mac-ops.ts`,
 * which look a name up under the board secret store's prefix and decode it,
 * so a card entry is read by the name the card asked for. An agent cannot
 * write the JSON entry (the secret store refuses it), so the card's pair is
 * the way a person hands over the state key; the JSON entry still wins when
 * both exist.
 *
 * The R2 pair is the state bucket's S3 credential, an R2 API token scoped to
 * that one bucket. Every value goes into terraform's environment and nowhere
 * else; an error names the source, never any part of a value.
 */

export const TOKEN_ENTRY = 'cloudflare-api-token';
export const STATE_ENTRY = 'cloudflare-r2-tfstate';
/** The board secret card's two entries for the same credential. */
export const STATE_CARD_ID_ENTRY = 'r2-tfstate-access-key-id';
export const STATE_CARD_SECRET_ENTRY = 'r2-tfstate-secret-access-key';
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
  if (!src.keychainHas(STATE_ENTRY)) return fromCard(src);
  const raw = src.keychainRead(STATE_ENTRY).trim();
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

/** The state credential from the board secret card's two entries. */
function fromCard(src: CredentialSources): Record<string, string> {
  const missing = [STATE_CARD_ID_ENTRY, STATE_CARD_SECRET_ENTRY].filter((e) => !src.keychainHas(e));
  if (missing.length === 2) {
    throw new Error(
      `none of AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, the Keychain entry ${STATE_ENTRY}, or the secret card's entries ${STATE_CARD_ID_ENTRY} and ${STATE_CARD_SECRET_ENTRY} is set; nothing was changed`,
    );
  }
  if (missing.length === 1) {
    throw new Error(
      `the Keychain entry ${STATE_ENTRY} is not set and the secret card's entry ${missing[0]} is missing; nothing was changed`,
    );
  }
  const keyId = src.keychainRead(STATE_CARD_ID_ENTRY).trim();
  const keySecret = src.keychainRead(STATE_CARD_SECRET_ENTRY).trim();
  const empty = [
    ...(keyId === '' ? [STATE_CARD_ID_ENTRY] : []),
    ...(keySecret === '' ? [STATE_CARD_SECRET_ENTRY] : []),
  ];
  if (empty.length > 0) {
    throw new Error(`the secret card's entry ${empty.join(' and ')} is empty; nothing was changed`);
  }
  return { AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: keySecret };
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
