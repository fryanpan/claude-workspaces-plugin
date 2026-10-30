/**
 * `PathGuards` sends a path under a walled lead's root through `tree-fs.ts`
 * on macOS: every read, stat, folder make and write there refuses a link
 * below the root even when it leads back inside, and a write onto a file
 * with a second name. The plain-path checks it used before allowed both, so
 * each case here is one they would pass. A path outside every root is read
 * as before (the control), and on macOS without the contained calls every
 * rooted path is refused. Fixtures synthetic.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { GuardRefused, PathGuards } from '../src/bound-path-guard.ts';
import { setTreeNativeForTest } from '../src/tree-fs-native.ts';

const top = realpathSync(mkdtempSync(join(tmpdir(), 'guard-tree-')));
afterAll(() => rmSync(top, { recursive: true, force: true }));
afterEach(() => setTreeNativeForTest(undefined));

const root = join(top, 'harborlight');
const elsewhere = join(top, 'riverbend');
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(elsewhere);
writeFileSync(join(root, 'docs', 'plain.md'), '# plain\n');
writeFileSync(join(root, 'docs', 'second.md'), '# second\n');
writeFileSync(join(elsewhere, 'free.md'), '# free\n');
// Links and names a lead could make, each leading back inside its root.
symlinkSync(join(root, 'docs'), join(root, 'alias'));
linkSync(join(root, 'docs', 'second.md'), join(root, 'twin.md'));

const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const guards = new PathGuards();
guards.add(roots);
expect(roots.set('w-harbor', [root]).ok).toBe(true);

const aliased = join(root, 'alias', 'plain.md');

describe.skipIf(process.platform !== 'darwin')('PathGuards under a walled lead’s root', () => {
  it('reads, stats and writes a plain file under the root, and one outside every root', async () => {
    expect(guards.readSync(join(root, 'docs', 'plain.md'))).toBe('# plain\n');
    expect((await guards.read(join(root, 'docs', 'plain.md'))).text).toBe('# plain\n');
    expect(guards.statSync(join(root, 'docs', 'plain.md')).size).toBe(8);
    guards.writeSync(join(root, 'docs', 'plain.md'), '# plain\n', 'flush');
    await guards.write(join(root, 'docs', 'new.md'), '# new\n');
    expect(readFileSync(join(root, 'docs', 'new.md'), 'utf8')).toBe('# new\n');
    expect(guards.readSync(join(elsewhere, 'free.md'))).toBe('# free\n');
  });

  it('names the root and the path as it spells them, and no root for a path outside', () => {
    expect(roots.containedOf(join(root, 'docs', 'plain.md'))).toEqual({
      root,
      abs: join(root, 'docs', 'plain.md'),
    });
    expect(roots.containedOf(join(elsewhere, 'free.md'))).toBeNull();
  });

  it('refuses every read through a link that leads back inside the root', async () => {
    expect(() => guards.readSync(aliased)).toThrow(GuardRefused);
    await expect(guards.read(aliased)).rejects.toThrow(GuardRefused);
    expect(() => guards.statSync(aliased)).toThrow(GuardRefused);
    await expect(guards.stat(aliased)).rejects.toThrow(GuardRefused);
    expect(() => guards.readBoundedBytesSync(aliased, 1024)).toThrow(GuardRefused);
    await expect(guards.readRange(aliased, 0, 3) ?? Promise.resolve()).rejects.toThrow(
      GuardRefused,
    );
  });

  it('makes no folder and writes no file through that link', async () => {
    expect(() => guards.mkdirSync(join(root, 'alias', 'made'))).toThrow(GuardRefused);
    expect(existsSync(join(root, 'docs', 'made'))).toBe(false);
    expect(() => guards.writeSync(join(root, 'alias', 'x.md'), 'x', 'export')).toThrow(
      GuardRefused,
    );
    await expect(guards.write(join(root, 'alias', 'y.md'), 'y')).rejects.toThrow(GuardRefused);
    expect(existsSync(join(root, 'docs', 'x.md')) || existsSync(join(root, 'docs', 'y.md'))).toBe(
      false,
    );
  });

  it('refuses a write onto a file that has a second name', async () => {
    expect(() => guards.writeSync(join(root, 'twin.md'), 'over', 'flush')).toThrow(GuardRefused);
    await expect(guards.write(join(root, 'twin.md'), 'over')).rejects.toThrow(GuardRefused);
    expect(readFileSync(join(root, 'docs', 'second.md'), 'utf8')).toBe('# second\n');
  });

  it('refuses a root put in place of the folder that was registered, before any read', () => {
    const fresh = join(top, 'saltmarsh');
    mkdirSync(fresh);
    expect(roots.set('w-salt', [fresh]).ok).toBe(true);
    renameSync(fresh, `${fresh}.old`);
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'plan.md'), '# impostor\n');
    expect(() => guards.readSync(join(fresh, 'plan.md'))).toThrow(GuardRefused);
  });

  it('refuses every rooted path when the contained calls are missing', () => {
    setTreeNativeForTest(null);
    expect(() => guards.readSync(join(root, 'docs', 'plain.md'))).toThrow(GuardRefused);
    expect(guards.readSync(join(elsewhere, 'free.md'))).toBe('# free\n');
  });
});
