/**
 * Where comment mode puts things, measured in a real browser with real input.
 *
 * Round 3 of the review-dock mock settled the LAYOUT the behaviours in
 * `widget-comment-mode.test.ts` live in, and the shipped widget missed it:
 *
 * - At iPad width the composer floated at the tap point and covered what was
 *   tapped. It is a card in the right margin at its element's height, joined
 *   to the element by a faint line, and on post it becomes the saved card
 *   with a tick, where it stood.
 * - At phone width the same floating box sat over the page and the banner
 *   sat over the page's title. It is a compact panel along the bottom, and
 *   the page behind holds still.
 * - With a finger, focus dropped back to the page after a tap on a plain
 *   element, so typing went nowhere. A mouse kept it, and the happy-dom suite
 *   fires a bare `pointerup`, which is why nothing caught it.
 * - Done left an empty composer on screen with the mode off.
 * - A mouse hovering in the mode showed no outline.
 *
 * Every one of those is about layout or about the browser's own event
 * sequence, which happy-dom does not have. `comment-layout-driver.ts` loads
 * the widget into headless Chromium at 1180x820 and 430x932 and drives it
 * with CDP touch, mouse and key input; this file asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Box, Look, Reading } from './comment-layout-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'comment-layout-driver.ts');
/** One launch, two page loads, about fifteen real inputs. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const look = (width: number, name: string): Look => {
  const l = at(width).looks[name];
  if (!l) throw new Error(`no look "${name}" at ${width}`);
  return l;
};

/** Square pixels two boxes share. */
function overlap(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

const box = (b: Box | null | undefined): Box => {
  if (!b) throw new Error('expected a painted box');
  return b;
};

describe.skipIf(CHROME === null)('where comment mode puts things', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    // The control for everything below: both page loads ran, and the mode
    // armed on each — a widget that never entered it would pass every
    // "nothing covers" case below by drawing nothing.
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
    expect(look(1180, 'entered').mode).toBe(true);
    expect(look(430, 'entered').mode).toBe(true);
  }, SUITE_MS);

  describe('at 1180, the composer is a card in the right margin', () => {
    it('puts the resting card away on Cancel, so the corner it stood over can be tapped', () => {
      // A finger has no Esc. Cancel used to open the same card again where it
      // stood, so a link under it could not be reached at all.
      const e = look(1180, 'entered');
      expect(
        overlap(box(e.card), box(e.el.acct)),
        'CONTROL: the resting card stands over the link',
      ).toBeGreaterThan(0);
      const l = look(1180, 'restCancelled');
      expect(l.mode, 'Cancel must not leave the mode').toBe(true);
      expect(l.card).toBeNull();
      expect(look(1180, 'onAcct').snippet).toBe('Account');
    });

    it('comments on a link rather than following it', () => {
      // Following it would leave the page, and the mode and its drafts with it.
      for (const name of ['onAcct', 'clickedAcct']) {
        const l = look(1180, name);
        expect(l.snippet, `CONTROL: the ${name} press reached the link`).toBe('Account');
        expect(l.mode).toBe(true);
        expect(l.hash, name).toBe('');
      }
    });

    it('sizes its field at 16px, so iPad Safari does not zoom the page when it takes focus', () => {
      // A zoom on focus moves the visual viewport the card is placed in.
      for (const [width, name] of [
        [1180, 'entered'],
        [1180, 'onNarrow'],
        [430, 'onLow'],
      ] as const) {
        expect(look(width, name).fieldPx, `${width} ${name}`).toBeGreaterThanOrEqual(16);
      }
    });

    it('stands level with an element that stops short of the margin, covering none of it', () => {
      const l = look(1180, 'onNarrow');
      const card = box(l.card);
      const el = box(l.el.narrow);
      expect(overlap(card, el), 'the card covers the element it is about').toBe(0);
      // The right margin: its right edge 16px in from the viewport's.
      expect(card[2]).toBe(1180 - 16);
      expect(Math.abs(card[1] - el[1]), 'level with its element').toBeLessThanOrEqual(1);
      // Two lines of text read as two words apart, not run together.
      expect(l.snippet).toBe('Ferry times Six sailings');
    });

    it('is joined to that element by a line from its edge to the card', () => {
      const l = look(1180, 'onNarrow');
      const card = box(l.card);
      const el = box(l.el.narrow);
      expect(l.lines).toHaveLength(1);
      const [x1, y1, x2, y2] = l.lines[0] as [number, number, number, number];
      // One end on the element's right edge, inside its height…
      expect(Math.abs(x1 - el[2])).toBeLessThanOrEqual(6);
      expect(y1).toBeGreaterThanOrEqual(el[1]);
      expect(y1).toBeLessThanOrEqual(el[3]);
      // …the other on the card's left edge, inside ITS height.
      expect(x2).toBe(card[0]);
      expect(y2).toBeGreaterThanOrEqual(card[1]);
      expect(y2).toBeLessThanOrEqual(card[3]);
    });

    it('steps below an element that reaches into the margin, rather than over it', () => {
      // A full-width element leaves no margin to stand beside. The card's
      // spot is still at the right edge, just under the element.
      const l = look(1180, 'onWide');
      const card = box(l.card);
      const el = box(l.el.wide);
      expect(el[2], 'CONTROL: the element really does reach the margin').toBeGreaterThan(card[0]);
      expect(overlap(card, el), 'the card covers the element it is about').toBe(0);
      expect(card[1]).toBeGreaterThanOrEqual(el[3]);
      expect(card[2]).toBe(1180 - 16);
      expect(l.snippet).toBe('The full timetable, across the page');
    });

    it('turns into the saved card, with a tick, where it stood', () => {
      const before = look(1180, 'onNarrow');
      const l = look(1180, 'posted');
      expect(l.posts).toEqual(['ferry times are wrong']);
      expect(l.saved, 'posting should leave a saved card on screen').not.toBeNull();
      const saved = l.saved as { box: Box; text: string };
      expect(saved.text).toContain('Saved');
      expect(saved.text).toContain('ferry times are wrong');
      // In the margin, still joined to the element it is about.
      expect(saved.box[0]).toBe(box(before.card)[0]);
      expect(overlap(saved.box, box(l.el.narrow))).toBe(0);
      expect(l.lines.some(([, , x2]) => x2 === saved.box[0])).toBe(true);
      // And the mode rests again in an empty, focused card that the saved one
      // does not sit on.
      expect(l.snippet).toBe('About this page');
      expect(l.draft).toBe('');
      expect(l.focus).toBe('TEXTAREA');
      expect(overlap(saved.box, l.card)).toBe(0);
    });

    it('stacks a second saved card below the first rather than over it', () => {
      const l = look(1180, 'posted2');
      expect(l.posts).toHaveLength(2);
      expect(l.posts[1]).toMatch(/^the timetable is missing Sunday/);
      expect(l.saves, 'CONTROL: both saved cards are still up').toHaveLength(2);
      const cards = [...l.saves, box(l.card)];
      for (const [i, a] of cards.entries()) {
        for (const b of cards.slice(i + 1)) expect(overlap(a, b), 'two cards overlap').toBe(0);
      }
    });

    it('ends a long saved comment on a whole line, never partway through one', () => {
      const [h, line, full] = look(1180, 'posted2').savedText ?? [0, 1, 0];
      expect(full, 'CONTROL: the comment is longer than the card shows').toBeGreaterThan(h + line);
      const lines = h / line;
      expect(Math.abs(lines - Math.round(lines)), `${lines} lines shown`).toBeLessThan(0.05);
      expect(Math.round(lines)).toBe(3);
    });

    it('leaves focus in the field when a finger lands on a saved card', () => {
      const l = look(1180, 'savedTapped');
      expect(look(1180, 'posted2').focus, 'CONTROL: the field had focus before').toBe('TEXTAREA');
      expect(l.saves.length, 'CONTROL: a saved card was there to tap').toBeGreaterThan(0);
      expect(l.focus).toBe('TEXTAREA');
    });

    it('keeps the card inside the visual viewport, not the layout viewport', () => {
      const l = look(1180, 'zoomed');
      const [top, height, left, width] = l.vv;
      expect(top, 'CONTROL: the visible part starts below the layout top').toBeGreaterThan(100);
      expect(height, 'CONTROL: and is shorter than the window').toBeLessThan(820);
      const card = box(l.card);
      expect(card[1]).toBeGreaterThanOrEqual(top);
      expect(card[3]).toBeLessThanOrEqual(top + height);
      // Sideways too: zoomed in, the window's right edge is off screen.
      expect(left + width, 'CONTROL: the right edge is off screen').toBeLessThan(1164);
      expect(card[0]).toBeGreaterThanOrEqual(left);
      expect(card[2]).toBeLessThanOrEqual(left + width);
      // And a line's element end, though that element is off to the left.
      expect(box(l.el.narrow)[2], 'CONTROL: an element is off to the left').toBeLessThan(left);
      for (const [x1] of l.lines) expect(x1).toBeGreaterThanOrEqual(left);
    });

    it('stays clear of the FAB and the list button for an element low on the screen', () => {
      const l = look(1180, 'onLowDesk');
      const card = box(l.card);
      expect(l.controls.length, 'CONTROL: the mode has buttons painted').toBeGreaterThan(0);
      const reach = box(l.el.low)[1] + (card[3] - card[1]);
      expect(
        reach,
        'CONTROL: a card level with the element would reach the buttons',
      ).toBeGreaterThan(Math.min(...l.controls.map((c) => c[1])));
      for (const c of l.controls) expect(overlap(card, c), 'the card covers a button').toBe(0);
      expect(overlap(card, l.el.low)).toBe(0);
    });

    it('puts the dot on an element that sits lower than the top of the buttons', () => {
      // Held to the card's room, which ends above the FAB, the dot sat above it.
      for (const name of ['onLowDesk', 'lowOpen', 'lowTwice']) {
        const l = look(1180, name);
        const el = box(l.el.low);
        const floor = Math.min(...l.controls.map((c) => c[1]));
        expect(el[1], `CONTROL: ${name}: it starts below the buttons`).toBeGreaterThan(floor);
        expect(l.lines.length, `CONTROL: ${name}: a card is joined to it`).toBeGreaterThan(0);
        for (const [x1, y1] of l.lines) {
          const dx = Math.max(el[0] - x1, 0, x1 - el[2]);
          const dy = Math.max(el[1] - y1, 0, y1 - el[3]);
          expect(Math.hypot(dx, dy), `${name}: the dot is off its element`).toBeLessThanOrEqual(4);
        }
      }
    });

    it('keeps every line on screen for an element taller than the screen', () => {
      // The line ran from the card to the element's far edge, off the bottom
      // of the screen and through whatever bar the page keeps there.
      const l = look(1180, 'onTall');
      const [top, height] = l.vv;
      expect(box(l.el.tall)[3], 'CONTROL: the element runs past the bottom').toBeGreaterThan(820);
      expect(l.snippet, 'CONTROL: its card is open').toBe('The route map');
      expect(l.lines.length, 'CONTROL: and has a line').toBeGreaterThan(0);
      for (const [x1, y1, x2, y2] of l.lines) {
        for (const y of [y1, y2]) {
          expect(y).toBeGreaterThanOrEqual(top);
          expect(y, 'a line runs off the screen').toBeLessThanOrEqual(top + height);
        }
        // Nor through a button: the box it spans, a pixel wider so it has area.
        const [lo, hi] = [Math.min, Math.max].map((f) => [f(x1, x2), f(y1, y2)]);
        const span: Box = [lo[0], lo[1], hi[0] + 1, hi[1] + 1];
        for (const c of l.controls) expect(overlap(span, c), 'through a button').toBe(0);
      }
    });

    it('stacks two quick posts on an element low on the screen rather than piling them up', () => {
      // A saved card stepped down past the one above it, off the bottom of the
      // screen, and was clamped back on top of it.
      for (const [name, count] of [
        ['lowOpen', 2],
        ['lowTwice', 3],
      ] as const) {
        const l = look(1180, name);
        expect(box(l.el.low)[1], `CONTROL: ${name}'s element is low on the screen`).toBeGreaterThan(
          820 / 2,
        );
        const cards = l.card ? [...l.saves, l.card] : l.saves;
        expect(cards, `CONTROL: ${name} has cards to stack`).toHaveLength(count);
        for (const [i, a] of cards.entries()) {
          for (const b of cards.slice(i + 1))
            expect(overlap(a, b), `${name}: two cards overlap`).toBe(0);
          for (const c of l.controls)
            expect(overlap(a, c), `${name}: a card covers a button`).toBe(0);
          expect(a[1]).toBeGreaterThanOrEqual(0);
          expect(a[3]).toBeLessThanOrEqual(820);
        }
      }
    });

    it('keeps a typed draft through Done, Esc and X, and gives it back on that element', () => {
      expect(look(1180, 'done').card, 'CONTROL: Done took the card off screen').toBeNull();
      expect(look(1180, 'reentered').draft, 'the resting card is about the page').toBe('');
      expect(look(1180, 'reopened').draft).toBe('Riverbend stop shelter');
      expect(look(1180, 'escaped').card, 'CONTROL: Esc closed the card').toBeNull();
      expect(look(1180, 'reopenedEsc').draft).toBe('Riverbend stop shelter');
      expect(look(1180, 'reopenedX').draft).toBe('Riverbend stop shelter');
    });

    it('keeps a draft whose post failed after the mode closed', () => {
      const l = look(1180, 'afterFailed');
      expect(l.posts.at(-1), 'CONTROL: the held post was sent').toBe('Riverbend stop shelter');
      expect(l.snippet).toBe('Parking');
      expect(l.draft).toBe('Riverbend stop shelter');
    });

    it('does not keep a draft that was already posting when the mode closed', () => {
      const l = look(1180, 'afterPending');
      expect(l.posts.at(-1), 'CONTROL: the held post landed').toBe('Riverbend stop shelter');
      expect(l.mode, 'CONTROL: the element opened again').toBe(true);
      expect(l.snippet).toBe('Parking');
      expect(l.draft).toBe('');
    });

    it('gives each element its own draft when a tap moves from one to the other', () => {
      // Both had words kept. The card used to carry the open one's words onto
      // the other element and throw that element's own away.
      const l = look(1180, 'switched');
      expect(l.snippet, 'CONTROL: the card moved').toBe('The full timetable, across the page');
      expect(l.draft).toBe('Timetable note');
      const back = look(1180, 'switchedBack');
      expect(back.snippet, 'CONTROL: and moved back').toBe('Ferry times Six sailings');
      expect(back.draft).toBe('Ferry note');
    });

    it('keeps the words typed in the resting card when a tap opens an element with its own', () => {
      const l = look(1180, 'fromRest');
      expect(l.snippet, 'CONTROL: the card moved').toBe('The full timetable, across the page');
      expect(l.draft).toBe('Timetable note');
      const back = look(1180, 'restBack');
      expect(back.snippet, 'CONTROL: the resting card is about the page').toBe('About this page');
      expect(back.draft).toBe('About the day');
    });

    it('moves a draft onto the bottom panel when the iPad turns to portrait, and back', () => {
      const p = look(1180, 'portrait');
      expect(p.mode).toBe(true);
      expect([box(p.card)[0], box(p.card)[2], box(p.card)[3]]).toEqual([0, 820, 1180]);
      expect(p.draft).toBe('Riverbend stop shelter');
      expect(p.snippet).toBe('The full timetable, across the page');
      expect(p.outlined).toBe('wide');
      const l = look(1180, 'landscape');
      expect(box(l.card)[2]).toBe(1180 - 16);
      expect(l.draft).toBe('Riverbend stop shelter');
      expect(l.snippet).toBe('The full timetable, across the page');
      expect(overlap(box(l.card), l.el.wide)).toBe(0);
    });
  });

  describe('a finger keeps the focus the tap gave the field', () => {
    for (const width of [1180, 430]) {
      it(`at ${width}, typing after a tap on a plain element lands in the field`, () => {
        // The driver tapped a <div> with CDP touch and then typed. Before the
        // fix the compatibility mousedown that follows a touch moved focus
        // to the page, and the typed words went nowhere.
        const l = look(width, 'onNarrow');
        expect(l.focus).toBe('TEXTAREA');
        expect(l.draft).toBe('ferry times are wrong');
      });
    }
  });

  describe('at 430, commenting happens in a panel along the bottom', () => {
    it('enters the mode as a prompt at the bottom, off the page title', () => {
      const l = look(430, 'entered');
      const banner = box(l.banner);
      expect(banner[3], 'the prompt sits on the bottom edge').toBe(932);
      expect([banner[0], banner[2]]).toEqual([0, 430]);
      expect(overlap(banner, l.el.title), 'the prompt covers the page title').toBe(0);
      expect(l.card, 'no composer before an element is tapped').toBeNull();
    });

    it('opens the composer as that panel, leaving the tapped element on screen and the page still', () => {
      const l = look(430, 'onNarrow');
      const panel = box(l.card);
      expect([panel[0], panel[2], panel[3]]).toEqual([0, 430, 932]);
      expect(overlap(panel, l.el.narrow), 'the panel covers the tapped element').toBe(0);
      expect(l.scrollY, 'the page moved under the reader').toBe(0);
      expect(l.outlined).toBe('narrow');
      // One panel, not two: the prompt steps aside while the composer is up.
      expect(l.banner).toBeNull();
    });

    it('moves the page by just enough when the tapped element is under the panel', () => {
      const before = look(430, 'posted');
      const l = look(430, 'onLow');
      const panel = box(l.card);
      expect(
        overlap(box(before.el.low), [0, panel[1], 430, 932]),
        'CONTROL: the element really did start under the panel',
      ).toBeGreaterThan(0);
      expect(overlap(panel, l.el.low)).toBe(0);
      // Just enough: the element ends a small gap above the panel, not
      // scrolled to the top of the screen.
      const gap = panel[1] - box(l.el.low)[3];
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(16);
    });

    it('moves the page again when the panel grows over that element as you type', () => {
      const height = (b: Box | null) => box(b)[3] - box(b)[1];
      const l = look(430, 'grown');
      expect(height(l.card), 'CONTROL: the panel grew').toBeGreaterThan(
        height(look(430, 'onLow').card),
      );
      expect(overlap(box(l.card), l.el.low), 'the panel grew over the element').toBe(0);
    });

    it('offers Done on the panel, which steps away and keeps the draft for that element', () => {
      // The prompt's Done and the FAB fold away while the panel is up, and
      // Cancel throws the words out: there was no way to leave and keep them.
      const l = look(430, 'onLow');
      const done = box(l.done);
      const post = box(l.post);
      // A row above Post and a column off it — never beside it, where the two
      // read as one button and Done would take the comment with it.
      expect(done[3]).toBeLessThanOrEqual(post[1]);
      expect(done[2]).toBeLessThanOrEqual(post[0]);
      const away = look(430, 'phoneAway');
      expect(away.mode).toBe(false);
      expect(away.card).toBeNull();
      expect(away.fab, 'the way back into the mode').toBe(true);
      const typed = look(430, 'grown').draft ?? '';
      expect(typed.length, 'CONTROL: there were words to keep').toBeGreaterThan(0);
      const back = look(430, 'phoneBack');
      expect(back.snippet, 'CONTROL: the panel opened on the same element').toBe('Parking');
      expect(back.draft).toBe(typed);
    });

    it('keeps the panel a tap opens, though the click after it lands where it stands', () => {
      // The panel opens on the pointerup, and a finger's click follows it,
      // hit-tested where the finger was: on the panel's Cancel, which closed
      // the panel as it opened. On a link, the link is not followed either.
      const l = look(430, 'onFare');
      expect(l.scrollY, 'CONTROL: the tap opened a panel, which nudged the page').toBeGreaterThan(
        0,
      );
      expect(l.card, "the tap's own click closed the panel").not.toBeNull();
      expect(l.snippet).toBe('Fares');
      const a = box(l.el.fare);
      // Where the finger was: the link's middle before the nudge scrolled it.
      const [x, y] = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2 + l.scrollY];
      const c = box(l.card);
      expect(
        c[0] <= x && x <= c[2] && c[1] <= y && y <= c[3],
        'CONTROL: the panel stands where the finger was',
      ).toBe(true);
      expect(l.mode).toBe(true);
      expect(l.hash).toBe('');
    });

    it('goes back to its prompt with a tick after a post, still in the mode', () => {
      const l = look(430, 'posted');
      expect(l.posts).toEqual(['ferry times are wrong']);
      expect(l.mode).toBe(true);
      expect(l.card).toBeNull();
      expect(box(l.banner)[3]).toBe(932);
      expect(l.tick).toBe(true);
    });
  });

  describe('Done leaves nothing of the mode on the page', () => {
    // At 1180 Done is pressed with a card and its line up, which is the case
    // that used to leave an empty composer behind. At 430 it is the prompt's
    // Done, after Cancel; the panel's own Done has its case above.
    for (const width of [1180, 430]) {
      it(`at ${width}`, () => {
        const before = look(width, width > 1100 ? 'onWide' : 'cancelled');
        if (width > 1100) {
          expect(before.card, 'CONTROL: a card was up to clear').not.toBeNull();
          expect(before.lines.length, 'CONTROL: and its line').toBeGreaterThan(0);
        } else {
          expect(before.banner, 'CONTROL: the prompt was up to clear').not.toBeNull();
        }
        const l = look(width, 'done');
        expect(l.mode).toBe(false);
        expect(l.card, 'an empty composer is left behind').toBeNull();
        expect(l.saved).toBeNull();
        expect(l.lines).toEqual([]);
        expect(l.banner).toBeNull();
        expect(l.fab, 'the way back into the mode').toBe(true);
      });
    }
  });

  it('at 1180 a mouse hovering in the mode outlines what a click would pick', () => {
    // The mode rests in a card about the page, and that used to switch the
    // hover off entirely.
    expect(look(1180, 'entered').outlined, 'CONTROL: nothing outlined before').toBeNull();
    expect(look(1180, 'hovered').outlined).toBe('narrow');
  });
});
