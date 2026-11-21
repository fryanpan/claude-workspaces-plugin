import { randomBytes } from 'node:crypto';
/**
 * The transcript store's spool: how a project machine sends a file it can
 * read only as one user with a credential only another user holds.
 *
 * Claude Code writes every transcript 0600, so only the user whose session
 * it is can read it: `cw` its own, `lead` the lead's. Neither may hold the
 * store's credential (a user's processes can read each other's
 * environment). So, as the backup does it (`backup-once.sh`), each file's
 * owner runs the uploader with `spoolStore` in place of the bucket: it reads,
 * compresses and seals with public keys only, and writes each object into a
 * spool. `cwstore`, which holds the credential and reads nothing else, sends
 * what it finds there (`sendSpool`) and removes each file once its put
 * succeeds.
 *
 * Each spool is `cwstore:<owner>` mode 3770 (`entrypoint.sh`): the owner's
 * group may add files, the sticky bit lets no one but `cwstore` remove them,
 * and no third user can enter. A spool file's name is its object key with `/`
 * written as `+`. The sender refuses, and leaves in place, any file that is
 * not a regular file owned by the spool's writer, that is a link, that is too
 * large, or whose key is not under the writer's own host: a writer that
 * plants a link to `/proc/self/environ` must not get the sender's
 * credential uploaded, and one writer must not put under another's host.
 */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { type ObjectStore, validSegment } from './store-upload.ts';

/** A sealed chunk is at most 8 MiB of plain text unless one line is longer. */
export const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const TMP = '.tmp-';

/** The spool file name for `key`, or null when `key` is not a safe object key. */
export function spoolName(key: string): string | null {
  const parts = key.split('/');
  return parts.length >= 2 && parts.every(validSegment) ? parts.join('+') : null;
}

/** The object key a spool file name stands for, or null. */
export function keyOfSpoolName(name: string): string | null {
  if (name.startsWith('.')) return null;
  const key = name.split('+').join('/');
  return spoolName(key) === name ? key : null;
}

/** An `ObjectStore` that writes each object into `dir`, whole or not at all. */
export function spoolStore(dir: string): ObjectStore {
  return {
    async put(key, body) {
      const name = spoolName(key);
      if (name === null) throw new Error(`${JSON.stringify(key)} is not a safe object key`);
      const tmp = join(dir, `${TMP}${randomBytes(8).toString('hex')}`);
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        let off = 0;
        while (off < body.length) off += writeSync(fd, body, off, body.length - off);
        // Readable by the spool's owner, cwstore, past this writer's umask.
        // The spool itself admits no third user.
        fchmodSync(fd, 0o644);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(dir, name));
    },
  };
}

/** Removes this writer's own half-written files, left by a pass that died. */
export function clearSpoolTemps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(TMP)) unlinkSync(join(dir, name));
  }
}

export interface SpoolSource {
  dir: string;
  /** The host segment every key in this spool must start with. */
  host: string;
  /** The uid that writes this spool; a file anyone else owns is refused. */
  ownerUid: number;
}

export interface SendReport {
  sent: number;
  bytes: number;
  /** Files left in place, with why. Names only, never contents. */
  refused: { name: string; reason: string }[];
}

function readSpoolFile(path: string, ownerUid: number, max: number): Buffer | string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ELOOP' || code === 'EMLINK' ? 'a link' : `cannot open (${code})`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'not a regular file';
    if (st.uid !== ownerUid) return `owned by uid ${st.uid}, not the writer`;
    if (st.nlink !== 1) return 'has another name';
    if (st.size > max) return `larger than ${max} bytes`;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : 'shrank while read';
  } finally {
    closeSync(fd);
  }
}

/**
 * One pass over each spool: put every acceptable file and remove it after
 * its put succeeds. A failed put stops that spool's pass, so the next pass
 * starts from the same file.
 */
export async function sendSpool(
  sources: readonly SpoolSource[],
  store: ObjectStore,
  max = MAX_SPOOL_BYTES,
): Promise<SendReport> {
  const report: SendReport = { sent: 0, bytes: 0, refused: [] };
  for (const src of sources) {
    if (!validSegment(src.host)) throw new Error(`host ${JSON.stringify(src.host)} is not safe`);
    for (const name of readdirSync(src.dir).sort()) {
      if (name.startsWith(TMP)) continue;
      const key = keyOfSpoolName(name);
      if (key === null || !key.startsWith(`${src.host}/`)) {
        report.refused.push({ name, reason: `not a key under ${src.host}/` });
        continue;
      }
      const path = join(src.dir, name);
      const body = readSpoolFile(path, src.ownerUid, max);
      if (typeof body === 'string') {
        report.refused.push({ name, reason: body });
        continue;
      }
      await store.put(key, body);
      unlinkSync(path);
      report.sent++;
      report.bytes += body.length;
    }
  }
  return report;
}
