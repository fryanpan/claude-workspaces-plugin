/**
 * Steps 1 to 3 of the transcript store's test-bucket proof
 * (`store-setup.ts`, `store-prove.ts`) against the loopback Tigris in
 * `fake-tigris.ts`: the setup is idempotent and prints no secret, and the
 * proof passes on a bucket set up that way and fails on each thing it exists
 * to catch.
 *
 * The Keychain is a map; every key and credential is made inside the test.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveStore } from '../../../infra/project-machine/store-prove.ts';
import {
  type SetupOps,
  readCredential,
  setupStoreTest,
  storeTestNames,
} from '../../../infra/project-machine/store-setup.ts';
import { attachPolicy, ensurePolicy } from '../../../infra/project-machine/tigris.ts';
import { startFakeTigris } from './fake-tigris.ts';

const tigris = startFakeTigris();
const scratch = mkdtempSync(join(tmpdir(), 'cw-store-proof-'));
afterAll(() => {
  tigris.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function memoryOps(): SetupOps & { entries: Map<string, string>; buckets: string[] } {
  const entries = new Map<string, string>();
  const buckets: string[] = [];
  return {
    entries,
    buckets,
    keychainHas: (n) => entries.has(n),
    keychainRead: (n) => {
      const v = entries.get(n);
      if (v === undefined) throw new Error(`Keychain has no entry ${n}`);
      return v;
    },
    keychainCreate: (n, v) => {
      if (entries.has(n)) throw new Error(`Keychain already has ${n}`);
      entries.set(n, v);
    },
    createBucket: async (name) => {
      buckets.push(name);
      return tigris.createBucket(name);
    },
    iamUrl: tigris.iamUrl,
  };
}

/** Every secret value the Keychain holds, so output can be searched for each. */
function secrets(entries: Map<string, string>): string[] {
  return [...entries.values()].flatMap((v) => {
    if (v.startsWith('cwsnap-key-')) return [v, v.slice('cwsnap-key-'.length)];
    const c = JSON.parse(v) as { secretAccessKey?: string };
    return c.secretAccessKey ? [c.secretAccessKey] : [];
  });
}

describe('the setup', () => {
  it('makes the bucket, versioning, keys and both credentials once; a second run does nothing', async () => {
    const names = storeTestNames('cw-proof-a-test');
    const ops = memoryOps();
    expect(await setupStoreTest(names, ops, true)).toHaveLength(7);
    expect(ops.entries.size).toBe(0);
    const first = await setupStoreTest(names, ops);
    expect(first).toHaveLength(7);
    expect(tigris.buckets.get('cw-proof-a-test')?.versioning).toBe('Enabled');
    const keysAfterFirst = tigris.log.filter((l) => l.includes('/iam/')).length;
    expect(await setupStoreTest(names, ops)).toEqual([]);
    expect(ops.buckets).toEqual(['cw-proof-a-test']);
    expect(tigris.log.filter((l) => l.includes('/iam/')).length).toBe(keysAfterFirst);
    // Names only: no line holds any secret the Keychain now holds.
    const text = first.join('\n');
    for (const s of secrets(ops.entries)) expect(text).not.toContain(s);
    expect(secrets(ops.entries).length).toBeGreaterThanOrEqual(6);
  });

  it('refuses a bucket that is not a test bucket', () => {
    expect(() => storeTestNames('cw-store')).toThrow(/-test/);
  });
});

async function setUp(bucket: string) {
  const names = storeTestNames(bucket);
  const ops = memoryOps();
  await setupStoreTest(names, ops);
  const lines: string[] = [];
  const run = () =>
    proveStore(names, ops, mkdtempSync(join(scratch, 'run-')), (l) => lines.push(l));
  return { names, ops, lines, run };
}

describe('the proof', () => {
  it('passes on a bucket the setup made, and prints no secret', async () => {
    const { ops, lines, run } = await setUp('cw-proof-b-test');
    expect(await run()).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('PASS step 1');
    expect(text).toContain('PASS step 2');
    expect(text).toContain('PASS step 3');
    expect(text).not.toContain('FAIL');
    for (const s of secrets(ops.entries)) expect(text).not.toContain(s);
    // It ran twice without colliding: every run's chunks have names of their own.
    expect(await run()).toBe(true);
  });

  it('fails step 2 when the writing credential can also read', async () => {
    const { names, ops, lines, run } = await setUp('cw-proof-c-test');
    const admin = readCredential(ops, names.admin);
    const writer = readCredential(ops, names.writer);
    const arn = await ensurePolicy(
      admin,
      'too-wide',
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${names.bucket}/*`],
          },
        ],
      }),
      tigris.iamUrl,
    );
    await attachPolicy(admin, writer.accessKeyId, arn, tigris.iamUrl);
    expect(await run()).toBe(false);
    expect(lines.join('\n')).toMatch(
      /FAIL step 2: can the write-only credential read a chunk\? HTTP 200/,
    );
  });

  it('fails step 3, and says stop, when versioning is off', async () => {
    const { names, lines, run } = await setUp('cw-proof-d-test');
    const b = tigris.buckets.get(names.bucket);
    if (!b) throw new Error('no bucket');
    b.versioning = 'Suspended';
    expect(await run()).toBe(false);
    expect(lines.join('\n')).toMatch(/FAIL step 3: .*STOP/);
  });
});
