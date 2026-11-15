/**
 * The page half of `lead-chat-meeting-browser-driver.ts`: what it reads off
 * the lead chat, and the three things it does to a page (load one, read it,
 * tap it), each bounded.
 *
 * Bounded because one did hang. On main 00529b058 (CI shard 14) the driver
 * printed "move to tasks at 430" and then nothing until its 230s deadline: a
 * CDP answer or a load event that never came, in an await with no limit, so
 * the run said neither which step stalled nor what it was waiting on. Every
 * `until` already had a limit; the awaits between them did not.
 */
import { type Cdp, sleep, withTimeout } from '../../../scripts/headless-chrome.ts';
import type { Rect } from './lead-chat-browser-reading.ts';

/** One CDP answer. Generous: a loaded runner answers in well under a second. */
const CDP_MS = 15_000;
/** A page's load event, after which the agent button still has `until`'s 20s. */
const LOAD_MS = 30_000;

/** A CDP call that names itself if it never answers. */
export const bounded = <T>(p: Promise<T>, what: string, ms = CDP_MS): Promise<T> =>
  withTimeout(p, ms, what);

export async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

/** The chat's meeting as the page shows it, through its shadow roots. */
export const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const q = (s) => sr && sr.querySelector(s);
  // A tab behind another draws no frames, so the panel's grow animation stalls part-way; read the end state.
  for (const a of q('.lc-pane')?.getAnimations?.() ?? []) a.finish();
  const box = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const nav = document.querySelector('.cw-host-nav');
  const frame = document.querySelector('iframe[data-cw-mock-frame]');
  const b = btn && btn.getBoundingClientRect();
  const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return {
    button: box(btn),
    buttonOnTop: !!hit && hit === host,
    pane: box(q('.lc-pane')),
    start: box(q('.lc-start')),
    next: q('[data-wiz="next"]') && !q('[data-wiz="next"]').disabled ? box(q('[data-wiz="next"]')) : null,
    go: box(q('[data-wiz="start"]')),
    wizard: box(q('.lc-wiz')),
    head: box(q('.lc-meet')),
    headText: q('.lc-meet') && !q('.lc-meet').hidden ? q('.lc-meet').textContent : '',
    end: box(q('.lc-end')),
    tap: box(q('.lc-tap')),
    notes: q('.lc-notes') && !q('.lc-notes').hidden ? q('.lc-notes').textContent : '',
    notesBox: box(q('.lc-notes')),
    composeBox: box(q('.lc-compose')),
    bar: box(q('.lc-bar')),
    barText: q('.lc-bar') && !q('.lc-bar').hidden ? q('.lc-bar').textContent : '',
    nav: box(nav),
    navLinks: nav ? [...nav.querySelectorAll('a')].map((a) => a.textContent) : [],
    frame: box(frame),
    viewport: { width: document.documentElement.clientWidth, height: innerHeight },
  };
})()`;

export interface Read {
  button: Rect | null;
  buttonOnTop: boolean;
  pane: Rect | null;
  start: Rect | null;
  next: Rect | null;
  go: Rect | null;
  wizard: Rect | null;
  head: Rect | null;
  headText: string;
  end: Rect | null;
  tap: Rect | null;
  notes: string;
  notesBox: Rect | null;
  composeBox: Rect | null;
  bar: Rect | null;
  barText: string;
  nav: Rect | null;
  navLinks: string[];
  frame: Rect | null;
  viewport: { width: number; height: number };
}

export async function read(cdp: Cdp): Promise<Read> {
  return (await bounded(cdp.evaluate(READ), 'reading the page')) as Read;
}

/** `loadMs` is the load event's limit; a test of the limit passes a short one. */
export async function go(cdp: Cdp, url: string, loadMs = LOAD_MS): Promise<Read> {
  const where = new URL(url).pathname;
  const loaded = cdp.once('Page.loadEventFired');
  await bounded(cdp.send('Page.navigate', { url }), `the navigation to ${where}`);
  await bounded(loaded, `the load event of ${where}`, loadMs);
  return until('the agent button on the page', async () => {
    const r = await read(cdp);
    return r.button ? r : null;
  });
}

export async function tap(cdp: Cdp, r: Rect): Promise<void> {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await bounded(
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }),
      `a ${type} at ${Math.round(x)},${Math.round(y)}`,
    );
  }
}
