/**
 * The doc page's review-item dock: a ticket's ask that links this doc, in a
 * bar across the bottom of the screen, answerable where the doc is being read.
 *
 * A mock gets this from the widget. The doc page loads no widget, so the ask
 * lived only on the ticket and the reader had to leave the doc to answer the
 * question about it. This draws the SAME dock — markup, sheet and styles are
 * `core/review-dock*.ts`, mounted in a shadow root so the widget's CSS applies
 * unchanged — and supplies the two things that are this page's own: the items,
 * off the doc record the page already reads (`linkedItems`, left out for a
 * share visitor and when nothing links the doc), and the answer, through the
 * ticket's own route.
 *
 * The bar sits outside the doc, so the page gives its height back:
 * `--doc-dock-h` is the bar's measured height, and doc.css shortens `#shell`
 * and lifts the composer, the toast and the phone's comment sheet by it. With
 * no item nothing is mounted and the variable is never set.
 *
 * Calm: nothing moves, pulses or wears a count.
 */
import type { User } from '@claude-workspaces/core';
import {
  type DockItem,
  dockBarHtml,
  dockItems,
  dockSheetHtml,
  linkedDockItems,
  wireDockSheet,
} from '@claude-workspaces/core/review-dock';
import { dockStyles } from '@claude-workspaces/core/review-dock-styles';
import { api } from '../doc-path.ts';
import type { MountScope } from '../mount-scope.ts';
import type { DocRecordReader } from './doc-record.ts';

/** The pieces of the widget's base sheet the dock's markup leans on: the
 *  host's viewport variables, the 44px close button and the pill buttons. */
const HOST_STYLES = `
:host { all: initial; --cw-vv-bottom: 0px; --cw-vv-left: 0px; --cw-vv-right: 100vw; --cw-edge: max(0px, 100% - var(--cw-vv-right)); }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.icon-btn { background: transparent; border: 0; font-size: 18px; cursor: pointer; color: #6e7781; min-width: 44px; min-height: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.icon-btn:hover { color: #1b1f23; }
.primary, .cancel { background: #fff; border: 1px solid #d1d5da; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
.primary { background: #2e7dd7; color: #fff; border-color: #2e7dd7; }
.primary:hover { filter: brightness(1.06); }
button:disabled, textarea:disabled { opacity: 0.55; cursor: default; }
`;

/**
 * After the dock's sheet, so it wins. The widget is a guest on a page it does
 * not know, so its bar stands over everything; this page's own overlays — the
 * phone's comment sheet (950), the composer (1000), the thread view (1100),
 * the toast (1200) — are the reader's current task and belong over the bar.
 * The expanded item keeps the sheet's own place above all of them.
 */
const PAGE_STYLES = '.cw-dock { z-index: 900; }';

/** The variable doc.css reserves the bar's height with. */
export const DOCK_HEIGHT_VAR = '--doc-dock-h';

export interface LinkedDockOptions {
  /** The doc record reader the floats share — its first read is the router's. */
  record: DocRecordReader;
  user: User;
  /** Signed out: the ask is readable, and its answers are disabled. */
  canWrite: boolean;
  scope: MountScope;
  /** The answer request; injected so a test sees what went over the wire.
   *  Resolves true when the server took the answer. */
  post?: (path: string, body: Record<string, unknown>) => Promise<boolean>;
}

async function defaultPost(path: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export function mountLinkedDock(opts: LinkedDockOptions): void {
  const { record, user, canWrite, scope } = opts;
  const post = opts.post ?? defaultPost;
  const root = document.documentElement;
  let items: DockItem[] = [];
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let resize: ResizeObserver | null = null;

  const setHeight = (bar: HTMLElement | null): void => {
    if (!bar) {
      root.style.removeProperty(DOCK_HEIGHT_VAR);
      return;
    }
    root.style.setProperty(DOCK_HEIGHT_VAR, `${Math.round(bar.getBoundingClientRect().height)}px`);
  };

  const unmount = (): void => {
    resize?.disconnect();
    resize = null;
    host?.remove();
    host = null;
    shadow = null;
    setHeight(null);
  };

  const openItem = (item: DockItem): void => {
    if (!shadow) return;
    shadow.querySelector('.cw-dock-scrim')?.remove();
    const scrim = document.createElement('div');
    scrim.className = 'cw-dock-scrim';
    scrim.innerHTML = dockSheetHtml(item);
    shadow.appendChild(scrim);
    wireDockSheet(scrim, {
      send: (text, optionId) =>
        post(
          api(
            `tasks/${encodeURIComponent(item.taskId ?? '')}/review-items/${encodeURIComponent(item.threadId)}/answer`,
          ),
          { author: user, text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
        ),
      // The item is the ticket's, not this doc's, so nothing will sync it
      // away: drop it here. The bar goes, its height goes back to the doc,
      // and the reader's scroll position is left where it was.
      onAnswered: () => {
        items = items.filter((i) => i !== item);
        render();
      },
    });
    if (!canWrite) {
      for (const el of Array.from(
        scrim.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
          '.cw-answer-opt, .cw-answer-text, .cw-answer-send',
        ),
      )) {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
      }
    }
  };

  function render(): void {
    const item = dockItems([], items)[0];
    if (!item) {
      unmount();
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.className = 'doc-dock-host';
      shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = HOST_STYLES + dockStyles + PAGE_STYLES;
      shadow.appendChild(style);
      document.body.appendChild(host);
    }
    let bar = shadow?.querySelector('.cw-dock') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'cw-dock';
      shadow?.appendChild(bar);
    }
    bar.innerHTML = dockBarHtml(item);
    bar.querySelector('.cw-dock-item')?.addEventListener('click', () => openItem(item));
    // Measured, never assumed: the headline wraps to two lines at 430, and a
    // rotation or a zoom changes it again.
    setHeight(bar);
    if (!resize && typeof ResizeObserver !== 'undefined') {
      const observed = bar;
      resize = new ResizeObserver(() => setHeight(observed));
      resize.observe(observed);
    }
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') shadow?.querySelector('.cw-dock-scrim')?.remove();
  };
  document.addEventListener('keydown', onKey);
  scope.onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    unmount();
  });

  record
    .read()
    .then((body) => {
      if (scope.disposed) return;
      items = linkedDockItems((body as { linkedItems?: unknown } | null)?.linkedItems);
      render();
    })
    // A record that could not be read shows no dock; the floats that share
    // the read say so for themselves.
    .catch(() => {});
}
