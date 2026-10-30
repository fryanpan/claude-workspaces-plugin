/**
 * Steps 1 to 3 of the transcript store's test-bucket proof, run against a
 * bucket `store-setup.ts` made:
 *
 *   1. the Fly-style credential uploads one transcript chunk and one events
 *      chunk for the test board, through the uploader itself (`runOnce`);
 *   2. the Mac-style credential lists and reads both, and each opens with
 *      `seal.ts`'s decrypt (the code `restore.ts` uses) under the review key
 *      AND the board's key, byte for byte; the writer gets 403 on read, list,
 *      delete and a put outside its prefix, the reader 403 on put and delete;
 *   3. the writer overwrites one chunk, and the admin credential reads the
 *      old version back, byte for byte. If this fails, stop.
 *
 * The files are synthetic and written to a scratch dir; each run's session
 * has a name of its own, so runs never collide. Output is one PASS or FAIL
 * line per step and per check, with counts and statuses, never a value.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBytes, recipientOf } from './seal.ts';
import { type Bucket, s3Bucket, statusOf } from './store-s3.ts';
import {
  FLY_HOST,
  type SetupOps,
  type StoreTestNames,
  TEST_BOARD,
  readCredential,
} from './store-setup.ts';
import { type StoreKeys, type UploadSource, runOnce, seal } from './store-upload.ts';

export type Log = (line: string) => void;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The chunk's plaintext, opened the way the restore opens a snapshot. */
const open = (body: Uint8Array, identity: string): Buffer =>
  Buffer.from(Bun.zstdDecompressSync(openBytes(body, identity)));

/** Synthetic JSONL: a short session and a few board events, fixture names only. */
export function syntheticFiles(dir: string, run: string): { transcript: string; events: string } {
  const transcript = join(dir, 'projects', `-proof-${TEST_BOARD}`, `${run}.jsonl`);
  const events = join(dir, 'data', 'workspaces', `${TEST_BOARD}.events.jsonl`);
  mkdirSync(join(transcript, '..'), { recursive: true });
  mkdirSync(join(events, '..'), { recursive: true });
  const lines = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  writeFileSync(
    transcript,
    lines([
      { type: 'user', message: { role: 'user', content: 'Plan the Harborlight ferry move.' } },
      {
        type: 'assistant',
        message: { model: 'claude-test', usage: { input_tokens: 9, output_tokens: 4 } },
        content: 'Riverbend first, then Saltmarsh.',
      },
    ]),
  );
  writeFileSync(
    events,
    lines([
      { type: 'task.created', by: 'Alice', at: new Date().toISOString(), run },
      { type: 'comment.added', by: 'Bob', at: new Date().toISOString(), run },
    ]),
  );
  return { transcript, events };
}

interface Steps {
  ok: boolean;
  check(cond: boolean, step: number, what: string): boolean;
}

function steps(log: Log): Steps {
  const s: Steps = {
    ok: true,
    check(cond, step, what) {
      log(`${cond ? 'ok  ' : 'FAIL'} step ${step}: ${what}`);
      if (!cond) s.ok = false;
      return cond;
    },
  };
  return s;
}

export async function proveStore(
  names: StoreTestNames,
  ops: Pick<SetupOps, 'keychainRead'>,
  scratch: string,
  log: Log,
): Promise<boolean> {
  const identity = (n: string) => ops.keychainRead(n).trim();
  const ids = {
    review: identity(names.identities.review),
    owner: identity(names.identities.owner),
    board: identity(names.identities.board),
  };
  const keys: StoreKeys = {
    review: recipientOf(ids.review),
    owner: recipientOf(ids.owner),
    boards: { [TEST_BOARD]: recipientOf(ids.board) },
  };
  const bucketFor = (entry: string): Bucket => s3Bucket(readCredential(ops, entry), names.bucket);
  const writer = bucketFor(names.writer);
  const reader = bucketFor(names.reader);
  const admin = bucketFor(names.admin);
  const s = steps(log);
  const run = `proof-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;

  // Step 1: upload through the uploader, with the write-only credential.
  const files = syntheticFiles(scratch, run);
  const sources: UploadSource[] = [
    { path: files.transcript, kind: 'transcript', name: run, board: TEST_BOARD },
    { path: files.events, kind: 'event', name: `${run}.events`, board: TEST_BOARD },
  ];
  const report = await runOnce({
    sources,
    store: writer,
    statePath: join(scratch, 'state.json'),
    host: FLY_HOST,
    keys,
    classOf: () => 'private',
  });
  const [tKey, eKey] = report.uploaded.map((u) => u.key);
  if (
    !s.check(
      report.uploaded.length === 2 && !!tKey && !!eKey,
      1,
      `${report.uploaded.length} chunks put as ${FLY_HOST} (want 2)`,
    ) ||
    !tKey ||
    !eKey
  ) {
    log('FAIL step 1');
    return false;
  }
  log(`PASS step 1: uploaded one transcript chunk and one events chunk as ${FLY_HOST}`);

  // Step 2: the reader lists and reads; both keys open; the writer is refused.
  const listed = (await reader.list(`${FLY_HOST}/`)).map((o) => o.key);
  s.check(
    listed.includes(tKey) && listed.includes(eKey),
    2,
    'the reading credential lists both chunks',
  );
  let bytes = 0;
  for (const [key, path] of [
    [tKey, files.transcript],
    [eKey, files.events],
  ] as const) {
    const body = await reader.get(key);
    const plain = readFileSync(path);
    for (const [who, id] of [
      ['review', ids.review],
      ['board', ids.board],
    ] as const) {
      let same = false;
      try {
        same = open(body, id).equals(plain);
      } catch {
        same = false;
      }
      s.check(same, 2, `a ${key.split('/')[1]} chunk opens with the ${who} key, byte for byte`);
    }
    let ownerOpened = true;
    try {
      open(body, ids.owner);
    } catch {
      ownerOpened = false;
    }
    s.check(!ownerOpened, 2, 'the owner key, which it was not sealed to, does not open it');
    bytes += plain.length;
  }
  const refusals: [string, Bucket, () => Promise<unknown>][] = [
    ['can the write-only credential read a chunk', writer, () => writer.get(tKey)],
    ['can the write-only credential list the bucket', writer, () => writer.list(`${FLY_HOST}/`)],
    ['can the write-only credential delete a chunk', writer, () => writer.delete(tKey)],
    [
      'can the write-only credential put outside its prefix',
      writer,
      () => writer.put(`mac/${run}`, new Uint8Array([1])),
    ],
    [
      'can the reading credential put a chunk',
      reader,
      () => reader.put(`${FLY_HOST}/${run}`, new Uint8Array([1])),
    ],
    ['can the reading credential delete a chunk', reader, () => reader.delete(tKey)],
  ];
  for (const [what, , fn] of refusals) {
    const status = await statusOf(fn);
    s.check(status === 403, 2, `${what}? HTTP ${status} (want 403)`);
  }
  if (!s.ok) {
    log('FAIL step 2');
    return false;
  }
  log(
    `PASS step 2: both chunks (${bytes} bytes) open with the review and board keys; 6 refusals were 403`,
  );

  // Step 3: overwrite with the write-only credential, read the old version as admin.
  const original = await admin.get(tKey);
  const replaced = seal(Buffer.from('{"overwritten":true}\n'), [keys.review]);
  s.check(
    (await statusOf(() => writer.put(tKey, replaced))) === 200,
    3,
    'the write-only credential overwrote a chunk it named',
  );
  const versioning = await admin.getVersioning();
  const versions = (await admin.listVersions(tKey)).filter(
    (v) => v.key === tKey && !v.deleteMarker,
  );
  const old = versions.find((v) => !v.isLatest);
  let restored = false;
  if (old) {
    const body = await admin.get(tKey, old.versionId);
    restored =
      sha(body) === sha(original) && open(body, ids.review).equals(readFileSync(files.transcript));
  }
  s.check(versioning === 'Enabled', 3, `versioning reads ${versioning}`);
  s.check(versions.length >= 2, 3, `${versions.length} versions of the overwritten chunk (want 2)`);
  s.check(restored, 3, 'the old version reads back byte for byte with the admin credential');
  if (!s.ok) {
    log('FAIL step 3: an overwrite is not recoverable. STOP: do not go on to step 4');
    return false;
  }
  log('PASS step 3: the overwritten chunk’s old version reads back byte for byte');
  return true;
}
