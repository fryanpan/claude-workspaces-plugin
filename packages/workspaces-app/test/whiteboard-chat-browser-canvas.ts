/**
 * The whiteboard chat driver's page helpers, and its check that Excalidraw
 * keeps its keys, pointer and room with the chat on the page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { type Board, closePerson, navigate, openPerson, tap, until } from './follow-browser-kit.ts';
import { CANVAS, CHAT, READY, TOOL } from './whiteboard-chat-browser-probes.ts';
import type { CanvasCase, CanvasRead, ChatRead } from './whiteboard-chat-browser-reading.ts';

export type Point = { x: number; y: number };
const AGENT_BUTTON = 8_000;

const shots = process.env.WHITEBOARD_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
export async function shot(cdp: Cdp, name: string): Promise<void> {
  if (!shots) return;
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

export const read = <T>(cdp: Cdp, expr: string): Promise<T> => cdp.evaluate(expr) as Promise<T>;

export async function openWhiteboard(cdp: Cdp, url: string): Promise<void> {
  await navigate(cdp, url);
  await until('the canvas', async () => ((await read<boolean>(cdp, READY)) ? true : null), 40_000);
}

/** The agent button's centre, or null on a page that draws none. */
export const agentButton = (cdp: Cdp) =>
  until(
    'the agent button',
    async () => (await read<ChatRead>(cdp, CHAT)).button,
    AGENT_BUTTON,
  ).catch(() => null);

/** The page's chat with its button drawn, read after one tap on it. */
export async function chatAfterTap(cdp: Cdp): Promise<ChatRead> {
  const at = await agentButton(cdp);
  if (!at) return read<ChatRead>(cdp, CHAT);
  await tap(cdp, at);
  return until('the chat open and listening', async () => {
    const chat = await read<ChatRead>(cdp, CHAT);
    return chat.pane && chat.listening ? chat : null;
  }).catch(() => read<ChatRead>(cdp, CHAT));
}

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
export async function canvasStill(
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
  const url = `${board.base}/workspaces/${board.ws}/whiteboards/${whiteboard}`;
  await openWhiteboard(tab, url);
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
  await openWhiteboard(voiceTab, url);
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
  const wideDock = width > 1100 ? await draggedDock(board, width, height, url) : null;
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
    wideDock,
  };
}

/** The chat dragged as wide as it goes, which turns Excalidraw's own layout
 *  into its phone one on a screen that is not a phone. */
async function draggedDock(
  board: Board,
  width: number,
  height: number,
  url: string,
): Promise<CanvasRead> {
  const tab = await openPerson(width, height, {
    anonId: `canvas-dock${width}`,
    name: 'Alice',
    ws: board.ws,
  });
  await openWhiteboard(tab, url);
  await tab.evaluate(`localStorage.setItem('cw.lead-chat.width', '720')`);
  await openWhiteboard(tab, url);
  await chatAfterTap(tab);
  const canvas = await until(
    'Excalidraw in its phone layout',
    async () => {
      const c = await read<CanvasRead>(tab, CANVAS);
      return c.phoneLayout ? c : null;
    },
    5_000,
  ).catch(() => read<CanvasRead>(tab, CANVAS));
  await shot(tab, `dragged-dock-${width}`);
  await closePerson(tab);
  return canvas;
}
