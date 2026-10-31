/**
 * A lead launched by its home-spelled name (`~/dev/harborlight`, with `~/dev`
 * a link onto a data volume) writes the scratch and transcript folders named
 * for that spelling, as well as for the resolved one. The server is told both
 * names by the launcher, so it refuses both as the lead's, and keeps them
 * after a restart. Fixtures synthetic, in a temp folder.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlugs } from '@claude-workspaces/core/lead-wall';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-shadow-spellings-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
const data = join(root, 'data');
const claude = join(home, '.claude');
const real = join(data, 'dev', 'harborlight');
mkdirSync(real, { recursive: true });
mkdirSync(home, { recursive: true });
// The home folder is real; `~/dev` is the link, as on the owner's Mac.
symlinkSync(join(data, 'dev'), join(home, 'dev'));
const spelled = join(home, 'dev', 'harborlight');
const homeSlug = spelled.replace(/[^a-zA-Z0-9]/g, '-');
const dataSlug = real.replace(/[^a-zA-Z0-9]/g, '-');
for (const slug of [homeSlug, dataSlug]) {
  mkdirSync(join(claude, 'projects', slug, 'memory'), { recursive: true });
  writeFileSync(join(claude, 'projects', slug, 'memory', 'MEMORY.md'), '# harborlight\n');
}
const shadows = { home, uid: 4242, realpath: (p: string) => realpathSync.native(p) };
const file = boardSocketRootsPath(join(root, 'data-dir'));
const store = () => new BoardSocketRoots(file, undefined, undefined, shadows);
const paths = (slug: string) => [
  `/private/tmp/claude-4242/${slug}/scratchpad/mock.html`,
  `/private/tmp/claude-4242/${slug}--claude-worktrees-wt/mock.html`,
  join(claude, 'projects', slug, 'memory', 'MEMORY.md'),
];

describe('a lead launched by its home-spelled name', () => {
  it('names both spellings, as the wall opens them', () => {
    expect(projectSlugs([spelled], (p) => realpathSync(p)).sort()).toEqual(
      [homeSlug, dataSlug].sort(),
    );
  });

  it("refuses both spellings' scratch and transcript folders as the lead's", () => {
    const roots = store();
    expect(roots.set('w-harbor', [spelled], [homeSlug, dataSlug]).ok).toBe(true);
    for (const p of [...paths(homeSlug), ...paths(dataSlug)]) {
      expect(roots.covers(p), p).toBe(true);
      expect(roots.admits(p), p).toBe(false);
    }
  });

  it('keeps refusing them after a restart, and after the board drops the lead', () => {
    const roots = store();
    expect(roots.set('w-harbor', []).ok).toBe(true);
    for (const p of paths(homeSlug)) expect(store().admits(p), p).toBe(false);
  });

  it('still takes a list with no names, and refuses a name that is not one', () => {
    const roots = store();
    expect(roots.set('w-river', [real]).ok).toBe(true);
    for (const bad of [['../x'], ['a/b'], [''], 'x', [7]])
      expect(roots.set('w-river', [real], bad).ok, JSON.stringify(bad)).toBe(false);
  });
});
