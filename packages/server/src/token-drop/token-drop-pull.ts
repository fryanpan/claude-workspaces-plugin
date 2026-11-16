/**
 * The Mac's half of a CI rotation: read each sealed drop in the state bucket,
 * open it with the private key only this Mac holds, and put the new pair in
 * the Keychain over the old one, under the services the token already uses
 * (`tokenServices`). Prod runs it on a timer (`token-drop-start.ts`);
 * `bun run cf:pull-token` runs it once by hand.
 *
 * A drop is stored only when all of these hold, and is otherwise skipped
 * with a line naming why and never a value:
 *   - it opens with this Mac's key and its layers agree (`openDrop`);
 *   - the Keychain already holds a client id for that token, and it is the
 *     drop's client id. Rotation keeps the client id, so this Mac only takes
 *     a new secret for a token it already holds, and a drop forged by someone
 *     who can write the bucket and read the public key also needs the old
 *     client id;
 *   - its rotation is newer than the last one stored here, so an old drop
 *     put back cannot roll the secret back to one Cloudflare has ended.
 *
 * Nothing here prints, logs or throws a value. Every Keychain call goes
 * through the injected io, so a test never touches the real one.
 */
import nacl from 'tweetnacl';
import { type TokenServices, tokenServices } from '../../../../infra/cloudflare/service-tokens.ts';
import { DROP_PREFIX, type DropRefusal, dropKey, openDrop } from './token-drop-blob.ts';

export interface DropKeys {
  publicKeyB64: string;
  secretKeyB64: string;
}

export interface PullIo {
  /** The bucket keys under `prefix`. */
  list: (prefix: string) => Promise<string[]>;
  /** One object's text, or null when there is none. */
  get: (key: string) => Promise<string | null>;
  /** This Mac's key pair, or null when the Keychain holds none. */
  keys: () => Promise<DropKeys | null>;
  /** A plain Keychain value by service, or null when absent. */
  keychainRead: (service: string) => Promise<string | null>;
  /** Store the pair over the old one; throws naming a service, never a value. */
  replaceToken: (services: TokenServices, clientId: string, secret: string) => Promise<void>;
  /** The rotation time last stored, per token name. */
  applied: () => Record<string, string>;
  recordApplied: (name: string, rotatedAt: string) => void;
  log: (line: string) => void;
}

export type PullOutcome =
  | 'stored'
  | 'already-stored'
  | 'not-held'
  | 'other-client-id'
  | 'store-failed'
  | 'missing'
  | DropRefusal;

export interface PullResult {
  key: string;
  name?: string;
  outcome: PullOutcome;
}

const SAY: Record<PullOutcome, string> = {
  stored: 'stored the new pair',
  'already-stored': 'already stored; nothing to do',
  'not-held': 'skipped: this Mac holds no client id for that token',
  'other-client-id': 'refused: its client id is not the one this Mac holds for that token',
  'store-failed': 'could not store it in the Keychain; the old pair is still there',
  missing: 'no drop in the bucket',
  'not-a-drop': 'refused: not a sealed drop',
  'wrong-key': 'refused: it names another token than the key it is stored under',
  'cannot-open':
    "refused: it does not open with this Mac's key (tampered, or sealed to another key)",
  mismatch: 'refused: its sealed and plain names or times disagree',
  'bad-pair': 'refused: the sealed pair is not shaped like an Access client id and secret',
};

/**
 * Pull every drop in the bucket, or the one for `only`. Returns one result
 * per object looked at. Null keys means this Mac has no private key yet:
 * nothing is read.
 */
export async function pullDrops(io: PullIo, only?: string): Promise<PullResult[] | null> {
  const keys = await io.keys();
  if (!keys) return null;
  const objectKeys = only === undefined ? await io.list(DROP_PREFIX) : [dropKey(only)];
  const results: PullResult[] = [];
  for (const key of objectKeys) {
    const r = await pullOne(io, key, keys);
    results.push(r);
    if (r.outcome !== 'already-stored') {
      io.log(`${r.name ? `"${r.name}"` : key}: ${SAY[r.outcome]}`);
    }
  }
  return results;
}

async function pullOne(io: PullIo, key: string, keys: DropKeys): Promise<PullResult> {
  const text = await io.get(key);
  if (text === null) return { key, outcome: 'missing' };
  const opened = openDrop(text, key, keys);
  if (!opened.ok) return { key, outcome: opened.refused };
  const { name, clientId, secret, rotatedAt } = opened.pair;
  const last = io.applied()[name];
  if (last !== undefined && Date.parse(rotatedAt) <= Date.parse(last)) {
    return { key, name, outcome: 'already-stored' };
  }
  const services = tokenServices(name);
  const held = await io.keychainRead(services.clientId);
  if (held === null) return { key, name, outcome: 'not-held' };
  if (held !== clientId) return { key, name, outcome: 'other-client-id' };
  try {
    await io.replaceToken(services, clientId, secret);
  } catch {
    // Never the caught message: it was raised next to the secret.
    return { key, name, outcome: 'store-failed' };
  }
  io.recordApplied(name, rotatedAt);
  return { key, name, outcome: 'stored' };
}

export interface KeyIo {
  /** The private key (base64) from the Keychain, or null when absent. */
  readPrivate: () => Promise<string | null>;
  /** Store a NEW private key; false when it did not land. Never replaces one. */
  storePrivate: (secretKeyB64: string) => Promise<boolean>;
}

/** The pair from a base64 private key, or null when it is not one. */
function pairOf(secretKeyB64: string): DropKeys | null {
  const sk = new Uint8Array(Buffer.from(secretKeyB64, 'base64'));
  if (sk.length !== nacl.box.secretKeyLength) return null;
  const pk = nacl.box.keyPair.fromSecretKey(sk).publicKey;
  sk.fill(0);
  return { publicKeyB64: Buffer.from(pk).toString('base64'), secretKeyB64 };
}

/** This Mac's key pair as the Keychain holds it; null when it holds none. Makes nothing. */
export async function readDropKeys(io: KeyIo): Promise<DropKeys | null> {
  const held = await io.readPrivate();
  return held === null ? null : pairOf(held);
}

/**
 * This Mac's key pair, made on first use: a fresh X25519 pair whose private
 * half goes to the Keychain and nowhere else. Null when the Keychain would
 * not take it, so the next boot tries again.
 */
export async function ensureDropKeys(io: KeyIo): Promise<(DropKeys & { created: boolean }) | null> {
  const held = await readDropKeys(io);
  if (held) return { ...held, created: false };
  const pair = nacl.box.keyPair();
  const secretKeyB64 = Buffer.from(pair.secretKey).toString('base64');
  pair.secretKey.fill(0);
  if (!(await io.storePrivate(secretKeyB64))) return null;
  // Read back, so a store that exited 0 and kept nothing is not believed.
  const stored = await readDropKeys(io);
  return stored && stored.secretKeyB64 === secretKeyB64 ? { ...stored, created: true } : null;
}
