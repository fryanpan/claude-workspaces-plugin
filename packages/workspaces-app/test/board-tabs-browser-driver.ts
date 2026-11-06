#!/usr/bin/env bun
/**
 * Every page and tab of a board has its own address: click it, read the
 * address, reload, and check the same thing is on screen. Headless Chromium
 * against a real server and the real bundles, at 1180x820 and 430x932.
 *
 * Spawned by `board-tabs-browser.test.ts`, which reads the JSON it prints.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import {
  ADDRESS,
  SIZES,
  bootBoard,
  deadline,
  navigate,
  openPerson,
  shutdown,
  until,
} from './follow-browser-kit.ts';

export interface TabStep {
  width: number;
  name: string;
  /** The address the click left. */
  address: string;
  shown: boolean;
  /** The address and the screen after a reload. */
  reloaded: string;
  shownAfterReload: boolean;
}

export interface BoardTabsRun {
  workspaceId: string;
  taskId: string;
  goalId: string;
  steps: TabStep[];
}

const step = (what: string): void => {
  process.stderr.write(`[board-tabs-driver] ${what}\n`);
};

const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.click()`;
const nav = (name: string) => click(`.board-nav-item[data-nav="${name}"]`);
const drawn = (selector: string) => `(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  return !!e && e.getClientRects().length > 0;
})()`;

interface Tab {
  name: string;
  /** A page to start from, for a tab reached from somewhere else. */
  from?: string;
  /** What the reader clicks; without it, the address is a link they opened. */
  act?: string;
  /** What has to be there before the click can land. */
  ready?: string;
  /** Selector for what the tab shows. */
  shown: string;
}

async function reach(cdp: Cdp, base: string, tab: Tab): Promise<void> {
  if (tab.from !== undefined) await navigate(cdp, `${base}${tab.from}`);
  await until(`${tab.name} ready`, async () =>
    (await cdp.evaluate(drawn('#board-main'))) ? true : null,
  );
  if (tab.ready) {
    const ready = tab.ready;
    await until(`${tab.name} can be clicked`, async () =>
      (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(ready)})`)) ? true : null,
    );
  }
  if (tab.act) await cdp.evaluate(tab.act);
}

async function main(): Promise<void> {
  deadline('board-tabs-driver', 170_000);
  const board = await bootBoard('board-tabs');
  const { base, ws } = board;
  const B = `/workspaces/${ws}`;
  const steps: TabStep[] = [];
  try {
    const tabs: Tab[] = [
      { name: 'home', from: B, act: nav('home'), shown: '#board-home' },
      { name: 'tasks', act: nav('tasks'), shown: '#board' },
      { name: 'library', act: nav('library'), shown: '#board-library' },
      // A link, because a board this small has no "all files" button to press;
      // `library-page.test.ts` presses it.
      { name: 'library files', from: `${B}/library?list=files`, shown: '.library-all' },
      { name: 'activity', from: B, act: nav('activity'), shown: '#board-activity' },
      {
        name: 'task comments',
        from: B,
        act: click(`[data-task-id="${board.taskId}"] .board-task-open`),
        ready: `[data-task-id="${board.taskId}"] .board-task-open`,
        shown: '.board-detail-tab-comments[aria-selected="true"]',
      },
      {
        name: 'task activity',
        act: click('.board-detail-tab-activity'),
        ready: '.board-detail-tab-activity',
        shown: '.board-detail-tab-activity[aria-selected="true"]',
      },
      { name: 'goal', from: `${B}?goal=${board.goalId}`, shown: '#board-goal-detail' },
      {
        name: 'settings',
        from: B,
        act: click('#board-settings'),
        ready: '#board-settings',
        shown: '#board-settings-view',
      },
      {
        name: 'settings notifications',
        act: click('.settings-subnav [data-type="notifications"]'),
        ready: '.settings-subnav [data-type="notifications"]',
        shown: '[data-pane="notifications"]',
      },
      {
        name: 'settings prompts',
        act: click('.settings-subnav [data-type="prompts"]'),
        ready: '.settings-subnav [data-type="prompts"]',
        shown: '[data-pane="prompts"]',
      },
    ];
    for (const [width, height] of SIZES) {
      step(`walking at ${width}`);
      const firstPerson = await openPerson(width, height, {
        anonId: `first-person-tabs${width}`,
        name: 'Alice',
        ws,
      });
      await navigate(firstPerson, `${base}${B}`);
      for (const tab of tabs) {
        step(`${width} ${tab.name}`);
        await reach(firstPerson, base, tab);
        const seen = async () =>
          (await until(`${tab.name} on screen`, async () =>
            (await firstPerson.evaluate(drawn(tab.shown))) ? true : null,
          ).catch(() => false)) === true;
        const shown = await seen();
        const address = (await firstPerson.evaluate(ADDRESS)) as string;
        await navigate(firstPerson, `${base}${address}`);
        const shownAfterReload = await seen();
        const reloaded = (await firstPerson.evaluate(ADDRESS)) as string;
        steps.push({ width, name: tab.name, address, shown, reloaded, shownAfterReload });
      }
      firstPerson.close();
    }
    const run: BoardTabsRun = {
      workspaceId: ws,
      taskId: board.taskId,
      goalId: board.goalId,
      steps,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
  }
}

await main();
process.exit(0);
