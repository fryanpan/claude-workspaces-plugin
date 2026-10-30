/**
 * Snapshots of a board server's data dir, encrypted on the machine before
 * they leave it, and the restore that puts one back.
 *
 * A snapshot is the data dir as a gzipped tar, encrypted to a recipient
 * public key in `seal.ts`'s v1 format. The machine holds only that public
 * key, so it can write snapshots but cannot read one back, and the bucket
 * sees ciphertext only. The private key (the identity) lives off the
 * machine, with Bryan, and is needed only to restore.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkRecipient, decryptFile, encryptToFile } from './seal.ts';

export {
  type SnapshotKeys,
  checkRecipient,
  decryptFile,
  encryptToFile,
  generateSnapshotKeys,
  openBytes,
  recipientOf,
  sealBytes,
} from './seal.ts';

/**
 * A snapshot holds up to two parts, each its own gzipped tar inside one
 * outer tar: the data dir (`data.tgz`, which carries every board's
 * `events.jsonl` and `agent-notes.jsonl`), and the machine's Claude Code
 * session transcripts (`claude-projects.tgz`, from `~/.claude/projects`).
 * The marker member names the format. A snapshot without it is the first
 * format, a bare tar of the data dir, and still restores.
 */
const MARKER = 'cwsnap-v2';
const PARTS = { data: 'data.tgz', transcripts: 'claude-projects.tgz' } as const;

/**
 * Tars `dir` into `file`. The tar reads a live directory. Every `.ydoc`
 * write is a rename, so each doc is whole; an append-only log may lose a
 * last line being written at that instant. GNU tar exits 1 when a file
 * changed while it read it, which is that case, so 1 is accepted and
 * anything else fails the snapshot.
 */
function tarDir(dir: string, file: string): void {
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const r = spawnSync('tar', ['-czf', file, '-C', dir, '.'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    // macOS tar otherwise adds `._` metadata members; GNU tar ignores it.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`tar of ${dir} exited ${r.status}`);
}

/**
 * Writes an encrypted snapshot of `dataDir`, and of `transcriptsDir` when it
 * is given and exists, to `outPath`. The parts are staged beside `outPath`.
 */
export async function snapshotDataDir(
  dataDir: string,
  recipient: string,
  outPath: string,
  transcriptsDir?: string,
): Promise<void> {
  checkRecipient(recipient);
  const stage = mkdtempSync(join(dirname(outPath), '.cwsnap-stage-'));
  try {
    tarDir(dataDir, join(stage, PARTS.data));
    const parts: string[] = [PARTS.data];
    if (transcriptsDir && existsSync(transcriptsDir)) {
      tarDir(transcriptsDir, join(stage, PARTS.transcripts));
      parts.push(PARTS.transcripts);
    }
    writeFileSync(join(stage, MARKER), `${JSON.stringify({ parts })}\n`);
    const tar = spawn('tar', ['-cf', '-', '-C', stage, MARKER, ...parts], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const exited = new Promise<number>((resolve, reject) => {
      tar.on('error', reject);
      tar.on('close', (code) => resolve(code ?? 1));
    });
    try {
      await encryptToFile(tar.stdout, recipient, outPath);
      const code = await exited;
      if (code !== 0) throw new Error(`tar exited ${code}`);
    } catch (err) {
      rmSync(outPath, { force: true });
      throw err;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export class RestoreRefused extends Error {}

/**
 * Every member of a snapshot must be a plain file or directory with a
 * relative path that stays inside the target. The archive is encrypted to a
 * public key, which proves nothing about who wrote it, so it is read as
 * untrusted input. Both the outer tar and each part are checked.
 */
function checkMembers(tarPath: string): string[] {
  // spawnSync's default 1 MB buffer would cut a listing of a few thousand
  // docs short and read as a broken tar. `-t` reads gzip or plain alike.
  const opts = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 } as const;
  const names = spawnSync('tar', ['-tf', tarPath], opts);
  const long = spawnSync('tar', ['-tvf', tarPath], opts);
  if (names.status !== 0 || long.status !== 0) throw new RestoreRefused('snapshot is not a tar');
  const list = names.stdout.split('\n').filter(Boolean);
  for (const name of list) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new RestoreRefused(`snapshot member escapes the data dir: ${name}`);
    }
  }
  for (const line of long.stdout.split('\n').filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new RestoreRefused(`snapshot holds a member that is not a file or directory: ${line}`);
    }
  }
  return list;
}

function extract(tarPath: string, into: string): void {
  mkdirSync(into, { mode: 0o700 });
  const x = spawnSync('tar', ['-xf', tarPath, '-C', into], { stdio: 'inherit' });
  if (x.status !== 0) throw new Error(`tar extract exited ${x.status}`);
}

function refuseUnlessEmpty(dir: string, what: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new RestoreRefused(`${dir} is not a directory`);
  if (readdirSync(dir).length > 0) {
    throw new RestoreRefused(`${dir} is not empty; restore only onto an empty ${what}`);
  }
}

function moveInto(tree: string, target: string): void {
  // Checked again: the target may have gained a file while this ran.
  if (existsSync(target)) {
    if (readdirSync(target).length > 0) {
      throw new RestoreRefused(`${target} stopped being empty during the restore`);
    }
    rmdirSync(target);
  }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(tree, target);
}

export interface RestoreResult {
  /** Whether the snapshot held transcripts. They are restored only onto a given dir. */
  transcripts: boolean;
}

/**
 * Restores `snapshotPath` onto `dataDir`, and its transcripts onto
 * `transcriptsDir` when one is given. Each target must be missing or empty.
 *
 * Nothing touches a target until the whole snapshot has decrypted and every
 * member has passed `checkMembers`. Each part is extracted to a sibling of
 * the data dir and renamed into place, so a failure part-way leaves the
 * targets as they were and the restore can be run again.
 */
export function restoreSnapshot(
  snapshotPath: string,
  identity: string,
  dataDir: string,
  transcriptsDir?: string,
): RestoreResult {
  refuseUnlessEmpty(dataDir, 'data dir');
  if (transcriptsDir) refuseUnlessEmpty(transcriptsDir, 'transcripts dir');
  const parent = dirname(dataDir);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, `.${basename(dataDir)}.restoring-`));
  try {
    const tarPath = join(work, 'snapshot.tar');
    decryptFile(snapshotPath, identity, tarPath);
    const members = checkMembers(tarPath);
    const outer = join(work, 'outer');
    extract(tarPath, outer);
    if (!members.includes(MARKER)) {
      moveInto(outer, dataDir);
      return { transcripts: false };
    }
    const allowed = new Set<string>([MARKER, PARTS.data, PARTS.transcripts]);
    const odd = members.find((m) => !allowed.has(m));
    if (odd !== undefined) throw new RestoreRefused(`snapshot holds an unknown part: ${odd}`);
    if (!members.includes(PARTS.data)) throw new RestoreRefused('snapshot has no data part');
    const hasTranscripts = members.includes(PARTS.transcripts);
    checkMembers(join(outer, PARTS.data));
    if (hasTranscripts) checkMembers(join(outer, PARTS.transcripts));
    extract(join(outer, PARTS.data), join(work, 'data'));
    if (hasTranscripts && transcriptsDir) {
      extract(join(outer, PARTS.transcripts), join(work, 'transcripts'));
    }
    moveInto(join(work, 'data'), dataDir);
    if (hasTranscripts && transcriptsDir) moveInto(join(work, 'transcripts'), transcriptsDir);
    return { transcripts: hasTranscripts };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
