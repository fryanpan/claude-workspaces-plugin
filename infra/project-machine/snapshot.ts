/**
 * Snapshots of a board server's data dir, encrypted on the machine before
 * they leave it, and the restore that puts one back.
 *
 * A snapshot is the data dir as a gzipped tar, encrypted to a recipient
 * public key. The machine holds only that public key, so it can write
 * snapshots but cannot read one back, and the bucket sees ciphertext only.
 * The private key (the identity) lives off the machine, with Bryan, and is
 * needed only to restore.
 *
 * The format is age's construction on node:crypto primitives, so the proof
 * test needs no extra binary:
 *
 *   magic "CWSNAP1\n" | ephemeral X25519 public key (32) | salt (16) | chunks
 *
 * The key is HKDF-SHA256 over the X25519 shared secret, bound to both public
 * keys. Each chunk is up to 64 KiB of plaintext sealed with AES-256-GCM; its
 * nonce is an 11-byte counter plus a final-chunk flag, so a truncated,
 * reordered or spliced file fails to decrypt rather than restoring part of a
 * data dir.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAGIC = Buffer.from('CWSNAP1\n', 'ascii');
const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = MAGIC.length + 32 + 16;
const PUBLIC_PREFIX = 'cwsnap-pub-';
const IDENTITY_PREFIX = 'cwsnap-key-';

export interface SnapshotKeys {
  /** Goes on the machine (`BACKUP_RECIPIENT`). Safe to show. */
  recipient: string;
  /** Stays with Bryan. Restores every snapshot written to `recipient`. */
  identity: string;
}

// DER wrappers for a raw 32-byte X25519 key (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function raw32(key: KeyObject, kind: 'spki' | 'pkcs8'): Buffer {
  const der = key.export({ format: 'der', type: kind });
  return Buffer.from(der.subarray(der.length - 32));
}

export function generateSnapshotKeys(): SnapshotKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    recipient: PUBLIC_PREFIX + raw32(publicKey, 'spki').toString('base64url'),
    identity: IDENTITY_PREFIX + raw32(privateKey, 'pkcs8').toString('base64url'),
  };
}

function rawKey(text: string, prefix: string, what: string): Buffer {
  const t = text.trim();
  if (!t.startsWith(prefix)) throw new Error(`${what} must start with ${prefix}`);
  const b64 = t.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(b64)) throw new Error(`${what} is not a 32-byte key`);
  return Buffer.from(b64, 'base64url');
}

function publicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function publicKeyOf(recipient: string): { key: KeyObject; raw: Buffer } {
  const raw = rawKey(recipient, PUBLIC_PREFIX, 'recipient');
  return { key: publicFromRaw(raw), raw };
}

function privateKeyOf(identity: string): { key: KeyObject; raw: Buffer } {
  const d = rawKey(identity, IDENTITY_PREFIX, 'identity');
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, d]),
    format: 'der',
    type: 'pkcs8',
  });
  return { key, raw: raw32(createPublicKey(key), 'spki') };
}

function deriveKey(shared: Buffer, salt: Buffer, ephRaw: Buffer, recipientRaw: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from('cwsnap v1 '), ephRaw, recipientRaw]);
  return Buffer.from(hkdfSync('sha256', shared, salt, info, 32));
}

function nonce(counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 5, 6);
  n[11] = final ? 1 : 0;
  return n;
}

/** Streams `input` into `outPath` as an encrypted snapshot. */
export async function encryptToFile(
  input: AsyncIterable<Uint8Array>,
  recipient: string,
  outPath: string,
): Promise<void> {
  const { key: recipientKey, raw: recipientRaw } = publicKeyOf(recipient);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = raw32(eph.publicKey, 'spki');
  const salt = randomBytes(16);
  const key = deriveKey(
    diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey }),
    salt,
    ephRaw,
    recipientRaw,
  );
  const fd = openSync(outPath, 'wx', 0o600);
  try {
    writeSync(fd, Buffer.concat([MAGIC, ephRaw, salt]));
    let counter = 0;
    const seal = (plain: Buffer, final: boolean): void => {
      const c = createCipheriv('aes-256-gcm', key, nonce(counter++, final));
      writeSync(fd, Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
    };
    // One full chunk is held back until the next byte arrives, because only
    // then is it known not to be the last.
    let pending = Buffer.alloc(0);
    for await (const piece of input) {
      pending = Buffer.concat([pending, Buffer.from(piece)]);
      while (pending.length > CHUNK) {
        seal(pending.subarray(0, CHUNK), false);
        pending = pending.subarray(CHUNK);
      }
    }
    seal(pending, true);
  } finally {
    closeSync(fd);
  }
}

/** Decrypts a whole snapshot to `outPath`, or throws without leaving one. */
export function decryptFile(snapshotPath: string, identity: string, outPath: string): void {
  const { key: priv, raw: recipientRaw } = privateKeyOf(identity);
  const inFd = openSync(snapshotPath, 'r');
  let outFd: number | null = null;
  try {
    const size = fstatSync(inFd).size;
    const header = Buffer.alloc(HEADER);
    if (size < HEADER + TAG || readSync(inFd, header, 0, HEADER, 0) !== HEADER) {
      throw new Error('not a snapshot: too short');
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a snapshot');
    const ephRaw = Buffer.from(header.subarray(MAGIC.length, MAGIC.length + 32));
    const salt = header.subarray(MAGIC.length + 32, HEADER);
    const key = deriveKey(
      diffieHellman({ privateKey: priv, publicKey: publicFromRaw(ephRaw) }),
      salt,
      ephRaw,
      recipientRaw,
    );
    outFd = openSync(outPath, 'wx', 0o600);
    const sealed = CHUNK + TAG;
    const buf = Buffer.alloc(sealed);
    let pos = HEADER;
    let counter = 0;
    while (pos < size) {
      const len = Math.min(sealed, size - pos);
      if (len < TAG) throw new Error('snapshot is truncated');
      readSync(inFd, buf, 0, len, pos);
      pos += len;
      const final = pos === size;
      const d = createDecipheriv('aes-256-gcm', key, nonce(counter++, final));
      d.setAuthTag(buf.subarray(len - TAG, len));
      const plain = Buffer.concat([d.update(buf.subarray(0, len - TAG)), d.final()]);
      writeSync(outFd, plain);
    }
  } catch (err) {
    if (outFd !== null) {
      closeSync(outFd);
      outFd = null;
      rmSync(outPath, { force: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      /unable to authenticate|auth/i.test(msg)
        ? 'snapshot did not decrypt: wrong identity, or the file was altered or truncated'
        : msg,
    );
  } finally {
    if (outFd !== null) closeSync(outFd);
    closeSync(inFd);
  }
}

/**
 * Writes an encrypted snapshot of `dataDir` to `outPath`.
 *
 * The tar reads a live directory. Every `.ydoc` write is a rename, so each
 * doc is whole; an append-only log may lose a last line being written at
 * that instant. GNU tar exits 1 when a file changed while it read it, which
 * is that case, so 1 is accepted and anything else fails the snapshot.
 */
export async function snapshotDataDir(
  dataDir: string,
  recipient: string,
  outPath: string,
): Promise<void> {
  if (!statSync(dataDir).isDirectory()) throw new Error(`${dataDir} is not a directory`);
  publicKeyOf(recipient);
  const tar = spawn('tar', ['-czf', '-', '-C', dataDir, '.'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    // macOS tar otherwise adds `._` metadata members; GNU tar ignores it.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const exited = new Promise<number>((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => resolve(code ?? 1));
  });
  try {
    await encryptToFile(tar.stdout, recipient, outPath);
    const code = await exited;
    if (code !== 0 && code !== 1) throw new Error(`tar exited ${code}`);
  } catch (err) {
    rmSync(outPath, { force: true });
    throw err;
  }
}

export class RestoreRefused extends Error {}

/**
 * Every member of a snapshot must be a plain file or directory with a
 * relative path that stays inside the target. The archive is encrypted to a
 * public key, which proves nothing about who wrote it, so it is read as
 * untrusted input.
 */
function checkMembers(tarPath: string): void {
  // spawnSync's default 1 MB buffer would cut a listing of a few thousand
  // docs short and read as a broken tar.
  const opts = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 } as const;
  const names = spawnSync('tar', ['-tzf', tarPath], opts);
  const long = spawnSync('tar', ['-tvzf', tarPath], opts);
  if (names.status !== 0 || long.status !== 0) throw new RestoreRefused('snapshot is not a tar');
  for (const name of names.stdout.split('\n').filter(Boolean)) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new RestoreRefused(`snapshot member escapes the data dir: ${name}`);
    }
  }
  for (const line of long.stdout.split('\n').filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new RestoreRefused(`snapshot holds a member that is not a file or directory: ${line}`);
    }
  }
}

/**
 * Restores `snapshotPath` onto `dataDir`, which must be missing or empty.
 *
 * Nothing touches `dataDir` until the whole snapshot has decrypted and every
 * member has passed `checkMembers`. The extract goes to a sibling directory
 * that is renamed into place, so a failure part-way leaves `dataDir` as it
 * was and the restore can be run again.
 */
export function restoreSnapshot(snapshotPath: string, identity: string, dataDir: string): void {
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory()) throw new RestoreRefused(`${dataDir} is not a directory`);
    if (readdirSync(dataDir).length > 0) {
      throw new RestoreRefused(`${dataDir} is not empty; restore only onto an empty data dir`);
    }
  }
  const parent = dirname(dataDir);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, `.${basename(dataDir)}.restoring-`));
  try {
    const tarPath = join(work, 'snapshot.tar.gz');
    decryptFile(snapshotPath, identity, tarPath);
    checkMembers(tarPath);
    const tree = join(work, 'tree');
    mkdirSync(tree, { mode: 0o700 });
    const x = spawnSync('tar', ['-xzf', tarPath, '-C', tree], { stdio: 'inherit' });
    if (x.status !== 0) throw new Error(`tar extract exited ${x.status}`);
    // Checked again: the target may have gained a file while this ran.
    if (existsSync(dataDir)) {
      if (readdirSync(dataDir).length > 0) {
        throw new RestoreRefused(`${dataDir} stopped being empty during the restore`);
      }
      rmdirSync(dataDir);
    }
    renameSync(tree, dataDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
