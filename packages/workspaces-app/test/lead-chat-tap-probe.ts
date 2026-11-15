/**
 * What took a tap meant for the lead chat's bar. CI has seen the bar stay out
 * after a tap on its centre, with no pane and no crash (run 43767519616), and
 * the driver could not say whether something covered the bar, the click never
 * reached it, or the page reloaded under it. Installed on the page before the
 * tap, this records each change in what sits on top at the bar's centre, the
 * the path of every press and click. `TAP_PROBE_READ` reports it, or says the
 * page it was installed on has been replaced.
 *
 * Run 43772344055 answered it: the bar was on top for the whole step and the
 * page recorded no click at all for the bar tap. Nothing on the page saw the
 * input, so `tapDelivered` counts presses on the page and sends a tap again
 * only when the page saw none.
 */
import { type Cdp, sleep } from '../../../scripts/headless-chrome.ts';

/** Installs the recorder on the current page. Evaluate after the page loads. */
export const TAP_PROBE_INSTALL = `(() => {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const p = { hits: [], clicks: [], presses: [] };
  window.__lcTapProbe = p;
  const deep = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const name = (el) => !el || !el.localName ? String(el && el.nodeName) : el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  let last = '';
  const sample = () => {
    const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
    const bar = sr && sr.querySelector('.lc-bar');
    if (!bar || bar.hidden) return;
    const r = bar.getBoundingClientRect();
    const el = deep(r.left + r.width / 2, r.top + r.height / 2);
    const key = el && bar.contains(el) ? 'bar' : name(el);
    if (key !== last && p.hits.length < 40) p.hits.push({ t: at(), top: key });
    last = key;
  };
  setInterval(sample, 50);
  document.addEventListener('pointerdown', (e) => {
    if (p.presses.length < 20) p.presses.push({ t: at(), path: e.composedPath().slice(0, 4).map(name).join(' < ') });
  }, true);
  document.addEventListener('click', (e) => {
    if (p.clicks.length < 20) p.clicks.push({ t: at(), path: e.composedPath().slice(0, 4).map(name).join(' < ') });
  }, true);
})()`;

/** The record, or a note that the page the recorder was on has gone. */
export const TAP_PROBE_READ = `window.__lcTapProbe ? JSON.stringify(window.__lcTapProbe) : 'no probe: the page was replaced after it was installed'`;

/** How many presses this page has seen. Installs the counter the first time. */
const PRESSES = `(() => {
  if (!window.__cwPresses) {
    window.__cwPresses = { n: 0 };
    addEventListener('pointerdown', () => { window.__cwPresses.n++; }, true);
  }
  return window.__cwPresses.n;
})()`;

/**
 * A real tap at the centre of a box, so a covered control fails the caller's
 * next wait. A tap the page never saw (no pointerdown anywhere on it) is input
 * lost before the page, not something the page did, so it is sent again, at
 * most twice. A tap the page saw is never repeated: a press that reached the
 * page and changed nothing is the product's to answer for.
 */
export async function tapDelivered(
  cdp: Cdp,
  r: { left: number; top: number; width: number; height: number },
  log: (line: string) => void = () => {},
): Promise<void> {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (let attempt = 1; ; attempt++) {
    const before = Number(await cdp.evaluate(PRESSES));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    // The press is dispatched before Chrome answers it; the reads after it
    // only cover a page that is slow to run its listeners.
    for (let read = 0; read < 10; read++) {
      if (Number(await cdp.evaluate(PRESSES)) > before) return;
      await sleep(50);
    }
    if (attempt === 3) throw new Error(`the page saw none of 3 taps at ${x},${y}`);
    log(`the page saw no press for the tap at ${x},${y}; sending it again`);
  }
}
