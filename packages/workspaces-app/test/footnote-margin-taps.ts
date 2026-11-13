/**
 * The pointer and the taps a reader makes on the footnote fixture, measured:
 * what a pointer moving over the body does to the text under it, and what a
 * tap on a superscript or a caption does to the margin captions. Split out of
 * `footnote-margin-driver.ts`, which mounts the fixture and calls these.
 */
import type { createEditor } from '../src/editor.ts';

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the pointer moving over body text did to it. */
export interface HoverReading {
  /** Superscripts the pointer crossed, and the lines of text measured. */
  crossed: number;
  lines: number;
  /** Lines whose box changed by more than half a pixel, as `n:dx,dy,dw,dh`. */
  shifted: string[];
  /** Runs showing their raw `^[…]` characters afterwards. */
  rawShown: number;
  /** Superscript spans the editor replaced with new ones while the pointer
   *  moved — a redraw of the paragraph under the pointer. */
  replaced: number;
  /** Superscripts drawn shaded while the pointer was over them — the
   *  control that the hover still lights its note. */
  litWhileOver: number;
}

/** Heights are `offsetHeight` px; `lineHeight` is one caption line. */
export interface CompactReading {
  lineHeight: number;
  /** Every caption at rest, nothing open. */
  restMin: number;
  restMax: number;
  /** Captions whose text is wider than their line — the control that a
   *  caption at full length would have wrapped. */
  truncated: number;
  /** After a tap on note 3's superscript in the text. */
  viaSuperscript: { open: number; othersMax: number; openCount: number };
  /** After a second tap on the same superscript. */
  closedAgain: { height: number; openCount: number; moved: number };
  /** A tap on caption 4, then on caption 5. */
  viaCaption: { open4: number; then4: number; then5: number; openCount: number };
  /** After a second tap on caption 5. */
  closedCaption: { height: number; openCount: number };
}

/**
 * Move the pointer across the body the way a reader skims: over each
 * paragraph and each of its superscripts in turn, with the browser's own
 * hover events, and read every text line's box before and after. Body text
 * that moves under a moving pointer is the fault (Bryan, 2026-11-02: "as I
 * move my cursor over the body text, raw citation details expand and shift
 * everything around").
 */
export async function hoverReading(editor: ReturnType<typeof createEditor>): Promise<HoverReading> {
  const blocks = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('#editor .ProseMirror > p, #editor .ProseMirror li'),
  ];
  const boxes = (): DOMRect[] => blocks().map((b) => b.getBoundingClientRect());
  const editorEl = document.getElementById('editor') as HTMLElement;
  editorEl.scrollTop = 0;
  // The reader clicked into the doc at some point: the caret sits at the end
  // of a sourced sentence, just before its note's characters.
  const view = editor.editor.view;
  // The run's FIRST piece: the number sits on its closing `]`, inside it.
  const at = document.querySelector<HTMLElement>('.cw-fn[data-cw-fn-run="2"]') as HTMLElement;
  view.focus();
  editor.editor.commands.setTextSelection(view.posAtDOM(at, 0));
  await frame();
  await sleep(250);
  const before = boxes();
  const runs = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]'),
  ];
  let crossed = 0;
  let litWhileOver = 0;
  const original = runs();
  const count = original.length;
  for (let i = 0; i < count; i++) {
    const run = runs()[i];
    if (!run) continue;
    const block = run.closest('p, li') as HTMLElement | null;
    for (const el of [block, run, block]) {
      if (!el) continue;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await frame();
      if (el === run) {
        crossed++;
        const shade = getComputedStyle(run, '::after').backgroundColor;
        if (shade !== 'rgba(0, 0, 0, 0)' && shade !== 'transparent') litWhileOver++;
      }
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    }
  }
  await sleep(250);
  await frame();
  const after = boxes();
  const shifted: string[] = [];
  for (const [i, a] of before.entries()) {
    const b = after[i];
    if (!b) continue;
    const d = [b.left - a.left, b.top - a.top, b.width - a.width, b.height - a.height];
    if (d.some((x) => Math.abs(x) > 0.5)) shifted.push(`${i}:${d.map(Math.round).join(',')}`);
  }
  if (after.length !== before.length) shifted.push(`count:${before.length}->${after.length}`);
  return {
    crossed,
    lines: before.length,
    shifted,
    rawShown: document.querySelectorAll('.cw-fn-open').length,
    replaced: original.filter((el) => !el.isConnected).length,
    litWhileOver,
  };
}

/** Tap the way a reader does — the superscript in the text, then the
 *  captions in the margin — and measure every caption after each tap. Leaves
 *  note 3 open, in view, for the screenshot. */
export async function compactReading(cards: HTMLElement[]): Promise<CompactReading> {
  const settle = async (): Promise<void> => {
    await frame();
    await sleep(250);
    await frame();
  };
  const card = (n: string): HTMLElement => cards.find((c) => c.dataset.cwFnN === n) as HTMLElement;
  // Asked fresh each time: the decoration plugin replaces the spans on a
  // rebuild, and a click on a detached one reaches nothing.
  const run = (n: string): HTMLElement =>
    document.querySelector<HTMLElement>(`.cw-fn[data-cw-fn="${n}"]`) as HTMLElement;
  // A tap on a touch screen sends a mouseover first, which lights the note —
  // and the editor redraws a span a class was written onto, so the tap lands
  // on a superscript that is about to be replaced.
  const tap = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const openCount = (): number =>
    cards.filter((c) => c.classList.contains('cw-fn-note-open')).length;
  const heights = (): number[] => cards.map((c) => c.offsetHeight);

  run('3').scrollIntoView({ block: 'center' });
  await settle();
  const lineHeight = Number.parseFloat(getComputedStyle(card('3')).lineHeight);
  const rest = heights();
  const restTops = cards.map((c) => c.offsetTop);
  const truncated = cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length;

  tap(run('3'));
  await settle();
  const viaSuperscript = {
    open: card('3').offsetHeight,
    othersMax: Math.max(...cards.filter((c) => c !== card('3')).map((c) => c.offsetHeight)),
    openCount: openCount(),
  };

  tap(run('3'));
  await settle();
  const closedAgain = {
    height: card('3').offsetHeight,
    openCount: openCount(),
    moved: Math.max(...cards.map((c, i) => Math.abs(c.offsetTop - (restTops[i] as number)))),
  };

  tap(card('4'));
  await settle();
  const open4 = card('4').offsetHeight;
  tap(card('5'));
  await settle();
  const viaCaption = {
    open4,
    then4: card('4').offsetHeight,
    then5: card('5').offsetHeight,
    openCount: openCount(),
  };
  tap(card('5'));
  await settle();
  const closedCaption = { height: card('5').offsetHeight, openCount: openCount() };

  tap(run('3'));
  await settle();
  return {
    lineHeight,
    restMin: Math.min(...rest),
    restMax: Math.max(...rest),
    truncated,
    viaSuperscript,
    closedAgain,
    viaCaption,
    closedCaption,
  };
}
