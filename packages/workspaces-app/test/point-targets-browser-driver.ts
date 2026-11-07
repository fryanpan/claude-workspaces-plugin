#!/usr/bin/env bun
/**
 * The places `point-follow-browser-driver.ts` does not reach: a thread and a
 * block in a doc, a thread and a scroll in a mock, an app, a diff, a folder
 * file, a whiteboard and the workspaces list, with a follow that carries on
 * from each. Then a person: a follower tracks the thread they open in a doc,
 * how far they scroll a board panel, and how far they scroll a mock.
 * Headless Chromium against a real server and the real bundles.
 *
 * Spawned by `point-targets-browser.test.ts`, which reads the JSON it prints.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameSessions, frameSurface } from '../../widget/test/frame-driver-kit.ts';
import {
  ADDRESS,
  DOC_PHRASE,
  MOCK_PHRASE,
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  docView,
  navigate,
  openPerson,
  shutdown,
  until,
} from './follow-browser-kit.ts';

export interface TargetStep {
  width: number;
  what: string;
  expected: string;
  address: string;
  /** The place on the page was on screen. */
  placed: boolean;
  /** From the move to the follower showing it. */
  ms: number;
}

export interface PointTargetsRun {
  workspaceId: string;
  steps: TargetStep[];
}

const step = (what: string): void => {
  process.stderr.write(`[point-targets-driver] ${what}\n`);
};

const BOARD_UP = `!!document.querySelector('#board-people')`;
/** A long enough file that a diff or a code page scrolls. */
const lines = (word: string) =>
  Array.from({ length: 400 }, (_, i) => `${word} line ${i + 1}`).join('\n');
const git = (repo: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=Alice', '-c', 'user.email=first-person@example.invalid', ...args],
    { encoding: 'utf8' },
  ).trim();

const threadOpen = (id: string) =>
  `!!document.querySelector(${JSON.stringify(`.thread.active[data-thread-id="${id}"]`)})`;
/** CodeMirror draws only the lines on screen, so a last line drawn means the
 *  file is scrolled to its end. */
const lastLineShown = (word: string) =>
  `!!document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(`${word} line 400`)})`;

/** Whatever scrolls the settings page, which differs by width. */
const SETTINGS_SCROLLER = `[...document.querySelectorAll('#board-settings-view, #board-settings-view *')].find((e) => e.scrollHeight - e.clientHeight > 40 && /auto|scroll/.test(getComputedStyle(e).overflowY))`;
const scrollSettings = `(() => { const e = ${SETTINGS_SCROLLER}; if (!e) return false; e.scrollTop = 30; return true; })()`;
const settingsScrolled = `(() => { const e = ${SETTINGS_SCROLLER}; return !!e && e.scrollTop > 0; })()`;

async function main(): Promise<void> {
  deadline('point-targets-driver', 200_000);
  const board = await bootBoard('point-targets');
  const { base, ws } = board;
  const B = `/workspaces/${ws}`;
  const dir = mkdtempSync(join(tmpdir(), 'point-targets-'));
  const dev = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response('<!doctype html><title>Riverbend</title><h1>Riverbend</h1>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  const steps: TargetStep[] = [];
  try {
    const author = { id: 'agent-house-lead', name: 'Harborlight', kind: 'agent' };
    const thread = async (docId: string, text: string, anchor: unknown) =>
      (
        (await board.post(`${B}/docs/${docId}/threads`, {
          author,
          text,
          anchor,
        })) as { thread?: { id: string }; id?: string }
      ).thread?.id ?? '';
    const docThread = await thread(board.docId, 'Is the Quay section right?', { kind: 'subject' });
    const mockThread = await thread(board.mockId, 'Is the timetable right?', {
      kind: 'element',
      fingerprint: {
        id: 'ferry',
        tag: 'h2',
        stableAttrs: {},
        classes: [],
        text: MOCK_PHRASE,
        path: '',
        dataAttrs: {},
      },
      snippet: { text: MOCK_PHRASE },
      context: { url: `${B}/mockups/${board.mockId}?cw-frame=1` },
    });

    const outline = await fetch(`${base}${B}/docs/${board.docId}/outline`);
    const { blocks } = (await outline.json()) as { blocks: Array<{ text: string; id: string }> };
    const lights = blocks.find((h) => h.text === 'Lights')?.id ?? '';

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'tide.txt'), 'first\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'first');
    const baseRef = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tide.txt'), `${lines('harbour')}\n`);
    const diff = (await board.post(`${B}/attachments`, { repo, base: baseRef })) as {
      files: Array<{ docId: string }>;
    };
    const diffDoc = diff.files[0]?.docId ?? '';
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), `${lines('mooring')}\n`);
    const browsed = (await board.post(`${B}/attachments`, { repo: folder })) as {
      files: Array<{ docId: string }>;
    };
    const folderDoc = browsed.files[0]?.docId ?? '';
    const whiteboard = (
      (await board.post(`${B}/whiteboards`, { title: 'Saltmarsh plan' })) as { docId: string }
    ).docId;
    const app = (
      (await board.post(`${B}/apps`, {
        docId: 'site-doc',
        origin: `http://127.0.0.1:${dev.port}/`,
        title: 'Riverbend site',
      })) as { docId: string }
    ).docId;

    for (const [width, height] of SIZES) {
      step(`agent at ${width}`);
      await board.point({ path: 'tasks' });
      const firstPerson = await openPerson(width, height, {
        anonId: `first-person-targets${width}`,
        name: 'Alice',
        ws,
        follow: 'a-agent-house-lead',
      });
      const sessions = await frameSessions(firstPerson);
      await navigate(firstPerson, `${base}${B}`);
      await until('the board', async () => ((await firstPerson.evaluate(BOARD_UP)) ? true : null));

      const moved = async (
        what: string,
        move: () => Promise<void>,
        expected: string,
        placed?: () => Promise<boolean>,
        tab = firstPerson,
      ): Promise<void> => {
        step(`${width} ${what}`);
        const t0 = Date.now();
        await move();
        const address = await until(`${what} lands at ${expected}`, async () => {
          const at = (await tab.evaluate(ADDRESS).catch(() => null)) as string | null;
          return at === expected ? at : null;
        }).catch(async () => `at ${await tab.evaluate(ADDRESS).catch(() => '?')}`);
        const onPlace = placed
          ? (await until(
              `${what} on screen`,
              async () => ((await placed()) ? true : null),
              8000,
            ).catch(() => false)) === true
          : true;
        steps.push({ width, what, expected, address, placed: onPlace, ms: Date.now() - t0 });
        step(`  ${JSON.stringify(steps.at(-1))}`);
      };
      const agent = (
        what: string,
        place: Record<string, unknown>,
        expected: string,
        placed?: () => Promise<boolean>,
      ) => moved(what, () => board.point(place), expected, placed);
      const frame = frameSurface(firstPerson, sessions, `!!document.getElementById('ferry')`);
      const onDoc = `${B}/docs/${board.docId}`;

      await agent('doc', { docId: board.docId }, onDoc);
      await agent(
        'doc thread',
        { docId: board.docId, threadId: docThread },
        onDoc,
        async () => (await firstPerson.evaluate(threadOpen(docThread))) === true,
      );
      await agent('doc block', { docId: board.docId, blockId: lights }, onDoc, async () => {
        const v = (await firstPerson.evaluate(docView('Lights'))) as { centred: boolean } | null;
        return v?.centred === true;
      });
      await agent('mock', { docId: board.mockId }, `${B}/mockups/${board.mockId}`);
      await agent(
        'mock scroll',
        { docId: board.mockId, scroll: 0.5 },
        `${B}/mockups/${board.mockId}`,
        async () => (await frame.eval('scrollY > 100')) === true,
      );
      await agent(
        'mock thread',
        { docId: board.mockId, threadId: mockThread },
        // `?thread=` is how the host page opens a thread in its frame; the
        // widget's own suites prove that link opens the pin.
        `${B}/mockups/${board.mockId}?thread=${mockThread}`,
      );
      await agent('app', { docId: app }, `${B}/apps/${app}/`);
      await agent('board after an app', { path: 'home' }, `${B}/home`);
      await agent(
        'diff',
        { docId: diffDoc, scroll: 1 },
        `${B}/docs/${encodeURIComponent(diffDoc)}`,
        async () => (await firstPerson.evaluate(lastLineShown('harbour'))) === true,
      );
      await agent(
        'folder file',
        { docId: folderDoc, scroll: 1 },
        `${B}/docs/${encodeURIComponent(folderDoc)}`,
        async () => (await firstPerson.evaluate(lastLineShown('mooring'))) === true,
      );
      await agent(
        'whiteboard',
        { docId: whiteboard, x: 400, y: 300 },
        `${B}/whiteboards/${whiteboard}`,
      );
      await agent('workspaces list', { path: '/' }, '/');
      await agent('board after the list', { taskId: board.taskId }, `${B}?task=${board.taskId}`);
      await until('board settled', async () =>
        (await firstPerson.evaluate(BOARD_UP)) ? true : null,
      );
      await agent('review queue', { path: '/review' }, '/review');
      await agent('board after the queue', { goalId: board.goalId }, `${B}?goal=${board.goalId}`);

      step(`person at ${width}`);
      await until('the panel loaded', async () =>
        (await firstPerson.evaluate(BOARD_UP)) ? true : null,
      );
      await board.point({ path: 'tasks' });
      await until('back on the board', async () =>
        (await firstPerson.evaluate(ADDRESS).catch(() => null)) === B ? true : null,
      );
      const secondPerson = await openPerson(width, height, {
        anonId: `second-person-targets${width}`,
        name: 'Bob',
        ws,
      });
      const secondPersonSessions = await frameSessions(secondPerson);
      await navigate(secondPerson, `${base}${onDoc}`);
      await firstPerson.evaluate(
        `sessionStorage.setItem('cw-follow:${ws}', JSON.stringify({ key: 'p-anon-second-person-targets${width}' }))`,
      );
      await navigate(firstPerson, `${base}${B}`);
      await until('the doc under secondPerson', async () =>
        (await secondPerson.evaluate(docView(DOC_PHRASE))) ? true : null,
      );
      await until('firstPerson followed secondPerson', async () =>
        (await firstPerson.evaluate(ADDRESS).catch(() => null))?.toString().startsWith(onDoc)
          ? true
          : null,
      );
      await moved(
        'person doc thread',
        async () => {
          await navigate(secondPerson, `${base}${onDoc}?thread=${docThread}`);
        },
        onDoc,
        async () => (await firstPerson.evaluate(threadOpen(docThread))) === true,
      );
      await moved(
        'person mock scroll',
        async () => {
          await navigate(secondPerson, `${base}${B}/mockups/${board.mockId}`);
          const inFrame = frameSurface(
            secondPerson,
            secondPersonSessions,
            `!!document.getElementById('ferry')`,
          );
          await until('secondPerson sees the mock', async () =>
            (await inFrame.eval('document.documentElement.scrollHeight > innerHeight')) === true
              ? true
              : null,
          );
          await inFrame.eval('scrollTo(0, 600)');
        },
        `${B}/mockups/${board.mockId}`,
        async () => (await frame.eval('scrollY > 100')) === true,
      );
      const onSettings = `${B}?settings=board`;
      await moved(
        'person board page',
        () => navigate(secondPerson, `${base}${onSettings}`),
        onSettings,
      );
      await moved(
        'person board scroll',
        async () => {
          await until('the settings page scrolls', async () =>
            (await secondPerson.evaluate(scrollSettings)) === true ? true : null,
          );
        },
        onSettings,
        async () => (await firstPerson.evaluate(settingsScrolled)) === true,
      );
      await closePerson(secondPerson);
      await closePerson(firstPerson);
    }
    process.stdout.write(
      `\n${JSON.stringify({ workspaceId: ws, steps } satisfies PointTargetsRun)}\n`,
    );
  } finally {
    dev.stop(true);
    rmSync(dir, { recursive: true, force: true });
    board.lead.close();
    await shutdown();
  }
}

await main();
process.exit(0);
