/**
 * A throwaway release world for the project machine's self-update tests: a
 * key pair, an image, and checkouts CI would build releases from, published
 * to a local release store (`project-machine-release-channel.ts`).
 */
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseManifest } from '../../../infra/project-machine/release-manifest.ts';
import { buildRelease } from '../../../infra/project-machine/release-publish.ts';
import { machineDir } from './project-machine-harness.ts';
import type { Store } from './project-machine-release-channel.ts';

export interface Keys {
  privateKey: string;
  publicKey: string;
}

export function makeKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** A full sha that names `n`, so each fixture release has its own commit. */
export const commitFor = (n: number): string => n.toString(16).padStart(40, 'a');

/**
 * An app tree the way the image lays one out: a bun.lock, an isolated
 * package store under node_modules/.bun, the root's and a workspace
 * package's links into it, and a server entry point saying `label`.
 */
export function writeApp(dir: string, label: string, lock = 'lockfile v1\n'): string {
  mkdirSync(join(dir, 'node_modules', '.bun', 'lib0@1', 'node_modules', 'lib0'), {
    recursive: true,
  });
  writeFileSync(
    join(dir, 'node_modules', '.bun', 'lib0@1', 'node_modules', 'lib0', 'index.js'),
    '',
  );
  symlinkSync('.bun/lib0@1/node_modules/lib0', join(dir, 'node_modules', 'lib0'));
  const pkgModules = join(dir, 'packages', 'server', 'node_modules');
  mkdirSync(pkgModules, { recursive: true });
  symlinkSync('../../../node_modules/.bun/lib0@1/node_modules/lib0', join(pkgModules, 'lib0'));
  mkdirSync(join(dir, 'packages', 'server', 'src'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'server', 'src', 'bin.ts'), `// ${label}\n`);
  mkdirSync(join(dir, 'demos'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'project-machine'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'board-router-worker'), { recursive: true });
  for (const f of ['package.json', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json']) {
    writeFileSync(join(dir, f), '{}\n');
  }
  writeFileSync(join(dir, 'bun.lock'), lock);
  return dir;
}

/**
 * The image: an app, its own serial, the public key baked in, and the real
 * release modules (linked from the repo), so `entrypoint.sh` can run them.
 */
export function writeImage(dir: string, keys: Keys, serial: number): string {
  writeApp(dir, 'image');
  const infra = join(dir, 'infra', 'project-machine');
  for (const f of ['release-cli.ts', 'release-store.ts', 'release-manifest.ts']) {
    symlinkSync(join(machineDir, f), join(infra, f));
  }
  writeFileSync(join(infra, 'release-signing-key.pub'), keys.publicKey);
  writeFileSync(
    join(infra, 'image-release.json'),
    JSON.stringify({ commit: commitFor(serial), serial }),
  );
  return dir;
}

/** Builds and signs a release the way CI does, and publishes it to the store. */
export function publish(
  scratch: string,
  store: Store,
  keys: Keys,
  serial: number,
  opts: { lock?: string; bun?: string } = {},
): ReleaseManifest {
  const app = writeApp(mkdtempSync(join(scratch, 'checkout-')), `release ${serial}`, opts.lock);
  const out = mkdtempSync(join(scratch, 'out-'));
  const m = buildRelease({
    app,
    commit: commitFor(serial),
    serial,
    out,
    privateKeyPem: keys.privateKey,
    ...(opts.bun ? { bun: opts.bun } : {}),
  });
  cpSync(join(out, m.tarball), join(store.dir, m.tarball));
  cpSync(join(out, 'channel.json'), join(store.dir, 'channel.json'));
  return m;
}
