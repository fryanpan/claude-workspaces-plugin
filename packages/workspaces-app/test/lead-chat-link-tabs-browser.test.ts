/**
 * Links in the lead's chat, followed with voice on: a board link opens in
 * this tab and voice keeps listening, Cmd- or Ctrl-click opens a new tab, a
 * link off the app opens a new tab and this tab keeps listening, a mock link
 * from an agent's closing message opens the mock, and on a phone a short tap
 * follows the link (the owner, 9 Nov). At 1180x820 with a mouse and 430x932 with
 * touch. `lead-chat-link-tabs-browser-driver.ts` drives a real server and
 * the real bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { LinkTabCase, LinkTabsRun } from './lead-chat-link-tabs-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-link-tabs-browser-driver.ts');
/** One bundle build, two launches, seven gestures that each start voice. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

let run: LinkTabsRun | null = null;
const result = (): LinkTabsRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};
const find = (width: number, link: string, gesture: string): LinkTabCase => {
  const c = result().cases.find(
    (x) => x.width === width && x.link === link && x.gesture === gesture,
  );
  if (!c) throw new Error(`no case ${width} ${link} ${gesture}`);
  return c;
};
const path = (url: string): string => new URL(url).pathname;

describe.skipIf(CHROME === null)('links in the lead chat, with voice on', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as LinkTabsRun;
  }, SUITE_MS);

  it('ran every gesture at both sizes', () => {
    expect(result().cases.map((c) => `${c.width} ${c.link} ${c.gesture}`)).toEqual([
      '1180 mock tap',
      '1180 doc tap',
      '1180 doc new-tab-click',
      '1180 external tap',
      '430 mock touch',
      '430 doc touch',
      '430 external touch',
    ]);
  }, 60_000);

  it('a board link opens in this tab, and the mock link from a closing message opens the mock', () => {
    const r = result();
    for (const [width, gesture] of [
      [1180, 'tap'],
      [430, 'touch'],
    ] as const) {
      for (const [link, want] of [
        ['mock', r.mockPath],
        ['doc', r.docPath],
      ] as const) {
        const c = find(width, link, gesture);
        const at = `${width} ${link} ${gesture}: ${c.pageUrl}`;
        expect(path(c.href), at).toBe(want);
        expect(c.target, at).toBeNull();
        expect(c.opened, at).toEqual([]);
        expect(path(c.pageUrl), at).toBe(want);
        expect(c.notFound, at).toBe(false);
      }
      // The doc page draws the agent button, and voice came back on there.
      expect(find(width, 'doc', gesture).listening, `${width} doc`).toBe(true);
    }
  }, 60_000);

  it('Cmd- or Ctrl-click on a board link opens a new tab and this one keeps listening', () => {
    const r = result();
    const c = find(1180, 'doc', 'new-tab-click');
    expect(c.opened.map(path)).toEqual([r.docPath]);
    expect(path(c.pageUrl)).toBe(`/workspaces/${r.workspaceId}/home`);
    expect(c.listening).toBe(true);
  }, 60_000);

  it('a link off the app opens a new tab and this one keeps listening', () => {
    const r = result();
    for (const [width, gesture] of [
      [1180, 'tap'],
      [430, 'touch'],
    ] as const) {
      const c = find(width, 'external', gesture);
      const at = `${width} external ${gesture}`;
      expect(c.target, at).toBe('_blank');
      expect(c.opened, at).toEqual([r.externalUrl]);
      expect(path(c.pageUrl), at).toBe(`/workspaces/${r.workspaceId}/home`);
      expect(c.listening, at).toBe(true);
    }
  }, 60_000);
});
