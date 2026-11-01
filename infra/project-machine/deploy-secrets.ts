/**
 * Where each of `machine:deploy`'s machine secrets comes from: the Keychain
 * (or, in CI, the environment standing in for it, `mac-ops.ts`) and the
 * project's config. Every error names the entry, never any part of a value.
 */
import {
  type BucketCredential,
  LEAD_BOARD_SECRET,
  LEAD_DEPLOY_KEY_SECRET,
  LEAD_TOKEN_SECRET,
  ORG_KEY_SECRET,
  type ProjectConfig,
} from './deploy-plan.ts';
import { keychainRead } from './mac-ops.ts';
import { recipientOf } from './snapshot.ts';

export function bucketAdmin(cfg: ProjectConfig): BucketCredential {
  return JSON.parse(keychainRead(cfg.keychain.bucketAdmin)) as BucketCredential;
}

export function secretValue(cfg: ProjectConfig, name: string): string {
  switch (name) {
    case 'BACKUP_RECIPIENT':
      return recipientOf(keychainRead(cfg.keychain.identity));
    case 'BACKUP_S3_ENDPOINT':
      return bucketAdmin(cfg).endpoint;
    case 'BACKUP_S3_BUCKET':
      return cfg.bucket;
    case 'BACKUP_S3_ACCESS_KEY_ID':
      return (JSON.parse(keychainRead(cfg.keychain.writer)) as { accessKeyId: string }).accessKeyId;
    case 'BACKUP_S3_SECRET_ACCESS_KEY':
      return (JSON.parse(keychainRead(cfg.keychain.writer)) as { secretAccessKey: string })
        .secretAccessKey;
    case 'CW_TUNNEL_MODE':
      return cfg.tunnel;
    case ORG_KEY_SECRET:
      return keychainRead(cfg.keychain.orgKey).trim();
    case LEAD_TOKEN_SECRET:
      return leadToken(cfg);
    case LEAD_BOARD_SECRET:
      if (cfg.leadBoard === undefined) throw new Error(`no source for secret ${name}`);
      return cfg.leadBoard;
    case LEAD_DEPLOY_KEY_SECRET:
      return deployKey(cfg);
    default:
      throw new Error(`no source for secret ${name}`);
  }
}

/**
 * The lead's token, as one line `fly secrets import` can carry. The error
 * names the entry, never any part of the value.
 */
function leadToken(cfg: ProjectConfig): string {
  const token = keychainRead(cfg.keychain.leadToken).trim();
  if (!/^[\x21-\x7e]+$/.test(token))
    throw new Error(
      `the Keychain entry ${cfg.keychain.leadToken} does not hold a token from \`claude setup-token\` (one line, no spaces)`,
    );
  return token;
}

/**
 * The deploy key, BASE64 so it is one line. The error names the entry, never
 * any part of the value.
 */
function deployKey(cfg: ProjectConfig): string {
  const entry = cfg.keychain.deployKey ?? '';
  const key = keychainRead(entry).trim();
  if (
    !/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n-]+\n-----END OPENSSH PRIVATE KEY-----$/.test(
      key,
    )
  )
    throw new Error(`the Keychain entry ${entry} does not hold an OpenSSH private key`);
  return Buffer.from(`${key}\n`).toString('base64');
}
