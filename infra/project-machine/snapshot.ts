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
  writeFileSync,
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

/** Throws unless `recipient` is a well-formed public key. */
export function checkRecipient(recipient: string): void {
  publicKeyOf(recipient);
}

/** The recipient an identity decrypts for, so only the identity needs storing. */
export function recipientOf(identity: string): string {
  return PUBLIC_PREFIX + privateKeyOf(identity).raw.toString('base64url');
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

/** A fresh header for `recipient`, and the function that seals each chunk under it. */
function sealer(recipient: string): {
  header: Buffer;
  seal: (plain: Buffer, final: boolean) => Buffer;
} {
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
  let counter = 0;
  return {
    header: Buffer.concat([MAGIC, ephRaw, salt]),
    seal: (plain, final) => {
      const c = createCipheriv('aes-256-gcm', key, nonce(counter++, final));
      return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    },
  };
}

/** Streams `input` into `outPath` as an encrypted snapshot. */
export async function encryptToFile(
  input: AsyncIterable<Uint8Array>,
  recipient: string,
  outPath: string,
): Promise<void> {
  const { header, seal } = sealer(recipient);
  const fd = openSync(outPath, 'wx', 0o600);
  try {
    writeSync(fd, header);
    // One full chunk is held back until the next byte arrives, because only
    // then is it known not to be the last.
    let pending = Buffer.alloc(0);
    for await (const piece of input) {
      pending = Buffer.concat([pending, Buffer.from(piece)]);
      while (pending.length > CHUNK) {
        writeSync(fd, seal(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
    }
    writeSync(fd, seal(pending, true));
  } finally {
    closeSync(fd);
  }
}

/** `plain` sealed to `recipient`, in memory, in the same format a snapshot file has. */
export function sealBytes(plain: Uint8Array, recipient: string): Buffer {
  const { header, seal } = sealer(recipient);
  const buf = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
  const parts = [header];
  let pos = 0;
  while (buf.length - pos > CHUNK) {
    parts.push(seal(buf.subarray(pos, pos + CHUNK), false));
    pos += CHUNK;
  }
  parts.push(seal(buf.subarray(pos), true));
  return Buffer.concat(parts);
}

/** The key a header was sealed under, for `identity`. */
function keyFromHeader(header: Buffer, identity: string): Buffer {
  const { key: priv, raw: recipientRaw } = privateKeyOf(identity);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a snapshot');
  const ephRaw = Buffer.from(header.subarray(MAGIC.length, MAGIC.length + 32));
  const salt = header.subarray(MAGIC.length + 32, HEADER);
  return deriveKey(
    diffieHellman({ privateKey: priv, publicKey: publicFromRaw(ephRaw) }),
    salt,
    ephRaw,
    recipientRaw,
  );
}

function openChunk(key: Buffer, counter: number, final: boolean, sealed: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, nonce(counter, final));
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}

function decryptError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    /unable to authenticate|auth/i.test(msg)
      ? 'snapshot did not decrypt: wrong identity, or the file was altered or truncated'
      : msg,
  );
}

/** What `sealBytes` sealed, or throws when `identity` is not its recipient's. */
export function openBytes(sealed: Uint8Array, identity: string): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  try {
    if (buf.length < HEADER + TAG) throw new Error('not a snapshot: too short');
    const key = keyFromHeader(buf.subarray(0, HEADER), identity);
    const parts: Buffer[] = [];
    let pos = HEADER;
    let counter = 0;
    while (pos < buf.length) {
      const len = Math.min(CHUNK + TAG, buf.length - pos);
      if (len < TAG) throw new Error('snapshot is truncated');
      parts.push(openChunk(key, counter++, pos + len === buf.length, buf.subarray(pos, pos + len)));
      pos += len;
    }
    return Buffer.concat(parts);
  } catch (err) {
    throw decryptError(err);
  }
}

/** Decrypts a whole snapshot to `outPath`, or throws without leaving one. */
export function decryptFile(snapshotPath: string, identity: string, outPath: string): void {
  const inFd = openSync(snapshotPath, 'r');
  let outFd: number | null = null;
  try {
    const size = fstatSync(inFd).size;
    const header = Buffer.alloc(HEADER);
    if (size < HEADER + TAG || readSync(inFd, header, 0, HEADER, 0) !== HEADER) {
      throw new Error('not a snapshot: too short');
    }
    const key = keyFromHeader(header, identity);
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
      writeSync(outFd, openChunk(key, counter++, pos === size, buf.subarray(0, len)));
    }
  } catch (err) {
    if (outFd !== null) {
      closeSync(outFd);
      outFd = null;
      rmSync(outPath, { force: true });
    }
    throw decryptError(err);
  } finally {
    if (outFd !== null) closeSync(outFd);
    closeSync(inFd);
  }
}

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
  publicKeyOf(recipient);
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
