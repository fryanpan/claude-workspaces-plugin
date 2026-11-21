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
import { attachPolicy, createAccessKey, deleteAccessKey, ensurePolicy } from './tigris.ts';

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

/**
 * The bucket, its keys and the Mac's reader. What later runs need is
 * persisted the moment it exists, so a run that fails part-way is re-run
 * rather than repaired: the admin credential as soon as the bucket is made,
 * the public keys as soon as they are written.
 */
export async function setupStore(io: StoreIo): Promise<string[]> {
  const names = storeNames();
  if (io.keychainHas(names.admin) && !io.keychainHas(STORE_KEYS_ENTRY)) {
    // An earlier run made the identities and sealed them to the Mac; making
    // new ones here would seal every later chunk to keys the Mac never gets.
    throw new Error(
      `STORE_BUCKET_ADMIN is set but STORE_KEYS is not: set the variable on ${STORE_ENVIRONMENT} from the Mac's ${STORE_KEYS_ENTRY} entry, then dispatch again`,
    );
  }
  const ops: SetupOps = {
    keychainHas: io.keychainHas,
    keychainRead: io.keychainRead,
    keychainCreate: (name, value) => {
      io.keychainCreate(name, value);
      if (name === names.admin) io.persist('secret', 'STORE_BUCKET_ADMIN', value);
    },
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
    io.persist('variable', 'STORE_KEYS', keys);
    done.push(`the public keys (STORE_KEYS on ${STORE_ENVIRONMENT}, sealed to the Mac)`);
  }
  return done;
}

/**
 * Writers minted this run and not yet set as the app's secrets, by app. Held
 * in memory only, for `storeSecretValue`, and revoked by `revokeUnstoredWriters`
 * when the run fails before `markWriterStored`.
 */
const writers = new Map<string, BucketCredential & { stored: boolean }>();

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
  writers.set(cfg.app, { endpoint: admin.endpoint, ...key, stored: false });
  await attachPolicy(admin, key.accessKeyId, arn, io.iamUrl);
}

/** The app's writer is in its secrets now; a later failure leaves it there. */
export function markWriterStored(app: string): void {
  const w = writers.get(app);
  if (w) w.stored = true;
}

/**
 * Deletes every writer this run minted and never stored, so a failed run
 * leaves no live key that can put. Returns how many it deleted.
 */
export async function revokeUnstoredWriters(
  io: Pick<StoreIo, 'keychainRead' | 'iamUrl'>,
): Promise<number> {
  let n = 0;
  for (const [app, w] of writers) {
    if (w.stored) continue;
    const admin = JSON.parse(io.keychainRead(storeNames().admin)) as BucketCredential;
    await deleteAccessKey(admin, w.accessKeyId, io.iamUrl);
    writers.delete(app);
    n++;
  }
  return n;
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
