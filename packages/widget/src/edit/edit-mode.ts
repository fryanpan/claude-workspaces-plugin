import { contextMatches, hasContext } from '@claude-workspaces/core/anchor/context';
import { resolve } from '@claude-workspaces/core/anchor/element';
import { type PageEdit, pageEditsText } from '@claude-workspaces/core/page-edits';
import { authedPost, httpBase } from '../widget-auth.ts';
import type { FeedbackWidgetEl } from '../widget.ts';
import type { EditMode } from './edit-button.ts';
import { EDIT_PAGE_CSS, EDIT_SHADOW_CSS } from './edit-css.ts';
import { EditDrafts, editableTarget, markFor, normText, sentEdits } from './edit-model.ts';

/**
 * Edit mode: the reviewer taps the words on the page, retypes them, and
 * sends the changes to the agent as structured edits.
 *
 * The page's source is never written. Typing changes the words on this
 * screen only; Send posts the element, the words it showed and the words
 * typed on the page's thread (`pageEdits`, `core/src/page-edits.ts`), and
 * the agent applies them to whatever generated the page. So it works the
 * same on a served mock and on a dev server this server cannot read.
 *
 * Every mark is a node in a fixed layer of our own: an orange change bar
 * beside an element whose edit the agent has not applied, which stays on the
 * page outside the mode and across a reload, and a green one once it has,
 * shown only inside the mode. Unsent edits wear the orange bar and an undo
 * button, and the banner's count opens the list of them.
 */

const IGNORE_ATTR = 'data-feedback-widget';
/** The widget's phone face starts here (`widget-card.ts`, PHONE_MAX). */
const PHONE_MAX = 1100;

const enc = encodeURIComponent;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function box(cls: string, r: { left: number; top: number; width: number; height: number }) {
  const d = document.createElement('div');
  d.className = cls;
  d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  return d;
}

export function mountEditMode(widget: FeedbackWidgetEl, button: HTMLButtonElement): EditMode {
  const shadow = widget.shadow;
  const drafts = new EditDrafts();
  /** Elements whose words the reader typed in this visit. Their words are
   *  the reader's, so they never count as the agent's change arriving. */
  const typedHere = new WeakSet<HTMLElement>();
  /** The elements each send of this visit was about, by thread. */
  const sentHere = new Map<string, HTMLElement[]>();
  let on = false;
  let editing: HTMLElement | null = null;
  let hover: HTMLElement | null = null;
  let banner: HTMLElement | null = null;
  let sheet: HTMLElement | null = null;
  let sending = false;
  let note = '';

  const style = document.createElement('style');
  style.textContent = EDIT_SHADOW_CSS;
  shadow.append(style);
  if (!document.querySelector('style[data-cfw-edit]')) {
    const page = document.createElement('style');
    page.setAttribute('data-cfw-edit', '');
    page.textContent = EDIT_PAGE_CSS;
    document.head.append(page);
  }
  const layer = document.createElement('div');
  layer.className = 'cfw-edit-layer';
  layer.setAttribute(IGNORE_ATTR, '');
  document.body.append(layer);

  const threadsMap = widget.client?.ydoc.getMap('threads');
  const threads = (): Record<string, unknown> => threadsMap?.toJSON() ?? {};

  // ---- painting ----------------------------------------------------------

  let frame: number | null = null;
  const schedule = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  };

  function mark(el: HTMLElement, state: 'pending' | 'applied', undo: boolean): void {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !undo) return;
    const cls = state === 'applied' ? ' applied' : '';
    const left = Math.max(2, r.left - 10);
    if (on) layer.append(box(`cfw-edit-wash${cls}`, r));
    layer.append(box(`cfw-edit-bar${cls}`, { left, top: r.top, width: 3, height: r.height }));
    if (!undo) return;
    const b = document.createElement('button');
    b.className = 'cfw-undo';
    b.title = 'Undo this edit';
    b.setAttribute('aria-label', 'Undo this edit');
    b.innerHTML = '<span>↶</span>';
    // In the gutter beside the bar when the page leaves one; otherwise on
    // the element's top-right corner, so it never covers the first words.
    const gutter = r.left >= 40;
    const x = gutter ? r.left - 26 : Math.min(r.right - 4, window.innerWidth - 16);
    b.style.left = `${x}px`;
    b.style.top = `${gutter ? r.top + Math.min(r.height / 2, 22) : r.top}px`;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      undoEdit(el);
    });
    layer.append(b);
  }

  function paint(): void {
    layer.replaceChildren();
    const drafted = new Set(drafts.elements());
    for (const sent of sentEdits(threads())) {
      const here = sentHere.get(sent.threadId);
      sent.edits.forEach((edit, i) => {
        if (!contextMatches(edit.anchor.context, widget.currentContext)) return;
        const found = here?.[i] ?? resolveEl(edit);
        if (!found || drafted.has(found)) return;
        const state = markFor(sent.open, edit, found.textContent ?? '', typedHere.has(found));
        if (state === 'pending' || on) mark(found, state, false);
      });
    }
    for (const el of drafted) mark(el, 'pending', on);
    if (on && hover && hover !== editing) {
      layer.append(box('cfw-edit-hover', hover.getBoundingClientRect()));
    }
    paintBanner();
  }

  /** The element an edit is about. Its fingerprint holds the words it had,
   *  so once the agent has changed them the fingerprint can lose it; the
   *  short path is asked then, and believed only if it shows the new words. */
  function resolveEl(edit: PageEdit): HTMLElement | null {
    const res = resolve(edit.anchor, { root: document });
    if (res.ok) return res.element;
    try {
      const el = document.querySelector(edit.selector);
      return el instanceof HTMLElement && normText(el.textContent) === normText(edit.after)
        ? el
        : null;
    } catch {
      return null;
    }
  }

  function paintBanner(): void {
    if (!banner) return;
    const n = drafts.elements().length;
    const q = (sel: string) => banner?.querySelector(sel) as HTMLElement;
    q('.edit-msg').hidden = n > 0 || note !== '';
    const noteEl = q('.edit-note');
    noteEl.hidden = note === '';
    noteEl.textContent = note;
    q('.edit-count').hidden = n === 0;
    q('.edit-count').textContent = `${n} ${n === 1 ? 'edit' : 'edits'}`;
    const send = q('.edit-send') as HTMLButtonElement;
    send.hidden = n === 0;
    send.disabled = sending;
  }

  // ---- typing ------------------------------------------------------------

  let priorEditable: string | null = null;

  function begin(el: HTMLElement): void {
    commit();
    drafts.begin(el);
    editing = el;
    priorEditable = el.getAttribute('contenteditable');
    el.setAttribute('data-cfw-editing', '');
    // Plain text only: an edit carries words, never markup a paste brought.
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.addEventListener('input', onInput);
    el.addEventListener('paste', onPaste);
    el.addEventListener('blur', commit, { once: true });
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    schedule();
  }

  function onInput(): void {
    if (editing) typedHere.add(editing);
    note = '';
    schedule();
  }

  function onPaste(ev: ClipboardEvent): void {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  }

  function commit(): void {
    const el = editing;
    if (!el) return;
    editing = null;
    el.removeEventListener('input', onInput);
    el.removeEventListener('paste', onPaste);
    el.removeEventListener('blur', commit);
    el.removeAttribute('data-cfw-editing');
    if (priorEditable === null) el.removeAttribute('contenteditable');
    else el.setAttribute('contenteditable', priorEditable);
    schedule();
  }

  function undoEdit(el: HTMLElement): void {
    if (editing === el) commit();
    drafts.undo(el);
    typedHere.delete(el);
    if (sheet) openSheet();
    schedule();
  }

  // ---- the banner and the sheet -----------------------------------------

  function showBanner(): void {
    const phone = window.innerWidth <= PHONE_MAX;
    banner = document.createElement('div');
    banner.className = phone
      ? 'picker-banner quick cw-edit-banner'
      : 'picker-banner cw-edit-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      `<span class="edit-msg">${phone ? 'Tap' : 'Click'} text to edit it.</span>` +
      '<span class="edit-note" hidden></span>' +
      '<button class="edit-count" hidden></button>' +
      '<button class="edit-send" hidden>Send</button>' +
      `<button class="picker-cancel">Done${phone ? '' : ' (Esc)'}</button>`;
    banner.querySelector('.edit-count')?.addEventListener('click', openSheet);
    banner.querySelector('.edit-send')?.addEventListener('click', () => void send());
    banner.querySelector('.picker-cancel')?.addEventListener('click', leave);
    shadow.append(banner);
  }

  function row(edit: PageEdit): string {
    return (
      '<div class="cw-editrow"><div class="grow">' +
      `<div class="where">${esc(edit.selector)}</div>` +
      `<div class="was">${esc(edit.before)}</div>` +
      (edit.after === ''
        ? '<div class="gone">→ deleted</div>'
        : `<div class="now">${esc(edit.after)}</div>`) +
      '</div><button class="drop" title="Undo this edit" aria-label="Undo this edit">×</button></div>'
    );
  }

  function closeSheet(): void {
    sheet?.remove();
    sheet = null;
  }

  function openSheet(): void {
    closeSheet();
    const edits = drafts.changed();
    if (edits.length === 0) return;
    const els = drafts.elements();
    const n = edits.length;
    sheet = document.createElement('div');
    sheet.className = 'cw-dock-scrim';
    sheet.innerHTML =
      '<div class="cw-modal" role="dialog" aria-label="Unsent edits">' +
      '<div class="cw-modal-head"><div class="cw-modal-who">Unsent edits</div>' +
      '<button class="icon-btn" data-close title="Close">×</button></div>' +
      `<div class="cw-modal-scroll">${edits.map(row).join('')}</div>` +
      '<div class="cw-modal-foot"><span class="grow">Sent to the agent as one thread on this page.</span>' +
      `<button class="primary" data-send>Send ${n} ${n === 1 ? 'edit' : 'edits'}</button></div></div>`;
    sheet.addEventListener('click', (ev) => {
      if (ev.target === sheet) closeSheet();
    });
    sheet.querySelector('[data-close]')?.addEventListener('click', closeSheet);
    sheet.querySelector('[data-send]')?.addEventListener('click', () => void send());
    sheet.querySelectorAll('.drop').forEach((b, i) => {
      const el = els[i];
      if (el) b.addEventListener('click', () => undoEdit(el));
    });
    shadow.append(sheet);
  }

  // ---- sending -----------------------------------------------------------

  async function send(): Promise<void> {
    commit();
    const els = drafts.elements();
    const ctx = hasContext(widget.currentContext) ? { context: { ...widget.currentContext } } : {};
    const pageEdits = drafts.changed().map((e) => ({ ...e, anchor: { ...e.anchor, ...ctx } }));
    const first = pageEdits[0];
    if (!first || sending) return;
    sending = true;
    paintBanner();
    const url =
      `${httpBase(widget)}/workspaces/${enc(widget.opts.workspaceId)}` +
      `/docs/${enc(widget.opts.docId)}/threads`;
    try {
      const res = await authedPost(widget, url, () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` too, though the server writes its own from the edits: a
        // server that predates them still files a readable comment.
        body: JSON.stringify({
          author: widget.user,
          text: pageEditsText(pageEdits),
          anchor: first.anchor,
          pageEdits,
        }),
      }));
      if (res.ok) {
        const { thread } = (await res.json()) as { thread?: { id?: string } };
        if (thread?.id) sentHere.set(thread.id, els);
        drafts.clear();
        note = '';
        closeSheet();
      } else if (widget.signInToWrite && !widget.authToken) {
        note = 'Sign in to send. Your edits are kept.';
        widget.retryAfterSignIn = () => void send();
      } else {
        note = 'Could not send. Your edits are kept.';
      }
    } catch {
      note = 'Could not send. Your edits are kept.';
    }
    sending = false;
    schedule();
  }

  // ---- the page's events while the mode is on ----------------------------

  const ours = (ev: Event): boolean => {
    const path = ev.composedPath();
    return path.includes(widget) || path.includes(layer);
  };

  function onClick(ev: MouseEvent): void {
    if (ours(ev)) return;
    // Nothing on the page acts while its words are being edited: a link
    // does not navigate, a button does not submit.
    ev.preventDefault();
    ev.stopPropagation();
    const target = editableTarget(ev.target as Element);
    if (target && target === editing) return;
    if (target) begin(target);
    else commit();
  }

  function onMove(ev: PointerEvent): void {
    const next = ours(ev) ? null : editableTarget(ev.target as Element);
    if (next === hover) return;
    hover = next;
    schedule();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.type === 'keydown' && ev.key === 'Escape') {
      ev.preventDefault();
      if (sheet) closeSheet();
      else leave();
      return;
    }
    const inEdit = editing?.contains(ev.target as Node);
    if (!inEdit) return;
    if (ev.type === 'keydown' && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      editing?.blur();
    }
    // The page's own shortcuts do not see the reviewer's typing.
    ev.stopPropagation();
  }

  const KEYS = ['keydown', 'keypress', 'keyup'] as const;

  function enter(): void {
    on = true;
    if (widget.feedbackMode) (shadow.querySelector('.fab') as HTMLElement | null)?.click();
    widget.togglePanel?.(false);
    widget.classList.add('cfw-edit-on');
    document.body.classList.add('cfw-edit-mode');
    button.classList.add('open');
    button.setAttribute('aria-pressed', 'true');
    showBanner();
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointermove', onMove, true);
    for (const k of KEYS) window.addEventListener(k, onKey, true);
    schedule();
  }

  function leave(): void {
    commit();
    closeSheet();
    on = false;
    hover = null;
    note = '';
    banner?.remove();
    banner = null;
    widget.classList.remove('cfw-edit-on');
    document.body.classList.remove('cfw-edit-mode');
    button.classList.remove('open');
    button.setAttribute('aria-pressed', 'false');
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointermove', onMove, true);
    for (const k of KEYS) window.removeEventListener(k, onKey, true);
    schedule();
  }

  // Marks follow the page: its threads, its scroll, its layout.
  threadsMap?.observeDeep(schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  new MutationObserver((records) => {
    if (records.some((r) => !layer.contains(r.target))) schedule();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  // A reload loses what has not been sent, so the browser asks first.
  window.addEventListener('beforeunload', (ev) => {
    if (drafts.elements().length === 0) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
  schedule();

  return { toggle: () => (on ? leave() : enter()) };
}
