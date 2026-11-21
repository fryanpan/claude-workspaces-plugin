/**
 * The transcript store's spool (`infra/project-machine/store-spool.ts`): a
 * reader that holds no credential writes sealed objects into it, and the
 * sender, which holds the credential and reads nothing else, puts them and
 * removes them. The sender must refuse what a hostile writer could plant: a
 * link to a file only the sender can read (the positive control is the same
 * bytes as a plain file, which IS sent), a file someone else owns, a key
 * under another host, and a file too large.
 *
 * Then the whole path, through the real uploader and sender modules, into
 * the loopback Tigris (`fake-tigris.ts`) with a credential that may only put
 * under the machine's two hosts.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnapshotKeys } from '../../../infra/project-machine/seal.ts';
import { storeWriterPolicy } from '../../../infra/project-machine/store-plan.ts';
import { readHosts } from '../../../infra/project-machine/store-read.ts';
import { s3Bucket, statusOf } from '../../../infra/project-machine/store-s3.ts';
import { parseSpoolArgs } from '../../../infra/project-machine/store-sender.ts';
import {
  keyOfSpoolName,
  sendSpool,
  spoolName,
  spoolStore,
} from '../../../infra/project-machine/store-spool.ts';
import {
  type ObjectStore,
  openChunk,
  runOnce,
} from '../../../infra/project-machine/store-upload.ts';
import {
  attachPolicy,
  createAccessKey,
  ensurePolicy,
} from '../../../infra/project-machine/tigris.ts';
import { startFakeTigris } from './fake-tigris.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-store-spool-'));
const tigris = startFakeTigris();
afterAll(() => {
  tigris.stop();
  rmSync(scratch, { recursive: true, force: true });
});
const uid = process.getuid?.() ?? 0;
let n = 0;
const dir = () => {
  const d = join(scratch, `s${n++}`);
  mkdirSync(d);
  return d;
};

function memory(): ObjectStore & { got: Map<string, Buffer> } {
  const got = new Map<string, Buffer>();
  return { got, put: async (k, b) => void got.set(k, Buffer.from(b)) };
}

describe('spool names', () => {
  it('stand for object keys one to one, and refuse anything that is not a safe key', () => {
    const key = 'cw-harborlight/transcripts/harborlight/s1/0-ab.jsonl.zst.cw';
    const name = spoolName(key);
    expect(name).toBe('cw-harborlight+transcripts+harborlight+s1+0-ab.jsonl.zst.cw');
    expect(keyOfSpoolName(name ?? '')).toBe(key);
    expect(spoolName('cw-harborlight/../x')).toBeNull();
    expect(spoolName('single')).toBeNull();
    expect(keyOfSpoolName('.tmp-1')).toBeNull();
    expect(keyOfSpoolName('a+..+b')).toBeNull();
  });

  it('parse the sender arguments, and refuse a relative spool', () => {
    expect(parseSpoolArgs(['--spool', '/data/s:cw-harborlight:10001'])).toEqual([
      { dir: '/data/s', host: 'cw-harborlight', ownerUid: 10001 },
    ]);
    expect(() => parseSpoolArgs(['--spool', 'data/s:h:1'])).toThrow(/absolute/);
    expect(() => parseSpoolArgs([])).toThrow(/at least one/);
  });
});

describe('the spool', () => {
  it('holds each object whole, readable by the spool owner, and the sender puts then removes it', async () => {
    const d = dir();
    await spoolStore(d).put(
      'cw-harborlight/events/b/e/2026-11-20/0-aa.jsonl.zst.cw',
      Buffer.from('x'),
    );
    const [name] = readdirSync(d);
    expect(statSync(join(d, name ?? '')).mode & 0o777).toBe(0o644);
    const store = memory();
    const r = await sendSpool([{ dir: d, host: 'cw-harborlight', ownerUid: uid }], store);
    expect(r).toEqual({ sent: 1, bytes: 1, refused: [], failed: [] });
    expect([...store.got.keys()]).toEqual([
      'cw-harborlight/events/b/e/2026-11-20/0-aa.jsonl.zst.cw',
    ]);
    expect(readdirSync(d)).toEqual([]);
  });

  it("leaves a file whose put failed for the next pass, and still sends the other spool's", async () => {
    const d = dir();
    const lead = dir();
    await spoolStore(d).put('cw-harborlight/transcripts/b/s/0-aa.jsonl.zst.cw', Buffer.from('x'));
    await spoolStore(lead).put(
      'cw-harborlight_lead/transcripts/b/s/0-aa.jsonl.zst.cw',
      Buffer.from('y'),
    );
    const got: string[] = [];
    const failingForCw: ObjectStore = {
      put: async (k) => {
        if (k.startsWith('cw-harborlight/')) throw new Error('HTTP 503');
        got.push(k);
      },
    };
    const r = await sendSpool(
      [
        { dir: d, host: 'cw-harborlight', ownerUid: uid },
        { dir: lead, host: 'cw-harborlight_lead', ownerUid: uid },
      ],
      failingForCw,
    );
    expect(r.failed).toEqual([{ host: 'cw-harborlight', error: 'HTTP 503' }]);
    expect(got).toEqual(['cw-harborlight_lead/transcripts/b/s/0-aa.jsonl.zst.cw']);
    expect(readdirSync(d)).toHaveLength(1);
    expect(readdirSync(lead)).toEqual([]);
  });

  it('sends the chunks before the manifest and inventory that list them', async () => {
    const d = dir();
    const put = spoolStore(d).put;
    for (const k of [
      'cw-harborlight/inventory/2026-11-20.json.zst.cw',
      'cw-harborlight/manifests/2026-11-19/events/b/e.json.zst.cw',
      'cw-harborlight/transcripts/b/s/0-aa.jsonl.zst.cw',
      'cw-harborlight/events/b/e/2026-11-19/0-aa.jsonl.zst.cw',
    ])
      await put(k, Buffer.from('x'));
    const store = memory();
    await sendSpool([{ dir: d, host: 'cw-harborlight', ownerUid: uid }], store);
    expect([...store.got.keys()].map((k) => k.split('/')[1])).toEqual([
      'events',
      'transcripts',
      'inventory',
      'manifests',
    ]);
  });

  it('holds, and says why, a chunk the sender would refuse, rather than counting it sent', async () => {
    const files = dir();
    const path = join(files, 's.jsonl');
    writeFileSync(path, `${JSON.stringify({ n: 1 })}\n`);
    const spool = dir();
    const keys = generateSnapshotKeys();
    const opts = {
      sources: [{ path, kind: 'transcript' as const, name: 's', board: 'b' }],
      statePath: join(files, 'state.json'),
      host: 'cw-harborlight',
      keys: { review: keys.recipient, owner: keys.recipient, boards: {} },
      classOf: () => 'private' as const,
    };
    const small = await runOnce({ ...opts, store: spoolStore(spool, 10) });
    expect(small.uploaded).toEqual([]);
    expect(small.held.map((h) => h.reason)).toEqual([
      expect.stringMatching(/over the 10-byte cap/),
    ]);
    expect(readdirSync(spool)).toEqual([]);
    // The control: the same file under the default cap is spooled.
    const plain = await runOnce({ ...opts, store: spoolStore(spool) });
    expect(plain.uploaded).toHaveLength(1);
    expect(plain.held).toEqual([]);
  });

  it('refuses a link to a file only the sender reads, and sends the same bytes as a plain file', async () => {
    const d = dir();
    const secret = join(scratch, `environ-${n}`);
    writeFileSync(secret, 'STORE_S3_SECRET_ACCESS_KEY=stand-in');
    symlinkSync(secret, join(d, 'cw-harborlight+transcripts+b+s+0-aa.jsonl.zst.cw'));
    linkSync(secret, join(d, 'cw-harborlight+transcripts+b+s+1-aa.jsonl.zst.cw'));
    writeFileSync(
      join(d, 'cw-harborlight+transcripts+b+s+2-aa.jsonl.zst.cw'),
      'STORE_S3_SECRET_ACCESS_KEY=stand-in',
    );
    const store = memory();
    const r = await sendSpool([{ dir: d, host: 'cw-harborlight', ownerUid: uid }], store);
    expect(r.refused.map((f) => f.reason)).toEqual(['a link', 'has another name']);
    // The control: the plain file with the same bytes is sent.
    expect([...store.got.keys()]).toEqual(['cw-harborlight/transcripts/b/s/2-aa.jsonl.zst.cw']);
  });

  it("refuses another writer's file, another host's key, and a file over the size cap", async () => {
    const d = dir();
    const put = spoolStore(d).put;
    await put('cw-riverbend/transcripts/b/s/0-aa.jsonl.zst.cw', Buffer.from('x'));
    await put('cw-harborlight/transcripts/b/s/0-aa.jsonl.zst.cw', Buffer.alloc(11));
    writeFileSync(join(d, 'not-a-key'), 'x');
    const store = memory();
    const r = await sendSpool([{ dir: d, host: 'cw-harborlight', ownerUid: uid }], store, 10);
    expect(r.sent).toBe(0);
    expect(r.refused.map((f) => f.reason).sort()).toEqual([
      'larger than 10 bytes',
      'not a key under cw-harborlight/',
      'not a key under cw-harborlight/',
    ]);
    const other = await sendSpool([{ dir: d, host: 'cw-harborlight', ownerUid: uid + 1 }], store);
    expect(other.refused.some((f) => f.reason.startsWith(`owned by uid ${uid}`))).toBe(true);
    expect(store.got.size).toBe(0);
  });
});

describe('from a transcript to the store, through the spool', () => {
  it('reaches the bucket under the machine host with a writer that may put there and nowhere else', async () => {
    const bucket = 'cw-transcript-store';
    const admin = tigris.createBucket(bucket);
    const key = await createAccessKey(admin, tigris.iamUrl);
    const arn = await ensurePolicy(
      admin,
      'cw-harborlight-store-writer',
      storeWriterPolicy(bucket, 'cw-harborlight'),
      tigris.iamUrl,
    );
    await attachPolicy(admin, key.accessKeyId, arn, tigris.iamUrl);
    const writer = s3Bucket({ endpoint: admin.endpoint, ...key }, bucket);

    const review = generateSnapshotKeys();
    const owner = generateSnapshotKeys();
    const files = dir();
    const transcript = join(files, 'session-1.jsonl');
    const events = join(files, 'harborlight.events.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', n: 1 })}\n`);
    writeFileSync(events, `${JSON.stringify({ type: 'task.created', n: 1 })}\n`);
    const spool = dir();
    for (const [host, path, kind, name] of [
      ['cw-harborlight', events, 'event', 'harborlight.events'],
      ['cw-harborlight_lead', transcript, 'transcript', 'session-1'],
    ] as const) {
      await runOnce({
        sources: [{ path, kind, name, board: 'harborlight' }],
        store: spoolStore(spool),
        statePath: join(files, `${host}.state.json`),
        host,
        keys: { review: review.recipient, owner: owner.recipient, boards: {} },
        classOf: () => 'private',
      });
    }
    const sources = ['cw-harborlight', 'cw-harborlight_lead'].map((host) => ({
      dir: spool,
      host,
      ownerUid: uid,
    }));
    // Each host's files are refused under the other, so one spool for both is only a test's.
    const r = await sendSpool(sources, writer);
    expect(r.sent).toBeGreaterThanOrEqual(2);

    const listed = await s3Bucket(admin, bucket).list('');
    const t = listed.find((o) =>
      o.key.startsWith('cw-harborlight_lead/transcripts/harborlight/session-1/'),
    );
    const e = listed.find((o) => o.key.startsWith('cw-harborlight/events/harborlight/'));
    if (!t || !e) throw new Error(`missing objects: ${listed.map((o) => o.key).join(', ')}`);
    const open = async (k: string) =>
      openChunk(await s3Bucket(admin, bucket).get(k), review.identity).toString();
    expect(JSON.parse((await open(t.key)).trim())).toEqual({ type: 'user', n: 1 });
    expect(JSON.parse((await open(e.key)).trim())).toEqual({ type: 'task.created', n: 1 });

    // The Mac's read: counts per host and kind, one chunk of each kind opened, no content.
    const readings = await readHosts(s3Bucket(admin, bucket), 'cw-harborlight', [
      owner.identity,
      review.identity,
    ]);
    expect(readings.map((r) => [r.host, r.opened.map((o) => [o.key, o.lines])])).toEqual([
      ['cw-harborlight', [[e.key, 1]]],
      ['cw-harborlight_lead', [[t.key, 1]]],
    ]);
    expect(readings[1]?.counts.transcripts).toBe(1);

    // The writer: another host is refused, and it cannot read, list or delete.
    expect(
      await statusOf(() =>
        writer.put('cw-riverbend/transcripts/x/y/0-a.jsonl.zst.cw', new Uint8Array([1])),
      ),
    ).toBe(403);
    expect(await statusOf(() => writer.get(t.key))).toBe(403);
    expect(await statusOf(() => writer.list(''))).toBe(403);
    expect(await statusOf(() => writer.delete(t.key))).toBe(403);
  });
});
