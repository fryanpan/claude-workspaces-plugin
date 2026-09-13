/**
 * The secret ask's value boxes, with long values in them, built for a real
 * browser.
 *
 * `secret-key-field-driver.ts` bundles this, loads it on both surfaces the
 * form has — Home's walkthrough and the task panel — at several viewports, and
 * reads the JSON `window.cwKeyFieldRead` returns. Each surface is painted by
 * the fixture its own Save test already uses, so what is measured here is the
 * page those tests measure, with a longer paste.
 *
 * Every value is an obvious placeholder (`harborlight-fake-000…`), and none is
 * ever returned: the readings are rectangles, class names and scroll offsets.
 */
import { paint as paintPanel } from './secret-save-bar-driver.ts';
import { paint as paintHome } from './secret-save-home-page.ts';

/** Far wider than any box, and three lines of it — a pasted key file. */
const LINE = `harborlight-fake-${'0'.repeat(160)}`;
const LONG = `${LINE}\n${LINE}\n${LINE}`;
/** Fits in the box at every width measured. */
const SHORT = 'harborlight-fake-0';

export type Surface = 'home' | 'panel';

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Which … marks a field is showing, and where. */
export interface Marks {
  start: boolean;
  end: boolean;
  /** Every mark's text — each must be a literal … and nothing else. */
  text: string[];
  /** Every mark sits inside its field's row, on screen. */
  inside: boolean;
}

export interface Reading {
  surface: Surface;
  width: number;
  height: number;
  /** Row (field + eye) and field heights, empty and with LONG pasted. The
   *  claim is that the two lists are equal. */
  rowsEmpty: number[];
  rowsLong: number[];
  fieldsEmpty: number[];
  fieldsLong: number[];
  /** CONTROL: LONG really is three lines tall inside a field — its scroll
   *  height over the field's own client height. A value that fits in one line
   *  would make the equality above say nothing. */
  linesInLong: number[];
  /** Marks with LONG in every field and nothing focused. */
  longAtRest: Marks[];
  /** Marks with SHORT in every field — the negative: nothing to mark. */
  shortAtRest: Marks[];
  /** Marks on the last field while it has the caret at the end of LONG. */
  longFocused: Marks;
  /** And once it lets go of the caret: back to showing the start. */
  longBlurred: Marks;
  /** Marks on the first field after its eye reveals LONG. */
  longRevealed: Marks;
  /** Every sampled point on Save, after tapping the last field and pasting
   *  LONG into all three: what `elementFromPoint` names there. */
  saveHits: string[];
  /** Where the scroller sat before and after a burst of re-renders — values
   *  arriving and eyes toggled — with the reader scrolled away from the form. */
  scrollAway: number;
  scrollAfterRenders: number;
  /** CONTROL: where the card's own first-draw scroll puts the scroller from
   *  that same spot. It has to differ from `scrollAway`, or a pull-back would
   *  be invisible and the equality above would say nothing. */
  scrollIfPulled: number;
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Frames until `done` holds, or give up after a second's worth. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !done(); i++) await frame();
}

const need = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`fixture is missing ${sel}`);
  return el;
};

const fields = (): HTMLTextAreaElement[] =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));
const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.board-walk-cred-box'));
const heightOf = (el: Element): number => Math.round(el.getBoundingClientRect().height);

const nameOf = (el: Element | null): string => {
  if (!el) return 'nothing';
  const cls = typeof el.className === 'string' ? el.className.trim() : '';
  return cls === ''
    ? el.tagName.toLowerCase()
    : `${el.tagName.toLowerCase()}.${cls.split(/\s+/).join('.')}`;
};

async function fill(value: string): Promise<void> {
  for (const box of fields()) {
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await frame();
  await frame();
}

function marksOf(i: number): Marks {
  const row = rows()[i] as HTMLElement;
  const r = row.getBoundingClientRect();
  const marks = Array.from(row.querySelectorAll<HTMLElement>('.board-walk-cred-more'));
  return {
    start: marks.some((m) => m.classList.contains('is-start')),
    end: marks.some((m) => m.classList.contains('is-end')),
    text: marks.map((m) => m.textContent?.trim() ?? ''),
    inside: marks.every((m) => {
      const b = m.getBoundingClientRect();
      return (
        b.width > 0 &&
        b.left >= r.left &&
        b.right <= r.right &&
        b.top >= r.top &&
        b.bottom <= r.bottom &&
        getComputedStyle(m).visibility === 'visible'
      );
    }),
  };
}

/** Every 4px across Save, 1px inside its edge. */
function saveHits(): string[] {
  const b = need<HTMLElement>('.board-walk-cred-send').getBoundingClientRect();
  const out: string[] = [];
  for (let y = b.top + 1; y <= b.bottom - 1; y += 4) {
    for (let x = b.left + 1; x <= b.right - 1; x += 4) {
      out.push(nameOf(document.elementFromPoint(x, y)));
    }
  }
  return out;
}

/** The box that scrolls on each surface: the panel is an overflow box, Home
 *  is a page in the viewport. */
interface Scroller {
  get: () => number;
  set: (top: number) => void;
  max: () => number;
}
function scroller(surface: Surface): Scroller {
  if (surface === 'panel') {
    // Looked up on every call: each paint replaces the panel.
    const panel = (): HTMLElement => need<HTMLElement>('.board-detail-panel');
    return {
      get: () => Math.round(panel().scrollTop),
      set: (top) => {
        panel().scrollTop = top;
      },
      max: () => panel().scrollHeight - panel().clientHeight,
    };
  }
  const root = document.documentElement;
  return {
    get: () => Math.round(window.scrollY),
    set: (top) => window.scrollTo(0, top),
    max: () => root.scrollHeight - root.clientHeight,
  };
}

/** Where the card's own first-draw scroll takes the scroller from `top`. */
async function pulledFrom(scroll: Scroller, top: number): Promise<number> {
  scroll.set(top);
  await frame();
  need<HTMLElement>('.board-walk-cred-form').scrollIntoView({ block: 'nearest' });
  await frame();
  return scroll.get();
}

async function paint(surface: Surface): Promise<void> {
  if (surface === 'panel') await paintPanel();
  else await paintHome();
}

export async function read(surface: Surface, width: number, height: number): Promise<string> {
  await paint(surface);
  const scroll = scroller(surface);

  // ── Height: empty, then LONG. ──
  await fill('');
  const rowsEmpty = rows().map(heightOf);
  const fieldsEmpty = fields().map(heightOf);
  await fill(LONG);
  const rowsLong = rows().map(heightOf);
  const fieldsLong = fields().map(heightOf);
  const linesInLong = fields().map((f) => Math.round(f.scrollHeight / Math.max(1, f.clientHeight)));
  const longAtRest = rows().map((_, i) => marksOf(i));

  // ── The negative: a value that fits. ──
  await fill(SHORT);
  const shortAtRest = rows().map((_, i) => marksOf(i));

  // ── The caret at the end of a long value: its start has scrolled away. ──
  await fill(LONG);
  const last = fields().length - 1;
  const lastField = fields()[last] as HTMLTextAreaElement;
  lastField.focus();
  lastField.setSelectionRange(lastField.value.length, lastField.value.length);
  await until(() => marksOf(last).start);
  const longFocused = marksOf(last);
  lastField.blur();
  await until(() => !marksOf(last).start);
  const longBlurred = marksOf(last);

  // ── Revealed. ──
  need<HTMLButtonElement>('.board-walk-cred-eye').click();
  await until(() => fields()[0]?.classList.contains('is-shown') === true);
  await frame();
  const longRevealed = marksOf(0);
  need<HTMLButtonElement>('.board-walk-cred-eye').click();
  await frame();

  // ── Save, after the reader taps the last field and pastes into all three. ──
  await paint(surface);
  await fill('');
  scroll.set(0);
  await frame();
  const tapped = fields()[last] as HTMLTextAreaElement;
  tapped.focus();
  await frame();
  await frame();
  await fill(LONG);
  const hits = saveHits();
  tapped.blur();

  // ── Scrolled away, then re-rendered. ──
  // Away is whichever end of the scroll the form is out of view from: the
  // panel's form sits above the task's description, Home's below the ask.
  await paint(surface);
  const away = (await pulledFrom(scroll, 0)) !== 0 ? 0 : scroll.max();
  scroll.set(away);
  await frame();
  const scrollAway = scroll.get();
  const eyes = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.board-walk-cred-eye'));
  await fill(LONG);
  for (const eye of eyes()) eye.click();
  await frame();
  await fill(SHORT);
  for (const eye of eyes()) eye.click();
  await frame();
  await frame();
  await frame();
  const scrollAfterRenders = scroll.get();
  const scrollIfPulled = await pulledFrom(scroll, away);

  const reading: Reading = {
    surface,
    width,
    height,
    rowsEmpty,
    rowsLong,
    fieldsEmpty,
    fieldsLong,
    linesInLong,
    longAtRest,
    shortAtRest,
    longFocused,
    longBlurred,
    longRevealed,
    saveHits: hits,
    scrollAway,
    scrollAfterRenders,
    scrollIfPulled,
  };
  return JSON.stringify(reading);
}

declare global {
  interface Window {
    cwKeyFieldRead?: (surface: Surface, width: number, height: number) => Promise<string>;
  }
}
window.cwKeyFieldRead = read;
