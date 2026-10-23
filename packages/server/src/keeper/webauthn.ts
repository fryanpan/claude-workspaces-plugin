/**
 * The keeper's passkey check: a WebAuthn registration and a WebAuthn
 * assertion, verified with `node:crypto` and nothing else.
 *
 * **Narrow on purpose.** One algorithm, ES256 (COSE -7, P-256), which is what
 * Touch ID, iCloud Keychain and the common security keys produce. One
 * attestation format, `none`: the keeper asks for no attestation, and it
 * trusts a passkey because Bryan registered it through a link only an admin
 * password can mint (`keeper-bin.ts enroll`), not because of who made the
 * authenticator. User verification is required on both ceremonies, so a
 * tap alone is not enough: Touch ID or the device passcode must pass too.
 *
 * Each check throws with the reason, and a caller that catches refuses the
 * request. Nothing here keeps state: the challenge, the stored key and the
 * last sign count are the caller's.
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { type CborValue, decodeCbor } from './cbor.ts';

/** A stored passkey: what verifying its next assertion needs. */
export interface StoredPasskey {
  /** The credential id, base64url. */
  id: string;
  /** The P-256 public key, as JWK coordinates (base64url). */
  x: string;
  y: string;
  signCount: number;
}

export interface CeremonyExpectation {
  /** The challenge the keeper issued, base64url. */
  challenge: string;
  /** The approval page's origin, e.g. `http://localhost:8797`. */
  origin: string;
  /** The relying party id, the origin's host name, e.g. `localhost`. */
  rpId: string;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Check clientDataJSON's type, challenge and origin; return its hash. */
function checkClientData(
  clientDataJSON: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  want: CeremonyExpectation,
): Uint8Array {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJSON));
  } catch {
    throw new Error('clientDataJSON is not JSON');
  }
  if (data.type !== type) throw new Error(`clientDataJSON type is not ${type}`);
  if (typeof data.challenge !== 'string') throw new Error('clientDataJSON has no challenge');
  if (!sameBytes(fromB64url(data.challenge), fromB64url(want.challenge))) {
    throw new Error('challenge does not match');
  }
  if (data.origin !== want.origin) throw new Error('origin does not match');
  if (data.crossOrigin === true) throw new Error('a cross-origin ceremony is refused');
  return sha256(clientDataJSON);
}

interface ParsedAuthData {
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  coseKey?: CborValue;
}

function parseAuthData(authData: Uint8Array, rpId: string): ParsedAuthData {
  if (authData.length < 37) throw new Error('authenticator data is too short');
  if (!sameBytes(authData.subarray(0, 32), sha256(new TextEncoder().encode(rpId)))) {
    throw new Error('rpId hash does not match');
  }
  const flags = authData[32] as number;
  if (!(flags & FLAG_UP)) throw new Error('user presence flag is not set');
  if (!(flags & FLAG_UV)) throw new Error('user verification flag is not set');
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  if (!(flags & FLAG_AT)) return { flags, signCount };
  if (authData.length < 55) throw new Error('attested credential data is too short');
  const idLength = (authData[53] as number) * 256 + (authData[54] as number);
  const idEnd = 55 + idLength;
  if (idLength === 0 || idLength > 1023 || idEnd > authData.length) {
    throw new Error('credential id length is invalid');
  }
  const credentialId = authData.slice(55, idEnd);
  const { value: coseKey } = decodeCbor(authData, idEnd);
  return { flags, signCount, credentialId, coseKey };
}

/** The P-256 coordinates of a COSE EC2 ES256 key, or a throw. */
function es256Coordinates(cose: CborValue | undefined): { x: Uint8Array; y: Uint8Array } {
  if (!(cose instanceof Map)) throw new Error('credential public key is not a COSE map');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1)
    throw new Error('only ES256 P-256 passkeys are accepted');
  if (
    !(x instanceof Uint8Array) ||
    !(y instanceof Uint8Array) ||
    x.length !== 32 ||
    y.length !== 32
  ) {
    throw new Error('credential public key coordinates are malformed');
  }
  return { x, y };
}

export interface RegistrationInput {
  /** base64url, as the browser returned them. */
  clientDataJSON: string;
  attestationObject: string;
}

/** Verify a registration; return the passkey to store. */
export function verifyRegistration(
  input: RegistrationInput,
  want: CeremonyExpectation,
): StoredPasskey {
  checkClientData(fromB64url(input.clientDataJSON), 'webauthn.create', want);
  const { value } = decodeCbor(fromB64url(input.attestationObject));
  if (!(value instanceof Map)) throw new Error('attestation object is not a map');
  if (value.get('fmt') !== 'none') throw new Error('only attestation format "none" is accepted');
  const attStmt = value.get('attStmt');
  if (!(attStmt instanceof Map) || attStmt.size !== 0) throw new Error('attStmt must be empty');
  const authData = value.get('authData');
  if (!(authData instanceof Uint8Array)) throw new Error('attestation object has no authData');
  const parsed = parseAuthData(authData, want.rpId);
  if (!parsed.credentialId) throw new Error('registration carries no credential');
  const { x, y } = es256Coordinates(parsed.coseKey);
  // Building the key proves the point is on the curve.
  createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' });
  return {
    id: b64url(parsed.credentialId),
    x: b64url(x),
    y: b64url(y),
    signCount: parsed.signCount,
  };
}

export interface AssertionInput {
  /** base64url, as the browser returned them. */
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/**
 * Verify an assertion against the stored passkey with the same id; return
 * the new sign count. A count that does not move past a non-zero stored one
 * is refused as a cloned authenticator. Synced passkeys report 0 forever,
 * which is allowed.
 */
export function verifyAssertion(
  input: AssertionInput,
  passkeys: readonly StoredPasskey[],
  want: CeremonyExpectation,
): { id: string; signCount: number } {
  const passkey = passkeys.find((p) => p.id === input.credentialId);
  if (!passkey) throw new Error('unknown passkey');
  const clientHash = checkClientData(fromB64url(input.clientDataJSON), 'webauthn.get', want);
  const authData = fromB64url(input.authenticatorData);
  const parsed = parseAuthData(authData, want.rpId);
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: passkey.x, y: passkey.y },
    format: 'jwk',
  });
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  if (!verify('sha256', signed, key, fromB64url(input.signature))) {
    throw new Error('signature does not verify');
  }
  if (
    (parsed.signCount !== 0 || passkey.signCount !== 0) &&
    parsed.signCount <= passkey.signCount
  ) {
    throw new Error('sign count did not advance');
  }
  return { id: passkey.id, signCount: parsed.signCount };
}
