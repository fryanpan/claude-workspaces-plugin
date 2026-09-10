/**
 * The stamp the disk→doc poll compares, read straight off the filesystem.
 *
 * `bound-poll-stamp.test.ts` drives the whole poll; this one pins the piece it
 * rests on, because a stamp that cannot separate two states makes every test
 * above it a test of nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampOf, statStampSync } from '../src/file-stamp.ts';

describe('a bound file’s stamp', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-stamp-unit-'));
    path = join(dir, 'a.md');
    writeFileSync(path, 'one\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('separates two same-length writes placed inside one millisecond', () => {
    const sameMs = Math.floor(Date.now() / 1000) + 0.25;
    utimesSync(path, sameMs, sameMs);
    const before = statStampSync(path);
    const wholeMsBefore = statSync(path).mtimeMs;

    writeFileSync(path, 'two\n');
    utimesSync(path, sameMs + 0.0005, sameMs + 0.0005);
    const after = statStampSync(path);

    // The premise: neither half of a whole-millisecond stamp moved.
    expect(statSync(path).mtimeMs).toBe(wholeMsBefore);
    expect(after.size).toBe(before.size);
    // ...and yet the stamp read here tells them apart.
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  });

  it('is still a whole-millisecond count, so it compares against an ordinary stat', () => {
    // The `.ydoc`-versus-file arbitration compares this number against a plain
    // `statSync().mtimeMs`; a bigint there would throw on the compare.
    //
    // The mtime is PLACED rather than taken as it comes: a double resolves
    // ~244ns here, so a stamp in the top ~122ns of a millisecond rounds up to
    // the next one and this would fail once in several thousand runs on an
    // arbitrary file. 0.9ms into the millisecond is far outside that window,
    // which is what makes the truncates-not-rounds claim a control rather
    // than a coin flip. `diskNewerThanState` names the window it leaves.
    const placed = Math.floor(Date.now() / 1000) + 0.2509;
    utimesSync(path, placed, placed);
    const stamp = statStampSync(path);
    expect(typeof stamp.mtimeMs).toBe('number');
    expect(Math.trunc(stamp.mtimeMs)).toBe(statSync(path).mtimeMs);
  });

  it('reports the byte count as the other half', () => {
    expect(statStampSync(path).size).toBe(4);
    writeFileSync(path, 'a longer line\n');
    expect(statStampSync(path).size).toBe(14);
  });

  it('stampOf reads a stat somebody else already took', () => {
    expect(stampOf(statSync(path, { bigint: true }))).toEqual(statStampSync(path));
  });
});
