/**
 * Steps 1 to 3 of the transcript store's test-bucket proof, set up: a test
 * bucket with versioning on, the keys chunks are sealed to, a Fly-style
 * credential that may only put under its host's prefix, and a Mac-style
 * credential that may only read and list.
 *
 * Each run reads what exists and makes only what is missing, so a second run
 * changes nothing. Every credential and identity goes into the Keychain and
 * nowhere else; what is printed is names only.
 */
import { type BucketCredential, writeOnlyPolicy } from './deploy-plan.ts';
import { generateSnapshotKeys } from './seal.ts';
import { s3Bucket } from './store-s3.ts';
import { TIGRIS_IAM_ENDPOINT, attachPolicy, createAccessKey, ensurePolicy } from './tigris.ts';

/** The Fly project machine the proof writes as, and the test board it writes for. */
export const FLY_HOST = 'cw-riverbend-test';
export const TEST_BOARD = 'riverbend-test';

export interface StoreTestNames {
  bucket: string;
  /** Keychain entries. */
  admin: string;
  writer: string;
  reader: string;
  identities: { review: string; owner: string; board: string };
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
  if (dryRun && !hasAdmin) {
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
    {
      entry: names.writer,
      what: `the Fly-style credential: put under ${FLY_HOST}/ only`,
      policy: `${names.bucket}-writer-${FLY_HOST}`,
      document: writeOnlyPolicy(names.bucket, `${FLY_HOST}/`),
    },
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
