/**
 * One reconcile pass, driven directly.
 *
 * The store decides WHERE a mount is; this module decides what is there and
 * what moved. So the fixtures here are plain directories — no git, no repo
 * registry — and the assertions are about the table afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MountedDir, reconcileProject } from '../src/mount-reconcile.ts';
import { MountRegistry, makeFileKey } from '../src/mount-registry.ts';

const REPO = 'dir:widgets-abc1234';

describe('reconcileProject', () => {
  let dir: string;
  let registry: MountRegistry;
  let mocks: string;
  let shipped: string;

  const dirs = (): MountedDir[] => [
    { mountId: 'm-mocks', relPath: 'docs/mocks', abs: mocks },
    { mountId: 'm-shipped', relPath: 'docs/shipped', abs: shipped },
  ];
  const run = (maxFiles = 100) => reconcileProject(registry, REPO, dirs(), maxFiles);
  const idAt = (relPath: string) => registry.fileIdFor(makeFileKey(REPO, relPath));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-mount-reconcile-'));
    registry = new MountRegistry(join(dir, 'data'));
    mocks = join(dir, 'docs', 'mocks');
    shipped = join(dir, 'docs', 'shipped');
    mkdirSync(mocks, { recursive: true });
    mkdirSync(shipped, { recursive: true });
    writeFileSync(join(mocks, 'home.png'), 'round-one-bytes');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('addresses what it finds, under the path from the repo root', () => {
    const res = run();
    expect([...res.present]).toEqual([makeFileKey(REPO, 'docs/mocks/home.png')]);
    expect(res.truncated).toBe(false);
    expect(idAt('docs/mocks/home.png')).toBeTruthy();
  });

  it('carries an address to the mount a file moved into', () => {
    run();
    const before = idAt('docs/mocks/home.png');
    renameSync(join(mocks, 'home.png'), join(shipped, 'home.png'));

    const res = run();
    expect([...res.present]).toEqual([makeFileKey(REPO, 'docs/shipped/home.png')]);
    // One address, not two: the move was read, not a delete and a create.
    expect(idAt('docs/shipped/home.png')).toBe(before);
    expect(idAt('docs/mocks/home.png')).toBe(before);
  });

  it('reads no move off a capped walk', () => {
    writeFileSync(join(mocks, 'zzz.png'), 'the-file-past-the-cap');
    run();
    const beyond = idAt('docs/mocks/zzz.png');
    // Sorted walk order is home.png then zzz.png, so a ceiling of one leaves
    // zzz.png unseen — and an unseen file is not a deleted one, however well
    // this newcomer's bytes match it.
    writeFileSync(join(shipped, 'aaa.png'), 'the-file-past-the-cap');

    const res = run(1);
    expect(res.truncated).toBe(true);
    expect(idAt('docs/mocks/zzz.png')).toBe(beyond);
    expect(idAt('docs/shipped/aaa.png')).not.toBe(beyond);
  });

  it('reads no move off a walk that hit a directory it could not open', () => {
    const locked = join(mocks, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'inner.png'), 'the-shut-away-bytes');
    run();
    const inner = idAt('docs/mocks/locked/inner.png');

    chmodSync(locked, 0o000);
    try {
      writeFileSync(join(shipped, 'newcomer.png'), 'the-shut-away-bytes');
      const res = run();
      expect(res.present.has(makeFileKey(REPO, 'docs/mocks/locked/inner.png'))).toBe(false);
      expect(idAt('docs/shipped/newcomer.png')).not.toBe(inner);
    } finally {
      chmodSync(locked, 0o755);
    }
    // The address never left the file it was minted for.
    expect(idAt('docs/mocks/locked/inner.png')).toBe(inner);
  });

  it('lists a file reachable through two overlapping mounts once', () => {
    const nested: MountedDir[] = [
      { mountId: 'm-docs', relPath: 'docs', abs: join(dir, 'docs') },
      { mountId: 'm-mocks', relPath: 'docs/mocks', abs: mocks },
    ];
    const res = reconcileProject(registry, REPO, nested, 100);
    expect([...res.present]).toEqual([makeFileKey(REPO, 'docs/mocks/home.png')]);
    expect(registry.entryFor(makeFileKey(REPO, 'docs/mocks/home.png'))?.mountId).toBe('m-docs');
  });

  it('says nothing is there when the mount folder is not', () => {
    rmSync(mocks, { recursive: true, force: true });
    const res = run();
    expect([...res.present]).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});
