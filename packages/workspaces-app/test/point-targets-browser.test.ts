/**
 * Following reaches the places `point-follow-browser.test.ts` does not: a
 * thread and a block in a doc, a thread and a scroll in a mock, an app, a
 * diff, a folder file, a whiteboard and the workspaces list, and carries on
 * from each. `point-targets-browser-driver.ts` drives a real browser at
 * 1180x820 and 430x932; these cases read its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { PointTargetsRun } from './point-targets-browser-driver.ts';

const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'point-targets-browser-driver.ts');

const MOVES = [
  'doc',
  'doc thread',
  'doc block',
  'mock',
  'mock scroll',
  'mock thread',
  'app',
  'board after an app',
  'diff',
  'folder file',
  'whiteboard',
  'workspaces list',
  'board after the list',
  'review queue',
  'board after the queue',
  'person doc thread',
  'person mock scroll',
  'person board page',
  'person board scroll',
];

let run: PointTargetsRun | null = null;
const result = (): PointTargetsRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('pointing at any place', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 210_000 });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as PointTargetsRun;
  }, 220_000);

  it('makes every move at both sizes', () => {
    expect(result().steps.map((s) => `${s.width} ${s.what}`)).toEqual([
      ...MOVES.map((m) => `1180 ${m}`),
      ...MOVES.map((m) => `430 ${m}`),
    ]);
  }, 60_000);

  it('lands the follower on the page, with the place on screen', () => {
    for (const s of result().steps) {
      expect(s.address, `${s.width} ${s.what}`).toBe(s.expected);
      expect(s.placed, `${s.width} ${s.what}`).toBe(true);
    }
  }, 60_000);
});
