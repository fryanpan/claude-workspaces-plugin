/**
 * Every caller of `tree-fs.ts` keeps working on every platform the server
 * runs on, including Linux, where no walled lead runs and the darwin calls
 * must never load. A folder registered as a lead's root is listed (the bind's
 * scan and the folder watch), made with `mkdir -p`, written and read back
 * through the bound-file guards. On macOS on arm64 that goes through the
 * contained calls; elsewhere through the plain-path checks, and the native
 * calls stay unloaded. This file runs in CI. Fixtures synthetic.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { folderListing } from '../src/folder-watch.ts';
import { scanFolder } from '../src/fs-scan.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { nativeSupported, treeNative } from '../src/tree-fs-native.ts';
import { treeFsMode } from '../src/tree-fs.ts';

const top = realpathSync(mkdtempSync(join(tmpdir(), 'tree-fs-platform-')));
const root = join(top, 'harborlight');
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n');
writeFileSync(join(root, 'README.md'), '# Harborlight\n');

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

const guards = boundFiles.guards;
const supported = nativeSupported(process.platform, process.arch);

describe(`tree-fs callers on ${process.platform}/${process.arch}`, () => {
  expect(roots.set('w-harbor', [root]).ok).toBe(true);

  it('is contained only where the native calls are supported, and loads them nowhere else', () => {
    expect(treeFsMode()).toBe(
      supported ? 'contained' : process.platform === 'darwin' ? 'refuse' : 'legacy',
    );
    if (!supported) expect(treeNative()).toBeNull();
    expect(guards.covers(join(root, 'docs', 'plan.md'))).toBe(true);
  });

  it.skipIf(process.platform === 'darwin' && !supported)(
    'lists the root for a bind and for the folder watch',
    async () => {
      expect(scanFolder(root).sort()).toEqual([
        join(root, 'README.md'),
        join(root, 'docs', 'plan.md'),
      ]);
      const watched = await folderListing(root);
      expect(watched && [...watched].sort()).toEqual(['README.md', 'docs/plan.md']);
    },
  );

  it.skipIf(process.platform === 'darwin' && !supported)(
    'makes nested folders, writes a file in them and reads it back',
    async () => {
      const dir = join(root, 'notes', 'week-1');
      guards.mkdirSync(dir);
      guards.writeSync(join(dir, 'monday.md'), '# Monday\n', 'flush');
      await guards.write(join(dir, 'tuesday.md'), '# Tuesday\n');
      expect(readFileSync(join(dir, 'monday.md'), 'utf8')).toBe('# Monday\n');
      expect(guards.readSync(join(dir, 'tuesday.md'))).toBe('# Tuesday\n');
      expect((await guards.read(join(dir, 'monday.md'))).text).toBe('# Monday\n');
    },
  );
});
