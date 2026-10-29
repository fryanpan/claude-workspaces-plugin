/**
 * The guarded read and write behind `slow-fs.ts` `boundFiles.guards`: each
 * judges where the file really is after it is open, so a folder link on the
 * way cannot carry it outside. Fixtures synthetic, in a temp folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  GuardRefused,
  type PathGuard,
  PathGuards,
  nearestRealpathSync,
  readChecked,
  writeChecked,
} from '../src/bound-path-guard.ts';

let dir: string;
let inside: string;
let outside: string;

const under = (root: string) => (real: string) => real.startsWith(`${root}${sep}`);

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'bound-path-guard-')));
  inside = join(dir, 'harborlight');
  outside = join(dir, 'riverbend');
  mkdirSync(join(inside, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(inside, 'sub', 'plan.md'), '# harborlight plan\n');
  writeFileSync(join(outside, 'keys.md'), 'riverbend secret\n');
  // A folder inside the root that leads outside it.
  symlinkSync(outside, join(inside, 'linked'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readChecked', () => {
  it('reads a file that lands inside', async () => {
    const read = await readChecked(join(inside, 'sub', 'plan.md'), under(inside));
    expect(read.text).toBe('# harborlight plan\n');
  });

  it('refuses a file that a link carries outside', async () => {
    const read = readChecked(join(inside, 'linked', 'keys.md'), under(inside));
    await expect(read).rejects.toBeInstanceOf(GuardRefused);
  });

  it('reads anything when nothing guards it', async () => {
    const read = await readChecked(join(inside, 'linked', 'keys.md'), null);
    expect(read.text).toBe('riverbend secret\n');
  });
});

describe('writeChecked', () => {
  it('writes a file that lands inside', async () => {
    const path = join(inside, 'sub', 'plan.md');
    await writeChecked(path, '# harborlight plan\n\nRevised.\n', under(inside));
    expect(readFileSync(path, 'utf8')).toContain('Revised.');
    expect(readdirSync(join(inside, 'sub'))).toEqual(['plan.md']);
  });

  it('creates nothing outside through a linked folder', async () => {
    const write = writeChecked(join(inside, 'linked', 'new.md'), 'leaked\n', under(inside));
    await expect(write).rejects.toBeInstanceOf(GuardRefused);
    expect(existsSync(join(outside, 'new.md'))).toBe(false);
    expect(readdirSync(outside)).toEqual(['keys.md']);
  });
});

describe('nearestRealpathSync', () => {
  it('answers a missing file with its nearest existing folder', () => {
    expect(nearestRealpathSync(join(inside, 'linked', 'missing', 'x.md'))).toBe(outside);
  });
});

describe('PathGuards', () => {
  const guard: PathGuard = {
    covers: (path) => path.startsWith(inside),
    admits: (path) => !path.endsWith('refused.md'),
    landsInside: (_path, real) => under(inside)(real),
  };

  it('checks only what a guard covers, and removes the guard on request', async () => {
    const guards = new PathGuards();
    const remove = guards.add(guard);
    expect(guards.covers(join(outside, 'keys.md'))).toBe(false);
    expect(guards.allows(join(inside, 'refused.md'))).toBe(false);
    expect(guards.landsAllowedSync(join(inside, 'linked', 'new.md'))).toBe(false);
    expect(guards.landsAllowedSync(join(inside, 'sub', 'new.md'))).toBe(true);
    await expect(guards.read(join(inside, 'linked', 'keys.md'))).rejects.toBeInstanceOf(
      GuardRefused,
    );
    remove();
    expect(guards.landsAllowedSync(join(inside, 'linked', 'new.md'))).toBe(true);
    expect((await guards.read(join(inside, 'linked', 'keys.md'))).text).toBe('riverbend secret\n');
  });
});
