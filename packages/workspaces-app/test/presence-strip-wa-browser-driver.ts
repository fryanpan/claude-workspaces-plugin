#!/usr/bin/env bun
/**
 * The board's presence strip, today's and the Web Awesome one, in headless
 * Chromium against a real server and the real bundles, at 1180x820 and
 * 430x932.
 *
 * Alice has the board open; Bob and the board's lead are on it too. The
 * driver reads her strip's deck on the current code, follows Bob by holding
 * his row in the list the deck opens,
 * then switches the board onto the collab core with her page still open and
 * reads the strip again once it has swapped, following Bob and stopping again
 * so the stop toast shows from that side too. Then it switches the board back.
 * Each reading is every circle's box and the computed fill, border, ring and
 * shape of whatever paints it, so the test can say the two strips look the
 * same rather than only that both rendered.
 *
 * `WA_STRIP_SHOTS=<dir>` also saves a screenshot of each strip at each size.
 *
 * Spawned by `presence-strip-wa-browser.test.ts`, which reads the JSON it
 * prints last.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import {
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  navigate,
  openPerson,
  personIdOf,
  shutdown,
  until,
} from './follow-browser-kit.ts';

export interface Circle {
  /** The participant the circle draws (`p-<id>` / `a-<agentId>`). */
  key: string;
  /** On the reader's page (28px) or elsewhere in the workspace (20px). */
  here: boolean;
  face: 'classic' | 'wa';
  following: boolean;
  /** The button's box, rounded to whole pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** Computed off whatever paints the circle: the button, or its avatar. */
  paint: {
    w: number;
    h: number;
    background: string;
    borderColor: string;
    radius: string;
    ring: string;
    color: string;
    fontSize: string;
  };
}

/** The follow toast as a reader sees it, off whichever element paints it. */
export interface Toast {
  text: string;
  face: 'classic' | 'wa';
  box: { x: number; y: number; w: number; h: number };
  background: string;
  color: string;
  radius: string;
  shadow: string;
  padding: string;
  font: string;
  /** Whether the board's own toast is showing as well. */
  classicShown: boolean;
  /** The feedback widget's "≡" chip (`.fab-list`) when it is shown, and
   *  which of the two the browser paints at the overlap's centre. */
  chip: { x: number; y: number; w: number; h: number } | null;
  /** 'toast', 'chip', or null when the two boxes do not overlap. */
  onTop: 'toast' | 'chip' | 'other' | null;
  /** What is painted around the toast: luminance 0–255 at points a set
   *  distance outside its box (`SHADE_POINTS`), so its shadow as drawn. */
  shade: Array<{ at: string; lum: number }>;
}

export interface Reading {
  width: number;
  phase: 'classic' | 'wa' | 'wa-unthemed' | 'classic-again';
  circles: Circle[];
  themeLinked: boolean;
  toast: Toast | null;
}

export interface WaStripRun {
  readings: Reading[];
  /** Bob's circle key at each width, so a reading can name him. */
  bobKeys: Record<number, string>;
}

const step = (what: string): void => {
  process.stderr.write(`[wa-strip-driver] ${what}\n`);
};

/** Every circle in the strip's deck, read the way a reader sees it. */
const READ_STRIP = `(() => {
  const round = (n) => Math.round(n);
  return [...document.querySelectorAll('#board-people .board-presence-deck > [data-key]')].map((b) => {
    const avatar = b.querySelector('wa-avatar');
    const painter = avatar ?? b;
    const r = b.getBoundingClientRect();
    const p = painter.getBoundingClientRect();
    const s = getComputedStyle(painter);
    return {
      key: b.getAttribute('data-key') ?? '',
      here: b.classList.contains('board-presence-here'),
      face: avatar ? 'wa' : 'classic',
      following: b.classList.contains('board-following'),
      box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
      paint: {
        w: round(p.width), h: round(p.height),
        background: s.backgroundColor, borderColor: s.borderTopColor,
        radius: s.borderTopLeftRadius, ring: s.boxShadow, color: s.color, fontSize: s.fontSize,
      },
    };
  });
})()`;

/** The toast showing now, if any: the board's own, or the Web Awesome one. */
const READ_TOAST = `(() => {
  const round = (n) => Math.round(n);
  const classic = document.getElementById('board-toast');
  const classicShown = !!classic && !classic.classList.contains('hidden');
  const item = document.querySelector('wa-toast.board-wa-toast wa-toast-item');
  const frame = item?.shadowRoot?.querySelector('[part="toast-item"]');
  const content = item?.shadowRoot?.querySelector('[part="content"]');
  const painter = frame ?? (classicShown ? classic : null);
  if (!painter) return null;
  const r = painter.getBoundingClientRect();
  const s = getComputedStyle(painter);
  const inner = getComputedStyle(content ?? painter);
  const widget = document.querySelector('claude-feedback-widget');
  const list = widget?.shadowRoot?.querySelector('.fab-list');
  const c = list && getComputedStyle(list).display !== 'none' ? list.getBoundingClientRect() : null;
  // Who is painted where the two boxes overlap: the top layer is hit-tested
  // like any other layer, so the deepest element at that point names it.
  let onTop = null;
  if (c) {
    const x0 = Math.max(r.left, c.left), x1 = Math.min(r.right, c.right);
    const y0 = Math.max(r.top, c.top), y1 = Math.min(r.bottom, c.bottom);
    if (x1 > x0 && y1 > y0) {
      const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
      let e = document.elementFromPoint(x, y);
      while (e?.shadowRoot) {
        const inner = e.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === e) break;
        e = inner;
      }
      const host = (n) => { while (n && n.getRootNode() instanceof ShadowRoot) n = n.getRootNode().host; return n; };
      const top = host(e);
      onTop = !top ? 'other'
        : list.contains(e) ? 'chip'
        : top.closest('wa-toast.board-wa-toast') || (classic && classic.contains(top)) ? 'toast'
        : 'other';
    }
  }
  return {
    text: (item ?? classic).textContent.trim(),
    face: frame ? 'wa' : 'classic',
    box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
    background: s.backgroundColor, color: inner.color, radius: s.borderTopLeftRadius,
    shadow: s.boxShadow, padding: inner.padding, font: inner.font, classicShown,
    chip: c && { x: round(c.x), y: round(c.y), w: round(c.width), h: round(c.height) },
    onTop,
  };
})()`;

const FACE = (face: 'classic' | 'wa') =>
  face === 'wa'
    ? `!!document.querySelector('#board-people .board-presence-wa wa-avatar')`
    : `!!document.querySelector('#board-people .board-presence-circle')`;

/** Where the shade around a toast is sampled, each a side of its box and a
 *  distance outside it in px: below its middle, beside its middle, and below
 *  each corner, where a shadow cut off at the toast's width shows as a hard
 *  edge. */
const SHADE_POINTS: Array<['below' | 'left' | 'right' | 'below-left' | 'below-right', number]> = [
  ['below', 8],
  ['below', 24],
  ['below', 44],
  ['left', 8],
  ['left', 24],
  ['right', 8],
  ['right', 24],
  ['below-left', 14],
  ['below-right', 14],
];

/** The toast's surroundings as painted: a screenshot of the viewport, read
 *  back through a canvas on the page at points around the toast's box. */
async function shadeAround(cdp: Cdp, box: Toast['box']): Promise<Toast['shade']> {
  // The whole viewport: a clip reaching past its edge is cut to it, which
  // would shift every point. Points off the screen read -1 on both toasts.
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  const [left, right, top, bottom] = [box.x, box.x + box.w, box.y, box.y + box.h];
  const [midX, midY] = [(left + right) / 2, (top + bottom) / 2];
  const points = SHADE_POINTS.map(([side, d]) => {
    if (side === 'below') return [midX, bottom + d];
    if (side === 'left') return [left - d, midY];
    if (side === 'right') return [right + d, midY];
    if (side === 'below-left') return [left - d, bottom + d];
    return [right + d, bottom + d];
  }).map(([x, y]) => [Math.round(x ?? 0), Math.round(y ?? 0)]);
  const lums = (await cdp.evaluate(`new Promise((done) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const k = img.width / innerWidth;
      done(${JSON.stringify(points)}.map(([x, y]) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return -1;
        const [r, gr, b] = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
        return Math.round(0.2126 * r + 0.7152 * gr + 0.0722 * b);
      }));
    };
    img.src = 'data:image/png;base64,${shot.data}';
  })`)) as number[];
  return SHADE_POINTS.map(([side, d], i) => ({ at: `${side} ${d}px`, lum: lums[i] ?? -1 }));
}

async function read(
  cdp: Cdp,
  width: number,
  phase: Reading['phase'],
  /** The deck as read earlier, while the follow was on: the toast is only
   *  raised once it stops. */
  following?: Circle[],
): Promise<Reading> {
  const circles = following ?? ((await cdp.evaluate(READ_STRIP)) as Circle[]);
  const themeLinked =
    (await cdp.evaluate(`!!document.querySelector('link[data-wa-theme]')`)) === true;
  const toast = (await cdp.evaluate(READ_TOAST)) as Omit<Toast, 'shade'> | null;
  return {
    width,
    phase,
    circles,
    themeLinked,
    toast: toast && { ...toast, shade: await shadeAround(cdp, toast.box) },
  };
}

/** The centre of the first element `selector` matches, or null. */
const centreOf = (selector: string) => `(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`;

/** Open the deck's list by hovering it, hold the mouse on `key`'s row until
 *  the follow ring is on (`ring`) or off, and wait for the list to close. */
async function longPress(cdp: Cdp, key: string, ring = true): Promise<void> {
  const deck = await until(
    'the deck',
    async () =>
      (await cdp.evaluate(centreOf('#board-people .board-presence-deck'))) as {
        x: number;
        y: number;
      } | null,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deck.x, y: deck.y });
  const row = `#board-people .board-presence-row[data-key="${key}"] .board-presence-who`;
  const at = await until(
    `the row for ${key}`,
    async () => (await cdp.evaluate(centreOf(row))) as { x: number; y: number } | null,
  );
  const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased') =>
    cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await mouse('mouseMoved');
  await mouse('mousePressed');
  await until(ring ? 'the follow ring' : 'the ring gone', async () =>
    (await cdp.evaluate(`!!document.querySelector('#board-people .board-following')`)) === ring
      ? true
      : null,
  );
  await mouse('mouseReleased');
  // Move off the strip, so hovering does not open the list again.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 400 });
  await until('the list closed', async () =>
    (await cdp.evaluate(`!document.querySelector('#board-people .board-presence-list')`))
      ? true
      : null,
  );
}

async function shoot(cdp: Cdp, dir: string | undefined, name: string): Promise<void> {
  if (!dir) return;
  // Let the page settle a frame so the swap's paint is in the picture.
  await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function main(): Promise<void> {
  deadline('wa-strip-driver', 150_000);
  const shots = process.env.WA_STRIP_SHOTS;
  const board = await bootBoard('wa-strip', { collabCore: true });
  const { base, ws, post } = board;
  const readings: Reading[] = [];
  const bobKeys: Record<number, string> = {};
  try {
    for (const [width, height] of SIZES) {
      await post(`/workspaces/${ws}/collab-core`, { on: false });
      step(`people at ${width}`);
      const alice = await openPerson(width, height, {
        anonId: `alice-${width}`,
        name: 'Alice',
        signIn: true,
        ws,
      });
      const bob = await openPerson(width, height, {
        anonId: `bob-${width}`,
        name: 'Bob',
        signIn: true,
        ws,
      });
      const bobKey = `p-${personIdOf(`bob-${width}`)}`;
      bobKeys[width] = bobKey;
      await navigate(bob, `${base}/workspaces/${ws}`);
      await navigate(alice, `${base}/workspaces/${ws}`);
      const bobHere = `!!document.querySelector('#board-people .board-presence-deck [data-key="${bobKey}"]')`;
      await until('Bob in the strip', async () => ((await alice.evaluate(bobHere)) ? true : null));
      await until('the lead in the strip', async () =>
        (await alice.evaluate(`!!document.querySelector('#board-people .board-presence-agent')`))
          ? true
          : null,
      );
      // Following raises no toast (the bar says it); stopping does. So read
      // the deck while following, then stop and read the toast.
      await longPress(alice, bobKey);
      const classicCircles = (await alice.evaluate(READ_STRIP)) as Circle[];
      await shoot(alice, shots, `strip-classic-${width}`);
      await longPress(alice, bobKey, false);
      await until('the board toast', async () =>
        (await alice.evaluate(
          `document.getElementById('board-toast')?.classList.contains('hidden') === false`,
        ))
          ? true
          : null,
      );
      readings.push(await read(alice, width, 'classic', classicCircles));

      step(`switch on at ${width}`);
      // Switching on from loopback needs the owner's own proof
      // (`owner-proof-widenings.test.ts`), and the route is not under test
      // here: set the switch, which tells the open pages itself.
      board.server.collabCore.switch.set(ws, true);
      await until('the Web Awesome strip', async () =>
        (await alice.evaluate(FACE('wa'))) ? true : null,
      );
      // Follow Bob and stop, so the stop toast shows from the Web Awesome
      // side. First let the classic phase's toast time out, so a board toast
      // showing below is one these presses raised.
      await until('the board toast gone', async () =>
        (await alice.evaluate(
          `document.getElementById('board-toast')?.classList.contains('hidden')`,
        ))
          ? true
          : null,
      );
      await longPress(alice, bobKey);
      const waCircles = (await alice.evaluate(READ_STRIP)) as Circle[];
      await shoot(alice, shots, `strip-webawesome-${width}`);
      await longPress(alice, bobKey, false);
      await until('the Web Awesome toast', async () =>
        (await alice.evaluate(`!!document.querySelector('wa-toast.board-wa-toast wa-toast-item')`))
          ? true
          : null,
      );
      readings.push(await read(alice, width, 'wa', waCircles));
      // Follow again, so the readings below have Bob followed as the two
      // above did.
      await longPress(alice, bobKey);
      // The theme file arrives after the strip mounts, so the strip has to be
      // right without it: read it again with the theme switched off, as a
      // reader on a slow link sees it first.
      await alice.evaluate(`document.querySelector('link[data-wa-theme]').disabled = true`);
      readings.push(await read(alice, width, 'wa-unthemed'));
      await alice.evaluate(`document.querySelector('link[data-wa-theme]').disabled = false`);

      step(`switch off at ${width}`);
      await post(`/workspaces/${ws}/collab-core`, { on: false });
      await until('today’s strip again', async () =>
        (await alice.evaluate(FACE('classic'))) ? true : null,
      );
      readings.push(await read(alice, width, 'classic-again'));
      await closePerson(alice);
      await closePerson(bob);
    }
  } finally {
    board.lead.close();
    await shutdown();
  }
  const run: WaStripRun = { readings, bobKeys };
  process.stdout.write(`${JSON.stringify(run)}\n`);
  process.exit(0);
}

await main();
