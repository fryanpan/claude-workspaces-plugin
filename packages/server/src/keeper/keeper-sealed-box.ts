/**
 * libsodium's sealed box (`crypto_box_seal`), which is how GitHub's REST API
 * takes an Actions secret: the value encrypted to the repository's or the
 * environment's public key, so only GitHub can open it.
 *
 * The construction, as libsodium writes it: a fresh X25519 key pair for this
 * one message; the nonce is BLAKE2b-192 of the ephemeral public key followed
 * by the recipient's; the ciphertext is `crypto_box` (X25519, then
 * XSalsa20-Poly1305) from the ephemeral secret key to the recipient's public
 * key; the output is the ephemeral public key followed by that ciphertext.
 * The ephemeral secret key is zeroed once the box is made.
 */
import { blake2b } from '@noble/hashes/blake2b';
import nacl from 'tweetnacl';

/** The nonce libsodium derives for a sealed box. */
export function sealNonce(ephemeralPublic: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  const both = new Uint8Array(64);
  both.set(ephemeralPublic, 0);
  both.set(recipientPublic, 32);
  return blake2b(both, { dkLen: nacl.box.nonceLength });
}

/** Seal `message` to a base64 X25519 public key; the answer is base64. */
export function sealedBox(message: string, recipientPublicB64: string): string {
  const pk = new Uint8Array(Buffer.from(recipientPublicB64, 'base64'));
  if (pk.length !== nacl.box.publicKeyLength) {
    throw new Error('the public key is not 32 bytes of base64');
  }
  const eph = nacl.box.keyPair();
  try {
    const boxed = nacl.box(
      new TextEncoder().encode(message),
      sealNonce(eph.publicKey, pk),
      pk,
      eph.secretKey,
    );
    const out = new Uint8Array(32 + boxed.length);
    out.set(eph.publicKey, 0);
    out.set(boxed, 32);
    return Buffer.from(out).toString('base64');
  } finally {
    eph.secretKey.fill(0);
  }
}
