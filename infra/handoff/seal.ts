/**
 * Sealing a value to one holder's public key, so CI can hand a credential it
 * made to the Mac (or from one GitHub Environment's job to another's) through
 * a workflow artifact that anyone may download.
 *
 * X25519 with a fresh ephemeral key per envelope, HKDF-SHA256 over the
 * shared secret and both public keys, then AES-256-GCM. The recipient's
 * public key is bound into the key derivation, so an envelope opens only
 * with the private half it was sealed to. Node's own crypto: no dependency.
 *
 * Keys travel as base64 of their raw 32 bytes (public) or PKCS#8 DER
 * (private), so a public key fits on one line of `recipients.json`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const INFO = Buffer.from('claude-workspaces handoff v1');
/** The DER prefix of an X25519 SubjectPublicKeyInfo; the raw key follows. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair {
  /** base64 of the raw 32-byte public key. */
  publicKey: string;
  /** base64 of the PKCS#8 DER private key. Never printed. */
  privateKey: string;
}

export interface Envelope {
  v: 1;
  /** The ephemeral public key, raw, base64. */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

export function generateHandoffKeys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey: spki.subarray(SPKI_PREFIX.length).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function publicKeyOf(raw: string) {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new Error('a handoff public key is 32 bytes of base64');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  });
}

function keyFor(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  const salt = Buffer.concat([epk, recipient]);
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
}

/** Seal `plaintext` to the holder of `recipientPublicKey`. */
export function seal(recipientPublicKey: string, plaintext: string): Envelope {
  const recipient = publicKeyOf(recipientPublicKey);
  const eph = generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = keyFor(shared, epk, Buffer.from(recipientPublicKey, 'base64'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  shared.fill(0);
  key.fill(0);
  return {
    v: 1,
    epk: epk.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Open an envelope with the private half it was sealed to. Throws on any tampering. */
export function open(privateKey: string, envelope: Envelope): string {
  if (envelope?.v !== 1) throw new Error('not a handoff envelope');
  const priv = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const own = createPublicKey(priv)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.length);
  const epk = Buffer.from(envelope.epk, 'base64');
  const shared = diffieHellman({ privateKey: priv, publicKey: publicKeyOf(envelope.epk) });
  const key = keyFor(shared, epk, own);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('the envelope does not open with this key');
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}
