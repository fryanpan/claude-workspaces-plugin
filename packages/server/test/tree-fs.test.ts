/**
 * `tree-fs.ts`: every read, listing, folder make and write under a root
 * refuses a link anywhere below the root, a hard link, a FIFO, a folder
 * moved out while it was being opened, and a root put in place of the one
 * registered; and a temp file planted ahead of a write cannot carry it.
 *
 * Each case builds its fixture in a fresh temp folder beside an "outside"
 * canary folder holding unique bytes, and each refusal checks the canary is
 * unchanged. Each has a positive control on a plain file. macOS only, as the
 * module is. Fixtures synthetic.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardRefused } from '../src/guard-refused.ts';
import { SF_DATALESS, setTreeNativeForTest, treeNative } from '../src/tree-fs-native.ts';
import {
  type Contained,
  listTreeSync,
  mkdirTreeSync,
  openFileSync,
  pinRoot,
  setTempNameForTest,
  setTreeSeamForTest,
  treeFsMode,
  writeTree,
  writeTreeSync,
} from '../src/tree-fs.ts';
import { makeFifo } from './fifo.ts';

const CANARY = 'riverbend-canary-7f3a9c';
const top = realpathSync(mkdtempSync(join(tmpdir(), 'tree-fs-')));
afterAll(() => rmSync(top, { recursive: true, force: true }));

let n = 0;
let root: string;
let outside: string;

beforeEach(() => {
  n += 1;
  root = join(top, `harborlight-${n}`);
  outside = join(top, `outside-${n}`);
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'docs', 'plain.md'), '# plain\n');
  writeFileSync(join(outside, 'secret.md'), CANARY);
  pinRoot(root);
});
afterEach(() => {
  setTreeSeamForTest(null);
  setTempNameForTest(null);
  setTreeNativeForTest(undefined);
});

const at = (rel: string): Contained => ({ root, abs: rel === '' ? root : `${root}/${rel}` });

/** The outside folder's names, sizes and mtimes, and its canary's bytes. */
function canary(): string {
  return JSON.stringify(
    readdirSync(outside)
      .sort()
      .map((name) => {
        const st = statSync(join(outside, name));
        return [
          name,
          st.size,
          st.mtimeMs,
          st.isFile() ? readFileSync(join(outside, name), 'utf8') : '',
        ];
      }),
  );
}

function readText(c: Contained): string {
  const { fd } = openFileSync(c);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function refused(fn: () => unknown): void {
  expect(fn).toThrow(GuardRefused);
}

/** Refused with any error: the kernel's own refusal (ELOOP) counts. */
function failed(fn: () => unknown): void {
  expect(fn).toThrow();
}

describe.skipIf(process.platform !== 'darwin')('tree-fs (macOS)', () => {
  it('runs contained here, and refuses every covered path when the native calls are missing', () => {
    expect(treeFsMode()).toBe('contained');
    setTreeNativeForTest(null);
    expect(treeFsMode()).toBe('refuse');
    refused(() => mkdirTreeSync(at('docs/new')));
  });

  describe('T1, reads', () => {
    it('reads a plain file under the root (control)', () => {
      expect(readText(at('docs/plain.md'))).toBe('# plain\n');
    });

    it('refuses a folder link, a file link and a relative link below the root', () => {
      const before = canary();
      symlinkSync(outside, join(root, 'out'));
      symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'file-link.md'));
      symlinkSync(`../../outside-${n}`, join(root, 'docs', 'rel'));
      failed(() => readText(at('out/secret.md')));
      failed(() => readText(at('docs/file-link.md')));
      failed(() => readText(at('docs/rel/secret.md')));
      expect(canary()).toBe(before);
    });

    it('refuses a link that stays inside the root, since no link below a root is followed', () => {
      symlinkSync(join(root, 'docs'), join(root, 'alias'));
      failed(() => readText(at('alias/plain.md')));
    });

    it('refuses a folder holding a link that was renamed in from outside', () => {
      const staged = join(top, `staged-${n}`);
      mkdirSync(staged);
      symlinkSync(join(outside, 'secret.md'), join(staged, 'notes.md'));
      renameSync(staged, join(root, 'moved-in'));
      failed(() => readText(at('moved-in/notes.md')));
    });

    it('refuses a hard link to an outside file', () => {
      linkSync(join(outside, 'secret.md'), join(root, 'docs', 'hard.md'));
      refused(() => readText(at('docs/hard.md')));
    });

    it('refuses a FIFO without blocking', () => {
      makeFifo(join(root, 'docs', 'pipe.md'));
      refused(() => readText(at('docs/pipe.md')));
    });

    it('refuses a path with a .. or an empty name, and a path off its root', () => {
      refused(() => readText(at('docs/../docs/plain.md')));
      refused(() => readText(at('docs//plain.md')));
      expect(() => readText({ root, abs: `${root}-evil/secret.md` })).toThrow(
        /is not under its root/,
      );
    });

    it('refuses a root that is no longer the folder registered', () => {
      renameSync(root, `${root}-old`);
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'plain.md'), '# impostor\n');
      refused(() => readText(at('docs/plain.md')));
      pinRoot(root);
      expect(readText(at('docs/plain.md'))).toBe('# impostor\n');
    });

    it('refuses a folder moved out of the root between the open and its judging (T3)', () => {
      setTreeSeamForTest((c) => {
        if (c.abs.endsWith('plain.md')) renameSync(join(root, 'docs'), join(outside, 'docs'));
      });
      refused(() => readText(at('docs/plain.md')));
    });

    it('refuses a file whose bytes are in the cloud, before opening it', () => {
      const real = treeNative();
      if (!real) throw new Error('no native calls');
      setTreeNativeForTest({ ...real, flagsAt: () => SF_DATALESS });
      refused(() => readText(at('docs/plain.md')));
    });
  });

  describe('T4, listing', () => {
    it('lists plain files and folders (control)', () => {
      writeFileSync(join(root, 'top.md'), 'x');
      const listed = listTreeSync(at(''), { maxEntries: 100 });
      expect(listed?.map((e) => `${e.kind}:${e.rel}`).sort()).toEqual([
        'dir:docs',
        'file:docs/plain.md',
        'file:top.md',
      ]);
    });

    it('reports a link as a link and never lists what is behind it', () => {
      symlinkSync(outside, join(root, 'out'));
      makeFifo(join(root, 'docs', 'pipe.md'));
      const listed = listTreeSync(at(''), { maxEntries: 100 }) ?? [];
      expect(listed.find((e) => e.rel === 'out')?.kind).toBe('link');
      expect(listed.find((e) => e.rel === 'docs/pipe.md')?.kind).toBe('other');
      expect(listed.some((e) => e.rel.includes('secret'))).toBe(false);
    });

    it('skips a folder swapped for a link after its parent was read', () => {
      // `enter` runs after the parent's entries are read and before the
      // child is opened: the moment a walk by path would follow the swap.
      const enter = (rel: string) => {
        if (rel === 'docs') {
          renameSync(join(root, 'docs'), join(root, 'docs-real'));
          symlinkSync(outside, join(root, 'docs'));
        }
        return true;
      };
      const listed = listTreeSync(at(''), { maxEntries: 100, enter }) ?? [];
      expect(listed.map((e) => e.rel)).toEqual(['docs']);
    });

    it('never walks into a link that stays inside the root', () => {
      symlinkSync(join(root, 'docs'), join(root, 'alias'));
      const listed = listTreeSync(at(''), { maxEntries: 100 }) ?? [];
      expect(listed.some((e) => e.rel.startsWith('alias/'))).toBe(false);
    });

    it('answers null past its entry bound, and does not enter a folder it is told to skip', () => {
      for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.md`), 'x');
      expect(listTreeSync(at(''), { maxEntries: 3 })).toBeNull();
      const listed = listTreeSync(at(''), { maxEntries: 100, enter: () => false }) ?? [];
      expect(listed.some((e) => e.rel === 'docs/plain.md')).toBe(false);
    });
  });

  describe('T2, folders and writes', () => {
    it('makes nested folders and writes a new and an existing file (control)', async () => {
      mkdirTreeSync(at('a/b/c'));
      expect(statSync(join(root, 'a', 'b', 'c')).isDirectory()).toBe(true);
      writeTreeSync(at('a/b/c/new.md'), Buffer.from('# new\n'), 'export');
      expect(readFileSync(join(root, 'a/b/c/new.md'), 'utf8')).toBe('# new\n');
      await writeTree(at('docs/plain.md'), '# changed\n', 'pool-write');
      expect(readFileSync(join(root, 'docs/plain.md'), 'utf8')).toBe('# changed\n');
      expect(readdirSync(join(root, 'docs'))).toEqual(['plain.md']);
    });

    it('makes no folder through a linked parent', () => {
      const before = canary();
      symlinkSync(outside, join(root, 'out'));
      failed(() => mkdirTreeSync(at('out/made')));
      expect(existsSync(join(outside, 'made'))).toBe(false);
      expect(canary()).toBe(before);
    });

    it('makes no folder through a link that stays inside the root', () => {
      symlinkSync(join(root, 'docs'), join(root, 'alias'));
      failed(() => mkdirTreeSync(at('alias/made')));
      expect(existsSync(join(root, 'docs', 'made'))).toBe(false);
    });

    it('refuses a link planted at the temp name that points at another file in the root', () => {
      writeFileSync(join(root, 'docs', 'other.md'), '# other\n');
      setTempNameForTest((name) => `${name}.guessed~`);
      symlinkSync(join(root, 'docs', 'other.md'), join(root, 'docs', 'plain.md.guessed~'));
      failed(() => writeTreeSync(at('docs/plain.md'), Buffer.from('owned'), 'flush'));
      expect(readFileSync(join(root, 'docs/other.md'), 'utf8')).toBe('# other\n');
      expect(readFileSync(join(root, 'docs/plain.md'), 'utf8')).toBe('# plain\n');
    });

    it('refuses a write whose target is a link, or whose parent is', async () => {
      const before = canary();
      symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'target.md'));
      symlinkSync(outside, join(root, 'out'));
      refused(() => writeTreeSync(at('docs/target.md'), Buffer.from('owned'), 'flush'));
      failed(() => writeTreeSync(at('out/secret.md'), Buffer.from('owned'), 'flush'));
      await expect(writeTree(at('out/new.md'), 'owned', 'pool-write')).rejects.toThrow();
      expect(canary()).toBe(before);
      expect(readdirSync(join(root, 'docs')).sort()).toEqual(['plain.md', 'target.md']);
    });

    it('refuses a hard-linked target, so the outside name never reads the new bytes', () => {
      const before = canary();
      linkSync(join(outside, 'secret.md'), join(root, 'docs', 'hard.md'));
      refused(() => writeTreeSync(at('docs/hard.md'), Buffer.from('owned'), 'flush'));
      expect(canary()).toBe(before);
    });

    it('refuses a link planted at the temp name, and leaves the planted link alone', () => {
      const before = canary();
      setTempNameForTest((name) => `${name}.guessed~`);
      symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'plain.md.guessed~'));
      failed(() => writeTreeSync(at('docs/plain.md'), Buffer.from('owned'), 'flush'));
      expect(canary()).toBe(before);
      expect(readFileSync(join(root, 'docs/plain.md'), 'utf8')).toBe('# plain\n');
    });

    it('removes its temp file when the folder moves out mid-write', () => {
      setTreeSeamForTest((c) => {
        if (c.abs.includes('.cw-flush-')) renameSync(join(root, 'docs'), join(outside, 'docs'));
      });
      refused(() => writeTreeSync(at('docs/plain.md'), Buffer.from('owned'), 'flush'));
      expect(readFileSync(join(outside, 'docs', 'plain.md'), 'utf8')).toBe('# plain\n');
      expect(readdirSync(join(outside, 'docs'))).toEqual(['plain.md']);
    });
  });
});
