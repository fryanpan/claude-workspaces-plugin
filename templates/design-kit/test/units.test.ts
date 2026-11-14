/**
 * The trial's pure parts, no browser: which file a request path serves, and
 * how the compact setting is read.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DIST, KIT_ROOT } from '../scripts/build.ts';
import { resolvePath } from '../scripts/serve.ts';
import { readDensity } from '../src/density.ts';

const THEMES = ['harborlight', 'workspaces'];

describe('resolvePath', () => {
  test('serves the same page file under every theme', () => {
    const a = resolvePath('/t/workspaces/tasks.html', THEMES);
    expect(a).toBe(join(KIT_ROOT, 'pages', 'tasks.html'));
    expect(resolvePath('/t/harborlight/tasks.html', THEMES)).toBe(a);
  });

  test("maps theme.css to that theme's built file", () => {
    expect(resolvePath('/t/harborlight/theme.css', THEMES)).toBe(
      join(DIST, 'themes', 'harborlight.css'),
    );
  });

  test('refuses an unknown theme, an unknown file and a traversal', () => {
    expect(resolvePath('/t/riverbend/tasks.html', THEMES)).toBeNull();
    expect(resolvePath('/t/workspaces/build.ts', THEMES)).toBeNull();
    expect(resolvePath('/t/../package.json', THEMES)).toBeNull();
    expect(resolvePath('/../package.json', THEMES)).toBeNull();
    expect(resolvePath('/kit.js', THEMES)).toBe(join(DIST, 'kit.js'));
  });
});

describe('readDensity', () => {
  test('the query wins over storage, and anything but compact is comfortable', () => {
    expect(readDensity('?density=compact', null)).toBe('compact');
    expect(readDensity('?density=comfortable', 'compact')).toBe('comfortable');
    expect(readDensity('', 'compact')).toBe('compact');
    expect(readDensity('', 'tiny')).toBe('comfortable');
    expect(readDensity('', null)).toBe('comfortable');
  });
});
