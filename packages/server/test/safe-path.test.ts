/**
 * `realPathUnder` names the file a path really lands on, relative to the
 * root, so a rule about names can judge a symlink's target as well as the
 * link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithinRoot, realPathUnder } from '../src/safe-path.ts';

describe('realPathUnder', () => {
  let dir: string;
  let root: string;

  beforeAll(() => {
    // tmpdir() on macOS is a symlinked path; both sides are resolved.
    dir = mkdtempSync(join(tmpdir(), 'safe-path-'));
    root = join(dir, 'riverbend');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'plan.md'), 'plan\n');
    writeFileSync(join(dir, 'outside.md'), 'outside\n');
    symlinkSync('sub/plan.md', join(root, 'alias.md'));
    symlinkSync('alias.md', join(root, 'chain.md'));
    symlinkSync(join(dir, 'outside.md'), join(root, 'out.md'));
    symlinkSync('missing.md', join(root, 'dangling.md'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names a plain file by its own path, and the root as empty', () => {
    expect(realPathUnder(root, join(root, 'sub', 'plan.md'))).toBe('sub/plan.md');
    expect(realPathUnder(root, root)).toBe('');
  });

  it('follows a symlink, and a chain of them, to the file it lands on', () => {
    expect(realPathUnder(root, join(root, 'alias.md'))).toBe('sub/plan.md');
    expect(realPathUnder(root, join(root, 'chain.md'))).toBe('sub/plan.md');
  });

  it('answers null outside the root, for a dangling link and a missing file', () => {
    expect(realPathUnder(root, join(root, 'out.md'))).toBeNull();
    expect(realPathUnder(root, join(root, 'dangling.md'))).toBeNull();
    expect(realPathUnder(root, join(root, 'nope.md'))).toBeNull();
    // Agrees with the containment check it refines.
    expect(isWithinRoot(root, join(root, 'out.md'))).toBe(false);
    expect(isWithinRoot(root, join(root, 'alias.md'))).toBe(true);
  });
});
