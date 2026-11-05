/**
 * A server release's manifest and the signature over it.
 *
 * CI builds one release per green commit on main, signs its manifest with an
 * Ed25519 key only CI holds, and publishes the pair as `channel.json`
 * (`release-publish.ts`). Each project machine checks that file against the
 * public key baked into its image before it downloads anything else
 * (`release-store.ts`). The manifest names the tarball's SHA-256, so the key
 * vouches for every byte the machine then runs.
 *
 * `channel.json` is one file holding both halves, so a reader never sees a new
 * manifest beside an old signature:
 *
 *   { "manifest": "<base64 of the manifest's JSON bytes>",
 *     "signature": "<base64 Ed25519 signature>" }
 *
 * The signature covers SIGNING_CONTEXT followed by those exact bytes, so a
 * signature made with this key for anything else never verifies as a release.
 * The bytes are verified before they are parsed.
 *
 * Only node:crypto: this runs from the image with no dependency installed.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const SIGNING_CONTEXT = 'claude-workspaces server release v1\n';
export const MANIFEST_SCHEMA = 1;
/** A tarball larger than this is refused before it is downloaded in full. */
export const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

export interface ReleaseManifest {
  schema: 1;
  /** The full git commit the release was built from. */
  commit: string;
  /**
   * `git rev-list --count --first-parent <commit>`: the commit's position on
   * main. A machine installs only a release whose serial is higher than the
   * one it runs, so an old signed manifest cannot be replayed onto it.
   */
  serial: number;
  /** The tarball's name in the release store. */
  tarball: string;
  sha256: string;
  size: number;
  /** The Bun version that built it. The machine's image must run the same. */
  bun: string;
  /**
   * SHA-256 of bun.lock. A release runs against the image's installed
   * dependencies, so a different lockfile needs an image deploy instead.
   */
  lockSha256: string;
  publishedAt: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUN_VERSION = /^\d+\.\d+\.\d+$/;

export const tarballName = (commit: string): string => `cw-server-${commit}.tar.gz`;

/** Checks every field; throws naming the first one that is wrong. */
export function checkManifest(value: unknown): ReleaseManifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest is not an object');
  const m = value as Record<string, unknown>;
  if (m.schema !== MANIFEST_SCHEMA) throw new Error(`manifest schema is not ${MANIFEST_SCHEMA}`);
  if (typeof m.commit !== 'string' || !COMMIT.test(m.commit))
    throw new Error('manifest commit is not a full git sha');
  if (!Number.isSafeInteger(m.serial) || (m.serial as number) < 1)
    throw new Error('manifest serial is not a positive whole number');
  if (m.tarball !== tarballName(m.commit))
    throw new Error('manifest tarball is not named for its commit');
  if (typeof m.sha256 !== 'string' || !SHA256.test(m.sha256))
    throw new Error('manifest sha256 is not a SHA-256');
  if (
    !Number.isSafeInteger(m.size) ||
    (m.size as number) < 1 ||
    (m.size as number) > MAX_TARBALL_BYTES
  )
    throw new Error(`manifest size is not 1-${MAX_TARBALL_BYTES} bytes`);
  if (typeof m.bun !== 'string' || !BUN_VERSION.test(m.bun))
    throw new Error('manifest bun is not a version');
  if (typeof m.lockSha256 !== 'string' || !SHA256.test(m.lockSha256))
    throw new Error('manifest lockSha256 is not a SHA-256');
  if (typeof m.publishedAt !== 'string' || Number.isNaN(Date.parse(m.publishedAt)))
    throw new Error('manifest publishedAt is not a date');
  return {
    schema: MANIFEST_SCHEMA,
    commit: m.commit,
    serial: m.serial as number,
    tarball: m.tarball,
    sha256: m.sha256,
    size: m.size as number,
    bun: m.bun,
    lockSha256: m.lockSha256,
    publishedAt: m.publishedAt,
  };
}

const signedBytes = (manifest: Buffer): Buffer =>
  Buffer.concat([Buffer.from(SIGNING_CONTEXT, 'utf8'), manifest]);

/** `channel.json` for a manifest, signed with a PKCS#8 PEM Ed25519 private key. */
export function signChannel(manifest: ReleaseManifest, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not Ed25519');
  const bytes = Buffer.from(JSON.stringify(checkManifest(manifest)), 'utf8');
  const signature = sign(null, signedBytes(bytes), key);
  return `${JSON.stringify({ manifest: bytes.toString('base64'), signature: signature.toString('base64') })}\n`;
}

/**
 * The manifest in `channel.json`, once its signature verifies against the
 * SPKI PEM Ed25519 public key. Throws `signature does not match` otherwise.
 */
export function verifyChannel(text: string, publicKeyPem: string): ReleaseManifest {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release key is not Ed25519');
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('channel.json is not JSON');
  }
  const e = envelope as { manifest?: unknown; signature?: unknown };
  if (typeof e?.manifest !== 'string' || typeof e.signature !== 'string')
    throw new Error('channel.json has no manifest and signature');
  const bytes = Buffer.from(e.manifest, 'base64');
  const signature = Buffer.from(e.signature, 'base64');
  if (signature.length !== 64 || !verify(null, signedBytes(bytes), key, signature)) {
    throw new Error('signature does not match the release key');
  }
  return checkManifest(JSON.parse(bytes.toString('utf8')));
}

/**
 * The serial a `channel.json` claims, WITHOUT checking its signature. Only
 * for CI's publish step, which asks whether the release already published is
 * newer than the one it built. Nothing installs on this answer.
 */
export function unverifiedSerial(text: string): number {
  const e = JSON.parse(text) as { manifest?: string };
  return checkManifest(JSON.parse(Buffer.from(e.manifest ?? '', 'base64').toString('utf8'))).serial;
}
