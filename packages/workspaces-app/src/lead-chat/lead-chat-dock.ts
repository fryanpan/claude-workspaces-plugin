/**
 * The lead chat's dock on a wide screen: how wide the panel is, the drag on
 * its left edge that changes that, and the choices kept on the device — the
 * width and whether board events show. `lead-chat-view.ts` places the panel
 * with what this answers.
 *
 * While the panel is docked, `<html data-lc-docked>` and `--lc-dock-w` say
 * so, and the board's column makes room for it (board.css, PANE LAYOUT).
 * While it fills a narrow screen, `<html data-lc-full>` pins the board's
 * navbar to the bottom beneath it.
 */
import type { ModeStorage } from './lead-chat-mode.ts';

/** The docked panel's width until the reader drags it, and its bounds. */
export const DOCK_W = 420;
const DOCK_MIN = 320;
const DOCK_MAX = 720;
/** What the docked panel leaves of the page, at least. */
const PAGE_MIN = 400;
/** How far one arrow key moves the edge. */
const KEY_STEP = 16;
export const DOCK_WIDTH_KEY = 'cw.lead-chat.width';
export const CHANNEL_KEY = 'cw.lead-chat.channel';

export interface LeadChatDock {
  /** The panel's width on a page `vw` wide. */
  width(vw: number): number;
  /** Say the panel is docked at `w` pixels, or not docked. */
  docked(w: number | null): void;
  /** Say the panel fills the screen (at 1100px or narrower), or not. */
  full(on: boolean): void;
  showChannel(): boolean;
  toggleChannel(): void;
}

export function createDock(opts: {
  doc: Document;
  grip: HTMLElement;
  storage: ModeStorage | null;
  /** The width changed; place the panel again. */
  onResize(): void;
}): LeadChatDock {
  const { doc, grip, storage } = opts;
  const win = doc.defaultView ?? window;
  const html = doc.documentElement;
  const read = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      storage?.setItem(key, value);
    } catch {
      // Unkept, it still holds for this page.
    }
  };
  let show = read(CHANNEL_KEY) !== 'hide';
  let want = Number(read(DOCK_WIDTH_KEY)) || DOCK_W;
  const vw = (): number => html.clientWidth || win.innerWidth;
  const width = (w: number): number =>
    Math.round(Math.max(DOCK_MIN, Math.min(want, DOCK_MAX, w - PAGE_MIN)));
  const resize = (to: number, keep: boolean): void => {
    want = to;
    want = width(vw());
    if (keep) write(DOCK_WIDTH_KEY, String(want));
    opts.onResize();
  };

  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.classList.add('lc-dragging');
    grip.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (dragging) resize(vw() - e.clientX, false);
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('lc-dragging');
    write(DOCK_WIDTH_KEY, String(want));
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    resize(width(vw()) + step, true);
  });

  return {
    width,
    docked(w) {
      if (w === null) {
        delete html.dataset.lcDocked;
        html.style.removeProperty('--lc-dock-w');
      } else {
        html.dataset.lcDocked = 'true';
        html.style.setProperty('--lc-dock-w', `${w}px`);
      }
    },
    full(on) {
      if (on) html.dataset.lcFull = 'true';
      else delete html.dataset.lcFull;
    },
    showChannel: () => show,
    toggleChannel() {
      show = !show;
      write(CHANNEL_KEY, show ? 'show' : 'hide');
    },
  };
}
