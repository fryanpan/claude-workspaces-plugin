/**
 * A software passkey for the keeper's tests: a P-256 key pair that answers a
 * registration and an assertion with the same bytes a platform
 * authenticator returns, so the keeper's real checks run on them.
 *
 * audit: no-text — nothing here reads a source file; it builds bytes.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const enc = new TextEncoder();
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(b).digest());

/** CBOR for the shapes a registration needs: small ints, bytes, text, maps. */
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    return [(major << 5) | 25, n >> 8, n & 0xff];
  };
  if (typeof value === 'number') {
    return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === 'string') {
    const b = enc.encode(value);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (value instanceof Uint8Array) return new Uint8Array([...head(2, value.length), ...value]);
  if (value instanceof Map) {
    const parts: number[] = [...head(5, value.size)];
    for (const [k, v] of value) parts.push(...cbor(k), ...cbor(v));
    return new Uint8Array(parts);
  }
  throw new Error('test cbor: unsupported value');
}

export interface Ceremony {
  challenge: string;
  origin: string;
  rpId: string;
}

export interface TestPasskeyOptions {
  /** Flags to set in authenticator data. Default UP|UV. */
  flags?: number;
  /** The sign count each assertion reports, or 'increment' (default 'increment'). */
  signCount?: number | 'increment';
}

export class TestPasskey {
  readonly id = new Uint8Array(randomBytes(16));
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private count = 0;

  constructor(private readonly opts: TestPasskeyOptions = {}) {}

  get credentialId(): string {
    return b64url(this.id);
  }

  private clientData(type: string, c: Ceremony): Uint8Array {
    return enc.encode(JSON.stringify({ type, challenge: c.challenge, origin: c.origin }));
  }

  private authData(rpId: string, extra: Uint8Array = new Uint8Array()): Uint8Array {
    const flags = this.opts.flags ?? 0x05;
    const n =
      this.opts.signCount === undefined || this.opts.signCount === 'increment'
        ? ++this.count
        : this.opts.signCount;
    const counter = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    return new Uint8Array([
      ...sha256(enc.encode(rpId)),
      flags | (extra.length ? 0x40 : 0),
      ...counter,
      ...extra,
    ]);
  }

  /** What `navigator.credentials.create` hands the page, base64url. */
  register(c: Ceremony, fmt = 'none'): { clientDataJSON: string; attestationObject: string } {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]);
    const attested = new Uint8Array([
      ...new Uint8Array(16),
      this.id.length >> 8,
      this.id.length & 0xff,
      ...this.id,
      ...cbor(cose),
    ]);
    const attestation = new Map<string, unknown>([
      ['fmt', fmt],
      ['attStmt', new Map()],
      ['authData', this.authData(c.rpId, attested)],
    ]);
    return {
      clientDataJSON: b64url(this.clientData('webauthn.create', c)),
      attestationObject: b64url(cbor(attestation)),
    };
  }

  /** What `navigator.credentials.get` hands the page, base64url. */
  assert(c: Ceremony): {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  } {
    const clientData = this.clientData('webauthn.get', c);
    const authData = this.authData(c.rpId);
    const signature = sign(
      'sha256',
      new Uint8Array([...authData, ...sha256(clientData)]),
      this.keys.privateKey,
    );
    return {
      credentialId: this.credentialId,
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(new Uint8Array(signature)),
    };
  }
}
