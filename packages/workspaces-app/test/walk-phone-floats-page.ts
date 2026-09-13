/**
 * Home's walkthrough at phone width, with the feedback widget seated over it,
 * built for a real browser.
 *
 * Two questions, both about what is on screen at the moment the reader acts:
 *
 * - WHAT A TAP ON A FORM'S LAST BUTTON LANDS ON. The widget's buttons are a
 *   `position: fixed` column down the viewport's right edge, so whether they
 *   cover a button depends on where the scroll has put it. `sweep` reads the
 *   first draw and then every scroll that lines the button up beside one of
 *   the widget's buttons, and hit-tests a grid over the whole button at each.
 * - WHAT THE PAGE SAYS WHEN A HAND-OVER LANDS. `handOver` fills and saves the
 *   first ask through the real controller and walkthrough, then reads the
 *   toast and the answered banner at the first frame the NEXT ask's form is
 *   there to be used.
 *
 * Built from the product's parts: `buildShell` for the dock and the toast,
 * `mountWalkthroughIsland` for the card, `createBoardWalkthrough` and
 * `createBoardReviewController` for the advance and the write, and the
 * widget's own sheets for its buttons. The one stand-in is `fetch`, which
 * answers the secrets POST the way the server does and drops the item from
 * the queue.
 *
 * `walk-phone-floats-driver.ts` bundles this and reads the JSON `read`
 * returns. All fixture content is synthetic.
 */
import { widgetStyles } from '../../widget/src/styles.ts';
import { MIC_CSS } from '../../widget/src/widget-mic.ts';
import { initialBoardState } from '../src/board/board-projection.ts';
import { createBoardReviewController } from '../src/board/board-review-controller.ts';
import type { ReviewItem, ReviewQueue } from '../src/board/board-review-model.ts';
import { buildShell } from '../src/board/board-shell.ts';
import { createBoardWalkthrough } from '../src/board/board-walkthrough.ts';
import { mountWalkthroughIsland } from '../src/board/walkthrough-island.tsx';

const NOW = 1_700_000_000_000;

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Every scroll position a button was read at, and what answered the taps. */
export interface Sweep {
  button: Rect;
  /** The widget's buttons that sit above the dock — the ones a scroll can
   *  line a form's button up beside. */
  besides: string[];
  /** How many of those the scroll actually lined the button up with. Fewer
   *  than `besides` means a position was never read. */
  aligned: number;
  /** Grid points read, over every position. */
  points: number;
  /** Points that answered with something other than the button. */
  covered: number;
  /** What answered them, once each. */
  hitBy: string[];
}

export interface HandOver {
  /** The next ask's form was drawn — the moment the reader can use it. */
  nextFormDrawn: boolean;
  /** Frames from the click until it was. */
  frames: number;
  /** The toast at that moment: null when it is hidden. */
  toast: string | null;
  /** The answered banner at that moment. */
  banner: string | null;
  /** Every text the toast showed between the click and that moment. */
  toastsSeen: string[];
}

export interface Reading {
  width: number;
  height: number;
  /** The widget's visible buttons, as painted. */
  widget: Array<{ name: string } & Rect>;
  dockTop: number;
  save: Sweep;
  send: Sweep;
  /** CONTROL: the same two sweeps with the gutter taken off the button. */
  saveUnguarded: Sweep;
  sendUnguarded: Sweep;
  handOver: HandOver;
  /** CONTROL: the task panel's hand-over, which does confirm with a toast —
   *  so the reading above can see one when there is one. */
  panelToast: string | null;
}

const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
];

const rect = (el: Element): Rect => {
  const b = el.getBoundingClientRect();
  return {
    top: Math.round(b.top),
    bottom: Math.round(b.bottom),
    left: Math.round(b.left),
    right: Math.round(b.right),
  };
};

const nameOf = (el: Element | null): string => {
  if (!el) return 'nothing';
  const cls = typeof el.className === 'string' ? el.className.trim() : '';
  return cls === ''
    ? el.tagName.toLowerCase()
    : `${el.tagName.toLowerCase()}.${cls.split(/\s+/).join('.')}`;
};

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const need = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`fixture is missing ${sel}`);
  return el;
};

function secretAsk(n: number, title: string): ReviewItem {
  return {
    key: `r-hand-${n}`,
    kind: 'task-review',
    title,
    ask: `Paste the two relay values for pass ${n}`,
    why: 'Riverbend Bot asked an hour ago',
    since: NOW - 3_600_000,
    docId: `task:t-pass-${n}`,
    threadId: `r-hand-${n}`,
    askedBy: 'Riverbend Bot',
    thread: { kind: 'task-review', taskId: `t-pass-${n}`, reviewItemId: `r-hand-${n}` },
    review: {
      shape: 'secret',
      headline: `Paste the two relay values for pass ${n}`,
      detail: 'The nightly pass signs in to the Saltmarsh relay and cannot without these.',
      ownerOnly: true,
      secrets: FIELDS,
    },
  } as unknown as ReviewItem;
}

const REVIEW: ReviewItem = {
  key: 'r-notes',
  kind: 'task-review',
  title: 'Tighten the Harborlight launch notes',
  ask: 'Do the launch notes read right?',
  why: 'Riverbend Bot asked an hour ago',
  since: NOW - 3_600_000,
  docId: 'task:t-notes',
  threadId: 'r-notes',
  askedBy: 'Riverbend Bot',
  thread: { kind: 'task-review', taskId: 't-notes', reviewItemId: 'r-notes' },
  review: {
    shape: 'review',
    headline: 'Do the launch notes read right?',
    detail: 'Two paragraphs, rewritten for the phone.',
  },
} as unknown as ReviewItem;

let items: ReviewItem[] = [];

/** The server's half: the secrets door answers the item, and the queue loses it. */
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const m = /\/review-items\/([^/]+)\/secrets$/.exec(url);
  if (init?.method === 'POST' && m) {
    items = items.filter((i) => i.key !== decodeURIComponent(m[1] ?? ''));
    return new Response(JSON.stringify({ saved: FIELDS.map((f) => f.service) }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

/** Build Home, seat the widget, and open the walkthrough on `first`. */
async function paint(queue: ReviewItem[]) {
  items = queue;
  document.body.className = 'board-body';
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.replaceChildren(root);
  buildShell(document, root, 'Harborlight relay', 'w-fixture');
  need('#board-home').classList.remove('hidden');
  const host = need<HTMLElement>('#board-walkthrough');
  host.classList.remove('hidden');
  mountWalkthroughIsland(host);

  // The widget's own buttons under its own sheets, as board-floats-browser
  // seats them: a button that moves in the widget moves here too.
  const widget = document.createElement('claude-feedback-widget');
  document.body.append(widget);
  const shadow = widget.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    `<style>${widgetStyles}${MIC_CSS}</style>` +
    '<button class="fab-list side">L<span class="count">3</span></button>' +
    '<button class="fab-list fab-mic">V</button>' +
    '<button class="fab">C</button>';

  const state = initialBoardState({
    nav: 'home',
    task: null,
    goal: null,
    thread: null,
    item: null,
    archived: false,
  });
  state.secretsGate = 'open';
  const currentQueue = (): ReviewQueue => ({ items, total: items.length, blocking: 0 });
  let walk: ReturnType<typeof createBoardWalkthrough> | null = null;
  const controller = createBoardReviewController({
    author: { id: 'known-riley', name: 'Riley', kind: 'known', color: '#2e7dd7' },
    state,
    currentQueue,
    renderWalkthrough: () => walk?.render(),
    loadReviewItems: async () => {},
    loadDiscussion: async () => {},
    openTaskThread: () => false,
  });
  const byId = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`fixture is missing #${id}`);
    return el;
  };
  walk = createBoardWalkthrough({
    state,
    currentQueue,
    el: byId,
    syncBoardUrl: () => {},
    renderHomeRegion: () => {},
    openReviewItem: () => true,
    openReviewThread: () => true,
    answerDecision: async () => false,
    askOnReviewItem: async () => false,
    replyToReviewItem: async () => false,
    saveSecretsOnItem: controller.saveSecretsOnItem,
    onQueueDrained: () => {},
  });
  controller.startWalkthrough();
  await frame();
  await frame();
  return { controller, shadow };
}

function widgetButtons(shadow: ShadowRoot): Array<{ name: string } & Rect> {
  return Array.from(shadow.querySelectorAll('button'))
    .filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0)
    .map((b) => ({ name: nameOf(b), ...rect(b) }));
}

/** Every point of the button, 3px apart and 2px inside its edge. */
function hitGrid(button: HTMLElement, into: Set<string>): { points: number; covered: number } {
  const b = button.getBoundingClientRect();
  let points = 0;
  let covered = 0;
  for (let x = b.left + 2; x <= b.right - 2; x += 3) {
    for (let y = b.top + 2; y <= b.bottom - 2; y += 3) {
      points++;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !button.contains(hit)) {
        covered++;
        into.add(nameOf(hit));
      }
    }
  }
  return { points, covered };
}

/** The first draw, then the button lined up beside each widget button above
 *  the dock. A position where the button is not wholly above the dock is not
 *  read: under the dock is a different fault with its own test. */
async function sweep(sel: string, shadow: ShadowRoot, guard: boolean): Promise<Sweep> {
  const button = need<HTMLElement>(sel);
  const had = button.style.marginRight;
  if (!guard) button.style.marginRight = '0px';
  await frame();
  const start = window.scrollY;
  const dockTop = need('.board-nav').getBoundingClientRect().top;
  const besides = widgetButtons(shadow).filter((w) => w.bottom <= dockTop);
  const hitBy = new Set<string>();
  let points = 0;
  let covered = 0;
  let aligned = 0;
  const readHere = (): void => {
    const b = button.getBoundingClientRect();
    if (b.top < 0 || b.bottom > dockTop) return;
    const g = hitGrid(button, hitBy);
    points += g.points;
    covered += g.covered;
  };
  readHere();
  const drawn = rect(button);
  // Room above and below the page, so a scroll can put the button beside
  // every widget button above the dock — including a spot lower on screen
  // than its place in a short page lets it reach from the top.
  const above = document.createElement('div');
  const below = document.createElement('div');
  above.style.height = '100vh';
  below.style.height = '100vh';
  document.body.prepend(above);
  document.body.append(below);
  await frame();
  for (const w of besides) {
    const b = button.getBoundingClientRect();
    window.scrollBy(0, (b.top + b.bottom) / 2 - (w.top + w.bottom) / 2);
    await frame();
    const after = button.getBoundingClientRect();
    if (Math.abs((after.top + after.bottom) / 2 - (w.top + w.bottom) / 2) <= 1) aligned++;
    readHere();
  }
  above.remove();
  below.remove();
  window.scrollTo(0, start);
  const out: Sweep = {
    button: drawn,
    besides: besides.map((w) => w.name),
    aligned,
    points,
    covered,
    hitBy: [...hitBy],
  };
  button.style.marginRight = had;
  await frame();
  return out;
}

/** Fill the first ask, press Save, and read the page at the first frame the
 *  second ask's form is there. */
async function handOver(): Promise<HandOver> {
  const toast = need<HTMLElement>('#board-toast');
  const seen = new Set<string>();
  const watch = new MutationObserver(() => {
    if (!toast.classList.contains('hidden')) seen.add(toast.textContent ?? '');
  });
  watch.observe(toast, { attributes: true, childList: true, characterData: true, subtree: true });
  for (const box of document.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input')) {
    box.value = 'not-a-real-value';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  need<HTMLButtonElement>('.board-walk-cred-send').click();
  const next = `secret:r-hand-2:${FIELDS[0]?.service}`;
  let frames = 0;
  while (frames < 120 && !document.getElementById(next)) {
    await frame();
    frames++;
  }
  watch.disconnect();
  const banner = document.querySelector('.board-walk-advanced-said');
  return {
    nextFormDrawn: document.getElementById(next) !== null,
    frames,
    toast: toast.classList.contains('hidden') ? null : (toast.textContent ?? ''),
    banner: banner ? (banner.textContent ?? '') : null,
    toastsSeen: [...seen],
  };
}

export async function read(width: number, height: number): Promise<string> {
  const first = await paint([
    secretAsk(1, 'Post the nightly index to the Saltmarsh relay'),
    secretAsk(2, 'Post the weekly digest to the Saltmarsh relay'),
  ]);
  const widget = widgetButtons(first.shadow);
  const dockTop = Math.round(need('.board-nav').getBoundingClientRect().top);
  const save = await sweep('.board-walk-cred-send', first.shadow, true);
  const saveUnguarded = await sweep('.board-walk-cred-send', first.shadow, false);
  const hand = await handOver();
  await first.controller.saveSecretsOnTaskItem('t-pass-9', 'r-hand-9', [
    { service: 'saltmarsh-relay-account', value: 'not-a-real-value' },
  ]);
  const toast = need<HTMLElement>('#board-toast');
  const panelToast = toast.classList.contains('hidden') ? null : (toast.textContent ?? '');

  const reviewPage = await paint([REVIEW]);
  const send = await sweep('.board-walk-answer .board-btn', reviewPage.shadow, true);
  const sendUnguarded = await sweep('.board-walk-answer .board-btn', reviewPage.shadow, false);

  const reading: Reading = {
    width,
    height,
    widget,
    dockTop,
    save,
    send,
    saveUnguarded,
    sendUnguarded,
    handOver: hand,
    panelToast,
  };
  return JSON.stringify(reading);
}

declare global {
  interface Window {
    cwWalkFloatsRead?: (width: number, height: number) => Promise<string>;
  }
}
window.cwWalkFloatsRead = read;
