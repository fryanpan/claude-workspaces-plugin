/**
 * `board-socket-roots.ts` on its own: which folders a walled lead works in,
 * as stored and as re-read after a restart, and the guard it is on every
 * bound file under them. The route over it is `board-socket-lead.test.ts`;
 * the guard installed in a running server is `board-socket-lead-binds.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoardSocketRoots, MAX_ROOTS, boardSocketRootsPath } from '../src/board-socket-roots.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-roots-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const harborlight = join(root, 'harborlight');
const riverbend = join(root, 'riverbend');
for (const d of [join(harborlight, 'docs'), riverbend]) mkdirSync(d, { recursive: true });
symlinkSync(riverbend, join(harborlight, 'to-riverbend'));

describe('BoardSocketRoots', () => {
  it('keeps each board’s list, resolved', () => {
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'a')));
    expect(roots.set('w-harbor', [join(harborlight, 'docs', '..')]).ok).toBe(true);
    expect(roots.rootsOf('w-harbor')).toEqual([harborlight]);
    expect(roots.rootsOf('w-river')).toEqual([]);
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

  it('guards every bound file under a root, whoever bound it', () => {
    const lead = join(root, 'harbor-guard');
    mkdirSync(join(lead, 'docs'), { recursive: true });
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'e')));
    roots.set('w-harbor', [lead]);
    const file = join(lead, 'docs', 'plan.md');
    let now = 1_000_000;
    const later = () => (now += 2 * BoardSocketRoots.ROOT_VERDICT_MS);

    // The controls: a file inside reads, and a file outside is no guard's business.
    expect(roots.covers(file)).toBe(true);
    expect(roots.admits(file, later())).toBe(true);
    expect(roots.landsInside(file, file)).toBe(true);
    expect(roots.covers(join(riverbend, 'x.md'))).toBe(false);
    expect(roots.holdsRoot(root)).toBe(true);
    expect(roots.holdsRoot(riverbend)).toBe(false);

    // A path through node_modules, where the lead may make links, is refused.
    expect(roots.admits(join(lead, 'node_modules', 'pkg', 'x.md'), later())).toBe(false);
    // A file that really lands outside is refused.
    expect(roots.landsInside(file, join(riverbend, 'plan.md'))).toBe(false);

    // Swapping the root for a link stops every file under it.
    renameSync(lead, `${lead}.moved`);
    symlinkSync(`${lead}.moved`, lead);
    expect(roots.admits(file, later())).toBe(false);
  });

  it('guards a path spelled through a link above the root, or in another case', () => {
    const lead = join(root, 'Harbor-Spelled');
    mkdirSync(join(lead, 'docs'), { recursive: true });
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'h')));
    roots.set('w-harbor', [lead]);
    const viaLink = join(alias, 'Harbor-Spelled', 'docs', 'plan.md');
    const viaCase = join(root, 'harbor-spelled', 'docs', 'plan.md');
    // The control: the stored spelling is covered, and so is each other one.
    expect(roots.covers(join(lead, 'docs', 'plan.md'))).toBe(true);
    for (const p of [viaLink, viaCase]) {
      expect(roots.covers(p), p).toBe(true);
      expect(roots.landsInside(p, join(riverbend, 'plan.md')), p).toBe(false);
      expect(roots.landsInside(p, join(lead, 'docs', 'plan.md')), p).toBe(true);
    }
    expect(roots.admits(join(alias, 'Harbor-Spelled', 'Node_Modules', 'x.md'))).toBe(false);
    // A repository above the root, spelled through the link, holds it.
    expect(roots.holdsRoot(alias)).toBe(true);
    // A folder below the root swapped for a link outside is still covered:
    // the spelling stops at the root and never follows the lead's link.
    renameSync(join(lead, 'docs'), join(lead, 'docs.moved'));
    symlinkSync(riverbend, join(lead, 'docs'));
    expect(roots.covers(viaLink)).toBe(true);
  });

  it('guards an owner’s link into a root after the lead swaps the folder it names', () => {
    const lead = join(root, 'harbor-swap');
    mkdirSync(join(lead, 'docs', 'sub'), { recursive: true });
    const notes = join(root, 'notes-link');
    symlinkSync(join(lead, 'docs', 'sub'), notes);
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'sw')));
    roots.set('w-harbor', [lead]);
    const viaOwner = join(notes, 'plan.md');
    expect(roots.covers(viaOwner)).toBe(true);
    // The lead swaps `docs` for a link off the root. The owner's link is
    // spelled from its own text, so the lead's link is never followed.
    renameSync(join(lead, 'docs'), join(lead, 'docs.moved'));
    mkdirSync(join(riverbend, 'sub'), { recursive: true });
    symlinkSync(riverbend, join(lead, 'docs'));
    const fresh = new BoardSocketRoots(boardSocketRootsPath(join(root, 'sw2')));
    fresh.set('w-harbor', [lead]);
    for (const r of [roots, fresh]) {
      expect(r.covers(viaOwner)).toBe(true);
      // Where it really lands is off the root, so the write is refused.
      expect(r.landsInside(viaOwner, join(riverbend, 'sub', 'plan.md'))).toBe(false);
    }
    // The control: the same file spelled off the root is not covered.
    expect(fresh.covers(join(riverbend, 'sub', 'plan.md'))).toBe(false);
  });

  it('guards a path whose link into a root is two levels down, at a folder or at the file', () => {
    const lead = join(root, 'harbor-deep');
    mkdirSync(join(lead, 'docs'), { recursive: true });
    writeFileSync(join(lead, 'docs', 'plan.md'), 'x');
    const off = join(root, 'deep-off', 'one');
    mkdirSync(off, { recursive: true });
    symlinkSync(join(lead, 'docs'), join(off, 'two'));
    symlinkSync(join(lead, 'docs', 'plan.md'), join(off, 'plan-link.md'));
    writeFileSync(join(off, 'own.md'), 'x');
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'dp')));
    roots.set('w-harbor', [lead]);
    expect(roots.covers(join(off, 'two', 'plan.md'))).toBe(true);
    expect(roots.covers(join(off, 'plan-link.md'))).toBe(true);
    // The control: a plain file beside them is off every root.
    expect(roots.covers(join(off, 'own.md'))).toBe(false);
  });

  it('reads a folder it could not spell as a lead’s, and asks again next time', () => {
    const off = join(riverbend, 'flaky');
    mkdirSync(off, { recursive: true });
    let fail = true;
    const flaky = (p: string) => {
      if (fail && p === off) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realpathSync.native(p);
    };
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'fl')), flaky);
    roots.set('w-harbor', [harborlight]);
    const file = join(off, 'plan.md');
    expect(roots.covers(file)).toBe(true);
    expect(roots.admits(file)).toBe(false);
    expect(roots.landsInside(file, join(harborlight, 'x.md'))).toBe(false);
    fail = false;
    expect(roots.covers(file)).toBe(false);
  });

  it('resolves no name twice, for a path off every root', () => {
    const asked: string[] = [];
    const counted = (p: string) => {
      asked.push(p);
      return realpathSync.native(p);
    };
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'n')), counted);
    roots.set('w-harbor', [harborlight]);
    asked.length = 0;
    const off = join(riverbend, 'notes', 'plan.md');
    mkdirSync(dirname(off), { recursive: true });
    writeFileSync(off, 'x');
    expect(roots.covers(off)).toBe(false);
    // Each name on the way, the file included, once.
    expect(asked).toContain(off);
    expect(new Set(asked).size).toBe(asked.length);
    const first = asked.length;
    for (let i = 0; i < 5; i++) roots.covers(off);
    expect(asked.length).toBe(first);
    // The control: a path spelled as the root is asked nothing.
    asked.length = 0;
    expect(roots.covers(join(harborlight, 'docs', 'x.md'))).toBe(true);
    expect(asked).toEqual([]);
  });

  it('reads a broken file again once it changes', () => {
    let now = 1_000_000;
    const path = boardSocketRootsPath(join(root, 'o'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    const roots = new BoardSocketRoots(path, realpathSync.native, () => now);
    expect(roots.covers(join(riverbend, 'x.md'))).toBe(true);
    writeFileSync(path, JSON.stringify({ boards: { 'w-harbor': [harborlight] } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    // Asked again only after the recheck window.
    expect(roots.covers(join(riverbend, 'x.md'))).toBe(true);
    now += BoardSocketRoots.BROKEN_RECHECK_MS;
    expect(roots.covers(join(riverbend, 'x.md'))).toBe(false);
    expect(roots.covers(join(harborlight, 'x.md'))).toBe(true);
  });

  it('reads a file of the wrong shape as unreadable, not as no roots', () => {
    for (const [name, text] of [
      ['i', '{"boards":null}'],
      ['j', '{"boards":{"w-harbor":"/x"}}'],
      ['k', '{"boards":{"w-harbor":["relative"]}}'],
      ['l', '{"boards":[]}'],
    ] as const) {
      const path = boardSocketRootsPath(join(root, name));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      expect(new BoardSocketRoots(path).covers(join(riverbend, 'x.md')), text).toBe(true);
    }
    // The control: the shape `set` writes reads back as written.
    const good = boardSocketRootsPath(join(root, 'm'));
    mkdirSync(dirname(good), { recursive: true });
    writeFileSync(good, JSON.stringify({ boards: { 'w-harbor': [harborlight] } }));
    expect(new BoardSocketRoots(good).covers(join(riverbend, 'x.md'))).toBe(false);
    expect(new BoardSocketRoots(good).rootsOf('w-harbor')).toEqual([harborlight]);
  });

  it('fails closed on every path when its file cannot be read, and writes nothing over it', () => {
    const path = boardSocketRootsPath(join(root, 'f'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    const roots = new BoardSocketRoots(path);
    const anywhere = join(riverbend, 'x.md');
    expect(roots.covers(anywhere)).toBe(true);
    expect(roots.admits(anywhere)).toBe(false);
    expect(roots.landsInside(anywhere, anywhere)).toBe(false);
    expect(roots.holdsRoot(riverbend)).toBe(true);
    expect(roots.set('w-harbor', [harborlight]).ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    // The control: a missing file is an empty list, not a broken one.
    const missing = new BoardSocketRoots(boardSocketRootsPath(join(root, 'g')));
    expect(missing.covers(anywhere)).toBe(false);
  });
});
