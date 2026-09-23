import type { FeedbackWidgetEl } from '../widget.ts';

/**
 * The pencil in the widget's corner stack, and the fetch of edit mode behind
 * it.
 *
 * Edit mode lets a reviewer retype the words on the page and send the
 * changes to the agent as structured edits (`edit-mode.ts`). None of it is in
 * the budgeted `widget.iife.js`: this button rides in `mic.js` (an embed on a
 * dev server) and in `mockup-live.js` (a served mock), beside the mic, and the
 * mode itself is `edit.js`, fetched on the first tap — or at load, when the
 * page already has edits waiting on the agent, so their marks are painted
 * after a reload without anybody tapping.
 */

/** What `edit.js` puts on the window when it has loaded. */
export interface EditChunk {
  mountEditMode(widget: FeedbackWidgetEl, button: HTMLButtonElement): EditMode;
}

export interface EditMode {
  /** Enter edit mode, or leave it. */
  toggle(): void;
}

declare global {
  interface Window {
    cwEdit?: EditChunk;
  }
}

const PENCIL =
  '<svg class="fab-icon-pencil" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="fab-icon-close">×</span>';

/**
 * Third in the stack: the FAB at 18px, the mic at 74px, the pencil at 126px,
 * the same column as the mic. It folds away wherever the stack's own buttons
 * do — comment mode, the thread panel, the phone face's bottom panel — and
 * while its own mode is on it is the button that leaves it (`.open`).
 */
export const EDIT_BUTTON_CSS = [
  '.fab-edit{position:fixed;right:max(20px,calc(env(safe-area-inset-right) + 2px));margin-right:var(--cw-edge);bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(126px,calc(env(safe-area-inset-bottom) + 126px)));width:44px;height:44px;border-radius:50%;background:#fff;color:#2e7dd7;border:1px solid #d1d5da;cursor:pointer;box-shadow:0 3px 9px rgba(0,0,0,.18);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:0}',
  '.fab-edit:hover{border-color:#2e7dd7}',
  '.fab-edit .fab-icon-close{display:none;font-size:24px;line-height:1}',
  '.fab-edit.open{background:#1b1f23;border-color:#1b1f23;color:#fff}',
  '.fab-edit.open .fab-icon-pencil{display:none}',
  '.fab-edit.open .fab-icon-close{display:block}',
  '.fab.open~.fab-edit,.panel.open~.fab-edit,.fab-edit:has(~.quick),.quick~.fab-edit{display:none}',
].join('');

function appendScript(src: string): Promise<EditChunk> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.cwEdit ? resolve(window.cwEdit) : reject(new Error('edit.js')));
    s.onerror = () => reject(new Error('edit.js'));
    document.head.append(s);
  });
}

let loading: Promise<EditChunk> | null = null;

/** Fetched through the page holding a sandboxed frame, as `voice.js` is
 *  (`voice-loader.ts` says why). One fetch however many callers ask. */
function loadChunk(src: string): Promise<EditChunk> {
  if (window.cwEdit) return Promise.resolve(window.cwEdit);
  loading ??= (
    window.parent === window
      ? appendScript(src)
      : fetch(src)
          .then((res) => (res.ok ? res.text() : Promise.reject(new Error('edit.js'))))
          .then((js) =>
            appendScript(URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))),
          )
  ).finally(() => {
    loading = null;
  });
  return loading;
}

/** Does the doc hold an edit the agent has not applied yet? Read off the
 *  threads map's JSON so this module needs no Yjs of its own. */
export function hasOpenEdits(threads: Record<string, unknown>): boolean {
  return Object.values(threads).some((raw) => {
    const t = raw as { status?: unknown; comments?: Array<{ pageEdits?: unknown }> } | null;
    const edits = t?.comments?.[0]?.pageEdits;
    return t?.status === 'open' && Array.isArray(edits) && edits.length > 0;
  });
}

/**
 * Put the pencil on the page's widget. `chunkSrc` is `edit.js`'s URL. Returns
 * null on a page whose widget did not render its buttons.
 */
export function mountEditLoader(doc: Document, chunkSrc: string): HTMLButtonElement | null {
  const widget = doc.querySelector('claude-feedback-widget') as FeedbackWidgetEl | null;
  const s = widget?.shadow;
  if (!widget || !s?.querySelector('.fab')) return null;
  const had = s.querySelector('.fab-edit') as HTMLButtonElement | null;
  if (had) return had;
  const style = document.createElement('style');
  style.textContent = EDIT_BUTTON_CSS;
  const button = document.createElement('button');
  button.className = 'fab-edit';
  button.innerHTML = PENCIL;
  button.dataset.tip = 'Edit the words on this page';
  button.setAttribute('aria-label', button.dataset.tip);
  button.setAttribute('aria-pressed', 'false');
  s.append(style, button);

  let mode: EditMode | null = null;
  const ready = (): Promise<EditMode> =>
    loadChunk(chunkSrc).then((chunk) => {
      mode ??= chunk.mountEditMode(widget, button);
      return mode;
    });
  button.addEventListener('click', () => {
    if (mode) {
      mode.toggle();
      return;
    }
    ready().then(
      (m) => m.toggle(),
      () => {
        button.title = 'Editing could not load. Try again.';
      },
    );
  });

  // Marks for edits already waiting: load the mode, without entering it, as
  // soon as the doc says there is one.
  const threads = widget.client?.ydoc.getMap('threads');
  if (threads) {
    const check = (): void => {
      if (!mode && hasOpenEdits(threads.toJSON())) void ready().catch(() => {});
    };
    widget.client?.onReady(check);
    threads.observeDeep(check);
  }
  return button;
}
