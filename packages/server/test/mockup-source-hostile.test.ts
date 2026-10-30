/**
 * A mock's source file when a walled lead can write the folder it sits in:
 * the read must not block on a FIFO, must not follow a link out of a walled
 * root, and must refuse a folder the wall shadows (the lead's scratch).
 * Fixtures synthetic, in a temp folder; the FIFO case runs in a bun child with
 * a hard timeout, so a regression fails instead of hanging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PathGuards } from '../src/bound-path-guard.ts';
import { checkMockupSource, readMockupHtml } from '../src/mockup-capture.ts';
import { makeFifo } from './fifo.ts';

let dir: string;
let root: string;
let shadow: string;
let outside: string;
let guards: PathGuards;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-mock-source-')));
  root = join(dir, 'harborlight');
  shadow = join(dir, 'scratch');
  outside = join(dir, 'riverbend');
  for (const d of [root, shadow, outside]) mkdirSync(d);
  writeFileSync(join(outside, 'secret.html'), '<p>owner file</p>');
  writeFileSync(join(root, 'mock.html'), '<p>mock</p>');
  writeFileSync(join(shadow, 'mock.html'), '<p>lead scratch</p>');
  symlinkSync(join(outside, 'secret.html'), join(root, 'linked.html'));
  makeFifo(join(outside, 'pipe.html'));
  const under = (p: string, d: string) => p === d || p.startsWith(`${d}${sep}`);
  guards = new PathGuards();
  guards.add({
    covers: (p) => under(p, root) || under(p, shadow),
    admits: (p) => !under(p, shadow),
    landsInside: (_p, real) => under(real, root),
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a mock source in a folder a walled lead can write', () => {
  it('is not read through a link out of a walled root', () => {
    expect(readMockupHtml(join(root, 'linked.html'), guards)).toBeNull();
    expect(checkMockupSource(join(root, 'linked.html'), guards).ok).toBe(false);
  });

  it('is refused in a folder the wall shadows', () => {
    expect(readMockupHtml(join(shadow, 'mock.html'), guards)).toBeNull();
    expect(checkMockupSource(join(shadow, 'mock.html'), guards).ok).toBe(false);
  });

  it('reads a plain mock inside a root and outside one (control)', () => {
    expect(readMockupHtml(join(root, 'mock.html'), guards)).toBe('<p>mock</p>');
    expect(checkMockupSource(join(root, 'mock.html'), guards).ok).toBe(true);
    expect(readMockupHtml(join(outside, 'secret.html'), guards)).toBe('<p>owner file</p>');
  });

  it('answers null for a FIFO instead of blocking', () => {
    const MODULE = resolve(__dirname, '../src/mockup-capture.ts');
    const res = spawnSync(
      'bun',
      [
        '-e',
        `const m = await import(${JSON.stringify(MODULE)});
         console.log(JSON.stringify(m.readMockupHtml(${JSON.stringify(join(outside, 'pipe.html'))})));`,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );
    expect(res.signal).toBe(null);
    expect(res.stdout.trim()).toBe('null');
  }, 15_000);
});
