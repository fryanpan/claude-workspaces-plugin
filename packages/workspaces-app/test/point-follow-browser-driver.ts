#!/usr/bin/env bun
/**
 * Following, in headless Chromium against a real server and the real
 * bundles, at 1180x820 and 430x932.
 *
 *  - An agent points (`POST /workspaces/<ws>/point`, what `point_at` sends)
 *    at every kind of place, and a tab following it lands there: a board
 *    tab, a review item, a task panel and a thread on it, a goal panel, a
 *    phrase and a scroll position in a doc, a phrase in a mock, and the
 *    review queue. A board place is shown in place, without a load.
 *  - A tab following a person tracks their page, the panel they open and
 *    where they scroll in a doc.
 *
 * Each step records the address it reached and how long it took; the test
 * asserts the places, and the times are reported.
 *
 * Spawned by `point-follow-browser.test.ts`, which reads the JSON it prints.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { frameSessions, frameSurface } from '../../widget/test/frame-driver-kit.ts';
import {
  ADDRESS,
  DOC_PHRASE,
  MOCK_PHRASE,
  SIZES,
  bootBoard,
  deadline,
  docView,
  navigate,
  openPerson,
  shutdown,
  until,
} from './follow-browser-kit.ts';

export interface Step {
  width: number;
  /** What moved: `agent <place>` or `person <move>`. */
  what: string;
  /** The address the follower was expected at. */
  expected: string;
  address: string;
  /** Whether the follower's page stayed the same document (shown in place). */
  inPlace: boolean;
  /** For a doc or mock: the place on the page was on screen. */
  placed: boolean;
  ms: number;
}

export interface PointFollowRun {
  workspaceId: string;
  steps: Step[];
}

const step = (what: string): void => {
  process.stderr.write(`[point-follow-driver] ${what}\n`);
};

/** A marker that a load clears: still there means the page did not load. */
const MARK = 'window.__cwStay = true';
const STAYED = 'window.__cwStay === true';

/** Where the board's presence room is open: the strip draws. */
const BOARD_UP = `!!document.querySelector('#board-people')`;

async function main(): Promise<void> {
  deadline('point-follow-driver', 200_000);
  const board = await bootBoard('point-follow');
  const { base, ws } = board;
  const B = `/workspaces/${ws}`;
  const steps: Step[] = [];
  try {
    for (const [width, height] of SIZES) {
      step(`agent at ${width}`);
      const firstPerson = await openPerson(width, height, {
        anonId: `first-person${width}`,
        name: 'Alice',
        ws,
        follow: 'a-agent-house-lead',
      });
      const sessions = await frameSessions(firstPerson);
      // The agent's last place, from the size before, was the review queue,
      // which a new follower would leave the board for: put it back first.
      await board.point({ path: 'tasks' });
      await navigate(firstPerson, `${base}${B}`);
      await until('the board', async () => ((await firstPerson.evaluate(BOARD_UP)) ? true : null));
      // A first point on the loaded board, so every step below starts from
      // a follow already shown once.
      await board.point({ path: 'activity' });
      await until('the first point', async () =>
        (await firstPerson.evaluate(ADDRESS)) === `${B}/activity` ? true : null,
      );
      await firstPerson.evaluate(MARK);

      const run = async (
        what: string,
        place: Record<string, unknown> | null,
        expected: string,
        placed?: () => Promise<boolean>,
        move?: () => Promise<void>,
        follower: Cdp = firstPerson,
      ): Promise<void> => {
        const t0 = Date.now();
        if (place) await board.point(place);
        else await move?.();
        const address = await until(`${what} lands at ${expected}`, async () => {
          const at = (await follower.evaluate(ADDRESS).catch(() => null)) as string | null;
          return at === expected ? at : null;
        });
        const onPlace = placed
          ? await until(`${what} on screen`, async () => ((await placed()) ? true : null)).catch(
              () => false,
            )
          : true;
        const ms = Date.now() - t0;
        const inPlace = (await follower.evaluate(STAYED).catch(() => false)) === true;
        steps.push({ width, what, expected, address, inPlace, placed: onPlace, ms });
        await follower.evaluate(MARK).catch(() => {});
      };

      const enc = (v: string) => encodeURIComponent(v);
      await run('agent home', { path: 'home' }, `${B}/home`);
      await run(
        'agent review item',
        { path: `home?item=${board.itemKey}` },
        `${B}/home?item=${enc(board.itemKey)}`,
      );
      await run('agent task panel', { taskId: board.taskId }, `${B}?task=${board.taskId}`);
      await run(
        'agent task thread',
        { taskId: board.taskId, threadId: 'th-tides' },
        `${B}?task=${board.taskId}&thread=th-tides`,
      );
      if (board.goalId)
        await run('agent goal panel', { goalId: board.goalId }, `${B}?goal=${board.goalId}`);
      await run('agent library', { path: 'library' }, `${B}/library`);
      await run('agent activity', { path: 'activity' }, `${B}/activity`);
      await run(
        'agent doc phrase',
        { docId: board.docId, quote: DOC_PHRASE },
        `${B}/docs/${board.docId}`,
        async () => {
          const v = (await firstPerson.evaluate(docView(DOC_PHRASE))) as {
            centred: boolean;
          } | null;
          return v?.centred === true;
        },
      );
      await run(
        'agent doc scroll',
        { docId: board.docId, scroll: 0 },
        `${B}/docs/${board.docId}`,
        async () => {
          const v = (await firstPerson.evaluate(docView(DOC_PHRASE))) as { scroll: number } | null;
          return v !== null && v.scroll < 0.05;
        },
      );
      const frame = frameSurface(firstPerson, sessions, `!!document.getElementById('ferry')`);
      await run(
        'agent mock phrase',
        { docId: board.mockId, quote: MOCK_PHRASE },
        `${B}/mockups/${board.mockId}`,
        async () => {
          const r = (await frame.eval(
            `(() => { const e = document.getElementById('ferry'); if (!e || !scrollY) return false; const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })()`,
          )) as boolean | null;
          return r === true;
        },
      );
      await run('agent board from a mock', { path: 'tasks' }, B);
      await run('agent review queue', { path: '/review' }, '/review');
      // A page the agent's spot already names must not load itself again.
      await run('agent review queue holds still', null, '/review', undefined, () =>
        Bun.sleep(1000),
      );

      step(`person at ${width}`);
      const secondPerson = await openPerson(width, height, {
        anonId: `second-person${width}`,
        name: 'Bob',
        ws,
      });
      await navigate(secondPerson, `${base}${B}`);
      await until('secondPerson on the board', async () =>
        (await secondPerson.evaluate(BOARD_UP)) ? true : null,
      );
      // Alice follows Bob from the board.
      await firstPerson.evaluate(
        `sessionStorage.setItem('cw-follow:${ws}', JSON.stringify({ key: 'p-anon-second-person${width}' }))`,
      );
      await navigate(firstPerson, `${base}${B}`);
      await until('the board', async () => ((await firstPerson.evaluate(BOARD_UP)) ? true : null));
      await firstPerson.evaluate(MARK);
      /** Bob moves in the board the way Back and Forward do. */
      const secondPersonGoes = (path: string) => async () => {
        await secondPerson.evaluate(
          `history.pushState(null, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`,
        );
      };
      await run(
        'person task panel',
        null,
        `${B}?task=${board.taskId}`,
        undefined,
        secondPersonGoes(`${B}?task=${board.taskId}`),
      );
      await run(
        'person library',
        null,
        `${B}/library`,
        undefined,
        secondPersonGoes(`${B}/library`),
      );
      await run('person doc', null, `${B}/docs/${board.docId}`, undefined, async () => {
        await navigate(secondPerson, `${base}${B}/docs/${board.docId}`);
      });
      await run(
        'person doc scroll',
        null,
        `${B}/docs/${board.docId}`,
        async () => {
          const v = (await firstPerson.evaluate(docView(DOC_PHRASE))) as {
            centred: boolean;
          } | null;
          return v?.centred === true;
        },
        async () => {
          await until('secondPerson doc up', async () =>
            (await secondPerson.evaluate(docView(DOC_PHRASE))) ? true : null,
          );
          await secondPerson.evaluate(
            `[...document.querySelectorAll('#editor p')].find((e) => e.textContent.includes(${JSON.stringify(DOC_PHRASE)})).scrollIntoView({ block: 'center' })`,
          );
        },
      );
      secondPerson.close();
      firstPerson.close();
    }
    const run: PointFollowRun = { workspaceId: ws, steps };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
  }
}

await main();
process.exit(0);
