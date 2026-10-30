/**
 * Step 4 of the transcript store's proof: the daily check
 * (`infra/project-machine/store-check.ts`) over a day the drill
 * (`store-drill.ts`) stages across a midnight in the loopback Tigris, with
 * one chunk deleted, one corrupted, one range never sent and one chunk sent
 * twice. The first three must raise a warning to Sentry; the duplicate must
 * not. Sentry is a capture server on loopback.
 *
 * The Keychain is a map; every key and credential is made inside the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recipientOf } from '../../../infra/project-machine/seal.ts';
import { checkAndAlert, runCheck } from '../../../infra/project-machine/store-check.ts';
import { type DrillFaults, stageDrill } from '../../../infra/project-machine/store-drill.ts';
import { s3Bucket } from '../../../infra/project-machine/store-s3.ts';
import {
  FLY_HOST,
  type SetupOps,
  readCredential,
  setupStoreTest,
  storeTestNames,
} from '../../../infra/project-machine/store-setup.ts';
import { seal } from '../../../infra/project-machine/store-upload.ts';
import { startFakeTigris } from './fake-tigris.ts';

const tigris = startFakeTigris();
const scratch = mkdtempSync(join(tmpdir(), 'cw-store-check-'));
const envelopes: string[] = [];
const sentry = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    envelopes.push(`${new URL(req.url).pathname}\n${await req.text()}`);
    return new Response('{}');
  },
});
const dsn = `http://publickey0123@127.0.0.1:${sentry.port}/42`;
afterAll(() => {
  tigris.stop();
  sentry.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function memoryOps(): SetupOps {
  const entries = new Map<string, string>();
  return {
    keychainHas: (n) => entries.has(n),
    keychainRead: (n) => entries.get(n) ?? '',
    keychainCreate: (n, v) => void entries.set(n, v),
    createBucket: async (name) => tigris.createBucket(name),
    iamUrl: tigris.iamUrl,
  };
}

let bucketN = 0;
async function staged(day: string, faults: Partial<DrillFaults>) {
  const names = storeTestNames(`cw-check-${bucketN++}-test`);
  const ops = memoryOps();
  await setupStoreTest(names, ops);
  const lines: string[] = [];
  const drill = await stageDrill(names, ops, mkdtempSync(join(scratch, 'd-')), day, faults, (l) =>
    lines.push(l),
  );
  const reader = s3Bucket(readCredential(ops, names.reader), names.bucket);
  const identities = Object.values(names.identities).map((n) => ops.keychainRead(n));
  return { names, ops, drill, reader, identities, lines };
}

const none: DrillFaults = { corrupt: false, delete: false, skip: false, duplicate: false };

describe('the check of a day', () => {
  it('is clean on a day with no faults, and raises nothing', async () => {
    const { reader, identities } = await staged('2001-01-01', none);
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST],
      day: '2001-01-01',
      identities,
    });
    // Not vacuous: it opened the day's chunks, from both sides of the midnight.
    expect(counts.chunksOpened).toBeGreaterThanOrEqual(4);
    expect(counts.files).toBe(3);
    expect(counts).toMatchObject({
      invalid: 0,
      deleted: 0,
      skipped: 0,
      conflicting: 0,
      missingInventory: 0,
      duplicates: 0,
    });
    const before = envelopes.length;
    const r = await checkAndAlert(counts, '2001-01-01', dsn);
    expect(r.raised).toBe(0);
    expect(envelopes.length).toBe(before);
  });

  it('finds the deleted, corrupted and skipped chunks across a midnight, and raises each', async () => {
    const { reader, identities, drill } = await staged('2001-02-01', {});
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST],
      day: '2001-02-01',
      identities,
    });
    expect(counts).toMatchObject({
      invalid: 1,
      deleted: 1,
      skipped: 1,
      conflicting: 0,
      missingInventory: 0,
      duplicates: 1,
    });
    // The deleted chunk is the one sent just after midnight, holding bytes from before it.
    expect(drill.deletedKey).toMatch(/\/\d+-[0-9a-f]{16}\.jsonl\.zst\.cw$/);
    const before = envelopes.length;
    const r = await checkAndAlert(counts, '2001-02-01', dsn);
    expect(r.raised).toBe(3);
    const sent = envelopes.slice(before);
    expect(sent).toHaveLength(3);
    for (const e of sent) {
      expect(e.startsWith('/api/42/envelope/')).toBe(true);
      expect(e).toContain('"level":"warning"');
      // Counts only: no session, board or key name reaches Sentry.
      expect(e).not.toContain('drill-');
      expect(e).not.toContain('riverbend');
      expect(e).not.toContain('jsonl');
    }
    const kinds = sent.map((e) => e.match(/"check":"(\w+)"/)?.[1]).sort();
    expect(kinds).toEqual(['deleted', 'invalid', 'skipped']);
  });

  it('the next day opens the chunk that straddles its start, so it finds no gap there', async () => {
    const { reader, identities } = await staged('2001-08-01', none);
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST],
      day: '2001-08-02',
      identities,
    });
    // Only the transcript grew after midnight; its window begins mid-chunk.
    expect(counts.files).toBe(1);
    expect(counts.chunksOpened).toBe(2);
    expect(counts).toMatchObject({ invalid: 0, deleted: 0, skipped: 0, conflicting: 0 });
  });

  it('counts a chunk sent twice once, and raises nothing for it', async () => {
    const { reader, identities } = await staged('2001-03-01', { ...none, duplicate: true });
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST],
      day: '2001-03-01',
      identities,
    });
    expect(counts.duplicates).toBe(1);
    expect(counts).toMatchObject({ invalid: 0, deleted: 0, skipped: 0, conflicting: 0 });
    const before = envelopes.length;
    expect((await checkAndAlert(counts, '2001-03-01', dsn)).raised).toBe(0);
    expect(envelopes.length).toBe(before);
  });

  it('fails a credentialed host with no inventory', async () => {
    const { reader, identities } = await staged('2001-04-01', none);
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST, 'mac'],
      day: '2001-04-01',
      identities,
    });
    expect(counts.missingInventory).toBe(1);
    const before = envelopes.length;
    expect((await checkAndAlert(counts, '2001-04-01', dsn)).raised).toBe(1);
    expect(envelopes.slice(before)[0]).toContain('"check":"missingInventory"');
  });

  it('fails two chunks at one offset with different bytes', async () => {
    const { names, ops, reader, identities, drill } = await staged('2001-05-01', none);
    const admin = s3Bucket(readCredential(ops, names.admin), names.bucket);
    const key = drill.firstKey.replace(/-[0-9a-f]{16}\./, '-0123456789abcdef.');
    const review = recipientOf(ops.keychainRead(names.identities.review));
    await admin.put(key, seal(Buffer.from('{"other":true}\n'), [review]));
    const counts = await runCheck({
      bucket: reader,
      hosts: [FLY_HOST],
      day: '2001-05-01',
      identities,
    });
    expect(counts.conflicting).toBe(1);
    expect(counts.duplicates).toBe(0);
  });

  it('without a DSN raises nothing and says so', async () => {
    const r = await checkAndAlert({ ...(await zeroCounts()), skipped: 2 }, '2001-06-01', undefined);
    expect(r.raised).toBe(0);
    expect(r.failed).toBe(true);
  });
});

async function zeroCounts() {
  const { reader, identities } = await staged('2001-06-01', none);
  return runCheck({ bucket: reader, hosts: [FLY_HOST], day: '2001-06-01', identities });
}

describe('the drill', () => {
  let names: ReturnType<typeof storeTestNames>;
  let ops: SetupOps;
  beforeAll(async () => {
    ({ names, ops } = await staged('2001-07-01', none));
  });
  it('refuses a day it has already staged', async () => {
    await expect(
      stageDrill(names, ops, mkdtempSync(join(scratch, 'again-')), '2001-07-01', none, () => {}),
    ).rejects.toThrow(/already/);
  });
});
