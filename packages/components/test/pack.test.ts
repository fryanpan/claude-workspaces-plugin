// @vitest-environment node
/**
 * What a site outside this repo installs: the tarball `pack.ts` writes holds
 * a compiled module and its declarations for every entry the manifest
 * exports, names no dependency (Leaflet is inside), carries no TypeScript
 * source, and its modules import nothing but each other, so a page with no
 * bundler can load them as they are.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACK = join(import.meta.dirname, '..', 'scripts', 'pack.ts');

let dir: string;
let tarball: string;
let listing: string[];

function fromTarball(path: string): string {
  const r = spawnSync('tar', ['-xzOf', tarball, `package/${path}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'components-pack-test-'));
  // Bun's bundler builds the modules, so the pack runs under bun.
  const run = spawnSync('bun', [PACK, dir], { encoding: 'utf8', timeout: 90_000 });
  if (run.status !== 0) throw new Error(`pack failed:\n${run.stderr}`);
  tarball = run.stdout.trim().split('\n').at(-1) ?? '';
  const r = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  listing = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the packed components', () => {
  it('is named for its version and holds a module and types for every export', () => {
    expect(tarball.endsWith('claude-workspaces-components-0.4.1.tgz')).toBe(true);
    const manifest = JSON.parse(fromTarball('package.json')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(Object.keys(manifest.exports)).toEqual(['.', './map']);
    const missing = Object.values(manifest.exports)
      .flatMap((t) => Object.values(t))
      .map((p) => p.replace(/^\.\//, ''))
      .filter((p) => !listing.includes(p));
    expect(missing).toEqual([]);
    expect(listing).toContain('README.md');
    expect(listing).toContain('LICENSE');
  });

  it('names no dependency, no script and nothing in this repo', () => {
    const manifest = JSON.parse(fromTarball('package.json')) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    for (const file of listing.filter((p) => p.endsWith('.js') || p.endsWith('.d.ts'))) {
      expect(fromTarball(file), file).not.toContain('@claude-workspaces/core');
    }
  });

  it('ships compiled modules whose imports are all relative', () => {
    expect(listing.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))).toEqual([]);
    const specifiers = listing
      .filter((p) => p.endsWith('.js'))
      .flatMap((p) => [...fromTarball(p).matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith('./'))).toEqual([]);
    // The declarations name the compiled files.
    expect(fromTarball('lib/map.d.ts')).toMatch(/from ["']\.\/core\/mdx-component-runtime\.js["']/);
  });
});
