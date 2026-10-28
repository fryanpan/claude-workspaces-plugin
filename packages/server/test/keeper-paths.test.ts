import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  folderEntries,
  pathArgIndexes,
  realish,
  resolveFlyPaths,
} from '../src/keeper/keeper-paths.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-paths-'));
const home = join(tmp, 'home');
const store = join(home, 'store');
const work = join(tmp, 'work');
mkdirSync(store, { recursive: true });
mkdirSync(work);
writeFileSync(join(work, 'Dockerfile'), 'FROM scratch\n');
symlinkSync(store, join(tmp, 'link'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('pathArgIndexes', () => {
  it('finds the build folder and every path flag, in both forms', () => {
    const args = ['deploy', '/a', '--app', 'x', '--config', '/b', '--dockerfile=/c', '-c', '/d'];
    expect(pathArgIndexes(args).map((i) => args[i])).toEqual(['/b', '--dockerfile=/c', '/d', '/a']);
  });

  it('finds the local side of an sftp copy', () => {
    expect(pathArgIndexes(['ssh', 'sftp', 'put', '/l', '/r', '-a', 'x'])).toEqual([3]);
    expect(pathArgIndexes(['ssh', 'sftp', 'get', '/r', '/l', '-a', 'x'])).toEqual([4]);
  });

  it('reads a flag value as a value, not as the build folder', () => {
    expect(pathArgIndexes(['deploy', '--config', '/b', '--app', 'x'])).toEqual([2]);
  });
});

describe('resolveFlyPaths', () => {
  const guarded = [home];

  it('refuses a path inside, through, or above a guarded folder', () => {
    for (const p of [
      store,
      join(store, 'credentials.json'),
      join(store, '..', '..'),
      join(tmp, 'link', 'apps.json'),
      join(store, 'not-yet', 'there'),
    ]) {
      expect('error' in resolveFlyPaths(['deploy', p, '--app', 'x'], guarded)).toBe(true);
    }
    expect('error' in resolveFlyPaths(['deploy', work, `--config=${store}/a`], guarded)).toBe(true);
  });

  it('refuses a relative path', () => {
    expect(resolveFlyPaths(['deploy', 'ctx', '--app', 'x'], guarded)).toEqual({
      error: 'name ctx as a full path',
    });
  });

  it('hands fly the resolved path (control: a clean folder passes)', () => {
    const r = resolveFlyPaths(
      ['deploy', join(tmp, '.', 'work'), `--dockerfile=${work}/Dockerfile`, '--app', 'x'],
      guarded,
    );
    const real = realpathSync(work);
    expect(r).toEqual({
      args: ['deploy', real, `--dockerfile=${real}/Dockerfile`, '--app', 'x'],
      paths: [`${real}/Dockerfile`, real],
      at: [2, 1],
    });
  });

  it('passes a call that names no local path', () => {
    expect(resolveFlyPaths(['status', '--app', 'x'], guarded)).toEqual({
      args: ['status', '--app', 'x'],
      paths: [],
      at: [],
    });
  });
});

describe('realish', () => {
  it('follows a link in the part that exists and keeps the rest', () => {
    expect(realish(join(tmp, 'link', 'missing', 'f'))).toBe(
      join(realpathSync(store), 'missing', 'f'),
    );
  });
});

describe('folderEntries', () => {
  it('lists a folder, capped, and nothing for a file', () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(work, `f${i}`), '');
    expect(folderEntries(work, 3)).toEqual(['Dockerfile', 'f0', 'f1', '… and 3 more']);
    expect(folderEntries(join(work, 'Dockerfile'))).toEqual([]);
  });
});
