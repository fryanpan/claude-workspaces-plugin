/**
 * The transcript store's bucket, set up: the bucket keeping every version, the
 * key pairs chunks are sealed to, and a credential for the Mac that may only
 * read and list. A test bucket also gets one writer for a stand-in host.
 *
 * The real store (`storeNames`) is made in CI, by `fly-provision.yml`'s
 * deploy (`deploy-store.ts`): there `keychainCreate` seals each identity and
 * credential to the Mac (`mac-ops.ts`), and each project machine's own
 * writer is minted by the deploy, not here. Each run reads what exists and
 * makes only what is missing, so a second run changes nothing. What is
 * printed is names only.
 *
 * Real Tigris answers PutBucketVersioning with 501, so the real store keeps
 * versions as a Tigris snapshot bucket (`retention: 'snapshots'`, the call the
 * backup bucket uses, `tigris.ts`). A test bucket asks for S3 versioning.
 */
import { type BucketCredential, writeOnlyPolicy } from './deploy-plan.ts';
import { generateSnapshotKeys } from './seal.ts';
import { s3Bucket } from './store-s3.ts';
import {
  TIGRIS_IAM_ENDPOINT,
  attachPolicy,
  createAccessKey,
  enableSnapshots,
  ensurePolicy,
  hasSnapshots,
} from './tigris.ts';

/** The stand-in host a test bucket's writer puts for, and its board. */
export const FLY_HOST = 'cw-riverbend-test';
export const TEST_BOARD = 'riverbend-test';

export interface StoreTestNames {
  bucket: string;
  /** Keychain entries. */
  admin: string;
  /** A test bucket's writer for `FLY_HOST`; the real store mints one per machine. */
  writer?: string;
  reader: string;
  identities: Record<string, string>;
  /** How the bucket keeps what an overwrite replaced. S3 versioning unless set. */
  retention?: 'versioning' | 'snapshots';
}

/** The one real store, every host's (the owner, 30 Oct 2026: one bucket). */
export const STORE_BUCKET = 'cw-transcript-store';

export function storeNames(): StoreTestNames {
  return {
    bucket: STORE_BUCKET,
    retention: 'snapshots',
    admin: `${STORE_BUCKET}-bucket-admin`,
    reader: `${STORE_BUCKET}-reader`,
    identities: {
      review: `${STORE_BUCKET}-review-identity`,
      owner: `${STORE_BUCKET}-owner-identity`,
      usage: `${STORE_BUCKET}-usage-identity`,
    },
  };
}

export function storeTestNames(bucket: string): StoreTestNames {
  if (!/^[a-z0-9][a-z0-9-]{1,61}-test$/.test(bucket)) {
    throw new Error(
      `--bucket must be a bucket name ending in -test, not ${JSON.stringify(bucket)}`,
    );
  }
  return {
    bucket,
    admin: `${bucket}-bucket-admin`,
    writer: `${bucket}-writer-${FLY_HOST}`,
    reader: `${bucket}-reader`,
    identities: {
      review: `${bucket}-review-identity`,
      owner: `${bucket}-owner-identity`,
      board: `${bucket}-${TEST_BOARD}-identity`,
    },
  };
}

/** What the Mac's reading credential holds: read and list, never put or delete. */
export function readOnlyPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:ListBucketVersions', 's3:GetBucketVersioning'],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
    ],
  });
}

export interface SetupOps {
  keychainHas(name: string): boolean;
  keychainRead(name: string): string;
  keychainCreate(name: string, value: string): void;
  /** `fly storage create`: a new bucket and its admin credential. */
  createBucket(name: string): Promise<BucketCredential>;
  iamUrl?: string;
}

export const readCredential = (ops: Pick<SetupOps, 'keychainRead'>, name: string) =>
  JSON.parse(ops.keychainRead(name)) as BucketCredential;

/**
 * Makes whatever is missing. Returns one line per thing made, or an empty
 * list when everything was there; with `dryRun` it makes nothing and returns
 * what it would make.
 */
export async function setupStoreTest(
  names: StoreTestNames,
  ops: SetupOps,
  dryRun = false,
): Promise<string[]> {
  const iamUrl = ops.iamUrl ?? TIGRIS_IAM_ENDPOINT;
  const done: string[] = [];
  const hasAdmin = ops.keychainHas(names.admin);
  if (!hasAdmin) {
    done.push(`create bucket ${names.bucket} (admin credential in the Keychain as ${names.admin})`);
    if (!dryRun) {
      ops.keychainCreate(names.admin, JSON.stringify(await ops.createBucket(names.bucket)));
    }
  }
  if (names.retention === 'snapshots') {
    if (dryRun && !hasAdmin) {
      done.push(`make ${names.bucket} a snapshot bucket`);
    } else {
      const admin = readCredential(ops, names.admin);
      if (!(await hasSnapshots(admin, names.bucket))) {
        done.push(`make ${names.bucket} a snapshot bucket`);
        if (!dryRun) {
          await enableSnapshots(admin, names.bucket);
          if (!(await hasSnapshots(admin, names.bucket)))
            throw new Error(`${names.bucket} is not a snapshot bucket after making it one`);
        }
      }
    }
  } else if (dryRun && !hasAdmin) {
    done.push(`turn on versioning for ${names.bucket}`);
  } else {
    const bucket = s3Bucket(readCredential(ops, names.admin), names.bucket);
    if ((await bucket.getVersioning()) !== 'Enabled') {
      done.push(`turn on versioning for ${names.bucket}`);
      if (!dryRun) {
        await bucket.enableVersioning();
        const now = await bucket.getVersioning();
        if (now !== 'Enabled') throw new Error(`versioning reads ${now} after turning it on`);
      }
    }
  }
  for (const [role, entry] of Object.entries(names.identities)) {
    if (ops.keychainHas(entry)) continue;
    done.push(`make the ${role} key pair (identity in the Keychain as ${entry})`);
    if (!dryRun) ops.keychainCreate(entry, generateSnapshotKeys().identity);
  }
  const credentials = [
    ...(names.writer === undefined
      ? []
      : [
          {
            entry: names.writer,
            what: `the Fly-style credential: put under ${FLY_HOST}/ only`,
            policy: `${names.bucket}-writer-${FLY_HOST}`,
            document: writeOnlyPolicy(names.bucket, `${FLY_HOST}/`),
          },
        ]),
    {
      entry: names.reader,
      what: 'the Mac-style credential: read and list only',
      policy: `${names.bucket}-reader`,
      document: readOnlyPolicy(names.bucket),
    },
  ];
  for (const c of credentials) {
    if (ops.keychainHas(c.entry)) continue;
    done.push(`mint ${c.what} (in the Keychain as ${c.entry})`);
    if (dryRun) continue;
    const admin = readCredential(ops, names.admin);
    const key = await createAccessKey(admin, iamUrl);
    const arn = await ensurePolicy(admin, c.policy, c.document, iamUrl);
    await attachPolicy(admin, key.accessKeyId, arn, iamUrl);
    ops.keychainCreate(c.entry, JSON.stringify({ endpoint: admin.endpoint, ...key }));
  }
  return done;
}
