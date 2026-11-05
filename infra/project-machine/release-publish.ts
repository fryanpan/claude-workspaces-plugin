#!/usr/bin/env bun
/**
 * CI's half of the server release (`.github/workflows/server-release.yml`),
 * and the one-time key pair.
 *
 *   bun release-publish.ts build --app <checkout> --commit <sha> --serial <n> --out <dir>
 *       Tars a built checkout and writes <dir>/cw-server-<sha>.tar.gz and
 *       <dir>/channel.json, signed with CW_RELEASE_SIGNING_KEY (a PKCS#8 PEM
 *       Ed25519 private key, from the environment only).
 *   bun release-publish.ts serial <channel.json>
 *       Prints the serial a published channel.json claims, unverified, so CI
 *       never replaces a newer release with an older one.
 *   bun release-publish.ts keygen --private-key <new file> [--public-key <file>]
 *       Makes the signing pair. The private half goes to a new mode-600 file,
 *       for the GitHub Environment secret; the public half to
 *       release-signing-key.pub beside this file, which the image bakes in.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BAKED_KEY } from './release-cli.ts';
import {
  type ReleaseManifest,
  signChannel,
  tarballName,
  unverifiedSerial,
} from './release-manifest.ts';
import { IMAGE_RELEASE_FILE, sha256Hex } from './release-store.ts';

/**
 * What a release carries: the paths the Dockerfile copies into /app, after
 * CI has installed and built them. `node_modules/.bun`, the package store
 * itself, stays out; the machine links the image's in its place.
 */
export const RELEASE_PATHS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'tsconfig.base.json',
  'packages',
  'demos',
  'infra/project-machine',
  'infra/board-router-worker',
  'node_modules',
] as const;

export interface BuildInput {
  app: string;
  commit: string;
  serial: number;
  out: string;
  privateKeyPem: string;
  /** Defaults to the Bun running this. */
  bun?: string;
  now?: Date;
}

export function buildRelease(input: BuildInput): ReleaseManifest {
  mkdirSync(input.out, { recursive: true });
  const name = tarballName(input.commit);
  const tarball = join(input.out, name);
  const tar = spawnSync(
    'tar',
    ['-czf', tarball, '--exclude', 'node_modules/.bun', '--exclude', '.DS_Store', ...RELEASE_PATHS],
    // COPYFILE_DISABLE: macOS's tar would add AppleDouble files.
    { cwd: input.app, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr ?? '').trim().slice(0, 300)}`);
  const bytes = readFileSync(tarball);
  const manifest: ReleaseManifest = {
    schema: 1,
    commit: input.commit,
    serial: input.serial,
    tarball: name,
    sha256: sha256Hex(bytes),
    size: bytes.length,
    bun: input.bun ?? Bun.version,
    lockSha256: sha256Hex(readFileSync(join(input.app, 'bun.lock'))),
    publishedAt: (input.now ?? new Date()).toISOString(),
  };
  writeFileSync(join(input.out, 'channel.json'), signChannel(manifest, input.privateKeyPem));
  return manifest;
}

/** A commit's position on main: the serial its release, or its image, carries. */
export function serialOf(repo: string, commit: string): number {
  const r = spawnSync('git', ['-C', repo, 'rev-list', '--count', '--first-parent', commit], {
    encoding: 'utf8',
  });
  const n = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isSafeInteger(n) || n < 1)
    throw new Error(`no serial for ${commit}`);
  return n;
}

/**
 * Writes `image-release.json` into an image's build context, so a machine
 * booting that image runs it rather than an older release on its volume.
 */
export function writeImageRelease(ctx: string, repo: string, commit: string): void {
  const body = { commit, serial: serialOf(repo, commit) };
  writeFileSync(join(ctx, IMAGE_RELEASE_FILE), `${JSON.stringify(body)}\n`);
}

export function keygen(privatePath: string, publicPath: string = BAKED_KEY): void {
  if (existsSync(privatePath)) throw new Error(`${privatePath} exists; refusing to overwrite it`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
  writeFileSync(publicPath, publicKey);
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function main(args: string[]): void {
  const [cmd] = args;
  if (cmd === 'build') {
    const key = process.env.CW_RELEASE_SIGNING_KEY?.trim();
    if (!key) throw new Error('CW_RELEASE_SIGNING_KEY is not set');
    const serial = Number(flag(args, '--serial'));
    const m = buildRelease({
      app: resolve(flag(args, '--app')),
      commit: flag(args, '--commit'),
      serial,
      out: resolve(flag(args, '--out')),
      privateKeyPem: `${key}\n`,
    });
    console.log(`built ${m.tarball}: ${m.size} bytes, serial ${m.serial}, sha256 ${m.sha256}`);
    return;
  }
  if (cmd === 'serial') {
    const [, path] = args;
    if (!path) throw new Error('usage: release-publish.ts serial <channel.json>');
    console.log(unverifiedSerial(readFileSync(path, 'utf8')));
    return;
  }
  if (cmd === 'keygen') {
    const i = args.indexOf('--public-key');
    keygen(
      resolve(flag(args, '--private-key')),
      i >= 0 ? resolve(flag(args, '--public-key')) : BAKED_KEY,
    );
    console.log('wrote the private key (mode 600) and the public key');
    return;
  }
  throw new Error('usage: release-publish.ts build|serial|keygen …');
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[release-publish] ${(e as Error).message}`);
    process.exit(1);
  }
}
