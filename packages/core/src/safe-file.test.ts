/**
 * Reading and replacing a file by name in a folder somebody else can write:
 * no link followed, no non-regular file read, nothing oversized, and a temp
 * file swapped before its rename never lands. Throwaway files in a temp folder.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commitTemp,
  discardTemp,
  isPlainFile,
  readSmallFile,
  replaceFile,
  writeTempBeside,
} from './safe-file.ts';

const dir = mkdtempSync(join(tmpdir(), 'safe-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const at = (name: string) => join(dir, name);
writeFileSync(at('server.json'), '{"port":8787}\n');
symlinkSync(at('server.json'), at('link.json'));
mkdirSync(at('folder'));

describe('readSmallFile', () => {
  it("reads a regular file's text (the control)", () => {
    expect(readSmallFile(at('server.json'))).toBe('{"port":8787}\n');
    expect(isPlainFile(at('server.json'))).toBe(true);
  });

  it('answers null for a link, a folder, a missing file and an oversized one', () => {
    expect(readSmallFile(at('link.json'))).toBeNull();
    expect(isPlainFile(at('link.json'))).toBe(false);
    expect(readSmallFile(at('folder'))).toBeNull();
    expect(readSmallFile(at('missing.json'))).toBeNull();
    expect(isPlainFile(at('missing.json'))).toBe(false);
    expect(readSmallFile(at('server.json'), 4)).toBeNull();
  });
});

describe('replacing a file through a temp beside it', () => {
  it('replaces the target with the mode asked, leaving no temp', () => {
    replaceFile(at('state.json'), '{"a":1}', 0o600);
    expect(readFileSync(at('state.json'), 'utf8')).toBe('{"a":1}');
    expect(statSync(at('state.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('writes through a link at the target name by replacing the link, not its target', () => {
    replaceFile(at('link.json'), '{"port":1}');
    expect(readFileSync(at('server.json'), 'utf8')).toBe('{"port":8787}\n');
    expect(isPlainFile(at('link.json'))).toBe(true);
  });

  it('refuses a temp swapped before the rename, and removes it', () => {
    const pending = writeTempBeside(at('swapped.json'), 'mine');
    unlinkSync(pending.tmp);
    writeFileSync(pending.tmp, 'planted');
    expect(() => commitTemp(pending, at('swapped.json'))).toThrow(/replaced before the rename/);
    expect(isPlainFile(at('swapped.json'))).toBe(false);
    expect(isPlainFile(pending.tmp)).toBe(false);
  });

  it('drops a temp it is told to discard', () => {
    const pending = writeTempBeside(at('dropped.json'), 'x');
    discardTemp(pending);
    expect(isPlainFile(pending.tmp)).toBe(false);
  });

  it('throws, leaving nothing, where the temp cannot be made', () => {
    expect(() => replaceFile(join(at('missing-folder'), 'x.json'), 'x')).toThrow();
  });
});
