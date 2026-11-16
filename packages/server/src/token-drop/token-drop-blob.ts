/**
 * The sealed drop a rotated Access service token travels in, from CI to the
 * Mac (docs/process/keeper.md, "Rotating a service token in CI").
 *
 * CI rotates the token (`infra/cloudflare/ci-rotate-token.ts`), seals the new
 * pair to the Mac's public key (`infra/cloudflare/token-drop.pub`) with
 * libsodium's sealed box (`keeper-sealed-box.ts`, the one GitHub's secrets
 * API already uses here), and writes the result to the state bucket under
 * `dropKey(name)`. Only the Mac holds the private half, so the bucket, its
 * readers and the public CI log see ciphertext at most.
 *
 * The object is JSON with two layers:
 *
 *   {"v":1, "name", "rotatedAt", "box"}        outside: no secret, so CI can
 *                                              read when the token was last
 *                                              rotated without opening it
 *   box = seal({"v":1, "name", "rotatedAt",    inside: the pair, and the name
 *               "clientId", "secret"})          and time again
 *
 * `openDrop` believes only the inside, and refuses an object whose outside
 * disagrees with it, or whose name is not the one its key was derived from:
 * a box moved to another token's key is refused rather than stored under the
 * wrong services. A sealed box proves nothing about who sealed it (anyone
 * with the public key can), so the pull adds the one check a forger cannot
 * meet without the old pair: rotation keeps the client id, and the pull
 * refuses a client id other than the one the Keychain already holds
 * (`token-drop-pull.ts`).
 */
import { CLIENT_ID, SECRET, tokenSlug } from '../../../../infra/cloudflare/service-tokens.ts';
import { openSealedBox, sealedBox } from '../keeper/keeper-sealed-box.ts';

/** Where the drops live in the bucket. */
export const DROP_PREFIX = 'service-tokens/';

/** The bucket key for one token's drop. */
export function dropKey(name: string): string {
  return `${DROP_PREFIX}${tokenSlug(name)}.sealed.json`;
}

export interface DropPair {
  name: string;
  clientId: string;
  secret: string;
  /** ISO time of the rotation. */
  rotatedAt: string;
}

/** The outside of a drop: what anyone with bucket read may see. */
export interface DropEnvelope {
  v: 1;
  name: string;
  rotatedAt: string;
  box: string;
}

/** The drop's text: the pair sealed to `publicKeyB64`, inside its envelope. */
export function sealDrop(pair: DropPair, publicKeyB64: string): string {
  const inner = JSON.stringify({ v: 1, ...pair });
  const envelope: DropEnvelope = {
    v: 1,
    name: pair.name,
    rotatedAt: pair.rotatedAt,
    box: sealedBox(inner, publicKeyB64),
  };
  return `${JSON.stringify(envelope)}\n`;
}

/** The envelope, or null when the text is not one. Reads no secret. */
export function readEnvelope(text: string): DropEnvelope | null {
  let j: Partial<DropEnvelope>;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j?.v !== 1 || typeof j.name !== 'string' || typeof j.box !== 'string') return null;
  if (typeof j.rotatedAt !== 'string' || Number.isNaN(Date.parse(j.rotatedAt))) return null;
  return { v: 1, name: j.name, rotatedAt: j.rotatedAt, box: j.box };
}

/** Why a drop was refused. Tags, never a value. */
export type DropRefusal = 'not-a-drop' | 'wrong-key' | 'cannot-open' | 'mismatch' | 'bad-pair';

export type Opened = { ok: true; pair: DropPair } | { ok: false; refused: DropRefusal };

/**
 * Open the drop found at bucket key `key`. Refuses an object that is not a
 * drop, one stored under another token's key, one that does not open with
 * this key pair (tampered, or sealed to another key), one whose two layers
 * disagree, and a pair not shaped like Cloudflare's.
 */
export function openDrop(
  text: string,
  key: string,
  keys: { publicKeyB64: string; secretKeyB64: string },
): Opened {
  const env = readEnvelope(text);
  if (!env) return { ok: false, refused: 'not-a-drop' };
  if (safeDropKey(env.name) !== key) return { ok: false, refused: 'wrong-key' };
  const opened = openSealedBox(env.box, keys.publicKeyB64, keys.secretKeyB64);
  if (opened === null) return { ok: false, refused: 'cannot-open' };
  let inner: Partial<DropPair & { v: number }>;
  try {
    inner = JSON.parse(opened);
  } catch {
    return { ok: false, refused: 'cannot-open' };
  }
  if (inner.v !== 1 || inner.name !== env.name || inner.rotatedAt !== env.rotatedAt) {
    return { ok: false, refused: 'mismatch' };
  }
  if (
    typeof inner.clientId !== 'string' ||
    typeof inner.secret !== 'string' ||
    !CLIENT_ID.test(inner.clientId) ||
    !SECRET.test(inner.secret)
  ) {
    return { ok: false, refused: 'bad-pair' };
  }
  return {
    ok: true,
    pair: {
      name: env.name,
      clientId: inner.clientId,
      secret: inner.secret,
      rotatedAt: env.rotatedAt,
    },
  };
}

function safeDropKey(name: string): string | null {
  try {
    return dropKey(name);
  } catch {
    return null;
  }
}
