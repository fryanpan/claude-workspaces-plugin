/**
 * The sealed format snapshots and store chunks share: encrypted to public
 * keys on the machine before anything leaves it. The machine holds only the
 * public keys (recipients), so it can write but cannot read back; the
 * private keys (identities) stay with the owner, on the Mac.
 *
 * Two forms, both age's construction on node:crypto primitives:
 *
 *   v1  "CWSNAP1\n" | ephemeral X25519 public key (32) | salt (16) | chunks
 *       one recipient; the payload key is HKDF-SHA256 over the X25519
 *       shared secret, bound to both public keys. Every snapshot is v1.
 *   v2  "CWSNAP2\n" | n (1) | n stanzas | payload salt (16) | chunks
 *       one random file key, wrapped once per recipient. A stanza is an
 *       ephemeral public key (32), a salt (16) and the file key under
 *       AES-256-GCM (48) with a key derived as in v1. Store chunks are v2,
 *       so a chunk opens with its board's key and with the review key.
 *
 * Each chunk is up to 64 KiB of plaintext sealed with AES-256-GCM; its
 * nonce is an 11-byte counter plus a final-chunk flag, so a truncated,
 * reordered or spliced file fails to decrypt rather than restoring part of
 * a data dir.
 */
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
import { closeSync, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs';

const MAGIC = Buffer.from('CWSNAP1\n', 'ascii');
const MAGIC2 = Buffer.from('CWSNAP2\n', 'ascii');
const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = MAGIC.length + 32 + 16;
const STANZA = 32 + 16 + 32 + TAG;
const MAX_RECIPIENTS = 16;
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

function payloadKey(fileKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', fileKey, salt, 'cwsnap v2 payload', 32));
}

function nonce(counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 5, 6);
  n[11] = final ? 1 : 0;
  return n;
}

/** An ephemeral key agreement with `recipient`: the ephemeral public half, a salt, the key. */
function agree(recipient: string): { ephRaw: Buffer; salt: Buffer; key: Buffer } {
  const { key: recipientKey, raw: recipientRaw } = publicKeyOf(recipient);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = raw32(eph.publicKey, 'spki');
  const salt = randomBytes(16);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
  return { ephRaw, salt, key: deriveKey(shared, salt, ephRaw, recipientRaw) };
}

function gcm(key: Buffer, n: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, n);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function ungcm(key: Buffer, n: Buffer, sealed: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, n);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}

/** A fresh header for the recipients, and the function that seals each chunk under it. */
function sealer(recipients: string | readonly string[]): {
  header: Buffer;
  seal: (plain: Buffer, final: boolean) => Buffer;
} {
  let header: Buffer;
  let key: Buffer;
  if (typeof recipients === 'string') {
    const a = agree(recipients);
    header = Buffer.concat([MAGIC, a.ephRaw, a.salt]);
    key = a.key;
  } else {
    const list = [...new Set(recipients)];
    if (list.length === 0 || list.length > MAX_RECIPIENTS) {
      throw new Error(`a seal needs 1 to ${MAX_RECIPIENTS} recipients, not ${list.length}`);
    }
    const fileKey = randomBytes(32);
    const stanzas = list.map((r) => {
      const a = agree(r);
      return Buffer.concat([a.ephRaw, a.salt, gcm(a.key, nonce(0, true), fileKey)]);
    });
    const salt = randomBytes(16);
    header = Buffer.concat([MAGIC2, Buffer.from([list.length]), ...stanzas, salt]);
    key = payloadKey(fileKey, salt);
  }
  let counter = 0;
  return { header, seal: (plain, final) => gcm(key, nonce(counter++, final), plain) };
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

/**
 * `plain` sealed in memory. One recipient as a string writes v1, the
 * snapshot format; a list writes v2, which any one of them opens.
 */
export function sealBytes(plain: Uint8Array, recipients: string | readonly string[]): Buffer {
  const { header, seal } = sealer(recipients);
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

/** How long the header is, from its first `MAGIC.length + 1` bytes; 0 when it is not one. */
function headerLength(start: Buffer): number {
  const magic = start.subarray(0, MAGIC.length);
  if (magic.equals(MAGIC)) return HEADER;
  if (!magic.equals(MAGIC2) || start.length <= MAGIC2.length) return 0;
  const n = start[MAGIC2.length] ?? 0;
  if (n < 1 || n > MAX_RECIPIENTS) return 0;
  return MAGIC2.length + 1 + n * STANZA + 16;
}

function agreed(identity: string, ephRaw: Buffer, salt: Buffer): Buffer {
  const { key: priv, raw: recipientRaw } = privateKeyOf(identity);
  const shared = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(ephRaw) });
  return deriveKey(shared, salt, ephRaw, recipientRaw);
}

/** The payload key a whole header was sealed under, for `identity`. */
function keyFromHeader(header: Buffer, identity: string): Buffer {
  if (header.subarray(0, MAGIC.length).equals(MAGIC)) {
    const ephRaw = Buffer.from(header.subarray(MAGIC.length, MAGIC.length + 32));
    return agreed(identity, ephRaw, header.subarray(MAGIC.length + 32, HEADER));
  }
  if (headerLength(header) !== header.length) throw new Error('not a snapshot');
  const n = header[MAGIC2.length] ?? 0;
  privateKeyOf(identity);
  for (let i = 0; i < n; i++) {
    const at = MAGIC2.length + 1 + i * STANZA;
    const ephRaw = Buffer.from(header.subarray(at, at + 32));
    const wrapKey = agreed(identity, ephRaw, header.subarray(at + 32, at + 48));
    let fileKey: Buffer;
    try {
      fileKey = ungcm(wrapKey, nonce(0, true), header.subarray(at + 48, at + STANZA));
    } catch {
      continue;
    }
    return payloadKey(fileKey, header.subarray(header.length - 16));
  }
  throw new Error('unable to authenticate: no stanza is for this identity');
}

function decryptError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    /unable to authenticate|auth/i.test(msg)
      ? 'snapshot did not decrypt: wrong identity, or the file was altered or truncated'
      : msg,
  );
}

/** What `sealBytes` sealed, or throws when `identity` is not one of its recipients'. */
export function openBytes(sealed: Uint8Array, identity: string): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  try {
    const head = headerLength(buf.subarray(0, MAGIC2.length + 1));
    if (head === 0) throw new Error('not a snapshot');
    if (buf.length < head + TAG) throw new Error('not a snapshot: too short');
    const key = keyFromHeader(buf.subarray(0, head), identity);
    const parts: Buffer[] = [];
    let pos = head;
    let counter = 0;
    while (pos < buf.length) {
      const len = Math.min(CHUNK + TAG, buf.length - pos);
      if (len < TAG) throw new Error('snapshot is truncated');
      const final = pos + len === buf.length;
      parts.push(ungcm(key, nonce(counter++, final), buf.subarray(pos, pos + len)));
      pos += len;
    }
    return Buffer.concat(parts);
  } catch (err) {
    throw decryptError(err);
  }
}

/** Decrypts a whole sealed file to `outPath`, or throws without leaving one. */
export function decryptFile(snapshotPath: string, identity: string, outPath: string): void {
  const inFd = openSync(snapshotPath, 'r');
  let outFd: number | null = null;
  try {
    const size = fstatSync(inFd).size;
    const start = Buffer.alloc(MAGIC2.length + 1);
    const got = readSync(inFd, start, 0, start.length, 0);
    const head = headerLength(start.subarray(0, got));
    if (head === 0) throw new Error('not a snapshot');
    const header = Buffer.alloc(head);
    if (size < head + TAG || readSync(inFd, header, 0, head, 0) !== head) {
      throw new Error('not a snapshot: too short');
    }
    const key = keyFromHeader(header, identity);
    outFd = openSync(outPath, 'wx', 0o600);
    const sealed = CHUNK + TAG;
    const buf = Buffer.alloc(sealed);
    let pos = head;
    let counter = 0;
    while (pos < size) {
      const len = Math.min(sealed, size - pos);
      if (len < TAG) throw new Error('snapshot is truncated');
      readSync(inFd, buf, 0, len, pos);
      pos += len;
      writeSync(outFd, ungcm(key, nonce(counter++, pos === size), buf.subarray(0, len)));
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
