#!/usr/bin/env bun
/**
 * Snapshot the data dir, encrypt it, and put it in the project's bucket.
 *
 *   bun infra/project-machine/backup.ts                  snapshot and upload, in one process
 *   bun infra/project-machine/backup.ts --out <file>     write the snapshot locally
 *   bun infra/project-machine/backup.ts --upload <file>  upload a snapshot --out wrote
 *
 * The machine runs the last two as two users (backup-once.sh), so the board
 * server's user never holds the bucket credential: `--out` needs no secret,
 * and `--upload` needs nothing but the bucket's settings.
 *
 * Configuration is environment only, so no credential is ever an argument
 * that `ps` would show:
 *
 *   CW_DATA_DIR                   the data dir to snapshot (with every board's
 *                                 events.jsonl and agent-notes.jsonl in it)
 *   BACKUP_TRANSCRIPTS_DIR        optional; Claude Code's session transcripts
 *                                 (~/.claude/projects), snapshotted beside it
 *   BACKUP_RECIPIENT              the public key snapshots are encrypted to
 *   BACKUP_S3_ENDPOINT            an S3-compatible endpoint, e.g. https://storage.googleapis.com
 *   BACKUP_S3_BUCKET              the project's own bucket
 *   BACKUP_S3_REGION              optional; "auto" when unset
 *   BACKUP_S3_PREFIX              optional; "snapshots/" when unset
 *   BACKUP_S3_ACCESS_KEY_ID       a credential that may create objects and nothing else
 *   BACKUP_S3_SECRET_ACCESS_KEY
 *
 * The upload is one PUT of a new key. Nothing here lists, reads or deletes,
 * so a credential with create-only permission is enough, and old snapshots
 * are pruned by the bucket's own lifecycle rule rather than by the machine.
 */
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { snapshotDataDir } from './snapshot.ts';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[backup] ${name} is not set`);
    process.exit(2);
  }
  return v;
}

/** `snapshots/<host>/2026-10-16T09-30-00Z-<8 hex>.cwsnap`: never reused. */
export function snapshotKey(prefix: string, host: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
  const p = prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`;
  return `${p}${host}/${stamp}-${randomBytes(4).toString('hex')}.cwsnap`;
}

interface Bucket {
  client: Bun.S3Client;
  prefix: string;
}

function bucketFromEnv(): Bucket {
  const endpoint = need('BACKUP_S3_ENDPOINT');
  const bucket = need('BACKUP_S3_BUCKET');
  const accessKeyId = need('BACKUP_S3_ACCESS_KEY_ID');
  const secretAccessKey = need('BACKUP_S3_SECRET_ACCESS_KEY');
  const region = process.env.BACKUP_S3_REGION?.trim() || 'auto';
  const prefix = process.env.BACKUP_S3_PREFIX?.trim() ?? 'snapshots/';
  return {
    client: new Bun.S3Client({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
    prefix,
  };
}

/**
 * Put one snapshot file in the bucket under a new key. Under `--upload` the
 * file is in a directory another user writes, so it is opened without
 * following a symlink and must be a regular file: a link there must not make
 * this process upload what only it can read, its own environment among it.
 */
async function upload(bucket: Bucket, file: string): Promise<void> {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    const key = snapshotKey(bucket.prefix, hostname(), new Date());
    await bucket.client.write(key, Bun.file(fd), { type: 'application/octet-stream' });
    console.log(`[backup] uploaded ${key} (${stat.size} bytes)`);
  } finally {
    closeSync(fd);
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) {
    console.error(`[backup] ${flag} needs a file path`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const uploadFile = flagValue(args, '--upload');
  if (uploadFile) {
    await upload(bucketFromEnv(), resolve(uploadFile));
    return;
  }
  const outFile = flagValue(args, '--out');
  const dataDir = resolve(need('CW_DATA_DIR'));
  const recipient = need('BACKUP_RECIPIENT');
  const transcripts = process.env.BACKUP_TRANSCRIPTS_DIR?.trim() || undefined;

  if (outFile) {
    await snapshotDataDir(dataDir, recipient, resolve(outFile), transcripts);
    console.log(`[backup] wrote ${resolve(outFile)} (${statSync(outFile).size} bytes)`);
    return;
  }

  const bucket = bucketFromEnv();

  // Staged beside the data dir, on the same volume, not in /tmp: the
  // machine's root filesystem is small and does not survive a restart.
  const work = mkdtempSync(join(dirname(dataDir), '.backup-'));
  try {
    const file = join(work, 'snapshot.cwsnap');
    await snapshotDataDir(dataDir, recipient, file, transcripts);
    await upload(bucket, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // The S3 client's errors name the request, never the secret key.
    console.error(`[backup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
