/**
 * The meetings folder's `.gitignore` when the name holds something other than
 * a file: a FIFO must not hold the main thread, and a link must not carry the
 * write to its target. Fixtures synthetic, in a temp folder; the FIFO case runs
 * in a bun child with a hard timeout, so a regression fails instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMeetingGitignore, meetingGitignorePath } from '../src/meeting-home.ts';
import { makeFifo } from './fifo.ts';

let tmp: string;
let folder: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-meeting-gitignore-')));
  folder = join(tmp, 'meetings');
  mkdirSync(folder);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("the meetings folder's .gitignore", () => {
  it('reads a FIFO as somebody else’s file instead of blocking', () => {
    makeFifo(meetingGitignorePath(folder));
    const MODULE = resolve(__dirname, '../src/meeting-home.ts');
    const res = spawnSync(
      'bun',
      [
        '-e',
        `const m = await import(${JSON.stringify(MODULE)});
         console.log(m.applyMeetingGitignore(${JSON.stringify(folder)}, true));`,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );
    expect(res.signal).toBe(null);
    expect(res.stdout.trim()).toBe('foreign');
  }, 15_000);

  it('does not write through a dangling link', () => {
    const victim = join(tmp, 'victim.txt');
    symlinkSync(victim, meetingGitignorePath(folder));
    expect(applyMeetingGitignore(folder, true)).toBe('foreign');
    expect(existsSync(victim)).toBe(false);
  });
});
