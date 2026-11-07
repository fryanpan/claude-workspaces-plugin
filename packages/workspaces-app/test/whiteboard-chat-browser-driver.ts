#!/usr/bin/env bun
/**
 * The chat with the lead on a whiteboard, in headless Chromium against a real
 * server and the real bundles, at 1180x820 and 430x932.
 *
 *  - The bar, the chat and the voice control are read off a doc page and off
 *    a whiteboard, so the two are compared rather than each checked against
 *    a list written here.
 *  - A person moves from a doc to a whiteboard the lead is pointing at, and
 *    the lead's chip has to be there; then the lead points again with the
 *    whiteboard open.
 *  - A person talking to the lead, on a doc and on Home, taps a whiteboard
 *    link in the lead's spoken answer. Nothing here assumes why that link
 *    was reported not to open: the run records where the tap went, what the
 *    new page shows on top, and whether listening came back.
 *  - Excalidraw keeps its keys, pointer and room with the chat mounted.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener the driver speaks through.
 *
 * Spawned by `whiteboard-chat-browser.test.ts`, which reads the JSON it
 * prints. `WHITEBOARD_SHOTS=<dir>` also writes a screenshot of each stage.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
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
  CANVAS,
  CHAT,
  LINK,
  LISTENING,
  PAGE,
  READY,
  TOOL,
  VOICE_WORDS,
  chipTitle,
} from './whiteboard-chat-browser-probes.ts';
import type {
  ArrivalCase,
  CanvasCase,
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

const AGENT_BUTTON = 8_000;
const shots = process.env.WHITEBOARD_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
async function shot(cdp: Cdp, name: string): Promise<void> {
  if (!shots) return;
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

const read = <T>(cdp: Cdp, expr: string): Promise<T> => cdp.evaluate(expr) as Promise<T>;

async function openWhiteboard(cdp: Cdp, url: string): Promise<void> {
  await navigate(cdp, url);
  await until('the canvas', async () => ((await read<boolean>(cdp, READY)) ? true : null), 40_000);
}

/** The agent button's centre, or null on a page that draws none. */
const agentButton = (cdp: Cdp) =>
  until(
    'the agent button',
    async () => (await read<ChatRead>(cdp, CHAT)).button,
    AGENT_BUTTON,
  ).catch(() => null);

/** The page's chat with its button drawn, read after one tap on it. */
async function chatAfterTap(cdp: Cdp): Promise<ChatRead> {
  const at = await agentButton(cdp);
  if (!at) return read<ChatRead>(cdp, CHAT);
  await tap(cdp, at);
  return until('the chat open and listening', async () => {
    const chat = await read<ChatRead>(cdp, CHAT);
    return chat.pane && chat.listening ? chat : null;
  }).catch(() => read<ChatRead>(cdp, CHAT));
}

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
): Promise<Pick<SizeRun, 'docPage' | 'whiteboardPage' | 'docChat' | 'whiteboardChat'>> {
  const B = `/workspaces/${board.ws}`;
  const openFresh = () =>
    openPerson(width, height, { anonId: `compare${width}`, name: 'Alice', ws: board.ws });
  const docTab = await openFresh();
  await navigate(docTab, `${board.base}${B}/docs/${board.docId}`);
  await agentButton(docTab);
  const docPage = await read<PageRead>(docTab, PAGE);
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
  return { docPage, whiteboardPage, docChat, whiteboardChat };
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
  await board.post(`/workspaces/${board.ws}/voice-queue/${heard.queueId}/answer`, {
    agentId: LEAD.agentId,
    text: `It is on [Ferry flow](${board.base}${target}).`,
  });
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

type Point = { x: number; y: number };
type LinkPoint = Point & { href: string; target: string | null };
type CanvasRead = CanvasCase['closed'];

const key = async (cdp: Cdp, k: string, code: string): Promise<void> => {
  for (const type of ['keyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: k,
      code,
      ...(type === 'keyDown' ? { text: k } : {}),
    });
  }
};

async function drag(cdp: Cdp, from: Point, to: Point): Promise<void> {
  const send = (type: string, at: Point, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left',
      buttons,
      clickCount: 1,
    });
  await send('mouseMoved', from, 0);
  await send('mousePressed', from, 1);
  await send('mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 1);
  await send('mouseMoved', to, 1);
  await send('mouseReleased', to, 0);
}

/** Excalidraw's keys, pointer and room with the chat on the page. */
async function canvasStill(
  board: Board,
  width: number,
  height: number,
  whiteboard: string,
): Promise<CanvasCase> {
  const tab = await openPerson(width, height, {
    anonId: `canvas${width}`,
    name: 'Alice',
    ws: board.ws,
  });
  await openWhiteboard(tab, `${board.base}/workspaces/${board.ws}/whiteboards/${whiteboard}`);
  await agentButton(tab);
  const elements = () => tab.evaluate(`Number(document.body.dataset.elements || '0')`);
  const start = (await elements()) as number;
  const cx = width / 2;
  const cy = height / 2;
  await tap(tab, { x: cx, y: cy });
  await key(tab, 'r', 'KeyR');
  const toolAfterKey = await until(
    'the shortcut',
    async () => {
      const t = await read<string | null>(tab, TOOL);
      return t === 'rectangle' ? t : null;
    },
    5_000,
  ).catch(() => read<string | null>(tab, TOOL));
  await drag(tab, { x: cx - 40, y: cy - 40 }, { x: cx + 40, y: cy + 40 });
  const drew = await until(
    'the rectangle',
    async () => {
      const n = (await elements()) as number;
      return n > start ? n - start : null;
    },
    5_000,
  ).catch(() => 0);
  const closed = await read<CanvasRead>(tab, CANVAS);
  await shot(tab, `canvas-${width}`);

  const chat = await chatAfterTap(tab);
  await until(
    'the composer focused',
    async () =>
      (await tab.evaluate(
        `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot?.activeElement?.tagName === 'TEXTAREA'`,
      ))
        ? true
        : null,
    5_000,
  ).catch(() => null);
  const toolBeforeTyping = await read<string | null>(tab, TOOL);
  const typed = 'reed';
  for (const c of typed) await key(tab, c, `Key${c.toUpperCase()}`);
  const composer = await until(
    'the composer text',
    async () => {
      const v = (await tab.evaluate(
        `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot?.querySelector('textarea')?.value ?? ''`,
      )) as string;
      return v === typed ? v : null;
    },
    3_000,
  ).catch(() => '');
  const toolAfterTyping = await read<string | null>(tab, TOOL);
  const open = await until(
    'the canvas fitted beside the chat',
    async () => {
      const c = await read<CanvasRead>(tab, CANVAS);
      return !chat.pane || c.canvasFits ? c : null;
    },
    3_000,
  ).catch(() => read<CanvasRead>(tab, CANVAS));
  await shot(tab, `canvas-chat-${width}`);
  const elementsWhileTyping = ((await elements()) as number) - start - drew;
  await closePerson(tab);

  const voiceTab = await openPerson(width, height, {
    anonId: `canvas-voice${width}`,
    name: 'Alice',
    ws: board.ws,
    voice: true,
  });
  await openWhiteboard(voiceTab, `${board.base}/workspaces/${board.ws}/whiteboards/${whiteboard}`);
  const voiceAt = await agentButton(voiceTab);
  if (voiceAt) await tap(voiceTab, voiceAt);
  const shown = await until(
    'the voice bar',
    async () => ((await read<ChatRead>(voiceTab, CHAT)).bar ? true : null),
    5_000,
  ).catch(() => false);
  const voiceBar = { shown, canvas: await read<CanvasRead>(voiceTab, CANVAS) };
  await shot(voiceTab, `voice-bar-${width}`);
  await closePerson(voiceTab);
  return {
    toolAfterKey,
    drew,
    closed,
    chatOpen: chat.pane,
    composer,
    toolBeforeTyping,
    toolAfterTyping,
    elementsWhileTyping,
    open,
    voiceBar,
  };
}

async function main(): Promise<void> {
  deadline('whiteboard-chat', 280_000);
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
      sizes.push({ width, ...pages, presence: moved, live, links, canvas });
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
