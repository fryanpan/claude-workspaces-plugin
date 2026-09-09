/**
 * Mounted folders over a real git checkout: the address a file keeps, the
 * move that follows it, and the retention rule.
 *
 * Fixtures are synthetic — a throwaway repo with a fictional remote — and the
 * assertions are about what the store DID, never about a source file's text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMountableRelPath } from '../src/mount-scan.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('MountStore', () => {
  let tmp: string;
  let repo: string;
  let dataDir: string;
  let store: MountStore;

  const mocks = () => join(repo, 'docs', 'mocks');
  const shipped = () => join(repo, 'docs', 'shipped');

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-mount-store-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    repo = join(tmp, 'widgets');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.example:example/widgets.git');
    mkdirSync(mocks(), { recursive: true });
    mkdirSync(shipped(), { recursive: true });
    writeFileSync(join(mocks(), 'home.png'), 'round-one-bytes');
    writeFileSync(join(repo, 'README.md'), '# Widgets\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    store = new MountStore(dataDir, new RepoRegistry(dataDir));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const mount = (path: string): string => {
    const res = store.mount(path);
    if (!res.ok) throw new Error(`mount refused: ${res.error}`);
    return res.mount.mountId;
  };
  const idOf = (relFromRepo: string): string => {
    const found = store
      .reconcile(store.locate(repo)?.repoKey ?? '', true)
      .files.find((f) => f.relPath === relFromRepo);
    if (!found) throw new Error(`no address for ${relFromRepo}`);
    return found.fileId;
  };

  describe('one address per file', () => {
    it('keeps the address when the file is rewritten in place', () => {
      mount(mocks());
      const before = idOf('docs/mocks/home.png');
      const first = store.resolveFile(before);
      expect(first?.file.size).toBe('round-one-bytes'.length);

      writeFileSync(join(mocks(), 'home.png'), 'round-two-bytes-are-longer');
      const after = idOf('docs/mocks/home.png');
      expect(after).toBe(before);
      // The address is the same and the bytes behind it are the new ones.
      expect(store.resolveFile(after)?.file.size).toBe('round-two-bytes-are-longer'.length);
    });

    it('keeps the address across a restart of the server', () => {
      mount(mocks());
      const before = idOf('docs/mocks/home.png');
      // A fresh store over the same data directory is what a restart is.
      const restarted = new MountStore(dataDir, new RepoRegistry(dataDir));
      expect(restarted.resolveFile(before)?.file.relPath).toBe('docs/mocks/home.png');
    });

    it('gives a mount reached through a worktree the same addresses', () => {
      mount(mocks());
      const viaMain = idOf('docs/mocks/home.png');
      const wt = join(tmp, 'wt-feature');
      git(repo, 'worktree', 'add', wt, '-b', 'feature');
      // Mounting the same folder through a linked worktree is the same mount:
      // the key is the repo plus the path from its root, not the checkout.
      const res = store.mount(join(wt, 'docs', 'mocks'));
      expect(res.ok).toBe(true);
      expect(idOf('docs/mocks/home.png')).toBe(viaMain);
    });

    it('never gives an address to a credential-shaped name', () => {
      writeFileSync(join(mocks(), '.env'), 'SAMPLE_TOKEN=not-a-real-value\n');
      writeFileSync(join(mocks(), 'deploy.key'), 'placeholder\n');
      mount(mocks());
      const listed = store
        .reconcile(store.locate(repo)?.repoKey ?? '', true)
        .files.map((f) => f.relPath);
      expect(listed).toEqual(['docs/mocks/home.png']);
    });
  });

  describe('a file that moves to another mount', () => {
    it('carries its address and its old spelling with it', () => {
      mount(mocks());
      mount(shipped());
      const before = idOf('docs/mocks/home.png');

      renameSync(join(mocks(), 'home.png'), join(shipped(), 'home.png'));

      // Nobody commanded the move. Asking for the old address is what finds it.
      const found = store.resolveFile(before);
      expect(found?.file.relPath).toBe('docs/shipped/home.png');
      expect(found?.file.fileId).toBe(before);
      // And the file now at the new path answers at that same address.
      expect(idOf('docs/shipped/home.png')).toBe(before);
    });

    it('mints a new address for a genuinely new file rather than reusing one', () => {
      mount(mocks());
      mount(shipped());
      const before = idOf('docs/mocks/home.png');
      writeFileSync(join(shipped(), 'about.png'), 'quite different bytes');
      expect(idOf('docs/shipped/about.png')).not.toBe(before);
      // The original is untouched and still at its own address.
      expect(store.resolveFile(before)?.file.relPath).toBe('docs/mocks/home.png');
    });

    it('answers nothing for a file that was deleted rather than moved', () => {
      mount(mocks());
      const before = idOf('docs/mocks/home.png');
      rmSync(join(mocks(), 'home.png'));
      expect(store.resolveFile(before)).toBeNull();
    });
  });

  describe('retention is the project’s', () => {
    it('unmounting removes no file and keeps the row', () => {
      const mountId = mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      expect(store.unmount(repoKey, mountId)).toBe(true);

      // The whole point: nothing on disk was touched.
      expect(existsSync(join(mocks(), 'home.png'))).toBe(true);
      expect(existsSync(mocks())).toBe(true);
      expect(store.registry.allMounts(repoKey)).toHaveLength(1);
      expect(store.registry.liveMounts(repoKey)).toHaveLength(0);
    });

    it('re-mounting brings every file back at the address it had', () => {
      const mountId = mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const before = idOf('docs/mocks/home.png');
      store.unmount(repoKey, mountId);
      expect(store.resolveFile(before)).toBeNull();
      expect(mount(mocks())).toBe(mountId);
      expect(store.resolveFile(before)?.file.relPath).toBe('docs/mocks/home.png');
    });
  });

  describe('what may be mounted', () => {
    it('refuses a path outside a repo, a file, and a dot-directory', () => {
      const outside = join(tmp, 'loose');
      mkdirSync(outside);
      expect(store.mount(outside)).toEqual({ ok: false, error: 'not-a-repo' });
      expect(store.mount(join(repo, 'README.md'))).toEqual({ ok: false, error: 'not-a-directory' });
      mkdirSync(join(repo, '.private'));
      expect(store.mount(join(repo, '.private'))).toEqual({ ok: false, error: 'refused-path' });
    });

    it('judges a mountable path without touching the filesystem', () => {
      expect(isMountableRelPath('docs/mocks')).toBe(true);
      expect(isMountableRelPath('.claude/mocks')).toBe(false);
      expect(isMountableRelPath('docs/../../etc')).toBe(false);
      expect(isMountableRelPath('')).toBe(false);
    });
  });

  describe('the conventions index', () => {
    it('defaults to WORKSPACES.md and reads it once it exists', () => {
      mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      expect(store.conventions(repoKey)).toMatchObject({
        relPath: 'WORKSPACES.md',
        text: null,
      });
      writeFileSync(join(repo, 'WORKSPACES.md'), 'Plans go in docs/plans.\n');
      expect(store.conventions(repoKey).text).toBe('Plans go in docs/plans.\n');
    });

    it('reads the file the lead pointed it at instead', () => {
      mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      mkdirSync(join(repo, 'docs', 'meta'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'meta', 'conventions.md'), 'Meeting notes: docs/notes.\n');
      store.setConventionsPath(repoKey, 'docs/meta/conventions.md');
      expect(store.conventions(repoKey)).toMatchObject({
        relPath: 'docs/meta/conventions.md',
        text: 'Meeting notes: docs/notes.\n',
      });
    });
  });

  describe('paging a large mount', () => {
    it('pages by path and stops when there is no more', () => {
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(mocks(), `shot-${String(i).padStart(3, '0')}.png`), `bytes ${i}`);
      }
      mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const first = store.listFiles(repoKey, { limit: 10 });
      expect(first.files).toHaveLength(10);
      expect(first.nextAfter).toBe(first.files[9]?.relPath);
      const second = store.listFiles(repoKey, { limit: 10, after: first.nextAfter as string });
      expect(second.files[0]?.relPath > (first.nextAfter as string)).toBe(true);
      const last = store.listFiles(repoKey, { limit: 1000 });
      expect(last.files).toHaveLength(26);
      expect(last.nextAfter).toBeUndefined();
    });
  });
  describe('the checkout a mount was made from', () => {
    /**
     * A folder mounted from a linked worktree holds THAT branch's files. The
     * address stays repo-relative — that is what lets a link survive between
     * checkouts — but the bytes have to come from the working copy the lead
     * pointed at, or a branch-only file reads as missing and every shared
     * path answers with the main checkout's revision.
     */
    it("serves the worktree's own files, not the main checkout's", () => {
      const wt = join(tmp, 'wt-feature');
      git(repo, 'worktree', 'add', wt, '-b', 'feature');
      const wtMocks = join(wt, 'docs', 'mocks');
      writeFileSync(join(wtMocks, 'checkout.png'), 'branch-only-bytes');
      writeFileSync(join(wtMocks, 'home.png'), 'worktree-home-bytes-differ');

      mount(wtMocks);
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const listed = store.reconcile(repoKey, true).files;
      expect(listed.map((f) => f.relPath)).toEqual([
        'docs/mocks/checkout.png',
        'docs/mocks/home.png',
      ]);

      const home = listed.find((f) => f.relPath === 'docs/mocks/home.png');
      const served = store.resolveFile(home?.fileId ?? '');
      expect(served?.abs).toBe(join(wtMocks, 'home.png'));
      expect(served?.file.size).toBe('worktree-home-bytes-differ'.length);
    });
  });

  describe('what a listing reports', () => {
    /**
     * The table is append-only on purpose: a deleted file keeps its address
     * and a moved file keeps the spelling it used to answer at, so a link
     * written a month ago still opens the right thing. None of that history
     * is a row in a listing.
     */
    it('shows the current scan only, while the old addresses still resolve', () => {
      mount(mocks());
      mount(shipped());
      writeFileSync(join(mocks(), 'about.png'), 'about-byte');
      const home = idOf('docs/mocks/home.png');
      const about = idOf('docs/mocks/about.png');

      renameSync(join(mocks(), 'home.png'), join(shipped(), 'home.png'));
      rmSync(join(mocks(), 'about.png'));

      const repoKey = store.locate(repo)?.repoKey ?? '';
      const listing = store.reconcile(repoKey, true);
      // One row: not the deleted file, and not both spellings of the move.
      expect(listing.files.map((f) => f.relPath)).toEqual(['docs/shipped/home.png']);
      expect(listing.truncated).toBe(false);
      expect(store.listFiles(repoKey).files).toHaveLength(1);

      // The history is still there, doing the job it exists for.
      expect(store.resolveFile(home)?.file.relPath).toBe('docs/shipped/home.png');
      expect(store.resolveFile(about)).toBeNull();
    });

    it('leaves out the files of a retired mount', () => {
      const id = mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      expect(store.reconcile(repoKey, true).files).toHaveLength(1);
      store.unmount(repoKey, id);
      expect(store.reconcile(repoKey, true).files).toEqual([]);
      // Retention is the project's: nothing on disk was touched.
      expect(existsSync(join(mocks(), 'home.png'))).toBe(true);
    });
  });

  describe('a mount bigger than the walk ceiling', () => {
    /**
     * A capped walk is not a complete one. Treating it as complete makes
     * every file past the cap look deleted — and a deleted file whose size
     * and fingerprint match a newly-appeared one is read as a MOVE, which
     * hands its address to an unrelated file and cannot be undone.
     */
    it('says so, and does not read the files past the cap as gone', () => {
      mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      // Sorted walk order in this folder is aaa.txt, home.png, zzz.txt.
      writeFileSync(join(mocks(), 'zzz.txt'), 'the-file-past-the-cap');
      const beyond = idOf('docs/mocks/zzz.txt');
      // An unrelated new file that happens to hold the same bytes. Off a
      // capped scan this is exactly the false move.
      writeFileSync(join(mocks(), 'aaa.txt'), 'the-file-past-the-cap');

      const capped = new MountStore(dataDir, new RepoRegistry(dataDir), { maxFilesPerMount: 2 });
      const listing = capped.reconcile(repoKey, true);
      expect(listing.truncated).toBe(true);
      expect(listing.files.map((f) => f.relPath)).toEqual([
        'docs/mocks/aaa.txt',
        'docs/mocks/home.png',
      ]);
      // The address past the cap still names its own file...
      expect(capped.resolveFile(beyond)?.file.relPath).toBe('docs/mocks/zzz.txt');
      // ...and the newcomer got an address of its own rather than that one.
      const fresh = listing.files.find((f) => f.relPath === 'docs/mocks/aaa.txt');
      expect(fresh?.fileId).not.toBe(beyond);
    });
  });
  describe('a repo that re-keys', () => {
    /**
     * A renamed remote gives the repo a new key. The repo registry adopts it
     * and keeps the old spelling as an alias — but the mount table is keyed
     * by the string, so without a fold every mount and every address stays
     * filed under a key nobody looks up again: an empty project, a second
     * address minted for every file, and every link written before the rename
     * pointing at nothing.
     */
    it('carries its mounts and every address across the rename', () => {
      mount(mocks());
      const before = store.locate(repo)?.repoKey ?? '';
      const id = idOf('docs/mocks/home.png');

      git(repo, 'remote', 'set-url', 'origin', 'git@github.example:example/widgets-renamed.git');
      // Noting the checkout is what makes the repo registry adopt the new key.
      store.mount(mocks());
      const after = store.locate(repo)?.repoKey ?? '';
      expect(after).not.toBe(before);

      // One mount, one file, and the SAME address as before the rename.
      const listing = store.reconcile(after, true);
      expect(listing.files.map((f) => f.relPath)).toEqual(['docs/mocks/home.png']);
      expect(listing.files[0]?.fileId).toBe(id);
      expect(store.resolveFile(id)?.file.relPath).toBe('docs/mocks/home.png');
      // The old spelling is not a second project sitting beside the new one.
      expect(store.registry.listProjects().map((p) => p.repoKey)).toEqual([after]);
    });
  });
});
