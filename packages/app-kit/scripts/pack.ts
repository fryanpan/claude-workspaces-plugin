#!/usr/bin/env bun
/**
 * Pack `@claude-workspaces/app-kit` into a tarball an app outside this repo
 * can install: `bun run --cwd packages/app-kit pack [outDir]`.
 *
 * The package's two source files point back into this repo, so the packed
 * copy replaces them with what they point at:
 *
 *   src/collab/   becomes the files of `packages/core/src/collab/`, which
 *                 import only yjs, y-protocols and lib0
 *                 (`core/test/collab/collab-imports.test.ts` holds that)
 *   src/theme.css becomes a copy of `packages/workspaces-app/src/wa-theme.css`
 *
 * and its `package.json` loses the in-repo `@claude-workspaces/core`
 * dependency and its scripts. The version is the one in `package.json`;
 * the tarball is `claude-workspaces-app-kit-<version>.tgz`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(PKG_ROOT, '../..');

interface Manifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  scripts?: Record<string, string>;
}

export function kitManifest(): Manifest {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Manifest;
}

/** The tarball's file name for a version, as `bun pm pack` writes it. */
export function tarballName(version: string): string {
  return `claude-workspaces-app-kit-${version}.tgz`;
}

/** Pack into `outDir`; returns the tarball's path. */
export function packKit(outDir: string): string {
  const stage = mkdtempSync(join(tmpdir(), 'app-kit-pack-'));
  try {
    const { scripts: _inRepo, ...manifest } = kitManifest();
    const { '@claude-workspaces/core': _repoOnly, ...dependencies } = manifest.dependencies;
    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`,
    );
    cpSync(join(PKG_ROOT, 'README.md'), join(stage, 'README.md'));
    cpSync(join(REPO, 'LICENSE'), join(stage, 'LICENSE'));
    cpSync(join(REPO, 'packages/core/src/collab'), join(stage, 'src/collab'), {
      recursive: true,
      filter: (src) => !src.endsWith('.test.ts'),
    });
    cpSync(join(REPO, 'packages/workspaces-app/src/wa-theme.css'), join(stage, 'src/theme.css'));

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
