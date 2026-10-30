/**
 * `~/.claude` while a walled lead is registered. The parts the lead may write
 * are its bytes and refused; the rest is the owner's, and a doc bound there
 * still reads, through the guard's checked open. Fixtures synthetic, in a
 * temp folder; the FIFO case runs in a bun child with a hard timeout, so a
 * regression to a blocking open fails instead of hanging the runner.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { GuardRefused, PathGuards } from '../src/bound-path-guard.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo } from './fifo.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-shadow-zones-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
const claude = join(home, '.claude');
const harborlight = join(root, 'harborlight');
const slug = harborlight.replace(/[^a-zA-Z0-9]/g, '-');
const otherSlug = join(root, 'riverbend').replace(/[^a-zA-Z0-9]/g, '-');
for (const d of [
  harborlight,
  join(root, 'dotfiles'),
  join(claude, 'plans'),
  join(claude, 'rules'),
  join(claude, 'projects', slug, 'memory'),
  join(claude, 'projects', otherSlug, 'memory'),
])
  mkdirSync(d, { recursive: true });
writeFileSync(join(claude, 'plans', 'plan.md'), '# plan\n');
writeFileSync(join(claude, 'projects', otherSlug, 'memory', 'MEMORY.md'), '# riverbend\n');
writeFileSync(join(claude, 'projects', slug, 'memory', 'MEMORY.md'), '# harborlight\n');
writeFileSync(join(claude, 'notes.md'), '# lead-writable\n');
writeFileSync(join(harborlight, 'inside.md'), '# inside a root\n');
writeFileSync(join(root, 'dotfiles', 'CLAUDE.md'), '# dotfiles\n');
// The owner's own link out, as a CLAUDE.md kept in a dotfiles repo.
symlinkSync(join(root, 'dotfiles', 'CLAUDE.md'), join(claude, 'CLAUDE.md'));
// The owner's folder linked into a root, which the lead writes.
symlinkSync(join(harborlight, 'inside.md'), join(claude, 'rules', 'into-root.md'));
makeFifo(join(claude, 'plans', 'pipe.md'));

const shadows = { home, uid: 4242, realpath: (p: string) => realpathSync.native(p) };
const roots = new BoardSocketRoots(
  boardSocketRootsPath(join(root, 'data')),
  undefined,
  undefined,
  shadows,
);
const guards = new PathGuards();
guards.add(roots);

describe('~/.claude while a walled lead is registered', () => {
  it('reads every owner file without a walled lead (control)', async () => {
    expect((await guards.read(join(claude, 'notes.md'))).text).toBe('# lead-writable\n');
    expect(guards.covers(join(claude, 'plans', 'plan.md'))).toBe(false);
  });

  it('still reads a doc bound outside what the lead writes', async () => {
    expect(roots.set('w-harbor', [harborlight]).ok).toBe(true);
    for (const [rel, text] of [
      ['plans/plan.md', '# plan\n'],
      [`projects/${otherSlug}/memory/MEMORY.md`, '# riverbend\n'],
      ['CLAUDE.md', '# dotfiles\n'],
    ]) {
      const path = join(claude, rel);
      expect(guards.covers(path), rel).toBe(true);
      expect((await guards.read(path)).text, rel).toBe(text);
      expect(guards.readSync(path), rel).toBe(text);
    }
  });

  it('reads it through the bound-file reader a doc hydrates from', async () => {
    const remove = boundFiles.guards.add(roots);
    try {
      expect(await boundFiles.read(join(claude, 'plans', 'plan.md'))).toMatchObject({
        status: 'ok',
        text: '# plan\n',
      });
      expect((await boundFiles.read(join(claude, 'notes.md'))).status).not.toBe('ok');
    } finally {
      remove();
      boundFiles.reset();
    }
  });

  it('refuses what the lead writes there, and a link from the owner’s part into a root', async () => {
    for (const rel of ['notes.md', `projects/${slug}/memory/MEMORY.md`, 'rules/into-root.md']) {
      await expect(guards.read(join(claude, rel))).rejects.toBeInstanceOf(GuardRefused);
      expect(() => guards.readSync(join(claude, rel)), rel).toThrow(GuardRefused);
    }
  });

  it('refuses a FIFO in the owner’s part without blocking', () => {
    const ROOTS = resolve(__dirname, '../src/board-socket-roots.ts');
    const GUARD = resolve(__dirname, '../src/bound-path-guard.ts');
    const res = spawnSync(
      'bun',
      [
        '-e',
        `const { BoardSocketRoots, boardSocketRootsPath } = await import(${JSON.stringify(ROOTS)});
         const { PathGuards } = await import(${JSON.stringify(GUARD)});
         const r = new BoardSocketRoots(boardSocketRootsPath(${JSON.stringify(join(root, 'data'))}), undefined, undefined, { home: ${JSON.stringify(home)}, uid: 4242, realpath: (p) => p });
         const g = new PathGuards(); g.add(r);
         try { g.readSync(${JSON.stringify(join(claude, 'plans', 'pipe.md'))}); console.log('read'); } catch (e) { console.log(e.constructor.name); }`,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );
    expect(res.signal).toBe(null);
    expect(res.stdout.trim()).toBe('GuardRefused');
  }, 15_000);
});
