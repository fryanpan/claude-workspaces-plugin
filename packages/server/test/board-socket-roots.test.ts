/**
 * `board-socket-roots.ts` on its own: which folders a lead may bind, as
 * stored and as re-read after a restart. The route over it, and a lead's
 * bind being held to it, are `board-socket-lead.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, MAX_ROOTS, boardSocketRootsPath } from '../src/board-socket-roots.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-roots-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const harborlight = join(root, 'harborlight');
const riverbend = join(root, 'riverbend');
for (const d of [join(harborlight, 'docs'), riverbend]) mkdirSync(d, { recursive: true });
symlinkSync(riverbend, join(harborlight, 'to-riverbend'));

describe('BoardSocketRoots', () => {
  it('answers a registered root, resolved, on its board only', () => {
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'a')));
    expect(roots.set('w-harbor', [harborlight]).ok).toBe(true);
    expect(roots.rootFor('w-harbor', harborlight)).toBe(harborlight);
    expect(roots.rootFor('w-harbor', join(harborlight, 'docs', '..'))).toBe(harborlight);
    expect(roots.rootFor('w-river', harborlight)).toBeNull();
    expect(roots.rootFor('w-harbor', riverbend)).toBeNull();
    // A folder inside a root is not one: it could be swapped for a link.
    expect(roots.rootFor('w-harbor', join(harborlight, 'docs'))).toBeNull();
  });

  it('judges a folder by where its links lead', () => {
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'b')));
    roots.set('w-harbor', [harborlight]);
    expect(roots.rootFor('w-harbor', join(harborlight, 'to-riverbend'))).toBeNull();
    expect(roots.rootFor('w-harbor', 'relative')).toBeNull();
  });

  it('refuses a list it cannot hold to anything', () => {
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'c')));
    for (const bad of ['/', 'relative/path', join(root, 'missing')])
      expect(roots.set('w-harbor', [bad]).ok, bad).toBe(false);
    expect(roots.set('w-harbor', 'not a list').ok).toBe(false);
    expect(roots.set('w-harbor', Array(MAX_ROOTS + 1).fill(harborlight)).ok).toBe(false);
    // One root inside another would let the lead swap the inner one.
    expect(roots.set('w-harbor', [harborlight, join(harborlight, 'docs')]).ok).toBe(false);
    expect(roots.rootsOf('w-harbor')).toEqual([]);
  });

  it('keeps the list across a restart, in a file only its owner can read', () => {
    const path = boardSocketRootsPath(join(root, 'd'));
    new BoardSocketRoots(path).set('w-harbor', [join(harborlight, 'to-riverbend')]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Stored resolved: the link's target, never the link.
    expect(new BoardSocketRoots(path).rootsOf('w-harbor')).toEqual([riverbend]);
  });
});
