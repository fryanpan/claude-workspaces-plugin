/**
 * Incoming Messages on the front page: what a tap, a swipe and a key do.
 *
 * The server draws the section (`packages/server/src/inbox/section.ts`) and
 * this file only acts on it, per the approved round-3 mock:
 *
 *  - a tap opens a line, fetches its message text, and scrolls the line to
 *    the top of the screen;
 *  - a right swipe, the hover clock or `b` opens one "Snooze until…" modal;
 *  - `e` or the opened line's Remove button removes a line, with Undo, and
 *    the Removed fold brings it back;
 *  - Gmail's keys move a cursor and open lines, `r` opens the reply box
 *    (`landing-inbox-reply.ts`), and `?` lists them in a modal
 *    (`landing-inbox-modals.ts`).
 *
 * The section takes keyboard focus when the page loads and when a tap lands
 * in it, so a key pressed on an iPad has a focused element to go to.
 *
 * After any tap that changes a row, the section is re-read from `/` and
 * swapped in whole, so there is one renderer and the page never draws a
 * state the server does not hold. A row posted or changed elsewhere arrives
 * the same way (`swapInboxFrom`, called by `landing-live.ts`). The message
 * text is set with `textContent` and never parsed as markup.
 */

import {
  closeModal,
  keysOpen,
  openKeys,
  openSnoozePicker,
  toast,
  whenLabel,
} from './landing-inbox-modals.ts';
import { el, replyBox, replyKindOf } from './landing-inbox-reply.ts';

export { snoozeChoices } from './landing-inbox-modals.ts';

const SECTION = '#inbox';
/** As `INBOX_VISIBLE_LINES` on the server. */
const VISIBLE_LINES = 5;

interface ViewState {
  open: string | null;
  cursor: string | null;
  expanded: boolean;
  /** Which folds are open: `snoozed`, `removed`. */
  folds: Set<string>;
}

const state: ViewState = {
  open: null,
  cursor: null,
  expanded: false,
  folds: new Set(),
};

const section = (): HTMLElement | null => document.querySelector<HTMLElement>(SECTION);
const rowEl = (id: string): HTMLElement | null =>
  section()?.querySelector<HTMLElement>(`.inbox-row[data-row="${CSS.escape(id)}"]`) ?? null;
/** The lines a cursor can rest on: open ones, not one already answered. */
const openRows = (): HTMLElement[] =>
  [
    ...(section()?.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row:not(.inbox-cleared)') ??
      []),
  ].filter((r) => !r.hidden);
/** Set by `r`: the next card to open puts the caret in its reply box. */
let focusReply = false;

async function post(id: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/inbox/rows/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-read the section from the server and put the view back as it was. */
async function refresh(): Promise<void> {
  try {
    const res = await fetch('/', { credentials: 'same-origin' });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector(SECTION);
    const here = section();
    if (!fresh || !here) return;
    const hadFocus =
      here.contains(document.activeElement) ||
      !document.activeElement ||
      document.activeElement === document.body;
    here.replaceWith(document.importNode(fresh, true));
    applyView();
    if (hadFocus) takeFocus();
  } catch {
    // The page keeps what it showed; the next load corrects it.
  }
}

/** The reader is typing in the section or has a modal open: a live swap
 *  would take the text box or the modal away. */
function liveHeld(): boolean {
  if (document.querySelector('.inbox-modal-back')) return true;
  const a = document.activeElement;
  return (
    (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) &&
    (section()?.contains(a) ?? false)
  );
}

/**
 * Swap in the section from a page read after a change elsewhere. The open
 * line keeps the card it already shows, so the message is not fetched again
 * and the page does not scroll to it. False, with nothing swapped, while
 * `liveHeld`.
 */
export function swapInboxFrom(doc: Document): boolean {
  const here = section();
  const fresh = doc.querySelector(SECTION);
  if (!here || !fresh) return true;
  if (liveHeld()) return false;
  const card = state.open ? rowEl(state.open)?.querySelector('.inbox-card') : null;
  const hadFocus = here.contains(document.activeElement);
  here.replaceWith(document.importNode(fresh, true));
  if (card && state.open) rowEl(state.open)?.append(card);
  applyView();
  if (hadFocus) takeFocus();
  return true;
}

// ---------- the view: cursor, open line, folds ----------

function applyView(): void {
  const s = section();
  if (!s) return;
  for (const [n, r] of [...s.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row')].entries()) {
    r.hidden = !state.expanded && n >= VISIBLE_LINES;
  }
  const more = s.querySelector<HTMLButtonElement>('[data-more]');
  if (more) {
    more.dataset.label ??= more.textContent ?? '';
    more.textContent = state.expanded ? 'Show fewer' : more.dataset.label;
  }
  for (const toggle of s.querySelectorAll<HTMLButtonElement>('[data-fold]')) {
    const kind = toggle.dataset.fold ?? '';
    const open = state.folds.has(kind);
    const body = s.querySelector<HTMLElement>(`[data-fold-body="${CSS.escape(kind)}"]`);
    if (body) body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = toggle.textContent?.replace(/^(Show|Hide)/, open ? 'Hide' : 'Show') ?? '';
  }
  if (state.open && !rowEl(state.open)?.closest('.inbox-rows')) state.open = null;
  for (const r of s.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row')) {
    const id = r.dataset.row ?? '';
    r.classList.toggle('inbox-row-cursor', id === state.cursor);
    const isOpen = id === state.open;
    r.classList.toggle('inbox-row-open', isOpen);
    r.querySelector('.board-review-row')?.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) r.querySelector('.inbox-card')?.remove();
    else if (!r.querySelector('.inbox-card')) void showCard(r, id);
  }
  localTimes(s);
}

/** Times the server wrote in its own zone, rewritten in the viewer's. */
function localTimes(root: HTMLElement): void {
  for (const t of root.querySelectorAll<HTMLTimeElement>('time[data-at]')) {
    const at = Number(t.dataset.at);
    if (!Number.isFinite(at)) continue;
    const d = new Date(at);
    t.dateTime = d.toISOString();
    t.textContent =
      t.dataset.clock !== undefined
        ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
}

async function showCard(row: HTMLElement, id: string): Promise<void> {
  const card = el('div', 'inbox-card');
  const msg = el('p', 'inbox-msg', 'Loading…');
  card.append(msg);
  row.append(card);
  row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  try {
    const res = await fetch(`/inbox/rows/${encodeURIComponent(id)}/body`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { body?: unknown; link?: unknown; reply?: unknown };
    msg.textContent = typeof data.body === 'string' ? data.body : '';
    const link = typeof data.link === 'string' ? data.link : null;
    const kind = replyKindOf(data.reply);
    const focus = focusReply;
    focusReply = false;
    let acts = kind
      ? replyBox(
          card,
          id,
          {
            kind,
            link,
            channel: row.dataset.channel ?? '',
            sender: row.dataset.sender ?? '',
            focus,
          },
          { sent: afterSend, toast },
        )
      : null;
    if (!acts) {
      acts = el('div', 'inbox-actions');
      card.append(acts);
    }
    const before = acts.querySelector('.inbox-hint, .inbox-unset');
    if (link && kind?.kind !== 'messages' && /^(https:|sms:|imessage:)/.test(link)) {
      const a = el('a', 'board-btn', `Open in ${row.dataset.channel ?? 'the app'}`);
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acts.insertBefore(a, before);
    }
    const remove = el('button', 'board-btn', 'Remove');
    remove.type = 'button';
    remove.dataset.act = 'remove';
    remove.title = 'Remove (e)';
    acts.insertBefore(remove, before);
  } catch {
    msg.textContent = 'Could not load this message.';
  }
}

async function afterSend(id: string, channel: string): Promise<void> {
  moveCursorPast(id);
  if (state.open === id) state.open = null;
  await refresh();
  toast(channel === 'slack' ? 'Sent on Slack.' : channel === 'gmail' ? 'Sent by email.' : 'Sent.');
}

/** Remove a line: it folds into "Removed", and the toast can undo it. */
async function removeRow(id: string): Promise<void> {
  closeModal();
  if (!(await post(id, { action: 'remove' }))) {
    toast('Could not remove that message.');
    return;
  }
  moveCursorPast(id);
  if (state.open === id) state.open = null;
  await refresh();
  toast('Removed.', async () => {
    if (await post(id, { action: 'undo' })) await refresh();
  });
}

function toggleOpen(id: string): void {
  state.open = state.open === id ? null : id;
  state.cursor = id;
  closeModal();
  applyView();
}

// ---------- snooze ----------

function openSnooze(id: string): void {
  state.cursor = id;
  applyView();
  const s = section();
  if (!s) return;
  openSnoozePicker(s, (when) => void snooze(id, when));
  rowEl(id)?.querySelector('.inbox-snooze-btn')?.setAttribute('aria-expanded', 'true');
}

function moveCursorPast(id: string): void {
  const ids = openRows().map((r) => r.dataset.row ?? '');
  const i = ids.indexOf(id);
  state.cursor = ids[i + 1] ?? ids[i - 1] ?? null;
}

async function snooze(id: string, when: Date): Promise<void> {
  closeModal();
  if (!(await post(id, { action: 'snooze', until: when.getTime() }))) {
    toast('Could not snooze that message.');
    return;
  }
  moveCursorPast(id);
  if (state.open === id) state.open = null;
  await refresh();
  toast(`Snoozed until ${whenLabel(when)}.`, async () => {
    if (await post(id, { action: 'undo' })) await refresh();
  });
}

// ---------- the swipe ----------

/** Drag a line right past a third of its width (or 96px) and let go: the
 *  snooze modal opens. Shorter springs back; a vertical drag stays a scroll. */
function onPointerDown(ev: PointerEvent): void {
  if (ev.pointerType === 'mouse') return;
  const line = (ev.target as Element | null)?.closest<HTMLElement>('.inbox-line');
  const main = line?.querySelector<HTMLElement>('.board-review-row');
  const id = line?.closest<HTMLElement>('.inbox-row')?.dataset.row;
  if (!line || !main || !id) return;
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let dx = 0;
  let horiz: boolean | null = null;
  const reach = () => Math.min(96, line.offsetWidth / 3);
  const move = (e: PointerEvent) => {
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (horiz === null && Math.abs(mx) + Math.abs(my) > 8) horiz = Math.abs(mx) > Math.abs(my);
    if (!horiz) return;
    dx = Math.max(0, mx);
    main.style.transform = `translateX(${dx}px)`;
    line.classList.toggle('inbox-swiping', dx > 0);
    line.classList.toggle('inbox-swipe-armed', dx > reach());
  };
  const end = () => {
    line.removeEventListener('pointermove', move);
    line.removeEventListener('pointerup', end);
    line.removeEventListener('pointercancel', end);
    const armed = dx > reach();
    main.style.transform = '';
    line.classList.remove('inbox-swiping', 'inbox-swipe-armed');
    if (horiz && dx > 8) {
      // The tap that ends a drag is not an open.
      main.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
        },
        { capture: true, once: true },
      );
    }
    if (armed) openSnooze(id);
  };
  line.addEventListener('pointermove', move);
  line.addEventListener('pointerup', end);
  line.addEventListener('pointercancel', end);
}

// ---------- clicks and keys ----------

function onClick(ev: MouseEvent): void {
  const t = ev.target as Element | null;
  const s = section();
  if (!t || !s?.contains(t)) return;
  const row = t.closest<HTMLElement>('.inbox-row');
  const id = row?.dataset.row ?? '';
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!document.activeElement || document.activeElement === document.body) takeFocus();
  if (act === 'snooze' && id) openSnooze(id);
  else if (act === 'remove' && id) void removeRow(id);
  else if (act === 'reopen' && id) {
    void post(id, { action: 'reopen' }).then((ok) => (ok ? refresh() : undefined));
  } else if (t.closest('[data-more]')) {
    state.expanded = !state.expanded;
    applyView();
  } else if (t.closest('[data-fold]')) {
    const kind = t.closest<HTMLElement>('[data-fold]')?.dataset.fold ?? '';
    if (!state.folds.delete(kind)) state.folds.add(kind);
    applyView();
  } else if (t.closest('.inbox-line > .board-review-row') && id) toggleOpen(id);
}

function step(delta: number): void {
  let ids = openRows().map((r) => r.dataset.row ?? '');
  let i = ids.indexOf(state.cursor ?? '');
  if (
    delta > 0 &&
    i === ids.length - 1 &&
    !state.expanded &&
    section()?.querySelector('[data-more]')
  ) {
    state.expanded = true;
    applyView();
    ids = openRows().map((r) => r.dataset.row ?? '');
  }
  i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta));
  state.cursor = ids[i] ?? null;
  applyView();
  if (state.cursor) rowEl(state.cursor)?.scrollIntoView({ block: 'nearest' });
}

function onKey(ev: KeyboardEvent): void {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || !section()) return;
  const t = ev.target as HTMLElement | null;
  if (
    t &&
    (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
  ) {
    if (ev.key === 'Escape') {
      closeModal();
      if (t instanceof HTMLTextAreaElement) t.blur();
    }
    return;
  }
  const k = ev.key;
  if (keysOpen()) {
    if (k !== '?' && k !== 'Escape') return;
    closeModal();
    ev.preventDefault();
    return;
  }
  const cursor = state.cursor ?? openRows()[0]?.dataset.row ?? null;
  const onControl = t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement;
  if (k === 'j' || k === 'k') step(k === 'j' ? 1 : -1);
  else if ((k === 'o' || (k === 'Enter' && !onControl)) && cursor) {
    state.open = cursor;
    state.cursor = cursor;
    applyView();
  } else if (k === 'r' && cursor) {
    const box = state.open === cursor ? rowEl(cursor)?.querySelector('textarea') : null;
    if (box) box.focus();
    else {
      focusReply = true;
      state.open = cursor;
      state.cursor = cursor;
      applyView();
    }
  } else if (k === 'b' && cursor) openSnooze(cursor);
  else if (k === 'e' && cursor) void removeRow(cursor);
  else if (k === 'u' || k === 'Escape') {
    closeModal();
    state.open = null;
    applyView();
  } else if (k === '?') {
    const s = section();
    if (s) openKeys(s);
  } else return;
  ev.preventDefault();
}

/** Give the section keyboard focus without scrolling to it. Safari does not
 *  focus a tapped button, so without this nothing in the page holds focus. */
function takeFocus(): void {
  section()?.focus({ preventScroll: true });
}

let listening = false;

export function startInbox(): void {
  const s = section();
  if (!s) return;
  Object.assign(state, { open: null, expanded: false, folds: new Set() });
  // No cursor until the first j/k, so the first j lands on the first line.
  // A key that acts on a line with no cursor acts on the first (onKey).
  state.cursor = null;
  applyView();
  if (!document.activeElement || document.activeElement === document.body) takeFocus();
  if (listening) return;
  listening = true;
  document.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKey);
}
