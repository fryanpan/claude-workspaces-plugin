/**
 * The guarded read and write behind `slow-fs.ts` `boundFiles.guards`: each
 * judges where the file really is after it is open, so a folder link on the
 * way cannot carry it outside. Fixtures synthetic, in a temp folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
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
  readCheckedSync,
  readRangeChecked,
  writeChecked,
  writeCheckedSync,
} from '../src/bound-path-guard.ts';
import { makeFifo } from './fifo.ts';

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

  it('refuses a file with a second name, which a hard link into a root would give it', async () => {
    const once = join(inside, 'sub', 'once.md');
    writeFileSync(once, '# harborlight once\n');
    // The control: one name reads.
    expect((await readChecked(once, under(inside))).text).toBe('# harborlight once\n');
    linkSync(join(outside, 'keys.md'), join(inside, 'sub', 'keys.md'));
    const read = readChecked(join(inside, 'sub', 'keys.md'), under(inside));
    await expect(read).rejects.toBeInstanceOf(GuardRefused);
  });

  it('refuses a pipe at once rather than waiting on it', async () => {
    const pipe = join(inside, 'sub', 'pipe.md');
    makeFifo(pipe);
    await expect(readChecked(pipe, under(inside))).rejects.toBeInstanceOf(GuardRefused);
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
    expect(readdirSync(join(inside, 'sub')).filter((f) => f.includes('cw-pool-write'))).toEqual([]);
  });

  it('creates nothing outside through a linked folder', async () => {
    const write = writeChecked(join(inside, 'linked', 'new.md'), 'leaked\n', under(inside));
    await expect(write).rejects.toBeInstanceOf(GuardRefused);
    expect(existsSync(join(outside, 'new.md'))).toBe(false);
    expect(readdirSync(outside)).toEqual(['keys.md']);
  });
});

describe('writeChecked and a link at the temp file’s old name', () => {
  it('never writes through, truncates or removes what the link names', async () => {
    const victim = join(outside, 'victim.md');
    writeFileSync(victim, 'riverbend keep\n');
    const path = join(inside, 'sub', 'notes.md');
    writeFileSync(path, '# harborlight notes\n');
    symlinkSync(victim, `${path}.cw-pool-write~`);
    await writeChecked(path, '# harborlight notes\n\nRevised.\n', under(inside));
    expect(readFileSync(path, 'utf8')).toContain('Revised.');
    expect(readFileSync(victim, 'utf8')).toBe('riverbend keep\n');
  });

  it('removes only its own temp file when a linked folder refuses the write', async () => {
    const write = writeChecked(join(inside, 'linked', 'keys.md'), 'leaked\n', under(inside));
    await expect(write).rejects.toBeInstanceOf(GuardRefused);
    expect(readFileSync(join(outside, 'keys.md'), 'utf8')).toBe('riverbend secret\n');
    expect(readdirSync(outside).filter((f) => f.includes('cw-pool-write'))).toEqual([]);
  });
});

describe('readCheckedSync', () => {
  it('reads inside, and refuses a linked folder, a second name and a pipe', () => {
    expect(readCheckedSync(join(inside, 'sub', 'plan.md'), under(inside))).toContain('harborlight');
    expect(() => readCheckedSync(join(inside, 'linked', 'keys.md'), under(inside))).toThrow(
      GuardRefused,
    );
    linkSync(join(outside, 'keys.md'), join(inside, 'sub', 'keys-sync.md'));
    expect(() => readCheckedSync(join(inside, 'sub', 'keys-sync.md'), under(inside))).toThrow(
      GuardRefused,
    );
    const pipe = join(inside, 'sub', 'pipe-sync.md');
    makeFifo(pipe);
    expect(() => readCheckedSync(pipe, under(inside))).toThrow(GuardRefused);
  });
});

describe('writeCheckedSync, for the shutdown flush and the export', () => {
  for (const lane of ['flush', 'export'] as const) {
    it(`${lane}: writes inside past a link at the old temp name, and nothing outside`, () => {
      const victim = join(outside, `victim-${lane}.md`);
      writeFileSync(victim, 'riverbend keep\n');
      const path = join(inside, 'sub', `${lane}.md`);
      writeFileSync(path, '# harborlight\n');
      symlinkSync(victim, `${path}.cw-${lane}~`);
      writeCheckedSync(path, '# harborlight\n\nRevised.\n', lane, under(inside));
      expect(readFileSync(path, 'utf8')).toContain('Revised.');
      expect(readFileSync(victim, 'utf8')).toBe('riverbend keep\n');

      const before = readdirSync(outside).sort();
      expect(() =>
        writeCheckedSync(join(inside, 'linked', `${lane}.md`), 'leaked\n', lane, under(inside)),
      ).toThrow(GuardRefused);
      expect(readdirSync(outside).sort()).toEqual(before);
    });
  }
});

describe('readRangeChecked', () => {
  it('reads the range of a file inside, and refuses one a link carries outside', async () => {
    const bytes = await readRangeChecked(join(inside, 'sub', 'plan.md'), 2, 13, under(inside));
    expect(new TextDecoder().decode(bytes)).toBe('harborlight ');
    writeFileSync(join(outside, 'range.md'), 'riverbend range\n');
    const outsideRead = readRangeChecked(join(inside, 'linked', 'range.md'), 0, 4, under(inside));
    await expect(outsideRead).rejects.toBeInstanceOf(GuardRefused);
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

  it('makes covered folders one at a time, and none through a link', () => {
    const guards = new PathGuards();
    // The root itself counts as inside, as `board-socket-roots.ts` has it.
    const remove = guards.add({
      ...guard,
      landsInside: (_path, real) => real === inside || under(inside)(real),
    });
    try {
      // The control: folders inside the root are made.
      guards.mkdirSync(join(inside, 'made', 'deeper'));
      expect(existsSync(join(inside, 'made', 'deeper'))).toBe(true);
      expect(() => guards.mkdirSync(join(inside, 'linked', 'new', 'deeper'))).toThrow(GuardRefused);
      expect(existsSync(join(outside, 'new'))).toBe(false);
    } finally {
      remove();
    }
  });
});
