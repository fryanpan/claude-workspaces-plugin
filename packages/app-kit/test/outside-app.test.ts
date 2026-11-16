/**
 * A Worker app outside this repo installs the packed kit and uses `./do` and
 * `./markdown-file` with no shims: it typechecks under a plain tsconfig (no
 * DOM lib, no `allowImportingTsExtensions`), the program it typechecks holds
 * none of the page's DOM code, and neither does its server bundle, which
 * holds no Web Awesome either.
 *
 * The app's dependencies are linked from this repo's install, so nothing is
 * fetched. Web Awesome is not linked: a server import of it fails the build.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packKit } from '../scripts/pack.ts';

const PKG_ROOT = join(import.meta.dirname, '..');
const LINKED = ['yjs', 'lib0', 'y-protocols', '@cloudflare/workers-types'];

let dir: string;
let app: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-kit-outside-'));
  const tarball = packKit(dir);
  app = join(dir, 'app');
  const kit = join(app, 'node_modules/@claude-workspaces/app-kit');
  mkdirSync(kit, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', kit, '--strip-components=1'], {
    encoding: 'utf8',
  });
  if (untar.status !== 0) throw new Error(untar.stderr);
  for (const name of LINKED) {
    const target = join(app, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(PKG_ROOT, 'node_modules', name)), target, 'dir');
  }
  mkdirSync(join(app, 'src'));
  copyFileSync(join(PKG_ROOT, 'test/fixtures/outside-app/worker.ts'), join(app, 'src/worker.ts'));
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        // `tsc --init`'s default. Yjs's own declarations name DOM types.
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src'],
    }),
  );
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a Worker app outside this repo', () => {
  it('typechecks against the packed kit with a plain tsconfig, reading no page code', () => {
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const run = spawnSync(process.execPath, [tsc, '-p', app, '--listFiles'], { encoding: 'utf8' });
    const kit = run.stdout.split('\n').filter((p) => p.includes('@claude-workspaces/app-kit/'));
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toContain('error TS');
    expect(run.status).toBe(0);
    expect(kit.some((p) => p.endsWith('/markdown-file/index.d.ts'))).toBe(true);
    expect(kit.filter((p) => p.includes('/client/'))).toEqual([]);
  }, 60_000);

  it('bundles for workerd with no page code and no Web Awesome', async () => {
    const out = await build({
      entryPoints: [join(app, 'src/worker.ts')],
      absWorkingDir: app,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'import'],
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(out.metafile.inputs);
    const kit = inputs.filter((p) => p.includes('@claude-workspaces/app-kit/'));
    expect(kit.some((p) => p.includes('/markdown-file/'))).toBe(true);
    expect(kit.filter((p) => p.includes('/client/'))).toEqual([]);
    expect(inputs.filter((p) => p.includes('webawesome'))).toEqual([]);
  }, 60_000);

  it('installs without Web Awesome, which only the theme needs', () => {
    const manifest = JSON.parse(
      readFileSync(join(app, 'node_modules/@claude-workspaces/app-kit/package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain('@awesome.me/webawesome');
    expect(manifest.peerDependenciesMeta?.['@awesome.me/webawesome']?.optional).toBe(true);
  });
});
