/**
 * `tree-fs.ts`, the cases from the wall-escape review: a folder below the
 * root on another volume (a mount the lead attached) is refused, read and
 * listing alike; a rewrite keeps the file's permission bits; a listing that
 * fails inside `readdirFd` closes its descriptor once; and the native calls
 * load only where their struct offsets were measured. The device is handed
 * back by a seam (`setTreeDevForTest`), so no disk image is mounted. The
 * last case runs everywhere; the rest are macOS only. Fixtures synthetic.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardRefused } from '../src/guard-refused.ts';
import { nativeSupported, setTreeNativeForTest, treeNative } from '../src/tree-fs-native.ts';
import {
  type Contained,
  listTreeSync,
  openFileSync,
  pinRoot,
  setTreeDevForTest,
  writeTree,
  writeTreeSync,
} from '../src/tree-fs.ts';

const top = realpathSync(mkdtempSync(join(tmpdir(), 'tree-fs-vm-')));
afterAll(() => rmSync(top, { recursive: true, force: true }));
afterEach(() => {
  setTreeDevForTest(null);
  setTreeNativeForTest(undefined);
});

const root = join(top, 'harborlight');
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, 'mounted'));
writeFileSync(join(root, 'docs', 'plain.md'), '# plain\n');
writeFileSync(join(root, 'mounted', 'remote.md'), '# remote\n');
const at = (rel: string): Contained => ({ root, abs: rel === '' ? root : `${root}/${rel}` });

/** As if a volume were mounted on `mounted/`: everything there reports
 *  another device. */
const mountOnMounted = () =>
  setTreeDevForTest((c, dev) => (c.abs.startsWith(join(root, 'mounted')) ? dev + 1 : dev));

const modeOf = (p: string) => statSync(p).mode & 0o7777;

describe.skipIf(process.platform !== 'darwin')('tree-fs volumes and modes (macOS)', () => {
  pinRoot(root);

  it('refuses a file on a volume mounted below the root, and reads one beside it', () => {
    mountOnMounted();
    expect(() => openFileSync(at('mounted/remote.md'))).toThrow(GuardRefused);
    const { fd } = openFileSync(at('docs/plain.md'));
    closeSync(fd);
  });

  it('lists nothing from a folder on another volume', () => {
    mountOnMounted();
    const listed = listTreeSync(at(''), { maxEntries: 100 })?.map((e) => e.rel);
    expect(listed).toContain('docs/plain.md');
    expect(listed).not.toContain('mounted/remote.md');
  });

  it('keeps a 0600 file 0600 through both writes, and makes a new file 0644', async () => {
    const secret = join(root, 'docs', 'private.md');
    writeFileSync(secret, 'x');
    chmodSync(secret, 0o600);
    writeTreeSync(at('docs/private.md'), Buffer.from('y'), 'flush');
    expect(modeOf(secret)).toBe(0o600);
    await writeTree(at('docs/private.md'), 'z', 'pool-write');
    expect(modeOf(secret)).toBe(0o600);
    writeTreeSync(at('docs/fresh.md'), Buffer.from('n'), 'flush');
    expect(modeOf(join(root, 'docs', 'fresh.md'))).toBe(0o644);
  });

  it('closes a listed folder once when reading its entries fails', () => {
    const real = treeNative();
    expect(real).not.toBeNull();
    if (!real) return;
    setTreeNativeForTest({
      ...real,
      readdirFd(fd) {
        closeSync(fd);
        throw new Error('entries unreadable');
      },
    });
    // A second close of the same number would throw EBADF in place of this.
    expect(() => listTreeSync(at('docs'), { maxEntries: 100 })).toThrow('entries unreadable');
  });
});

describe('where the native calls load', () => {
  it('only on macOS on arm64, where the struct offsets were measured', () => {
    expect(nativeSupported('darwin', 'arm64')).toBe(true);
    expect(nativeSupported('darwin', 'x64')).toBe(false);
    expect(nativeSupported('linux', 'arm64')).toBe(false);
    expect(nativeSupported('linux', 'x64')).toBe(false);
  });
});
