/**
 * The transcript store's half of `machine:deploy`: the one bucket every host
 * uploads to (the owner, 30 Oct 2026), and each project machine's writer.
 *
 * Both are made only in `fly-provision.yml`, the one run that holds the org
 * token and a handoff sink to the Mac:
 *
 *   setup-store        the first such run, for any project, makes the bucket
 *                      with versioning on, the review, owner and usage key
 *                      pairs, and the Mac's read-and-list credential
 *                      (`store-setup.ts`). Each identity and credential is
 *                      sealed to the Mac, which stores it on `handoff:pull`.
 *                      The bucket's admin credential is also written to the
 *                      `fly-org` environment as STORE_BUCKET_ADMIN, and the
 *                      public keys as the variable STORE_KEYS, so every later
 *                      run finds the store made.
 *   make-store-writer  per project, a credential that may put objects under
 *                      the machine's two hosts, `<app>/` (the server's
 *                      sessions and event logs) and `<app>_lead/` (the lead's
 *                      sessions), and nothing else. It goes straight into the
 *                      app's secrets and is kept nowhere else: nothing but
 *                      the machine needs it, and a lost one is replaced by
 *                      unsetting STORE_S3_ACCESS_KEY_ID and dispatching again.
 *
 * `_` cannot occur in a project's name (`PROJECT_NAME`), so one machine's
 * lead host is never another machine's server host.
 */
import { spawnSync } from 'node:child_process';
import type { BucketCredential, ProjectConfig } from './deploy-plan.ts';
import { recipientOf } from './seal.ts';
import { STORE_SECRETS, storeWriterPolicy } from './store-plan.ts';
import { type SetupOps, setupStoreTest, storeNames } from './store-setup.ts';
import { attachPolicy, createAccessKey, ensurePolicy } from './tigris.ts';

/** The public keys every chunk is sealed to, as a Keychain entry (CI: the variable). */
export const STORE_KEYS_ENTRY = 'cw-transcript-store-keys';

/** The GitHub Environment that holds the store's admin credential for later runs. */
export const STORE_ENVIRONMENT = 'fly-org';

export interface StoreIo {
  keychainHas(name: string): boolean;
  keychainRead(name: string): string;
  keychainCreate(name: string, value: string): void;
  createBucket(name: string): Promise<BucketCredential>;
  /** Writes a secret (stdin) or a variable to the GitHub Environment. */
  persist(kind: 'secret' | 'variable', name: string, value: string): void;
  iamUrl?: string;
}

/** Whether the admin credential and the public keys are found. */
export function storeReady(io: Pick<StoreIo, 'keychainHas'>): boolean {
  return io.keychainHas(storeNames().admin) && io.keychainHas(STORE_KEYS_ENTRY);
}

/** The bucket, its keys and the Mac's reader; then what later runs need, persisted. */
export async function setupStore(io: StoreIo): Promise<string[]> {
  const names = storeNames();
  const ops: SetupOps = {
    keychainHas: io.keychainHas,
    keychainRead: io.keychainRead,
    keychainCreate: io.keychainCreate,
    createBucket: io.createBucket,
    ...(io.iamUrl ? { iamUrl: io.iamUrl } : {}),
  };
  const done = await setupStoreTest(names, ops);
  if (!io.keychainHas(STORE_KEYS_ENTRY)) {
    const pub = (role: string) => recipientOf(io.keychainRead(names.identities[role] ?? '').trim());
    const keys = JSON.stringify({
      review: pub('review'),
      owner: pub('owner'),
      usage: pub('usage'),
    });
    io.keychainCreate(STORE_KEYS_ENTRY, keys);
    done.push(`the public keys (in the Keychain as ${STORE_KEYS_ENTRY})`);
  }
  io.persist('secret', 'STORE_BUCKET_ADMIN', io.keychainRead(names.admin));
  io.persist('variable', 'STORE_KEYS', io.keychainRead(STORE_KEYS_ENTRY));
  done.push(`STORE_BUCKET_ADMIN and STORE_KEYS on the ${STORE_ENVIRONMENT} environment`);
  return done;
}

/** Writers minted this run, by app. Held in memory only, for `storeSecretValue`. */
const writers = new Map<string, BucketCredential>();

export async function makeStoreWriter(
  cfg: Pick<ProjectConfig, 'app'>,
  io: Pick<StoreIo, 'keychainRead' | 'iamUrl'>,
): Promise<void> {
  const names = storeNames();
  const admin = JSON.parse(io.keychainRead(names.admin)) as BucketCredential;
  const key = await createAccessKey(admin, io.iamUrl);
  const arn = await ensurePolicy(
    admin,
    `${cfg.app}-store-writer`,
    storeWriterPolicy(names.bucket, cfg.app),
    io.iamUrl,
  );
  await attachPolicy(admin, key.accessKeyId, arn, io.iamUrl);
  writers.set(cfg.app, { endpoint: admin.endpoint, ...key });
}

/** The value of a store secret, or undefined for a name that is not one. */
export function storeSecretValue(
  cfg: Pick<ProjectConfig, 'app'>,
  name: string,
  io: Pick<StoreIo, 'keychainRead'>,
): string | undefined {
  if (!(STORE_SECRETS as readonly string[]).includes(name)) return undefined;
  if (name === 'STORE_S3_BUCKET') return storeNames().bucket;
  if (name === 'STORE_KEYS') return io.keychainRead(STORE_KEYS_ENTRY);
  const w = writers.get(cfg.app);
  if (!w) throw new Error(`${name} is set only in the run that mints ${cfg.app}'s store writer`);
  if (name === 'STORE_S3_ENDPOINT') return w.endpoint;
  return name === 'STORE_S3_ACCESS_KEY_ID' ? w.accessKeyId : w.secretAccessKey;
}

/** `gh` writing to the store's environment, with the run's admin token. Values on stdin. */
export function ghPersist(kind: 'secret' | 'variable', name: string, value: string): void {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo)
    throw new Error('GITHUB_REPOSITORY is not set: the store is made in fly-provision.yml');
  const r = spawnSync('gh', [kind, 'set', name, '--env', STORE_ENVIRONMENT, '--repo', repo], {
    input: value,
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN ?? '' },
  });
  // gh's own errors name the call, never the value it read from stdin.
  if (r.status !== 0) throw new Error(`gh ${kind} set ${name} failed: ${r.stderr.trim()}`);
}
