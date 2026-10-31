/**
 * The guard's stat and bounded read: under a walled lead's project a plain
 * `stat` follows a link and reports the size and time of the file it names
 * (the Library, the copy check and the poll all showed those), and a plain
 * read of a FIFO holds the main thread. Fixtures synthetic, in a temp folder.
 *
 * The FIFO cases run in a bun child with a hard timeout, so a regression to a
 * blocking open fails here instead of hanging the runner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  GUARDED_TEXT_MAX,
  GuardRefused,
  type PathGuard,
  PathGuards,
} from '../src/bound-path-guard.ts';
import { makeFifo } from './fifo.ts';

let dir: string;
let inside: string;
let outside: string;
let guards: PathGuards;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'guarded-stat-')));
  inside = join(dir, 'harborlight');
  outside = join(dir, 'riverbend');
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(inside, 'plan.md'), '# plan\n');
  writeFileSync(join(outside, 'keys.md'), 'x'.repeat(4_321));
  symlinkSync(join(outside, 'keys.md'), join(inside, 'keys.md'));
  symlinkSync(outside, join(inside, 'linked'));
  makeFifo(join(inside, 'pipe.md'));
  makeFifo(join(outside, 'pipe.md'));
  const guard: PathGuard = {
    covers: (path) => path.startsWith(`${inside}${sep}`),
    admits: () => true,
    landsInside: (_path, real) => real.startsWith(`${inside}${sep}`),
  };
  guards = new PathGuards();
  guards.add(guard);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the guard’s stat', () => {
  it('refuses a link to a file outside instead of reporting that file', async () => {
    for (const p of [join(inside, 'keys.md'), join(inside, 'linked', 'keys.md')]) {
      expect(() => guards.statSync(p)).toThrow(GuardRefused);
      await expect(guards.stat(p)).rejects.toBeInstanceOf(GuardRefused);
    }
  });

  it('stats a plain file inside, and a missing one as ENOENT (control)', async () => {
    expect(guards.statSync(join(inside, 'plan.md')).size).toBe(7);
    expect((await guards.stat(join(inside, 'plan.md'))).size).toBe(7n);
    expect(() => guards.statSync(join(inside, 'gone.md'))).toThrow(/ENOENT/);
  });

  it('stats an uncovered path as it is (control)', () => {
    expect(guards.statSync(join(outside, 'keys.md')).size).toBe(4_321);
  });
});

describe('the guard’s bounded read', () => {
  const GUARD = resolve(__dirname, '../src/bound-path-guard.ts');
  const inChild = (path: string) =>
    spawnSync(
      'bun',
      [
        '-e',
        `const { PathGuards } = await import(${JSON.stringify(GUARD)});
         const g = new PathGuards();
         g.add({ covers: (p) => p.startsWith(${JSON.stringify(`${inside}${sep}`)}), admits: () => true, landsInside: (_p, r) => r.startsWith(${JSON.stringify(`${inside}${sep}`)}) });
         try { console.log(String(g.readBoundedSync(${JSON.stringify(path)}, 1024))); } catch (e) { console.log(e.constructor.name); }`,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );

  it('refuses a FIFO, covered or not, without blocking', () => {
    for (const p of [join(inside, 'pipe.md'), join(outside, 'pipe.md')]) {
      const res = inChild(p);
      expect(res.signal, p).toBe(null);
      expect(res.stdout.trim(), p).toBe('GuardRefused');
    }
  });

  it('refuses a link out, caps the size, and reads a plain file', () => {
    expect(() => guards.readBoundedSync(join(inside, 'keys.md'), 1024)).toThrow(GuardRefused);
    expect(guards.readBoundedSync(join(outside, 'keys.md'), 1024)).toBe('too-large');
    expect(guards.readBoundedSync(join(inside, 'plan.md'), 1024)).toBe('# plan\n');
  });
});

describe('the guard’s text read', () => {
  it('refuses a covered file over the cap, both ways', async () => {
    const big = join(inside, 'big.md');
    writeFileSync(big, 'x'.repeat(GUARDED_TEXT_MAX + 1));
    try {
      await expect(guards.read(big)).rejects.toBeInstanceOf(GuardRefused);
      expect(() => guards.readSync(big)).toThrow(GuardRefused);
    } finally {
      rmSync(big);
    }
  });

  it('reads through a link that lands inside, resolved before the open (control)', async () => {
    mkdirSync(join(inside, 'real'), { recursive: true });
    writeFileSync(join(inside, 'real', 'doc.md'), '# doc\n');
    symlinkSync(join(inside, 'real'), join(inside, 'alias'));
    expect((await guards.read(join(inside, 'alias', 'doc.md'))).text).toBe('# doc\n');
    expect(guards.readSync(join(inside, 'alias', 'doc.md'))).toBe('# doc\n');
  });
});
