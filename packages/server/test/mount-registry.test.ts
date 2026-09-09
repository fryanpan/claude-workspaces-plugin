/**
 * The mount table on its own: what a claim does, what an alias does, and what
 * survives a restart.
 *
 * No filesystem beyond the data directory the registry writes into — every
 * decision here is a decision about the record, which is the seam
 * `mount-registry.ts` was split along.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONVENTIONS_PATH,
  MOUNT_REGISTRY_FILE,
  MountRegistry,
  makeFileKey,
  parseFileKey,
} from '../src/mount-registry.ts';

const REPO = 'git:github.example/widgets';
const seen = (mountId: string, size: number, hash?: string) => ({
  mountId,
  size,
  mtimeMs: 1_788_912_000_000,
  ...(hash === undefined ? {} : { hash }),
});

describe('MountRegistry', () => {
  let dir: string;
  let registry: MountRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-mount-registry-'));
    registry = new MountRegistry(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('the file key', () => {
    it('round-trips a path with spaces and slashes in it', () => {
      const key = makeFileKey(REPO, 'docs/mock ups/round 2.png');
      expect(parseFileKey(key)).toEqual({ repoKey: REPO, relPath: 'docs/mock ups/round 2.png' });
    });
  });

  describe('claiming an address', () => {
    it('mints one address per key and keeps it when the bytes change', () => {
      const key = makeFileKey(REPO, 'mocks/a.png');
      const first = registry.claim(key, seen('m-1', 10, 'hash-a'));
      const second = registry.claim(key, seen('m-1', 4096, 'hash-b'));
      expect(second.fileId).toBe(first.fileId);
      // The record follows the file even though the address does not.
      expect(registry.entryFor(key)?.size).toBe(4096);
      expect(registry.entryFor(key)?.hash).toBe('hash-b');
    });

    it('gives two files two addresses', () => {
      const a = registry.claim(makeFileKey(REPO, 'mocks/a.png'), seen('m-1', 10));
      const b = registry.claim(makeFileKey(REPO, 'mocks/b.png'), seen('m-1', 10));
      expect(a.fileId).not.toBe(b.fileId);
    });
  });

  describe('a move', () => {
    it('keeps the address and leaves the old spelling resolving', () => {
      const from = makeFileKey(REPO, 'mocks/a.png');
      const to = makeFileKey(REPO, 'shipped/a.png');
      const before = registry.claim(from, seen('m-1', 10, 'h'));
      expect(registry.aliasKey(from, to, seen('m-2', 10, 'h'))).toEqual({
        ok: true,
        aliased: true,
      });
      expect(registry.fileIdFor(to)).toBe(before.fileId);
      // The link somebody wrote before the move still opens the same file.
      expect(registry.fileIdFor(from)).toBe(before.fileId);
      expect(registry.entryFor(to)?.mountId).toBe('m-2');
      expect(registry.keysFor(before.fileId).sort()).toEqual([from, to].sort());
    });

    it('refuses to repoint one file address at another file', () => {
      const from = makeFileKey(REPO, 'mocks/a.png');
      const to = makeFileKey(REPO, 'shipped/b.png');
      const a = registry.claim(from, seen('m-1', 10));
      const b = registry.claim(to, seen('m-2', 99));
      const res = registry.aliasKey(from, to);
      expect(res).toEqual({
        ok: false,
        error: 'held-by-other',
        fileId: b.fileId,
        otherFileId: a.fileId,
      });
      // Neither address moved.
      expect(registry.fileIdFor(from)).toBe(a.fileId);
      expect(registry.fileIdFor(to)).toBe(b.fileId);
    });

    it('terminates on a file that moved out and back', () => {
      const a = makeFileKey(REPO, 'mocks/a.png');
      const b = makeFileKey(REPO, 'shipped/a.png');
      const id = registry.claim(a, seen('m-1', 10, 'h')).fileId;
      registry.aliasKey(a, b, seen('m-2', 10, 'h'));
      expect(registry.aliasKey(b, a)).toEqual({ ok: true, aliased: false });
      expect(registry.fileIdFor(a)).toBe(id);
    });
  });

  describe('mounts', () => {
    it('is idempotent by relative path, and revives what was unmounted', () => {
      const first = registry.mount(REPO, 'docs/mocks');
      const again = registry.mount(REPO, 'docs/mocks');
      expect(again.mount.mountId).toBe(first.mount.mountId);
      expect(again.created).toBe(false);

      expect(registry.unmount(REPO, first.mount.mountId)).toBe(true);
      expect(registry.liveMounts(REPO)).toHaveLength(0);
      // Soft: the row is still there, with the date it was retired.
      expect(registry.allMounts(REPO)).toHaveLength(1);
      expect(registry.allMounts(REPO)[0]?.removedAt).toBeGreaterThan(0);

      const revived = registry.mount(REPO, 'docs/mocks');
      expect(revived.mount.mountId).toBe(first.mount.mountId);
      expect(registry.liveMounts(REPO)).toHaveLength(1);
    });

    it('refuses to retire a mount twice', () => {
      const { mount } = registry.mount(REPO, 'docs/mocks');
      expect(registry.unmount(REPO, mount.mountId)).toBe(true);
      expect(registry.unmount(REPO, mount.mountId)).toBe(false);
    });
  });

  describe('project settings', () => {
    it('defaults to a workspace-visible project with a WORKSPACES.md index', () => {
      expect(registry.privacyOf(REPO)).toBe('workspace');
      expect(registry.conventionsPathOf(REPO)).toBe(DEFAULT_CONVENTIONS_PATH);
    });

    it('remembers privacy and the conventions path', () => {
      registry.setPrivacy(REPO, 'local-only');
      registry.setConventionsPath(REPO, 'docs/workspaces.md');
      expect(registry.privacyOf(REPO)).toBe('local-only');
      expect(registry.conventionsPathOf(REPO)).toBe('docs/workspaces.md');
    });
  });

  describe('the file on disk', () => {
    it('survives a restart, and is written 600', () => {
      const key = makeFileKey(REPO, 'mocks/a.png');
      const id = registry.claim(key, seen('m-1', 10, 'h')).fileId;
      registry.setPrivacy(REPO, 'local-only');

      const reopened = new MountRegistry(dir);
      expect(reopened.fileIdFor(key)).toBe(id);
      expect(reopened.privacyOf(REPO)).toBe('local-only');

      const mode = statSync(join(dir, MOUNT_REGISTRY_FILE)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('keeps a corrupt file beside the fresh one rather than discarding it', () => {
      const path = join(dir, MOUNT_REGISTRY_FILE);
      writeFileSync(path, '{ not json');
      const reopened = new MountRegistry(dir);
      expect(reopened.listProjects()).toEqual([]);
      const kept = readdirSync(dir).filter((n) => n.startsWith(`${MOUNT_REGISTRY_FILE}.corrupt-`));
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(dir, kept[0] as string), 'utf8')).toBe('{ not json');
    });

    it('reads an unrecognised privacy value as the restrictive one', () => {
      writeFileSync(
        join(dir, MOUNT_REGISTRY_FILE),
        JSON.stringify({
          version: 1,
          projects: [{ repoKey: REPO, privacy: 'public-please', conventionsPath: '', mounts: [] }],
          fileKeys: {},
          fileKeyAliases: {},
        }),
      );
      expect(new MountRegistry(dir).privacyOf(REPO)).toBe('local-only');
    });
  });
  describe('re-filing a project under a new repo key', () => {
    it('keeps every fileId and answers at the old spelling too', () => {
      const NEW = 'git:github.example/widgets-renamed';
      const { mount } = registry.mount(REPO, 'docs/mocks');
      const key = makeFileKey(REPO, 'docs/mocks/home.png');
      const id = registry.claim(key, seen(mount.mountId, 15, 'abc')).fileId;

      expect(registry.rekeyProject(REPO, NEW)).toBe(true);

      expect(registry.listProjects().map((p) => p.repoKey)).toEqual([NEW]);
      expect(registry.liveMounts(NEW).map((m) => m.mountId)).toEqual([mount.mountId]);
      // One address, reachable by either spelling.
      expect(registry.fileIdFor(makeFileKey(NEW, 'docs/mocks/home.png'))).toBe(id);
      expect(registry.fileIdFor(key)).toBe(id);
      expect(registry.keyOf(id)).toBe(makeFileKey(NEW, 'docs/mocks/home.png'));
    });

    it('leaves a key whose new spelling another file already holds', () => {
      const NEW = 'git:github.example/widgets-renamed';
      const { mount } = registry.mount(REPO, 'docs/mocks');
      const old = registry.claim(makeFileKey(REPO, 'docs/mocks/home.png'), seen(mount.mountId, 15));
      const held = registry.claim(makeFileKey(NEW, 'docs/mocks/home.png'), seen(mount.mountId, 22));

      registry.rekeyProject(REPO, NEW);

      // Repointing an address is the one thing this table never does, and a
      // re-key is not a reason to start.
      expect(registry.fileIdFor(makeFileKey(NEW, 'docs/mocks/home.png'))).toBe(held.fileId);
      expect(registry.fileIdFor(makeFileKey(REPO, 'docs/mocks/home.png'))).toBe(old.fileId);
    });
  });
});
