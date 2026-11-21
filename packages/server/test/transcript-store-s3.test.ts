/**
 * The transcript store's S3 calls (`infra/project-machine/store-s3.ts`) and
 * the Tigris IAM calls the store's setup adds, against the loopback stand-in
 * in `fake-tigris.ts`, which checks every signature and every policy.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { writeOnlyPolicy } from '../../../infra/project-machine/deploy-plan.ts';
import { S3Error, s3Bucket, statusOf } from '../../../infra/project-machine/store-s3.ts';
import {
  attachPolicy,
  createAccessKey,
  ensurePolicy,
} from '../../../infra/project-machine/tigris.ts';
import { startFakeTigris } from './fake-tigris.ts';

const tigris = startFakeTigris();
afterAll(() => tigris.stop());

describe('the bucket calls', () => {
  it('put, get, list past a page, delete; versions keep what an overwrite replaced', async () => {
    const admin = tigris.createBucket('cw-s3-a');
    const b = s3Bucket(admin, 'cw-s3-a');
    expect(await b.getVersioning()).toBe('Off');
    await b.enableVersioning();
    expect(await b.getVersioning()).toBe('Enabled');

    const body = new Uint8Array([0, 1, 2, 255, 10]);
    await b.put('mac/transcripts/riverbend/s/0-aa.jsonl.zst.cw', body);
    await b.put('mac/transcripts/riverbend/s/5-bb.jsonl.zst.cw', new Uint8Array([7]));
    await b.put('mac/events/riverbend/e/2026-10-29/0-cc.jsonl.zst.cw', new Uint8Array([8]));
    expect([...(await b.get('mac/transcripts/riverbend/s/0-aa.jsonl.zst.cw'))]).toEqual([...body]);
    // The stand-in pages by two, so all three come back only by following the token.
    expect((await b.list('mac/')).map((o) => o.key)).toEqual([
      'mac/events/riverbend/e/2026-10-29/0-cc.jsonl.zst.cw',
      'mac/transcripts/riverbend/s/0-aa.jsonl.zst.cw',
      'mac/transcripts/riverbend/s/5-bb.jsonl.zst.cw',
    ]);
    expect((await b.list('mac/transcripts/'))[0]?.size).toBe(5);

    await b.put('mac/transcripts/riverbend/s/0-aa.jsonl.zst.cw', new Uint8Array([9]));
    const versions = await b.listVersions('mac/transcripts/riverbend/s/0-aa');
    expect(versions.map((v) => v.isLatest)).toEqual([true, false]);
    const old = versions.find((v) => !v.isLatest);
    if (!old) throw new Error('no old version');
    expect([...(await b.get(old.key, old.versionId))]).toEqual([...body]);

    await b.delete('mac/transcripts/riverbend/s/5-bb.jsonl.zst.cw');
    expect((await b.list('mac/transcripts/')).map((o) => o.key)).toEqual([
      'mac/transcripts/riverbend/s/0-aa.jsonl.zst.cw',
    ]);
    const err = await b.get('mac/transcripts/riverbend/s/5-bb.jsonl.zst.cw').catch((e) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect((err as S3Error).status).toBe(404);
  });

  it('a credential with the wrong secret is refused, so the signature is really checked', async () => {
    const admin = tigris.createBucket('cw-s3-b');
    const wrong = s3Bucket({ ...admin, secretAccessKey: 'not-the-secret' }, 'cw-s3-b');
    expect(await statusOf(() => wrong.list(''))).toBe(403);
    expect(await statusOf(() => s3Bucket(admin, 'cw-s3-b').list(''))).toBe(200);
  });
});

describe('a minted write-only credential', () => {
  it('puts under its prefix only, and cannot read, list or delete', async () => {
    const admin = tigris.createBucket('cw-s3-c');
    const key = await createAccessKey(admin, tigris.iamUrl);
    const arn = await ensurePolicy(
      admin,
      'cw-s3-c-writer',
      writeOnlyPolicy('cw-s3-c', 'fly/'),
      tigris.iamUrl,
    );
    // A second ensure finds the first by name.
    expect(
      await ensurePolicy(
        admin,
        'cw-s3-c-writer',
        writeOnlyPolicy('cw-s3-c', 'fly/'),
        tigris.iamUrl,
      ),
    ).toBe(arn);
    await attachPolicy(admin, key.accessKeyId, arn, tigris.iamUrl);
    const w = s3Bucket({ endpoint: admin.endpoint, ...key }, 'cw-s3-c');
    expect(await statusOf(() => w.put('fly/x', new Uint8Array([1])))).toBe(200);
    expect(await statusOf(() => w.put('mac/x', new Uint8Array([1])))).toBe(403);
    expect(await statusOf(() => w.get('fly/x'))).toBe(403);
    expect(await statusOf(() => w.list('fly/'))).toBe(403);
    expect(await statusOf(() => w.delete('fly/x'))).toBe(403);
  });
});
