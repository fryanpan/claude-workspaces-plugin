/**
 * Home, with a secret ask open in the walkthrough, built for a real browser.
 *
 * The task panel's half of this question lives in `secret-save-bar-driver.ts`.
 * This is the OTHER surface, and the two are not the same measurement: on
 * Home the walkthrough is a page in the Home column rather than an overlay,
 * so the box that scrolls is the viewport, and the bottom of the viewport is
 * owned by a `position: fixed` nav dock that is not part of the scroll at
 * all. A reserve authored on the wrong box computes `auto` on the right one
 * and the page behaves exactly as if nothing had been written.
 *
 * So everything here is built from the product's own parts — `buildShell`
 * for the dock, `mountWalkthroughIsland` for the card — rather than from a
 * hand-written approximation of them. A fixture that draws its own nav can
 * pass with the dock's real height, position or z-order changed underneath
 * it.
 *
 * `secret-save-home-driver.ts` bundles this, loads it at four phone
 * viewports and reads the JSON each function returns. All fixture content is
 * synthetic: invented names, invented services, and a placeholder value that
 * is deliberately not token-shaped.
 */
import type { ReviewItem, ReviewQueue } from '../src/board/board-review-model.ts';
import { buildShell } from '../src/board/board-shell.ts';
import { mountWalkthroughIsland, walkthroughData } from '../src/board/walkthrough-island.tsx';

const NOW = 1_700_000_000_000;

/** Three lines, none of them token-shaped — the paste this round is about. */
const THREE_LINES = 'not-a-real-line-1\nnot-a-real-line-2\nnot-a-real-line-3';

/** Three fields, for the reason `secret-save-bar-driver.ts` gives: a form
 *  short enough to fit on screen proves nothing about a scroll. */
const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
  { label: 'Relay endpoint', service: 'saltmarsh-relay-endpoint' },
];

const DETAIL =
  'The nightly pass signs in to the Saltmarsh relay and posts the index. ' +
  'It needs the relay account it posts as, the value that account signs with, ' +
  'and where to send it. None of the three is read back here: they go straight ' +
  'to the store on the machine the board runs on, and the pass reads them from ' +
  'there. Nothing is recorded on this task, echoed into the feed, or handed to ' +
  'an agent. Paste them once and the pass runs unattended from tonight.';

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One reading of the page: where Save is, and what answers a tap on it. */
export interface Look {
  save: Rect;
  form: Rect;
  /** The fixed nav dock at the foot of the viewport. */
  nav: Rect;
  /** What `elementFromPoint` answers at each of five points on Save — its
   *  centre and one inside each corner. A tap lands on whatever this names. */
  hits: string[];
  /** The value boxes, and what answers a tap at the middle of each. */
  fields: Rect[];
  fieldHits: string[];
  /** Which box the page put the caret in, by service name — the half-filled
   *  form sends the reader to the one still empty, and a box they cannot
   *  reach is the same fault as a Save they cannot reach. */
  focusedField: string;
  scrollY: number;
}

/**
 * The grip's whole reach, and what it leaves Save standing on.
 *
 * Dragging a textarea's grip makes the browser write an inline height on it,
 * which `max-height` then clamps — so asking for far more than the cap is the
 * same geometry as dragging to the bottom of the grip's travel, and it needs
 * no number from the stylesheet to say where that is. Every field, because a
 * reader with three values to paste has three fields they might want to see
 * more of.
 */
export interface Grip {
  /** Computed `resize` on a field. `none` is the answer that says the browser
   *  draws no grip at all, so there is nothing to take hold of. */
  resize: string;
  /** Field heights before and after the drag. With no grip they are equal —
   *  that equality is the claim, not the absence of a screenshot. */
  before: number[];
  after: number[];
  /** Where Save was before the drag, so the control can say what the drag did
   *  WITHOUT reading a second reading. A control that borrowed the no-grip
   *  reading for its baseline went red alongside the case it was meant to
   *  vouch for, which is the one thing a control may not do. */
  saveBefore: Rect;
  look: Look;
}

export interface Reading {
  width: number;
  height: number;
  /** Which element the page's scroll actually belongs to, and what reserve
   *  each of the two candidates carries. The whole fault was a reserve on the
   *  one that does not scroll. */
  scroller: string;
  htmlReserve: string;
  bodyReserve: string;
  /** The dock is fixed — so no amount of scrolling moves the page out from
   *  under it, which is why the reserve has to exist at all. */
  navPosition: string;
  /** CONTROL: the page really is taller than the viewport. A page that fits
   *  has no scroll to get wrong. */
  pageScrolls: boolean;
  /** As the reader first meets it, after the card's own clearance scroll. */
  firstDraw: Look;
  /** After tapping the last field, the way a reader does to paste into it. */
  focused: Look;
  /** After pressing Save with a field still empty, which grows the row by a
   *  line and pushes the button down. */
  message: Look;
  /** CONTROL: the same first draw with the reserve taken off the element that
   *  scrolls. This is the page as the UX walk found it, and Save has to land
   *  under the dock — a fixture that passes here proves nothing above. */
  unreserved: Look;
  /** What a drag on the field's resize grip does to a settled form. */
  dragged: Grip;
  /** CONTROL: the same drag forced through whatever `resize` says, so the
   *  reading above is taken against a page where the height CAN move. A field
   *  the reader can grow puts Save under the dock, which is both why the grip
   *  is gone and why `dragged` reading clean means something. */
  draggable: Grip;
}

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

const boxes = (): HTMLTextAreaElement[] =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));

/** Five points on Save: the centre, and one 6px inside each corner. Six
 *  pixels rather than one, because a hit test on the very edge of a box is a
 *  rounding argument rather than a question about what a thumb reaches. */
function look(): Look {
  const save = need<HTMLElement>('.board-walk-cred-send');
  const b = save.getBoundingClientRect();
  const points: Array<[number, number]> = [
    [(b.left + b.right) / 2, (b.top + b.bottom) / 2],
    [b.left + 6, b.top + 6],
    [b.right - 6, b.top + 6],
    [b.left + 6, b.bottom - 6],
    [b.right - 6, b.bottom - 6],
  ];
  const fields = boxes();
  const active = document.activeElement as HTMLTextAreaElement | null;
  return {
    save: rect(save),
    form: rect(need('.board-walk-cred-form')),
    nav: rect(need('.board-nav')),
    hits: points.map(([x, y]) => nameOf(document.elementFromPoint(x, y))),
    fields: fields.map(rect),
    fieldHits: fields.map((f) => {
      const r = f.getBoundingClientRect();
      return nameOf(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2));
    }),
    focusedField: active?.name ?? 'none',
    scrollY: Math.round(window.scrollY),
  };
}

/** The ask, as one item of a one-item queue. */
function queue(): ReviewQueue {
  const item = {
    key: 'r-secret',
    kind: 'task-review',
    title: 'Post the nightly index to the Saltmarsh relay',
    ask: 'Paste the three relay values so the nightly post can run',
    why: 'Riverbend Bot asked an hour ago',
    since: NOW - 3_600_000,
    review: {
      shape: 'secret',
      headline: 'Paste the three relay values so the nightly post can run',
      detail: DETAIL,
      ownerOnly: true,
      secrets: FIELDS,
      taskId: 't-nightly',
      askedBy: 'Riverbend Bot',
      askedAt: NOW - 3_600_000,
    },
  } as unknown as ReviewItem;
  return { items: [item], total: 1, blocking: 0 };
}

/** Build the page the product builds, open the walkthrough on the ask, and
 *  paste a three-line value into every field. */
export async function paint(): Promise<void> {
  document.body.className = 'board-body';
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.replaceChildren(root);
  buildShell(document, root, 'Harborlight relay', 'w-fixture');
  // The shell ships Home and the walkthrough hidden; the board's own loader
  // is what opens them, and this fixture stands in for that one step.
  need('#board-home').classList.remove('hidden');
  const host = need<HTMLElement>('#board-walkthrough');
  host.classList.remove('hidden');
  mountWalkthroughIsland(host);
  walkthroughData.value = {
    queue: queue(),
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    secretsGate: 'open',
    handlers: {
      onAnswer: () => Promise.resolve(false),
      onAskOnItem: () => Promise.resolve(false),
      onQuestionOnItem: () => Promise.resolve(false),
      onReply: () => Promise.resolve(false),
      onSaveSecrets: () => Promise.resolve(true),
      onOpenItem: () => {},
      onOpenThread: () => {},
      onStep: () => {},
      onClose: () => {},
    },
  };
  await frame();
  for (const box of boxes()) {
    box.value = THREE_LINES;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Two frames: one for the paint, one for the card's own clearance effect.
  await frame();
  await frame();
}

/** Tap the LAST field — the one that has to carry Save into view with it. */
export async function focusLast(): Promise<void> {
  window.scrollTo(0, 0);
  await frame();
  const fields = boxes();
  fields[fields.length - 1]?.focus();
  await frame();
  await frame();
}

/** Press Save with the first field emptied, so the "still empty" line appears
 *  and the row grows by a line under it. */
export async function submitHalfFilled(): Promise<void> {
  const first = boxes()[0];
  if (first) {
    first.value = '';
    first.dispatchEvent(new Event('input', { bubbles: true }));
  }
  need<HTMLButtonElement>('.board-walk-cred-send').click();
  await frame();
  await frame();
}

/**
 * The control: the card's own clearance scroll, run again with the reserve
 * taken off the element that scrolls.
 *
 * It re-runs the effect's call rather than reloading the page, so what it
 * measures is the same scroll with one property changed — which is what makes
 * it evidence about the property rather than about the fixture.
 */
export async function unreserved(): Promise<Look> {
  const html = document.documentElement;
  const had = html.style.scrollPaddingBottom;
  html.style.scrollPaddingBottom = '0px';
  window.scrollTo(0, 0);
  await frame();
  need<HTMLElement>('.board-walk-cred-form').scrollIntoView({ block: 'nearest' });
  await frame();
  const out = look();
  html.style.scrollPaddingBottom = had;
  return out;
}

/**
 * Take hold of every field's resize grip and pull it as far as it goes.
 *
 * The ordinary path, and the one the UX walk took: the reader pastes a key,
 * the field caps at a few lines, and the grip in its corner is an invitation
 * to see the rest. The form is repainted first so the drag happens on a
 * settled page — the same first draw every other reading is taken from —
 * rather than on whatever the half-filled Save left behind.
 *
 * `force` is the control. A drag is a thing a POINTER does, so it is only
 * possible where the browser drew a grip; with `resize: none` there is
 * nothing there and `heights` cannot move. Forcing the inline height anyway
 * is the same page with a grip on it, which is what says the clean reading is
 * about the grip rather than about a form that could not have moved either
 * way.
 */
export async function grip(force: boolean): Promise<Grip> {
  await paint();
  const fields = boxes();
  const resize = fields[0] ? getComputedStyle(fields[0]).resize : 'no field';
  const heightOf = (el: Element): number => Math.round(el.getBoundingClientRect().height);
  const before = fields.map(heightOf);
  const saveBefore = rect(need('.board-walk-cred-send'));
  if (force || resize !== 'none') {
    // Past any cap on purpose: `max-height` clamps it, so this lands exactly
    // where the bottom of the grip's travel is without naming that number.
    for (const box of fields) box.style.height = '999px';
  }
  await frame();
  await frame();
  return { resize, before, after: fields.map(heightOf), saveBefore, look: look() };
}

/** Everything the driver asks for at one viewport, as JSON. */
export async function read(width: number, height: number): Promise<string> {
  await paint();
  const firstDraw = look();
  // The control runs against the SAME first draw the reading above measured,
  // before anything else has moved the page.
  const control = await unreserved();
  await focusLast();
  const focused = look();
  await submitHalfFilled();
  const message = look();
  // Each of these repaints, so neither inherits the half-filled form above.
  const dragged = await grip(false);
  const draggable = await grip(true);
  const reading: Reading = {
    width,
    height,
    scroller: (document.scrollingElement ?? document.documentElement).tagName,
    htmlReserve: getComputedStyle(document.documentElement).scrollPaddingBottom,
    bodyReserve: getComputedStyle(document.body).scrollPaddingBottom,
    navPosition: getComputedStyle(need('.board-nav')).position,
    pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    firstDraw,
    focused,
    message,
    unreserved: control,
    dragged,
    draggable,
  };
  return JSON.stringify(reading);
}

declare global {
  interface Window {
    cwSecretHomeRead?: (width: number, height: number) => Promise<string>;
  }
}
window.cwSecretHomeRead = read;
