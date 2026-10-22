/**
 * The refusals around a project machine's snapshots: a restore never lands on
 * a data dir that holds anything, never on an altered or wrongly-keyed
 * snapshot, and never extracts a member that could escape the target. And the
 * upload is write-only: against a stand-in bucket on loopback, `backup.ts`
 * makes PUTs and nothing else.
 *
 * Keys are generated inside the test; the bucket is a Bun.serve on 127.0.0.1.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RestoreRefused,
  encryptToFile,
  generateSnapshotKeys,
  restoreSnapshot,
  snapshotDataDir,
} from '../../../infra/project-machine/snapshot.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-snapshot-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function fresh(name: string): string {
  const dir = join(scratch, `${name}-${n++}`);
  mkdirSync(dir);
  return dir;
}

/** A small data dir: a Riverbend doc file and a nested Saltmarsh one. */
function sampleDataDir(): string {
  const dir = fresh('data');
  writeFileSync(join(dir, 'riverbend.ydoc'), 'riverbend survey');
  mkdirSync(join(dir, 'meetings'));
  writeFileSync(join(dir, 'meetings', 'saltmarsh.json'), '{"title":"Saltmarsh"}');
  return dir;
}

async function sampleSnapshot(recipient: string): Promise<string> {
  const out = join(fresh('snap'), 'snapshot.cwsnap');
  await snapshotDataDir(sampleDataDir(), recipient, out);
  return out;
}

describe('restore refuses', () => {
  const keys = generateSnapshotKeys();

  it('a data dir that holds anything, and leaves it as it was', async () => {
    const snapshot = await sampleSnapshot(keys.recipient);
    const target = fresh('target');
    writeFileSync(join(target, '.keep'), 'Harborlight');
    expect(() => restoreSnapshot(snapshot, keys.identity, target)).toThrow(RestoreRefused);
    expect(readdirSync(target)).toEqual(['.keep']);
    expect(readFileSync(join(target, '.keep'), 'utf8')).toBe('Harborlight');
  });

  it('nothing when the dir is empty or missing', async () => {
    const snapshot = await sampleSnapshot(keys.recipient);
    const empty = fresh('target');
    restoreSnapshot(snapshot, keys.identity, empty);
    expect(readFileSync(join(empty, 'meetings', 'saltmarsh.json'), 'utf8')).toContain('Saltmarsh');
    const missing = join(scratch, `missing-${n++}`);
    restoreSnapshot(snapshot, keys.identity, missing);
    expect(readFileSync(join(missing, 'riverbend.ydoc'), 'utf8')).toBe('riverbend survey');
  });

  it('the wrong identity, an altered byte and a truncated file, writing nothing', async () => {
    const snapshot = await sampleSnapshot(keys.recipient);
    const bytes = readFileSync(snapshot);
    const other = generateSnapshotKeys();

    const altered = join(fresh('bad'), 'altered.cwsnap');
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1;
    writeFileSync(altered, flipped);

    const truncated = join(fresh('bad'), 'truncated.cwsnap');
    writeFileSync(truncated, bytes.subarray(0, bytes.length - 5));

    for (const [file, identity] of [
      [snapshot, other.identity],
      [altered, keys.identity],
      [truncated, keys.identity],
    ] as const) {
      const target = join(scratch, `never-${n++}`);
      expect(() => restoreSnapshot(file, identity, target)).toThrow(/did not decrypt/);
      expect(existsSync(target)).toBe(false);
      // No half-restored work dir is left beside the target either.
      expect(readdirSync(scratch).some((e) => e.includes('.restoring-'))).toBe(false);
    }
  });

  it('a snapshot holding a symlink, even one encrypted to the right key', async () => {
    const hostile = fresh('hostile');
    symlinkSync('/etc', join(hostile, 'escape'));
    const tarFile = join(fresh('tar'), 'hostile.tar.gz');
    const t = spawnSync('tar', ['-czf', tarFile, '-C', hostile, '.']);
    expect(t.status).toBe(0);
    const snapshot = join(fresh('snap'), 'hostile.cwsnap');
    await encryptToFile(createReadStream(tarFile), keys.recipient, snapshot);
    const target = join(scratch, `never-${n++}`);
    expect(() => restoreSnapshot(snapshot, keys.identity, target)).toThrow(/not a file or dir/);
    expect(existsSync(target)).toBe(false);
  });

  it('through the CLI, with exit 3 and the data dir untouched', async () => {
    const snapshot = await sampleSnapshot(keys.recipient);
    const target = fresh('target');
    writeFileSync(join(target, 'activity.jsonl'), '{}\n');
    const identityFile = join(fresh('id'), 'identity.key');
    writeFileSync(identityFile, keys.identity, { mode: 0o600 });
    const r = spawnSync(
      'bun',
      [
        join(repoRoot, 'infra', 'project-machine', 'restore.ts'),
        '--snapshot',
        snapshot,
        '--identity-file',
        identityFile,
        '--data-dir',
        target,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('is not empty');
    expect(readdirSync(target)).toEqual(['activity.jsonl']);
  });
});

describe('backup upload', () => {
  it('only ever PUTs a new key, and what it put restores', async () => {
    const keys = generateSnapshotKeys();
    const seen: string[] = [];
    const objects = new Map<string, Uint8Array>();
    const bucket = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}${url.search}`);
        if (req.method !== 'PUT') return new Response('AccessDenied', { status: 403 });
        objects.set(url.pathname, new Uint8Array(await req.arrayBuffer()));
        return new Response('', { status: 200, headers: { etag: '"x"' } });
      },
    });
    try {
      const dataDir = sampleDataDir();
      // Async: a spawnSync would block this process, and the stand-in bucket
      // it serves from with it.
      const child = Bun.spawn(['bun', join(repoRoot, 'infra', 'project-machine', 'backup.ts')], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          CW_DATA_DIR: dataDir,
          BACKUP_RECIPIENT: keys.recipient,
          BACKUP_S3_ENDPOINT: `http://127.0.0.1:${bucket.port}`,
          BACKUP_S3_BUCKET: 'harborlight-backups',
          BACKUP_S3_REGION: 'auto',
          // Obviously fake: the stand-in bucket checks no signature.
          BACKUP_S3_ACCESS_KEY_ID: 'test-access-key',
          BACKUP_S3_SECRET_ACCESS_KEY: 'test-secret-key',
        },
      });
      const r = {
        status: await child.exited,
        stderr: await new Response(child.stderr).text(),
      };
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(
        /^PUT \/harborlight-backups\/snapshots\/[^/]+\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ-[0-9a-f]{8}\.cwsnap$/,
      );
      // The staging dir beside the data dir is gone.
      expect(readdirSync(dirname(dataDir)).some((e) => e.startsWith('.backup-'))).toBe(false);

      const [body] = [...objects.values()];
      const downloaded = join(fresh('dl'), 'downloaded.cwsnap');
      writeFileSync(downloaded, body ?? new Uint8Array());
      const target = join(scratch, `restored-${n++}`);
      restoreSnapshot(downloaded, keys.identity, target);
      expect(readFileSync(join(target, 'riverbend.ydoc'), 'utf8')).toBe('riverbend survey');
    } finally {
      bucket.stop(true);
    }
  }, 30_000);
});

/** A transcripts dir as Claude Code lays one out: a folder per project. */
function sampleTranscripts(): string {
  const dir = fresh('transcripts');
  mkdirSync(join(dir, '-data-riverbend'));
  writeFileSync(
    join(dir, '-data-riverbend', 'session-1.jsonl'),
    '{"type":"user","text":"Harborlight"}\n',
  );
  return dir;
}

describe('transcripts and the first format', () => {
  const keys = generateSnapshotKeys();

  it('restores the data dir and the transcripts each onto its own dir', async () => {
    const out = join(fresh('snap'), 'snapshot.cwsnap');
    await snapshotDataDir(sampleDataDir(), keys.recipient, out, sampleTranscripts());
    const data = join(scratch, `data-${n++}`);
    const transcripts = join(scratch, `transcripts-${n++}`);
    expect(restoreSnapshot(out, keys.identity, data, transcripts)).toEqual({ transcripts: true });
    expect(readFileSync(join(data, 'riverbend.ydoc'), 'utf8')).toBe('riverbend survey');
    expect(readFileSync(join(transcripts, '-data-riverbend', 'session-1.jsonl'), 'utf8')).toBe(
      '{"type":"user","text":"Harborlight"}\n',
    );
    // The parts never leak into the data dir.
    expect(readdirSync(data).sort()).toEqual(['meetings', 'riverbend.ydoc']);
  });

  it('restores the data dir alone when no transcripts dir is named, and says it held some', async () => {
    const out = join(fresh('snap'), 'snapshot.cwsnap');
    await snapshotDataDir(sampleDataDir(), keys.recipient, out, sampleTranscripts());
    const data = join(scratch, `data-${n++}`);
    expect(restoreSnapshot(out, keys.identity, data)).toEqual({ transcripts: true });
    expect(readdirSync(data).sort()).toEqual(['meetings', 'riverbend.ydoc']);
  });

  it('refuses a transcripts dir that holds anything, before touching the data dir', async () => {
    const out = join(fresh('snap'), 'snapshot.cwsnap');
    await snapshotDataDir(sampleDataDir(), keys.recipient, out, sampleTranscripts());
    const data = join(scratch, `data-${n++}`);
    const transcripts = fresh('transcripts');
    writeFileSync(join(transcripts, 'kept.jsonl'), '{}\n');
    expect(() => restoreSnapshot(out, keys.identity, data, transcripts)).toThrow(RestoreRefused);
    expect(existsSync(data)).toBe(false);
    expect(readdirSync(transcripts)).toEqual(['kept.jsonl']);
  });

  it('still restores a snapshot in the first format, a bare tar of the data dir', async () => {
    const tarFile = join(fresh('tar'), 'v1.tar.gz');
    expect(spawnSync('tar', ['-czf', tarFile, '-C', sampleDataDir(), '.']).status).toBe(0);
    const snapshot = join(fresh('snap'), 'v1.cwsnap');
    await encryptToFile(createReadStream(tarFile), keys.recipient, snapshot);
    const data = join(scratch, `data-${n++}`);
    expect(restoreSnapshot(snapshot, keys.identity, data)).toEqual({ transcripts: false });
    expect(readFileSync(join(data, 'riverbend.ydoc'), 'utf8')).toBe('riverbend survey');
  });

  it('refuses a part that holds a symlink', async () => {
    const hostile = fresh('hostile');
    symlinkSync('/etc', join(hostile, 'escape'));
    const out = join(fresh('snap'), 'snapshot.cwsnap');
    await snapshotDataDir(sampleDataDir(), keys.recipient, out, hostile);
    expect(() =>
      restoreSnapshot(out, keys.identity, join(scratch, `d-${n++}`), join(scratch, `t-${n++}`)),
    ).toThrow(/not a file or dir/);
  });
});
