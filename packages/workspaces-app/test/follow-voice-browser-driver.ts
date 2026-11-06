#!/usr/bin/env bun
/**
 * What a voice message tells the lead about where it was said, and whether
 * a spoken answer survives a follow moving the page, in headless Chromium
 * against a real server and the real bundles, at 1180x820 and 430x932.
 *
 *  - Context: a question said on a board tab, on a task panel, and in a doc
 *    scrolled to a section. The lead's `voice.request` names the page (its
 *    link carries the tab and the `?task=`) and, in a doc, the section on
 *    screen.
 *  - Handover: a tab following the lead asks a question on the board; before
 *    the lead answers, it points at a doc, so the tab loads the doc. The
 *    answer is then said on the doc page's own voice socket.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener the driver speaks through.
 *
 * Spawned by `follow-voice-browser.test.ts`, which reads the JSON it prints.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { frameSessions, frameSurface } from '../../widget/test/frame-driver-kit.ts';
import {
  ADDRESS,
  type Board,
  DOC_PHRASE,
  LEAD,
  SIZES,
  bootBoard,
  deadline,
  navigate,
  openPerson,
  shutdown,
  tap,
  until,
} from './follow-browser-kit.ts';

export interface ContextCase {
  width: number;
  where: string;
  /** The page's own address when the question was said. */
  address: string;
  link: string | null;
  surface: string | null;
  /** The thread on the task that was opened for 'task thread'. */
  threadId: string;
  visibleHeading: string | null;
}

export interface HandoverCase {
  width: number;
  /** The address the follow moved the tab to before the answer. */
  movedTo: string;
  /** What the answer route said: whether the answer reached a page. */
  delivered: boolean;
  /** Whether the answer arrived on a voice socket the new page opened. */
  heardOnNewPage: boolean;
  /** Whether the new page needed a tap to listen again. */
  tapped: boolean;
}

export interface FollowVoiceRun {
  workspaceId: string;
  docId: string;
  taskId: string;
  goalId: string;
  mockId: string;
  contexts: ContextCase[];
  handovers: HandoverCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[follow-voice-driver] ${what}\n`);
};

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

const LISTENING = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  return !!b && b.dataset.listening === 'true';
})()`;

/** Puts a heading of the doc in the middle of its scroller. */
const centre = (heading: string) => `(() => {
  const el = [...document.querySelectorAll('#editor h2')].find((e) => e.textContent.trim() === ${JSON.stringify(heading)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  return true;
})()`;

/** The voice sockets a tab opened, and the text frames each received. */
interface Sockets {
  /** requestId → the order it was opened in. */
  opened: Map<string, number>;
  received: Array<{ socket: number; data: string }>;
}

function watchSockets(cdp: Cdp): Sockets {
  const s: Sockets = { opened: new Map(), received: [] };
  cdp.on('Network.webSocketCreated', (p) => {
    const e = p as unknown as { requestId: string; url: string };
    if (e.url.includes('/voice/converse')) s.opened.set(e.requestId, s.opened.size);
  });
  cdp.on('Network.webSocketFrameReceived', (p) => {
    const e = p as unknown as {
      requestId: string;
      response: { opcode: number; payloadData: string };
    };
    const socket = s.opened.get(e.requestId);
    if (socket !== undefined && e.response.opcode === 1) {
      s.received.push({ socket, data: e.response.payloadData });
    }
  });
  return s;
}

/**
 * Listening on the page now loaded, and a listener the server opened for it
 * since `since`. Taps the agent button only if voice did not come back by
 * itself; returns whether it had to.
 */
async function listen(board: Board, cdp: Cdp, since: number): Promise<boolean> {
  const btn = await until(
    'the agent button',
    async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
  );
  let tapped = false;
  const back = await until(
    'voice back by itself',
    async () => ((await cdp.evaluate(LISTENING)) && board.opened.length > since ? true : null),
    3000,
  ).catch(() => false);
  if (!back) {
    tapped = true;
    await tap(cdp, btn);
    await until('listening', async () => ((await cdp.evaluate(LISTENING)) ? true : null));
  }
  await until('the listener opened', () => (board.opened.length > since ? true : null));
  return tapped;
}

/** Says `text` through the newest listener and returns what the lead heard. */
async function say(board: Board, text: string) {
  // Again each couple of seconds: a listener that has only just opened can
  // miss a turn, which is the fake listener's timing and not what this tests.
  let last = 0;
  return until('the lead heard it', () => {
    if (Date.now() - last > 2000) {
      last = Date.now();
      board.opened.at(-1)?.onTurn({ turn: 0, text, final: true });
    }
    return board.lead.voice.find((v) => v.transcript === text) ?? null;
  });
}

async function main(): Promise<void> {
  deadline('follow-voice-driver', 200_000);
  const board = await bootBoard('follow-voice');
  const { base, ws } = board;
  const B = `/workspaces/${ws}`;
  const contexts: ContextCase[] = [];
  const handovers: HandoverCase[] = [];
  try {
    for (const [width, height] of SIZES) {
      step(`context at ${width}`);
      const firstPerson = await openPerson(width, height, {
        anonId: `first-person-voice${width}`,
        name: 'Alice',
        ws,
        voice: true,
      });
      await firstPerson.send('Network.enable');
      const sessions = await frameSessions(firstPerson);
      const taskThread = (
        await board.post(`${B}/docs/task:${board.taskId}/threads`, {
          author: { id: LEAD.agentId, name: LEAD.agentName, kind: 'agent' },
          text: `Are the tides right, at ${width}?`,
          anchor: { kind: 'subject' },
        })
      ).thread as { id: string };
      const places = [
        ['board tab', `${B}/library`],
        ['task panel', `${B}?task=${board.taskId}`],
        ['task activity tab', `${B}?task=${board.taskId}&tab=activity`],
        ['task thread', `${B}?task=${board.taskId}&thread=${taskThread.id}`],
        ['goal panel', `${B}?goal=${board.goalId}`],
        ['settings pane', `${B}?settings=notifications`],
        ['library list', `${B}/library?list=files`],
        ['doc section', `${B}/docs/${board.docId}`],
        ['mock section', `${B}/mockups/${board.mockId}`],
      ] as const;
      for (const [where, path] of places) {
        const since = board.opened.length;
        await navigate(firstPerson, `${base}${path}`);
        await listen(board, firstPerson, since);
        if (where === 'doc section') {
          // The doc reads its section when the scroll settles, in the same
          // callback that moves this person's spot: wait for the spot. A
          // scroll made while the doc is still drawing can be undone by it,
          // so centre the heading again until the spot shows it held.
          let last = 0;
          await until('the scroll read', async () => {
            const spot = board.spotOf(`anon-first-person-voice${width}`);
            if (spot?.docId === board.docId && (spot.scroll ?? 0) > 0.1) return true;
            if (Date.now() - last > 500) {
              last = Date.now();
              await firstPerson.evaluate(centre('Tides'));
            }
            return null;
          });
        }
        if (where === 'mock section') {
          const frame = frameSurface(firstPerson, sessions, `!!document.getElementById('ferry')`);
          await until('the frame said where', async () => {
            await frame.eval(`document.getElementById('ferry').scrollIntoView({ block: 'start' })`);
            const spot = board.spotOf(`anon-first-person-voice${width}`);
            return spot?.docId === board.mockId && (spot.scroll ?? 0) > 0.1 ? true : null;
          });
        }
        const address = (await firstPerson.evaluate(ADDRESS)) as string;
        const heard = await say(board, `What is here, from the ${where} at ${width}?`);
        contexts.push({
          width,
          where,
          address,
          link: heard.context?.link ?? null,
          surface: heard.context?.surface ?? null,
          threadId: taskThread.id,
          visibleHeading: heard.context?.visibleHeading ?? null,
        });
      }
      firstPerson.close();

      step(`handover at ${width}`);
      await board.point({ path: 'library' });
      const secondPerson = await openPerson(width, height, {
        anonId: `second-person-voice${width}`,
        name: 'Bob',
        ws,
        voice: true,
        follow: 'a-agent-house-lead',
      });
      const sockets = watchSockets(secondPerson);
      await secondPerson.send('Network.enable');
      const since = board.opened.length;
      await navigate(secondPerson, `${base}${B}/library`);
      await listen(board, secondPerson, since);
      const asked = await say(board, `Is the Riverbend ferry running, at ${width}?`);
      const firstSocket = Math.max(...sockets.opened.values());
      const beforeMove = board.opened.length;
      const moved = `${B}/docs/${board.docId}`;
      await board.point({ docId: board.docId, quote: DOC_PHRASE });
      await until('the follow moved the tab', async () =>
        (await secondPerson.evaluate(ADDRESS).catch(() => null)) === moved ? true : null,
      );
      const tapped = await listen(board, secondPerson, beforeMove);
      const text = `It runs at noon, at ${width}.`;
      const res = await board.post(`/workspaces/${ws}/voice-queue/${asked.queueId}/answer`, {
        agentId: LEAD.agentId,
        text,
      });
      const heardOnNewPage = await until('the answer on the new page', () =>
        sockets.received.some(
          (f) =>
            f.socket > firstSocket && f.data.includes('"lead-answer"') && f.data.includes(text),
        )
          ? true
          : null,
      ).catch(() => false);
      handovers.push({
        width,
        movedTo: moved,
        delivered: res.delivered === true,
        heardOnNewPage,
        tapped,
      });
      secondPerson.close();
    }
    const run: FollowVoiceRun = {
      workspaceId: ws,
      docId: board.docId,
      taskId: board.taskId,
      goalId: board.goalId,
      mockId: board.mockId,
      contexts,
      handovers,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
  }
}

await main();
process.exit(0);
