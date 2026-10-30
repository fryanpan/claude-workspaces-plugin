/**
 * `fs-scan-contained.ts` lists a folder under a walled lead's root through
 * `tree-fs.ts`: files spelled from the folder asked for, links and FIFOs
 * skipped with the caller's reason, skipped folders reported but `.git`
 * never named, and a refused root listing nothing. A folder outside every
 * root takes the plain walk (the control). macOS only. Fixtures synthetic.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { containedRoot, includedStat, readdirContained } from '../src/fs-scan-contained.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo } from './fifo.ts';

const top = realpathSync(mkdtempSync(join(tmpdir(), 'scan-contained-')));
const root = join(top, 'harborlight');
const outside = join(top, 'riverbend');
mkdirSync(join(root, 'docs', 'deep'), { recursive: true });
mkdirSync(join(root, '.git'));
mkdirSync(join(root, 'build'));
mkdirSync(outside);
writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n');
writeFileSync(join(root, 'docs', 'deep', 'notes.md'), '# notes\n');
writeFileSync(join(root, 'docs', 'skip.bin'), 'x');
writeFileSync(join(outside, 'secret.md'), 'riverbend');
symlinkSync(outside, join(root, 'docs', 'out'));

const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const remove = boundFiles.guards.add(roots);
afterAll(() => {
  remove();
  rmSync(top, { recursive: true, force: true });
});

type Why = 'skipped-dir' | 'binary' | 'not-a-regular-file';
const skips = {
  skipDir: (name: string): Why | null =>
    name === '.git' || name === 'build' ? 'skipped-dir' : null,
  skipFile: (name: string): Why | null => (name.endsWith('.bin') ? 'binary' : null),
  notRegular: 'not-a-regular-file' as const,
};

describe.skipIf(process.platform !== 'darwin')('the folder scan under a walled lead’s root', () => {
  expect(roots.set('w-harbor', [root]).ok).toBe(true);
  makeFifo(join(root, 'docs', 'pipe.md'));

  it('lists the files, skips a link, a FIFO and named folders, and never names .git', () => {
    const c = containedRoot(root);
    expect(c).not.toBeNull();
    const skipped: Array<{ path: string; reason: Why }> = [];
    const listed = readdirContained(root, c ?? 'refused', skipped, skips).sort();
    expect(listed).toEqual([join(root, 'docs', 'deep', 'notes.md'), join(root, 'docs', 'plan.md')]);
    expect(skipped).toContainEqual({ path: 'docs/out', reason: 'not-a-regular-file' });
    expect(skipped).toContainEqual({ path: 'docs/pipe.md', reason: 'not-a-regular-file' });
    expect(skipped).toContainEqual({ path: 'docs/skip.bin', reason: 'binary' });
    expect(skipped).toContainEqual({ path: 'build/', reason: 'skipped-dir' });
    expect(skipped.some((s) => s.path.startsWith('.git'))).toBe(false);
  });

  it('spells a subfolder’s entries from that subfolder', () => {
    const sub = join(root, 'docs');
    const c = containedRoot(sub);
    const listed = readdirContained(sub, c ?? 'refused', null, skips).sort();
    expect(listed).toEqual([join(sub, 'deep', 'notes.md'), join(sub, 'plan.md')]);
  });

  it('lists nothing for a refused root, and nothing through a linked subfolder', () => {
    expect(readdirContained(root, 'refused', null, skips)).toEqual([]);
    const linked = join(root, 'docs', 'out');
    const c = containedRoot(linked);
    expect(c).not.toBeNull();
    expect(readdirContained(linked, c ?? 'refused', null, skips)).toEqual([]);
  });

  it('stats an include from a descriptor, refusing one behind a link', () => {
    expect(includedStat(join(root, 'docs', 'plan.md'))).toHaveProperty('size', 7);
    expect(includedStat(join(root, 'docs', 'out', 'secret.md'))).toBe('not-a-regular-file');
    expect(includedStat(join(root, 'docs', 'gone.md'))).toBe('not-found');
  });

  it('takes the plain walk for a folder outside every root (control)', () => {
    expect(containedRoot(outside)).toBeNull();
    expect(includedStat(join(outside, 'secret.md'))).toHaveProperty('size', 9);
  });
});
