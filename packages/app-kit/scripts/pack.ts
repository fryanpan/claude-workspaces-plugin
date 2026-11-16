#!/usr/bin/env bun
/**
 * Pack `@claude-workspaces/app-kit` into a tarball an app outside this repo
 * can install: `bun run --cwd packages/app-kit pack [outDir]`.
 *
 * The folders in `OWN_FOLDERS` are this package's own and are packed as
 * they are. Its two other source paths point back into this repo, so the
 * packed copy replaces them with what they point at:
 *
 *   src/collab/   becomes the files of `packages/core/src/collab/`, which
 *                 import only yjs, y-protocols and lib0
 *                 (`core/test/collab/collab-imports.test.ts` holds that)
 *   src/theme.css becomes a copy of `packages/workspaces-app/src/wa-theme.css`
 *
 * Then it compiles all of that TypeScript into `lib/` as `.js` and `.d.ts`
 * (`scripts/compile-lib.ts`) and ships only that, so an app needs no
 * `allowImportingTsExtensions`: each export the manifest names as
 * `./src/<path>.ts` becomes `{ types: ./lib/<path>.d.ts, default:
 * ./lib/<path>.js }` in the packed `package.json`.
 *
 * It also builds the page client into `dist/cw-collab.js` and
 * `dist/cw-collab.mjs` (`scripts/build-client.ts`), for a page with no bundler.
 *
 * The packed `package.json` loses the in-repo `@claude-workspaces/core`
 * dependency and its scripts. The version is the one in `package.json`;
 * the tarball is `claude-workspaces-app-kit-<version>.tgz`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClient } from './build-client.ts';
import { compileLib } from './compile-lib.ts';

const PKG_ROOT = resolve(import.meta.dirname, '..');
/** The folders under `src/` that are this package's own, packed as they are. */
export const OWN_FOLDERS = ['agent', 'auth', 'client', 'do', 'markdown-file', 'text'];
const REPO = resolve(PKG_ROOT, '../..');

type ExportTarget = string | { types: string; default: string };

interface Manifest {
  name: string;
  version: string;
  exports: Record<string, ExportTarget>;
  files: string[];
  dependencies: Record<string, string>;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function kitManifest(): Manifest {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Manifest;
}

/** The tarball's file name for a version, as `bun pm pack` writes it. */
export function tarballName(version: string): string {
  return `claude-workspaces-app-kit-${version}.tgz`;
}

/** An export of `./src/<path>.ts` as the compiled file and its types. */
export function compiledExport(target: ExportTarget): ExportTarget {
  if (typeof target !== 'string') return target;
  const m = /^\.\/src\/(.+)\.ts$/.exec(target);
  return m ? { types: `./lib/${m[1]}.d.ts`, default: `./lib/${m[1]}.js` } : target;
}

/** Every `.ts` file under `dir`. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/** Pack into `outDir`; returns the tarball's path. */
export function packKit(outDir: string): string {
  const stage = mkdtempSync(join(tmpdir(), 'app-kit-pack-'));
  try {
    const { scripts: _inRepo, devDependencies: _devOnly, ...manifest } = kitManifest();
    const { '@claude-workspaces/core': _repoOnly, ...dependencies } = manifest.dependencies;
    const exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([path, target]) => [path, compiledExport(target)]),
    );
    const files = ['lib', 'src/theme.css', ...manifest.files.filter((f) => f !== 'src')];
    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify({ ...manifest, exports, files, dependencies }, null, 2)}\n`,
    );
    cpSync(join(PKG_ROOT, 'README.md'), join(stage, 'README.md'));
    cpSync(join(REPO, 'LICENSE'), join(stage, 'LICENSE'));
    // Folders that live in this package go as they are.
    for (const own of OWN_FOLDERS) {
      cpSync(join(PKG_ROOT, 'src', own), join(stage, 'src', own), {
        recursive: true,
        filter: (src) => !src.endsWith('.test.ts'),
      });
    }
    cpSync(join(REPO, 'packages/core/src/collab'), join(stage, 'src/collab'), {
      recursive: true,
      filter: (src) => !src.endsWith('.test.ts'),
    });
    compileLib(stage, tsFiles(join(stage, 'src')));
    for (const folder of [...OWN_FOLDERS, 'collab']) {
      rmSync(join(stage, 'src', folder), { recursive: true });
    }
    cpSync(join(REPO, 'packages/workspaces-app/src/wa-theme.css'), join(stage, 'src/theme.css'));
    buildClient(join(stage, 'dist'));

    mkdirSync(outDir, { recursive: true });
    const out = resolve(outDir);
    const run = spawnSync('bun', ['pm', 'pack', '--destination', out, '--quiet'], {
      cwd: stage,
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`bun pm pack failed:\n${run.stdout}\n${run.stderr}`);
    return join(out, tarballName(manifest.version));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(packKit(process.argv[2] ?? join(PKG_ROOT, 'dist')));
}
