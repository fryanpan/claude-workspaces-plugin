/**
 * What an app outside this repo installs: the tarball `packKit` writes holds
 * every entry point the manifest exports, the prebuilt page client among
 * them, and none of this repo's tests or dev-only dependencies.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packKit } from '../scripts/pack.ts';

let dir: string;
let tarball: string;
let listing: string[];

function readFromTarball(path: string): string {
  const r = spawnSync('tar', ['-xzOf', tarball, `package/${path}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-kit-pack-test-'));
  tarball = packKit(dir);
  const r = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  listing = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''));
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the packed kit', () => {
  it('holds a file for every export the manifest names', () => {
    const manifest = JSON.parse(readFromTarball('package.json')) as {
      exports: Record<string, string | Record<string, string>>;
    };
    const missing = Object.values(manifest.exports)
      .flatMap((t) => (typeof t === 'string' ? [t] : Object.values(t)))
      .map((p) => p.replace(/^\.\//, ''))
      .filter((p) => !listing.includes(p));
    expect(missing).toEqual([]);
    expect(listing).toContain('dist/cw-collab.js');
    expect(listing).toContain('dist/cw-collab.mjs');
  });

  it('ships compiled JavaScript and declarations, with no TypeScript source', () => {
    expect(listing.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))).toEqual([]);
    expect(listing).toContain('lib/do/index.js');
    expect(listing).toContain('lib/do/index.d.ts');
    // Relative imports name the compiled files, in the code and its types.
    expect(readFromTarball('lib/markdown-file/markdown-file.js')).toMatch(
      /from ["']\.\.\/text\/splice\.js["']/,
    );
    expect(readFromTarball('lib/markdown-file/index.d.ts')).toMatch(
      /from ["']\.\/markdown-file\.js["']/,
    );
  });

  it('carries no tests and no dev-only dependencies', () => {
    expect(listing.filter((p) => p.endsWith('.test.ts'))).toEqual([]);
    const manifest = JSON.parse(readFromTarball('package.json')) as Record<string, unknown>;
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(Object.keys(manifest.dependencies as object)).not.toContain('@claude-workspaces/core');
  });
});
