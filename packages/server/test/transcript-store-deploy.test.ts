/**
 * The transcript store in `machine:deploy` (`infra/project-machine/deploy-store.ts`,
 * `store-plan.ts`): what a run plans, and what the CI run makes, against the
 * loopback Tigris (`fake-tigris.ts`), which checks every signature and policy.
 *
 * The store is made only where something can be made (fly-provision.yml):
 * the first run makes the bucket, keys and the Mac's reader and persists what
 * later runs need; every run mints its machine a writer that may put under
 * its own two hosts and do nothing else.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import type { Observed } from '../../../infra/project-machine/deploy-plan.ts';
import {
  STORE_KEYS_ENTRY,
  type StoreIo,
  makeStoreWriter,
  setupStore,
  storeReady,
  storeSecretValue,
} from '../../../infra/project-machine/deploy-store.ts';
import { recipientOf } from '../../../infra/project-machine/seal.ts';
import {
  STORE_SECRETS,
  storeActions,
  storeSecretNames,
} from '../../../infra/project-machine/store-plan.ts';
import { s3Bucket, statusOf } from '../../../infra/project-machine/store-s3.ts';
import { setupStoreTest, storeNames } from '../../../infra/project-machine/store-setup.ts';
import { hasSnapshots } from '../../../infra/project-machine/tigris.ts';
import { startFakeTigris } from './fake-tigris.ts';

// As real Tigris: S3 versioning answers 501, a snapshot bucket keeps versions.
const tigris = startFakeTigris({ asTigris: true });
afterAll(() => tigris.stop());

const obs = (store: Observed['store'], secrets: string[] = []) => ({
  store,
  secrets: new Set(secrets),
});

describe('what a run plans for the store', () => {
  it('in CI with no store: the store, then the writer, and every store secret', () => {
    const o = obs({ ready: false, canMake: true });
    expect(storeActions(o).map((a) => a.kind)).toEqual(['setup-store', 'make-store-writer']);
    expect(storeSecretNames(o)).toEqual([...STORE_SECRETS]);
  });

  it('in CI with the store made: the writer only', () => {
    expect(storeActions(obs({ ready: true, canMake: true })).map((a) => a.kind)).toEqual([
      'make-store-writer',
    ]);
  });

  it('once the app has its writer, or on the Mac, nothing', () => {
    expect(storeActions(obs({ ready: true, canMake: true }, ['STORE_S3_ACCESS_KEY_ID']))).toEqual(
      [],
    );
    expect(storeActions(obs({ ready: true, canMake: false }))).toEqual([]);
    expect(storeSecretNames(obs({ ready: false, canMake: false }))).toEqual([]);
    expect(storeActions(obs(undefined))).toEqual([]);
  });
});

function memoryIo(): StoreIo & { entries: Map<string, string>; persisted: string[] } {
  const entries = new Map<string, string>();
  const persisted: string[] = [];
  return {
    entries,
    persisted,
    keychainHas: (n) => entries.has(n),
    keychainRead: (n) => {
      const v = entries.get(n);
      if (v === undefined) throw new Error(`no ${n}`);
      return v;
    },
    keychainCreate: (n, v) => {
      if (entries.has(n)) throw new Error(`${n} already exists`);
      entries.set(n, v);
    },
    createBucket: async (name) => tigris.createBucket(name),
    persist: (kind, name) => void persisted.push(`${kind} ${name}`),
    iamUrl: tigris.iamUrl,
  };
}

describe('the CI run that makes the store', () => {
  it('makes the bucket, keys and reader once, persists them, and mints a writer per machine', async () => {
    const io = memoryIo();
    const names = storeNames();
    expect(storeReady(io)).toBe(false);
    const made = await setupStore(io);
    expect(made.length).toBeGreaterThan(3);
    expect(storeReady(io)).toBe(true);
    expect(io.persisted).toEqual(['secret STORE_BUCKET_ADMIN', 'variable STORE_KEYS']);
    const admin = JSON.parse(io.keychainRead(names.admin));
    expect(await hasSnapshots(admin, names.bucket)).toBe(true);

    // The public keys are the identities' own.
    const keys = JSON.parse(io.keychainRead(STORE_KEYS_ENTRY));
    for (const role of ['review', 'owner', 'usage'])
      expect(keys[role]).toBe(recipientOf(io.keychainRead(names.identities[role] ?? '')));

    // A second run makes nothing new.
    const before = [...io.entries.keys()].sort();
    await setupStore(io);
    expect([...io.entries.keys()].sort()).toEqual(before);

    await makeStoreWriter({ app: 'cw-harborlight' }, io);
    const value = (n: string) => storeSecretValue({ app: 'cw-harborlight' }, n, io) ?? '';
    const writer = s3Bucket(
      {
        endpoint: value('STORE_S3_ENDPOINT'),
        accessKeyId: value('STORE_S3_ACCESS_KEY_ID'),
        secretAccessKey: value('STORE_S3_SECRET_ACCESS_KEY'),
      },
      value('STORE_S3_BUCKET'),
    );
    expect(value('STORE_KEYS')).toBe(io.keychainRead(STORE_KEYS_ENTRY));
    const one = new Uint8Array([1]);
    expect(await statusOf(() => writer.put('cw-harborlight/events/b/e/0-a.cw', one))).toBe(200);
    expect(
      await statusOf(() => writer.put('cw-harborlight_lead/transcripts/b/s/0-a.cw', one)),
    ).toBe(200);
    expect(await statusOf(() => writer.put('cw-riverbend/events/b/e/0-a.cw', one))).toBe(403);
    expect(await statusOf(() => writer.put('cw-harborlight-x/events/b/e/0-a.cw', one))).toBe(403);
    expect(await statusOf(() => writer.list(''))).toBe(403);
    expect(await statusOf(() => writer.get('cw-harborlight/events/b/e/0-a.cw'))).toBe(403);
    expect(await statusOf(() => writer.delete('cw-harborlight/events/b/e/0-a.cw'))).toBe(403);

    // The Mac's reader reads and lists, and may not write or delete.
    const reader = s3Bucket(JSON.parse(io.keychainRead(names.reader)), names.bucket);
    expect((await reader.list('cw-harborlight')).length).toBe(2);
    expect(await statusOf(() => reader.get('cw-harborlight/events/b/e/0-a.cw'))).toBe(200);
    expect(await statusOf(() => reader.put('cw-harborlight/events/b/e/1-a.cw', one))).toBe(403);
    expect(await statusOf(() => reader.delete('cw-harborlight/events/b/e/0-a.cw'))).toBe(403);
  });

  it('would fail on real Tigris if it asked for S3 versioning: the control for the snapshot path', async () => {
    const io = memoryIo();
    const names = { ...storeNames(), retention: 'versioning' as const };
    await expect(setupStoreTest(names, io)).rejects.toThrow(/501/);
  });

  it('refuses a store secret for a machine whose writer this run did not mint', () => {
    expect(() =>
      storeSecretValue({ app: 'cw-riverbend' }, 'STORE_S3_ACCESS_KEY_ID', memoryIo()),
    ).toThrow(/only in the run that mints/);
    expect(
      storeSecretValue({ app: 'cw-riverbend' }, 'BACKUP_S3_BUCKET', memoryIo()),
    ).toBeUndefined();
  });
});
