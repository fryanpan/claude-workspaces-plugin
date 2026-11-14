/**
 * The collab core is for apps other than Workspaces, so nothing in it may
 * import anything outside its own folder but the Yjs packages.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '../../src/collab');
const ALLOWED = /^(yjs|y-protocols\/[\w-]+|lib0\/[\w-]+)$/;

function importsOf(file: string): string[] {
  const src = readFileSync(join(DIR, file), 'utf8');
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
}

describe('collab core imports', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

  it('finds the modules it checks', () => {
    expect(files).toContain('room-host.ts');
  });

  it('imports nothing outside its folder but yjs, y-protocols and lib0', () => {
    const outside = files.flatMap((f) =>
      importsOf(f)
        .filter((spec) => !(spec.startsWith('./') && !spec.includes('/', 2)) && !ALLOWED.test(spec))
        .map((spec) => `${f}: ${spec}`),
    );
    expect(outside).toEqual([]);
  });
});
