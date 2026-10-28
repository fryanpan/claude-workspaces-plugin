/**
 * The keeper's passkey check, driven by a software passkey that produces the
 * same bytes a platform authenticator does. Each refusal has the accepted
 * ceremony beside it as its control: the same passkey, one field changed.
 */
import { describe, expect, it } from 'bun:test';
import { decodeCbor } from '../src/keeper/cbor.ts';
import { type StoredPasskey, verifyAssertion, verifyRegistration } from '../src/keeper/webauthn.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const want = {
  challenge: 'Y2hhbGxlbmdlLW9uZQ',
  origin: 'http://localhost:8796',
  rpId: 'localhost',
};

function registered(opts?: ConstructorParameters<typeof TestPasskey>[0]): {
  key: TestPasskey;
  stored: StoredPasskey;
} {
  const key = new TestPasskey(opts);
  return { key, stored: verifyRegistration(key.register(want), want) };
}

describe('registration', () => {
  it('CONTROL: a well-formed ES256 registration yields the passkey to store', () => {
    const { key, stored } = registered();
    expect(stored.id).toBe(key.credentialId);
    expect(stored.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses another challenge, another origin and another relying party', () => {
    const key = new TestPasskey();
    expect(() => verifyRegistration(key.register({ ...want, challenge: 'b3RoZXI' }), want)).toThrow(
      'challenge does not match',
    );
    expect(() =>
      verifyRegistration(key.register({ ...want, origin: 'http://localhost:9999' }), want),
    ).toThrow('origin does not match');
    expect(() => verifyRegistration(key.register({ ...want, rpId: 'evil.test' }), want)).toThrow(
      'rpId hash does not match',
    );
  });

  it('refuses a registration without user verification', () => {
    const key = new TestPasskey({ flags: 0x01 });
    expect(() => verifyRegistration(key.register(want), want)).toThrow('user verification');
  });

  it('refuses an attestation format other than none', () => {
    const key = new TestPasskey();
    expect(() => verifyRegistration(key.register(want, 'packed'), want)).toThrow('"none"');
  });
});

describe('assertion', () => {
  it('CONTROL: the registered passkey approves its challenge', () => {
    const { key, stored } = registered();
    const r = verifyAssertion(key.assert(want), [stored], want);
    expect(r.id).toBe(stored.id);
    expect(r.signCount).toBeGreaterThan(stored.signCount);
  });

  it('refuses an assertion made for another challenge', () => {
    const { key, stored } = registered();
    expect(() =>
      verifyAssertion(key.assert({ ...want, challenge: 'b3RoZXI' }), [stored], want),
    ).toThrow('challenge does not match');
  });

  it('refuses a passkey that was never registered', () => {
    const { stored } = registered();
    const stranger = new TestPasskey();
    expect(() => verifyAssertion(stranger.assert(want), [stored], want)).toThrow('unknown passkey');
  });

  it("refuses another key's signature under a registered credential id", () => {
    const { key, stored } = registered();
    const other = new TestPasskey();
    const forged = { ...other.assert(want), credentialId: key.credentialId };
    expect(() => verifyAssertion(forged, [stored], want)).toThrow('signature does not verify');
  });

  it('refuses a tampered authenticator data', () => {
    const { key, stored } = registered();
    const a = key.assert(want);
    const bytes = Buffer.from(a.authenticatorData, 'base64url');
    bytes[36] = (bytes[36] as number) ^ 0xff;
    expect(() =>
      verifyAssertion({ ...a, authenticatorData: bytes.toString('base64url') }, [stored], want),
    ).toThrow('signature does not verify');
  });

  it('refuses an assertion without user verification', () => {
    const { stored } = registered();
    const weak = new TestPasskey({ flags: 0x01 });
    const a = { ...weak.assert(want), credentialId: stored.id };
    expect(() => verifyAssertion(a, [stored], want)).toThrow('user verification');
  });

  it('refuses a sign count that does not advance, and allows a synced passkey at 0', () => {
    const { key, stored } = registered();
    const replayed = { ...stored, signCount: 50 };
    expect(() => verifyAssertion(key.assert(want), [replayed], want)).toThrow('did not advance');
    const synced = registered({ signCount: 0 });
    expect(verifyAssertion(synced.key.assert(want), [synced.stored], want).signCount).toBe(0);
  });
});

describe('cbor', () => {
  it('CONTROL: decodes a map of text, bytes and negative ints', () => {
    const bytes = new Uint8Array([0xa2, 0x61, 0x61, 0x42, 1, 2, 0x20, 0xf5]);
    const { value, end } = decodeCbor(bytes);
    expect(value instanceof Map && value.get('a')).toEqual(new Uint8Array([1, 2]));
    expect(value instanceof Map && value.get(-1)).toBe(true);
    expect(end).toBe(bytes.length);
  });

  it('refuses truncation, indefinite lengths, tags and duplicate keys', () => {
    expect(() => decodeCbor(new Uint8Array([0x45, 1, 2]))).toThrow('ends inside');
    expect(() => decodeCbor(new Uint8Array([0x5f]))).toThrow('unsupported length');
    expect(() => decodeCbor(new Uint8Array([0xc0, 0]))).toThrow('major type 6');
    expect(() => decodeCbor(new Uint8Array([0xa2, 1, 1, 1, 2]))).toThrow('duplicate');
  });
});
