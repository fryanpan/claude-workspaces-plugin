/**
 * A voice message says where it was said, and a spoken answer survives a
 * follow moving the page, in a real browser at 1180x820 and 430x932.
 * `follow-voice-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { MOCK_PHRASE } from './follow-browser-phrases.ts';
// Types only: importing a value would run the driver in this process.
import type { FollowVoiceRun } from './follow-voice-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'follow-voice-browser-driver.ts');
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

let run: FollowVoiceRun | null = null;
const result = (): FollowVoiceRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('voice and following', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as FollowVoiceRun;
  }, SUITE_MS);

  it('names the board tab and the open task panel the question was said on', () => {
    const { workspaceId, taskId, contexts } = result();
    const B = `/workspaces/${workspaceId}`;
    for (const width of [1180, 430]) {
      const at = (where: string) => contexts.find((c) => c.width === width && c.where === where);
      expect(at('board tab')).toMatchObject({ link: `${B}/library`, surface: 'board' });
      expect(at('task panel')).toMatchObject({ link: `${B}?task=${taskId}`, surface: 'task' });
    }
  }, 60_000);

  it('names the exact tab, thread, panel, settings pane and list it was said on', () => {
    const { workspaceId, taskId, goalId, contexts } = result();
    const B = `/workspaces/${workspaceId}`;
    for (const width of [1180, 430]) {
      const at = (where: string) => contexts.find((c) => c.width === width && c.where === where);
      const link = (where: string) => at(where)?.link;
      expect(link('task activity tab')).toBe(`${B}?task=${taskId}&tab=activity`);
      expect(link('task thread')).toBe(`${B}?task=${taskId}&thread=${at('task thread')?.threadId}`);
      expect(link('goal panel')).toBe(`${B}?goal=${goalId}`);
      expect(link('settings pane')).toBe(`${B}?settings=notifications`);
      expect(link('library list')).toBe(`${B}/library?list=files`);
    }
  }, 60_000);

  it('names the mock and the section on screen in its frame', () => {
    const { workspaceId, mockId, contexts } = result();
    const mocks = contexts.filter((c) => c.where === 'mock section');
    expect(mocks.map((c) => c.width)).toEqual([1180, 430]);
    for (const c of mocks) {
      expect(c).toMatchObject({
        link: `/workspaces/${workspaceId}/mockups/${mockId}`,
        visibleHeading: MOCK_PHRASE,
      });
    }
  }, 60_000);

  it('names the doc and the section on screen in it', () => {
    const { workspaceId, docId, contexts } = result();
    const docs = contexts.filter((c) => c.where === 'doc section');
    expect(docs.map((c) => c.width)).toEqual([1180, 430]);
    for (const c of docs) {
      expect(c).toMatchObject({
        link: `/workspaces/${workspaceId}/docs/${docId}`,
        surface: 'doc',
        visibleHeading: 'Tides',
      });
    }
  }, 60_000);

  it('says the answer on the page a follow moved the asker to, without a tap', () => {
    const { workspaceId, docId, handovers } = result();
    expect(handovers).toEqual(
      [1180, 430].map((width) => ({
        width,
        movedTo: `/workspaces/${workspaceId}/docs/${docId}`,
        delivered: true,
        heardOnNewPage: true,
        tapped: false,
      })),
    );
  }, 60_000);
});
