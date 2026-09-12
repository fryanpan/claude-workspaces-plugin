/**
 * The task panel, with a secret ask on it, mounted in a real browser.
 *
 * `secret-save-bar.test.ts` runs this: it builds the module for the browser,
 * puts it in a page beside the board's own stylesheets, and asks it for the
 * one thing happy-dom cannot answer — which element is actually painted at a
 * point. Everything here is geometry; nothing reads a stylesheet's text.
 *
 * All fixtures are synthetic: invented names, invented service names, and a
 * placeholder value that is deliberately not token-shaped.
 */
import type { DetailHandlers, TaskDiscussion } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import type { ReviewThreadItem } from '../src/board/board-review-model.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/board/task-detail-island.tsx';

const NOW = 1_700_000_000_000;

/** Three lines, none of them token-shaped — the paste this whole round is about. */
const THREE_LINES = 'not-a-real-line-1\nnot-a-real-line-2\nnot-a-real-line-3';

/**
 * Three fields, not two, and that is load-bearing.
 *
 * A two-field form happened to end level with the panel's own foot at
 * 1180x820, so Save was on screen there whatever the scroll reserved — the
 * control that says the reservation does something could not fail. Three is
 * also what a real ask of this shape looks like: what to sign in as, what to
 * sign with, and where to send it.
 */
const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
  { label: 'Relay endpoint', service: 'saltmarsh-relay-endpoint' },
];

/**
 * A detail paragraph the length a real ask carries.
 *
 * It is load-bearing, not decoration: it is what puts the form's foot below
 * the panel's fold at 1180x820, which is the state the sticky row misbehaves
 * in. A one-line ask leaves the whole form on screen and every assertion in
 * the test would pass without the fix — `formFootBelowFold` is reported so
 * that a fixture which stops reproducing fails loudly instead.
 */
const DETAIL =
  'The nightly pass signs in to the Saltmarsh relay and posts the index. ' +
  'It needs the relay account it posts as and the value that account signs with. ' +
  'Neither is read back here: they go straight to the store on the machine the ' +
  'board runs on, and the pass reads them from there. Nothing is recorded on ' +
  'this task, echoed into the feed, or handed to an agent. Paste them once and ' +
  'the pass runs unattended from tonight; if either one is rotated, paste the ' +
  'new one over the top and the next run picks it up.';

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One field, and what is painted at the two points a reader aims at. */
export interface FieldReading {
  field: Rect;
  /** What `elementFromPoint` answers at the field's last line. */
  lastLine: string;
  /** And at the middle of its eye. */
  eye: string;
}

export interface Probe {
  panel: Rect;
  form: Rect;
  bar: Rect;
  barPosition: string;
  scrollPadBottom: string;
  /** The fixture still reproduces: the form is taller than what the panel can
   *  show at once, so there are scroll positions with fields against the foot
   *  of the scrollport. A form that fits proves nothing. */
  formOverflowsPanel: boolean;
  /** As drawn, before anybody touches it. */
  firstDraw: FieldReading[];
  /** Save is on screen when the reader first meets the form. */
  saveShownOnFirstDraw: boolean;
  /** After the reader taps each field, the way they would to paste. */
  focused: FieldReading[];
  /** And Save came with it, per field. */
  saveShownWhenFocused: boolean[];
  /** Every field at every scroll position the panel has, nothing focused. */
  atRest: FieldReading[];
  /** Control: the same sweep with the row stuck back down, which is the rule
   *  this round removed. It must find Save over a field. */
  atRestWithStickyRow: FieldReading[];
  /** Control: Save's visibility on focus with the reserved room taken off. */
  saveShownWhenFocusedUnreserved: boolean[];
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

/** A name for whatever is painted at a point — a class list when there is one. */
const nameOf = (el: Element | null): string => {
  if (!el) return 'nothing';
  const cls = typeof el.className === 'string' ? el.className.trim() : '';
  return cls === ''
    ? el.tagName.toLowerCase()
    : `${el.tagName.toLowerCase()}.${cls.split(/\s+/).join('.')}`;
};

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function boxes(): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));
}
function eyes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.board-walk-cred-eye'));
}

function readField(i: number): FieldReading {
  const f = rect(boxes()[i] as Element);
  const e = rect(eyes()[i] as Element);
  return {
    field: f,
    // Inside the field, one line up from its bottom edge — the last line of a
    // three-line value.
    lastLine: nameOf(document.elementFromPoint(f.left + 20, f.bottom - 6)),
    eye: nameOf(document.elementFromPoint((e.left + e.right) / 2, (e.top + e.bottom) / 2)),
  };
}

/** Mount the panel with one secret ask on it and paste into both fields. */
async function paint(): Promise<void> {
  const host = document.createElement('div');
  host.className = 'board-detail';
  document.body.replaceChildren(host);
  mountTaskDetailIsland(host);
  const task: BoardTask = {
    id: 't-nightly',
    title: 'Post the nightly index to the Saltmarsh relay',
    status: 'todo',
    assignee: 'Riverbend Bot',
    goal: CHORES_ID,
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-nightly',
    createdAt: NOW,
    updatedAt: NOW,
  } as BoardTask;
  const ask = {
    kind: 'task-review',
    band: 'declared',
    review: {
      shape: 'secret',
      headline: 'Paste the two relay values so the nightly post can run',
      detail: DETAIL,
      ownerOnly: true,
      secrets: FIELDS,
    },
    taskId: task.id,
    reviewItemId: 'r-secret',
    title: task.title,
    ask: 'Paste the two relay values so the nightly post can run',
    askedBy: 'Riverbend Bot',
    since: NOW - 60_000,
    askedAt: NOW - 60_000,
    direct: true,
  } as unknown as ReviewThreadItem;
  const discussion: TaskDiscussion = { loading: false, threads: [] };
  taskDetailData.value = {
    task,
    discussion,
    handlers: {
      onClose: () => {},
      onStatusSet: () => {},
      onTitleCommit: () => {},
      onAnswer: () => {},
      onAnswerThread: () => {},
      asks: [ask],
      onSaveSecrets: async () => true,
      secretsGate: 'open',
    } as unknown as DetailHandlers,
  };
  await frame();
  // The description a real task carries. The panel is only as tall as what is
  // in it, and an empty one leaves the whole form on screen — the state the
  // sticky row behaves perfectly in. This is what makes the panel scroll, and
  // `formFootBelowFold` is the reading that says it worked.
  const slot = document.querySelector('.board-detail-body-slot');
  if (slot) {
    slot.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const para = document.createElement('p');
      para.textContent =
        'Agent can post the nightly index to the Saltmarsh relay so that the ' +
        'archive stays fresh overnight without anybody opening a terminal.';
      slot.append(para);
    }
  }
  for (const box of boxes()) {
    box.value = THREE_LINES;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Two frames: one for the paint, one for the card's own clearance effect.
  await frame();
  await frame();
}

/** Answers as JSON text: `ui-shot` hands `--eval`'s value back as a string. */
export async function secretSaveBarProbe(): Promise<string> {
  await paint();
  const panel = document.querySelector('.board-detail-panel') as HTMLElement;
  const form = document.querySelector('.board-walk-cred-form') as HTMLElement;
  const bar = document.querySelector('.board-walk-cred-send-row') as HTMLElement;
  const send = document.querySelector('.board-walk-cred-send') as HTMLElement;
  const fields = boxes();

  /** Is Save inside the part of the panel a reader can see? */
  const saveShown = (): boolean => {
    const s = send.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return s.top >= p.top && s.bottom <= p.bottom;
  };

  const firstDraw = fields.map((_, i) => readField(i));
  const saveShownOnFirstDraw = saveShown();

  const pad = getComputedStyle(panel).scrollPaddingBottom;
  panel.scrollTop = 0;
  await frame();
  const formOverflowsPanel =
    form.getBoundingClientRect().height + 92 > panel.getBoundingClientRect().height ||
    panel.scrollHeight > panel.clientHeight;

  /** Every field at every scroll position, in steps of a third of a field. */
  const sweep = async (): Promise<FieldReading[]> => {
    const out: FieldReading[] = [];
    const step = 24;
    for (let top = 0; top <= panel.scrollHeight - panel.clientHeight; top += step) {
      panel.scrollTop = top;
      await frame();
      for (let i = 0; i < fields.length; i++) out.push(readField(i));
    }
    return out;
  };

  /**
   * Put the reader where a reader is: scrolled down to the field, with it
   * just inside the bottom of the panel and Save past the edge below it.
   * Starting from the panel's top instead would hand some fixtures a field
   * that needs no scroll at all, and the tap would prove nothing.
   */
  const aimAt = async (i: number): Promise<void> => {
    const field = fields[i] as HTMLTextAreaElement;
    field.blur();
    panel.scrollTop = 0;
    await frame();
    panel.scrollTop +=
      field.getBoundingClientRect().bottom - (panel.getBoundingClientRect().bottom - 20);
    await frame();
    field.focus();
    await frame();
  };

  const focused: FieldReading[] = [];
  const saveShownWhenFocused: boolean[] = [];
  for (let i = 0; i < fields.length; i++) {
    await aimAt(i);
    focused.push(readField(i));
    saveShownWhenFocused.push(saveShown());
  }
  (fields[0] as HTMLTextAreaElement).blur();

  const atRest = await sweep();

  // Control one: stick the row back down, which is the rule this round took
  // out, and sweep again. It has to find Save over a field.
  bar.style.position = 'sticky';
  bar.style.bottom = 'calc(8px + var(--safe-bottom, 0px))';
  bar.style.background = 'var(--bg-panel)';
  const atRestWithStickyRow = await sweep();
  bar.style.position = '';
  bar.style.bottom = '';
  bar.style.background = '';

  // Control two: take the reserved room off, and Save no longer comes along
  // when a field is tapped.
  panel.style.scrollPaddingBottom = '0px';
  const saveShownWhenFocusedUnreserved: boolean[] = [];
  for (let i = 0; i < fields.length; i++) {
    await aimAt(i);
    saveShownWhenFocusedUnreserved.push(saveShown());
  }
  panel.style.scrollPaddingBottom = '';
  (fields[0] as HTMLTextAreaElement).blur();
  panel.scrollTop = 0;

  const probe: Probe = {
    panel: rect(panel),
    form: rect(form),
    bar: rect(bar),
    barPosition: getComputedStyle(bar).position,
    scrollPadBottom: pad,
    formOverflowsPanel,
    firstDraw,
    saveShownOnFirstDraw,
    focused,
    saveShownWhenFocused,
    atRest,
    atRestWithStickyRow,
    saveShownWhenFocusedUnreserved,
  };
  return JSON.stringify(probe);
}

declare global {
  interface Window {
    secretSaveBarProbe?: () => Promise<string>;
  }
}
window.secretSaveBarProbe = secretSaveBarProbe;
