#!/usr/bin/env bun
import {
  ADDRESS,
  type Board,
  LEAD,
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  navigate,
  openPerson,
  shutdown,
  tap,
  until,
} from './follow-browser-kit.ts';
import {
  type Point,
  agentButton,
  canvasStill,
  chatAfterTap,
  leaveByNav,
  liveDraw,
  openWhiteboard,
  read,
  shot,
} from './whiteboard-chat-browser-canvas.ts';
import {
  CANVAS,
  CHAT,
  LINK,
  LISTENING,
  PAGE,
  READY,
  VOICE_BUBBLES,
  VOICE_WORDS,
  chipTitle,
} from './whiteboard-chat-browser-probes.ts';
import type {
  ArrivalCase,
  CanvasRead,
  ChatRead,
  LinkCase,
  LiveCase,
  PageRead,
  PresenceCase,
  SizeRun,
  WhiteboardChatRun,
} from './whiteboard-chat-browser-reading.ts';

const step = (what: string): void => {
  process.stderr.write(`[whiteboard-chat] ${what}\n`);
};

/** Says `text` through the newest listener; returns what the lead heard. */
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

async function comparePages(
  board: Board,
  width: number,
  height: number,
  whiteboard: string,
): Promise<
  Pick<SizeRun, 'mockPage' | 'docPage' | 'whiteboardPage' | 'docChat' | 'whiteboardChat'>
> {
  const B = `/workspaces/${board.ws}`;
  const openFresh = () =>
    openPerson(width, height, { anonId: `compare${width}`, name: 'Alice', ws: board.ws });
  const mockTab = await openFresh();
  await navigate(mockTab, `${board.base}${B}/mockups/${board.mockId}`);
  await agentButton(mockTab);
  const mockPage = await read<PageRead>(mockTab, PAGE);
  await shot(mockTab, `mock-${width}`);
  await closePerson(mockTab);

  const docTab = await openFresh();
  await navigate(docTab, `${board.base}${B}/docs/${board.docId}`);
  await agentButton(docTab);
  // The shell's arrow says "/" until the doc's meta lands (`applyBackLink`),
  // which the chat's mount does not wait for.
  const docPage = await until('the doc page’s arrow on its board', async () => {
    const page = await read<PageRead>(docTab, PAGE);
    return page.bar?.back === B ? page : null;
  });
  await shot(docTab, `doc-${width}`);
  const docChat = await chatAfterTap(docTab);
  await closePerson(docTab);

  const boardTab = await openFresh();
  await openWhiteboard(boardTab, `${board.base}${B}/whiteboards/${whiteboard}`);
  await agentButton(boardTab);
  const whiteboardPage = await read<PageRead>(boardTab, PAGE);
  await shot(boardTab, `whiteboard-${width}`);
  const whiteboardChat = await chatAfterTap(boardTab);
  await shot(boardTab, `whiteboard-chat-${width}`);
  await closePerson(boardTab);
  return { mockPage, docPage, whiteboardPage, docChat, whiteboardChat };
}

/** The lead's chip reaching a person who moves here, and a tab already here. */
async function presence(
  board: Board,
  width: number,
  height: number,
  whiteboard: string,
): Promise<PresenceCase> {
  const B = `/workspaces/${board.ws}`;
  const anonId = `mover${width}`;
  const tab = await openPerson(width, height, { anonId, name: 'Alice', ws: board.ws });
  const lead = `${LEAD.agentName} · pointing in ${whiteboard}`;
  await board.point({ docId: board.docId });
  await navigate(tab, `${board.base}${B}/docs/${board.docId}`);
  await until('the person on the doc', () =>
    board.spotOf(`anon-${anonId}`)?.docId === board.docId ? true : null,
  );
  await board.point({ docId: whiteboard, x: 400, y: 300 });
  const moved = navigate(tab, `${board.base}${B}/whiteboards/${whiteboard}`);
  await until('the person on the whiteboard', () =>
    board.spotOf(`anon-${anonId}`)?.docId === whiteboard ? true : null,
  );
  const arrived = Date.now();
  await until(
    'the lead on the arrival',
    async () => ((await read<string | null>(tab, chipTitle)) === lead ? true : null),
    10_000,
  );
  const arrivalMs = Date.now() - arrived;
  await moved;
  await read(tab, READY);

  await board.point({ docId: board.docId });
  const away = `${LEAD.agentName} · pointing in ${board.docId}`;
  await until('the lead away', async () =>
    (await read<string | null>(tab, chipTitle)) === away ? true : null,
  );
  const pointed = Date.now();
  await board.point({ docId: whiteboard, x: 500, y: 300 });
  await until(
    'the lead back',
    async () => ((await read<string | null>(tab, chipTitle)) === lead ? true : null),
    10_000,
  );
  const liveMs = Date.now() - pointed;
  await closePerson(tab);
  return { arrivalMs, liveMs };
}

/** A question said on a whiteboard, and the answer reaching the open page. */
async function liveChat(
  board: Board,
  width: number,
  height: number,
  whiteboard: string,
): Promise<LiveCase> {
  const path = `/workspaces/${board.ws}/whiteboards/${whiteboard}`;
  const tab = await openPerson(width, height, {
    anonId: `live${width}`,
    name: 'Alice',
    ws: board.ws,
  });
  await openWhiteboard(tab, `${board.base}${path}`);
  const none: LiveCase = { link: null, surface: null, docId: null, answerShown: false };
  const since = board.opened.length;
  const chat = await chatAfterTap(tab);
  if (!chat.listening) {
    await closePerson(tab);
    return none;
  }
  await until('the listener opened', () => (board.opened.length > since ? true : null));
  await tab.evaluate('window.__stillThisPage = true');
  const text = `Is the Riverbend crossing on the board, at ${width}?`;
  const heard = await say(board, text);
  const answer = `Yes, it is drawn, at ${width}.`;
  await board.post(`/workspaces/${board.ws}/voice-queue/${heard.queueId}/answer`, {
    agentId: LEAD.agentId,
    text: answer,
  });
  const answerShown = await until('the answer in the open chat', async () => {
    const shown = await read<ChatRead>(tab, CHAT);
    return shown.voiceBubbles > 0 && (await tab.evaluate('window.__stillThisPage === true'))
      ? true
      : null;
  }).catch(() => false);
  await closePerson(tab);
  return {
    link: heard.context?.link ?? null,
    surface: heard.context?.surface ?? null,
    docId: heard.context?.docId ?? null,
    answerShown,
  };
}

/** A whiteboard link tapped in a spoken answer, voice on, from `start`. */
async function tapLink(
  board: Board,
  width: number,
  height: number,
  whiteboard: string,
  start: 'doc' | 'home',
): Promise<LinkCase> {
  const B = `/workspaces/${board.ws}`;
  const target = `${B}/whiteboards/${whiteboard}`;
  const tab = await openPerson(width, height, {
    anonId: `link-${start}${width}`,
    name: 'Alice',
    ws: board.ws,
  });
  await navigate(tab, `${board.base}${B}${start === 'doc' ? `/docs/${board.docId}` : '/home'}`);
  let since = board.opened.length;
  const opened = await chatAfterTap(tab);
  if (!opened.listening) throw new Error(`voice never started on ${start}`);
  await until('the listener opened', () => (board.opened.length > since ? true : null));
  const heard = await say(board, `Where is the ferry drawn, from ${start} at ${width}?`);
  // The chat keeps earlier replies, so "the newest" is only this answer once
  // the count has moved. Read too soon, it is a reply with no link in it.
  const earlier = await read<number>(tab, VOICE_BUBBLES);
  await board.post(`/workspaces/${board.ws}/voice-queue/${heard.queueId}/answer`, {
    agentId: LEAD.agentId,
    text: `It is on [Ferry flow](${board.base}${target}).`,
  });
  await until('this answer’s bubble', async () =>
    (await read<number>(tab, VOICE_BUBBLES)) > earlier ? true : null,
  );
  const words = await until('the voice bubble', () => read<Point | null>(tab, VOICE_WORDS));
  await tap(tab, words);
  const link = await until('the link', () => read<LinkPoint | null>(tab, LINK));
  await shot(tab, `link-before-${start}-${width}`);
  const before = await read<ChatRead>(tab, CHAT);
  since = board.opened.length;
  const loaded = tab.once('Page.loadEventFired');
  await tap(tab, link);
  const left = await Promise.race([
    loaded.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 8_000)),
  ]);
  const address = (await read<string>(tab, ADDRESS)) as string;
  const ready = left
    ? await until(
        'the canvas',
        async () => ((await read<boolean>(tab, READY)) ? true : null),
        40_000,
      )
        .then(() => true)
        .catch(() => false)
    : false;
  // Voice comes back by itself on a browser that allows it, and takes a
  // listener the server opens for the new page.
  const listening = await until(
    'voice back',
    async () =>
      (await read<boolean>(tab, LISTENING)) && board.opened.length > since ? true : null,
    8_000,
  ).catch(() => false);
  const after = await read<ChatRead>(tab, CHAT);
  await shot(tab, `link-after-${start}-${width}`);
  const canvas = await read<CanvasRead>(tab, CANVAS);
  if (after.barAt) await tap(tab, after.barAt);
  const conversation = await until(
    'the conversation',
    async () => {
      const chat = await read<ChatRead>(tab, CHAT);
      return chat.pane && chat.messageIds.length > 0 ? chat : null;
    },
    5_000,
  ).catch(() => after);
  await closePerson(tab);
  return {
    start,
    href: link.href,
    target: link.target,
    address,
    expected: target,
    ready,
    listening,
    before,
    after,
    conversation,
    canvasCovered: canvas.centreCovered,
  };
}

type LinkPoint = Point & { href: string; target: string | null };

async function main(): Promise<void> {
  deadline('whiteboard-chat', 370_000);
  const board = await bootBoard('whiteboard-chat');
  const made = (await board.post(`/workspaces/${board.ws}/whiteboards`, {
    title: 'Ferry flow',
  })) as { url: string };
  const whiteboard = made.url.split('/').pop() ?? '';
  const sizes: SizeRun[] = [];
  try {
    for (const [width, height] of SIZES) {
      step(`compare at ${width}`);
      const pages = await comparePages(board, width, height, whiteboard);
      step(`presence at ${width}`);
      const moved = await presence(board, width, height, whiteboard).catch(
        (e): ArrivalCase => ({ error: String(e) }),
      );
      step(`live chat at ${width}`);
      const live = await liveChat(board, width, height, whiteboard);
      const links: LinkCase[] = [];
      for (const start of ['doc', 'home'] as const) {
        step(`link from ${start} at ${width}`);
        links.push(await tapLink(board, width, height, whiteboard, start));
      }
      step(`canvas at ${width}`);
      const canvas = await canvasStill(board, width, height, whiteboard);
      step(`live draw at ${width}`);
      const drawn = await liveDraw(board, width, height);
      const navLeave =
        width > 1100
          ? null
          : {
              whiteboard: await leaveByNav(
                board,
                width,
                height,
                `${board.base}/workspaces/${board.ws}/whiteboards/${whiteboard}`,
                'nav-whiteboard',
              ),
              mock: await leaveByNav(
                board,
                width,
                height,
                `${board.base}/workspaces/${board.ws}/mockups/${board.mockId}`,
                'nav-mock',
              ),
            };
      sizes.push({
        width,
        ...pages,
        presence: moved,
        live,
        links,
        canvas,
        liveDraw: drawn,
        navLeave,
      });
    }
    const run: WhiteboardChatRun = { workspaceId: board.ws, whiteboard, sizes };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
  }
}

await main();
process.exit(0);
