#!/usr/bin/env bun
/**
 * A mock's comment mode on the board's host page, beside the lead chat's
 * agent button, in headless Chromium against a real server and the real
 * bundles, at 320, 430, 768 and 1180 wide.
 *
 * Seen by the owner on a phone: the way out of comment mode sat under the
 * agent button, which the host page floats over the frame's bottom-left
 * corner, so a tap on it reached the agent instead. This measures every
 * control comment mode offers as a way out — the FAB's close glyph, the
 * prompt's Done, the composer's Cancel — and the agent button, all in the
 * host page's coordinates, and taps each way out at 430.
 *
 * Spawned by `comment-close-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { frameSessions, frameSurface } from '../../widget/test/frame-driver-kit.ts';
import {
  bootBoard,
  closePerson,
  deadline,
  navigate,
  openPerson,
  shutdown,
  tap,
  until,
} from './follow-browser-kit.ts';

export type Box = [number, number, number, number];

export interface ModeReading {
  /** Each way out on screen in this state, by name, in host coordinates. */
  exits: Record<string, Box | null>;
  /** The page's own hit test at each way out's centre lands on it. */
  onTop: Record<string, boolean>;
}

export interface WidthReading {
  width: number;
  height: number;
  agent: Box | null;
  /** The mode just opened: the prompt, nothing picked yet. */
  prompt: ModeReading;
  /** A row of the mock tapped: the composer is open about it. */
  composing: ModeReading;
  /** The agent button's box once the composer is up, to show it held still. */
  agentComposing: Box | null;
  /** At 430 only: the mode is off after tapping each way out. */
  exited?: Record<string, boolean>;
}

const step = (what: string): void => {
  process.stderr.write(`[comment-close-driver] ${what}\n`);
};

const AGENT = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && !host.hidden && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null;
})()`;

const W = `document.querySelector('claude-feedback-widget')`;
const S = `${W}.shadowRoot`;
/** The ways out, by name: the expression for each inside the frame. */
const EXITS: Record<string, string> = {
  fab: `${S}.querySelector('.fab')`,
  done: `${S}.querySelector('.picker-cancel')`,
  cancel: `${S}.querySelector('.composer .cancel')`,
};

const BOX = `(e) => {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') return null;
  return [r.left, r.top, r.right, r.bottom];
}`;

/** A mock tall enough to scroll, with rows a tap can comment on. */
export const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Saltmarsh</title>
<style>body{margin:0;font:15px/1.5 system-ui} p{margin:0;padding:12px 16px;border-bottom:1px solid #eee}</style>
</head><body>${Array.from({ length: 40 }, (_, i) => `<p id="row${i + 1}">Saltmarsh berth ${i + 1}</p>`).join('')}</body></html>`;

async function read(cdp: Cdp, frame: ReturnType<typeof frameSurface>): Promise<ModeReading> {
  const o = await frame.offset();
  const exits: Record<string, Box | null> = {};
  const onTop: Record<string, boolean> = {};
  for (const [name, expr] of Object.entries(EXITS)) {
    const b = (await frame.eval(`(${BOX})(${expr})`)) as Box | null;
    exits[name] = b
      ? ([b[0] + o.x, b[1] + o.y, b[2] + o.x, b[3] + o.y].map(Math.round) as Box)
      : null;
    if (!exits[name]) continue;
    const box = exits[name] as Box;
    const x = (box[0] + box[2]) / 2;
    const y = (box[1] + box[3]) / 2;
    // The host's hit test lands on the frame when nothing of the host's own
    // covers the point; the frame's then has to land on the way out itself.
    const host = (await cdp.evaluate(
      `document.elementFromPoint(${x}, ${y})?.matches('iframe[data-cw-mock-frame]') ?? false`,
    )) as boolean;
    const inFrame = (await frame.eval(
      `(() => { const t = ${expr}; const hit = ${S}.elementFromPoint(${x - o.x}, ${y - o.y}); return !!t && !!hit && (hit === t || t.contains(hit)); })()`,
    )) as boolean;
    onTop[name] = host && inFrame;
  }
  return { exits, onTop };
}

const modeOn = (frame: ReturnType<typeof frameSurface>) =>
  frame.eval(`${W}.feedbackMode === true`) as Promise<boolean>;

async function enterMode(cdp: Cdp, frame: ReturnType<typeof frameSurface>): Promise<void> {
  const fab = await until('the widget FAB', async () => {
    const b = (await frame.eval(`(${BOX})(${EXITS.fab})`)) as Box | null;
    return b ?? null;
  });
  const o = await frame.offset();
  await tap(cdp, { x: o.x + (fab[0] + fab[2]) / 2, y: o.y + (fab[1] + fab[3]) / 2 });
  await until('comment mode on', async () => ((await modeOn(frame)) ? true : null));
}

async function openComposer(cdp: Cdp, frame: ReturnType<typeof frameSurface>): Promise<void> {
  const o = await frame.offset();
  const row = (await frame.eval(`(${BOX})(document.getElementById('row2'))`)) as Box;
  await tap(cdp, { x: o.x + 40, y: o.y + (row[1] + row[3]) / 2 });
  await until('the composer', async () =>
    (await frame.eval(`!!${S}.querySelector('.composer')`)) ? true : null,
  );
}

async function main(): Promise<void> {
  deadline('comment-close-driver', 200_000);
  const board = await bootBoard('comment-close');
  const { base, ws } = board;
  const B = `/workspaces/${ws}`;
  const mockDir = mkdtempSync(join(tmpdir(), 'comment-close-mock-'));
  const file = join(mockDir, 'saltmarsh.html');
  writeFileSync(file, MOCK_HTML);
  const mockId = (
    await board.post(`${B}/docs`, { docId: 'saltmarsh', type: 'mockup', sourceUrl: file })
  ).docId as string;
  const readings: WidthReading[] = [];
  try {
    for (const [width, height] of [
      [320, 640],
      [430, 932],
      [768, 1024],
      [1180, 820],
    ] as const) {
      step(`at ${width}`);
      const cdp = await openPerson(width, height, { anonId: `close-${width}`, name: 'Alice', ws });
      const sessions = await frameSessions(cdp);
      await navigate(cdp, `${base}${B}/mockups/${mockId}`);
      const frame = frameSurface(cdp, sessions, `!!document.getElementById('row1')`);
      const agent = await until(
        'the agent button',
        async () => (await cdp.evaluate(AGENT)) as Box | null,
      );
      await enterMode(cdp, frame);
      const prompt = await read(cdp, frame);
      await openComposer(cdp, frame);
      const composing = await read(cdp, frame);
      const agentComposing = (await cdp.evaluate(AGENT)) as Box | null;
      const r: WidthReading = { width, height, agent, prompt, composing, agentComposing };
      if (width === 430) {
        // A real tap on each way out, as the reader leaves: Cancel backs out
        // of the comment, then Done ends the mode.
        const tapExit = async (name: string): Promise<void> => {
          const box = (await read(cdp, frame)).exits[name];
          if (box) await tap(cdp, { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });
        };
        const settled = (what: string, done: () => Promise<boolean>) =>
          until(what, async () => ((await done()) ? true : null), 3000).catch(() => false);
        await tapExit('cancel');
        const cancelled = await settled('Cancel closed the composer', async () =>
          Boolean(await frame.eval(`!${S}.querySelector('.composer')`)),
        );
        await tapExit('done');
        const left = await settled('Done ended the mode', async () => !(await modeOn(frame)));
        r.exited = { cancel: cancelled, done: left };
      }
      readings.push(r);
      await closePerson(cdp);
    }
    process.stdout.write(`\n${JSON.stringify(readings)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
    rmSync(mockDir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
