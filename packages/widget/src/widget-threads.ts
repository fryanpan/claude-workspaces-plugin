import {
  type Comment,
  type ElementAnchor,
  type Thread,
  cssColor,
  escapeHtml as escape,
  formatTime,
  listThreads,
  pendingDeclaration,
} from '@claude-workspaces/core';
// The anchor LEAVES, never the `anchors` namespace off the core barrel: a
// namespace object keeps every module behind it, and that one carried text-range
// anchors, their validator and the yjs position code they reach — about 1.8 KB
// gzipped that no element pin reads. The build refuses a bundle holding them
// (`scripts/bundle-guard.ts`).
import { contextMatches } from '@claude-workspaces/core/anchor/context';
import { resolve as resolveElement } from '@claude-workspaces/core/anchor/element';
// The receipt decision and the glyph, from the leaf module that holds them
// rather than from the app's renderer: the widget is a guest bundle with a
// gzip ceiling and cannot import `comment-view.ts`, but a second copy of
// "what does a tick mean" is how two surfaces come to disagree. Deep path,
// not the barrel — `comment-receipt.ts` imports nothing, so this drags in
// nothing behind it.
import { receiptHtml, receiptState } from '@claude-workspaces/core/comment-receipt';
import { clipAudio, composerNote } from './widget-auth.ts';
import { IGNORE_ATTR } from './widget-picker.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * Threads, pins and the popover — everything that renders a comment back onto
 * the page and into the panel.
 *
 * Third and last of B7's extractions. `renderThreads` is the one entry point
 * the element's render loop calls; `positionPins` is the cheap
 * position-only path the scroll, resize and rAF handlers call. The rest is
 * reached from inside this file.
 *
 * `threadSnippet` and `capitalize` come along because nothing outside these
 * six functions ever read them.
 */

/**
 * The line a thread row shows above its latest comment.
 *
 * A subject anchor points at the PAGE rather than into it — `create_thread`
 * with no `find` makes one on any doc — so it names that instead of quoting
 * something. Without this the row would read a snippet that isn't there.
 */
function threadSnippet(anchor: Thread['anchor']): string {
  if (anchor.kind === 'orphan') return anchor.original.snippet.text;
  if (anchor.kind === 'subject') return 'About this page';
  return (anchor as ElementAnchor).snippet.text;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The delivery mark for a comment the reader wrote, as markup, or nothing.
 *
 * Both places the widget draws a comment call this, so neither can be given a
 * mark the other lacks — the failure the shared decision exists to stop. The
 * DECISION is core's; all that is here is where the markup goes.
 */
function receipt(c: Comment | undefined, t: Thread, el: FeedbackWidgetEl): string {
  const state = c ? receiptState(c, t.comments, el.user) : null;
  return state ? receiptHtml(state) : '';
}

export function renderThreadsInto(el: FeedbackWidgetEl): void {
  if (!el.client) return;
  const threads = listThreads(el.client.ydoc);
  // pin layer
  el.threadPositions.clear();
  const pinLayer = el.pinLayer;
  if (!pinLayer) return; // disconnectedCallback fired between schedule and render
  pinLayer.innerHTML = '';
  const annotated: {
    thread: Thread;
    status: 'open' | 'resolved' | 'orphan';
    el: HTMLElement | null;
  }[] = [];
  for (const t of threads) {
    // A subject thread has nothing on the page to pin, but the panel is the
    // one place it can ever appear — dropping it here is how a comment ends
    // up in the store with no surface able to show it.
    if (t.anchor.kind === 'subject') {
      annotated.push({
        thread: t,
        status: t.status === 'resolved' ? 'resolved' : 'open',
        el: null,
      });
      continue;
    }
    if (t.anchor.kind !== 'element' && t.anchor.kind !== 'orphan') continue;
    const statusBase: 'open' | 'resolved' | 'orphan' =
      t.status === 'resolved' ? 'resolved' : 'open';
    if (t.anchor.kind === 'orphan') {
      annotated.push({ thread: t, status: 'orphan', el: null });
      continue;
    }
    // Pin only when the anchor's captured context matches the current
    // page / view. Legacy anchors with no context show everywhere
    // (back-compat). Off-context threads still flow into the side
    // panel via listThreads — they're just not overlaid on the doc.
    if (!contextMatches(t.anchor.context, el.currentContext)) {
      annotated.push({ thread: t, status: statusBase, el: null });
      continue;
    }
    const res = resolveElement(t.anchor, { root: document });
    if (!res.ok) {
      annotated.push({ thread: t, status: 'orphan', el: null });
      continue;
    }
    annotated.push({ thread: t, status: statusBase, el: res.element });
    // Every thread on the page has a pin, resolved ones included — the pin is
    // how a comment is found again, and a resolved one is still worth
    // reopening. Its look says which it is (the light styles in `widget.ts`).
    const pin = document.createElement('div');
    pin.setAttribute(IGNORE_ATTR, '');
    pin.className = 'cfw-pin';
    pin.dataset.threadId = t.id;
    pin.dataset.state =
      statusBase === 'resolved' ? statusBase : pendingDeclaration(t) ? 'review' : statusBase;
    pin.title = t.comments[0]?.text ?? 'open thread';
    pin.addEventListener('click', (ev) => {
      showThreadPopover(el, t, ev.clientX, ev.clientY);
    });
    pinLayer.appendChild(pin);
    el.threadPositions.set(t.id, { el: res.element, status: statusBase, at: t.anchor.at });
  }
  positionPins(el);
  renderPanelList(el, annotated);
}

/** Where a thread's pin goes, kept between frames while its element's size
 *  holds: `spot` is the tip's offset from the element's top-left corner. */
export interface PinPosition {
  el: HTMLElement;
  status: 'open' | 'resolved' | 'orphan';
  at?: { x: number; y: number } | undefined;
  spot?: number[] | undefined;
}

const words = document.createRange();

/**
 * Is a teardrop with its tip at (x, y) clear of the page's text and of the
 * pins already stood this frame?
 *
 * The page is asked what is under nine points of the drop's box, and the text
 * directly inside each element there is measured against the box. A pin used
 * to be drawn over the words of the chip it marked ("Malformed", on a
 * Confirmed chip); nothing about an element's box says where its words are.
 */
function clear(x: number, y: number, placed: number[][], text = true): boolean {
  const l = x - 11;
  const t = y - 26;
  if (l < 0 || x + 11 > innerWidth || t < 0 || y > innerHeight) return false;
  for (const [px, py] of placed) {
    if (Math.abs(px - x) < 22 && Math.abs(py - y) < 27) return false;
  }
  for (let i = 0; text && i < 9; i++) {
    for (const e of document.elementsFromPoint(l + (i % 3) * 11, t + ((i / 3) | 0) * 13.5)) {
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
        words.selectNodeContents(n);
        for (const q of words.getClientRects()) {
          if (q.left < x + 11 && q.right > l && q.top < y + 1 && q.bottom > t) return false;
        }
      }
    }
  }
  return true;
}

export function positionPins(el: FeedbackWidgetEl): void {
  if (!el.pinLayer) return;
  const placed: number[][] = [];
  for (const pin of el.pinLayer.children as HTMLCollectionOf<HTMLElement>) {
    const pos = el.threadPositions.get(pin.dataset.threadId ?? '');
    if (!pos) continue;
    const r = pos.el.getBoundingClientRect();
    // An element on a screen the page has not opened has no box, or is not
    // shown. Its pin waits, hidden, and stands on the element when the page
    // shows it — rather than at the no-box corner, off the top left.
    pin.hidden =
      !(r.width || r.height) ||
      pos.el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false;
    if (pin.hidden) continue;
    // The spot is kept while the element holds its size and its place on the
    // page: a scroll moves neither, but an element that slides has new
    // neighbours under the spot.
    const px = r.left + scrollX;
    const py = r.top + scrollY;
    let s = pos.spot;
    if (!s || s[2] !== r.width || s[3] !== r.height || s[4] !== px || s[5] !== py) {
      // The tapped point first, then the element's edges: past its words
      // (past its right side when they reach it, so a chip's pill is not
      // cut), above it, below it, before its left side.
      // An element with nothing in it has an empty range at the origin; its
      // words end at its right side.
      words.selectNodeContents(pos.el);
      const q = words.getBoundingClientRect();
      const end = q.width ? q.right : r.right;
      const m = r.height / 2 + 13;
      // How far the element reaches as a reader sees it: a heading's box runs
      // the width of the page, but its words stop part way, and a pin by the
      // box's far corner belongs to nothing on screen.
      const w = (r.right - end > 40 ? end : r.right) - r.left;
      const spots = [
        [w + 16, m],
        [w - 12, 0],
        [w - 12, r.height + 27],
        [-12, m],
      ];
      // The tapped point only on an element with words: words are what the
      // check keeps a pin off, and nothing tells it where an icon is drawn —
      // a pin at the tap on an icon button covered the icon.
      const at = pos.at;
      if (pos.el.textContent?.trim() && at && at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1) {
        spots.unshift([at.x * r.width, at.y * r.height]);
      }
      let c = spots.find(([x, y]) => clear(r.left + x, r.top + y, placed));
      // More threads on it than spots: a row along its top, then rows under
      // it, clear of the other pins — of the page's words too, the first time
      // round those four rows.
      const n = Math.max(1, (w / 24) | 0);
      for (let k = 0; !c && k < 8 * n; k++) {
        const j = ((k % (4 * n)) / n) | 0;
        const d = [w - 12 - 24 * (k % n), j && r.height - 2 + 29 * j];
        if (clear(r.left + d[0], r.top + d[1], placed, k < 4 * n)) c = d;
      }
      c ??= spots[0];
      s = [c[0], c[1], r.width, r.height, px, py];
      // Kept only when the drop was on screen: off it, the page has nothing
      // under the points to say whether they were clear.
      if (r.top + s[1] > 26 && r.top + s[1] < innerHeight) pos.spot = s;
    }
    const x = r.left + s[0];
    const y = r.top + s[1];
    placed.push([x, y]);
    pin.style.left = `${x}px`;
    pin.style.top = `${y}px`;
  }
}

function renderPanelList(
  el: FeedbackWidgetEl,
  entries: { thread: Thread; status: 'open' | 'resolved' | 'orphan' }[],
): void {
  const list = el.shadow.querySelector('.panel-threads') as HTMLElement | null;
  if (!list) return;
  list.innerHTML = '';
  const groups: Record<'open' | 'orphan' | 'resolved', typeof entries> = {
    open: entries.filter((e) => e.status === 'open'),
    orphan: entries.filter((e) => e.status === 'orphan'),
    resolved: entries.filter((e) => e.status === 'resolved'),
  };
  if (entries.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No comments yet. Tap the bubble, then click anything on the page.';
    list.appendChild(e);
    return;
  }
  for (const key of ['open', 'orphan'] as const) {
    const group = groups[key];
    if (!group.length) continue;
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = `${capitalize(key)} (${group.length})`;
    list.appendChild(h);
    for (const { thread, status } of group) {
      list.appendChild(renderThreadRow(el, thread, status));
    }
  }
  if (groups.resolved.length) {
    const toggle = document.createElement('button');
    toggle.className = 'resolved-toggle';
    toggle.textContent = el.showResolved
      ? `Hide resolved (${groups.resolved.length})`
      : `Show resolved (${groups.resolved.length})`;
    toggle.addEventListener('click', () => {
      el.showResolved = !el.showResolved;
      localStorage.setItem('cfw:showResolved', el.showResolved ? '1' : '0');
      // Rerender to show or hide the resolved group; their pins stay either way
      el.scheduleRender();
    });
    list.appendChild(toggle);
    if (el.showResolved) {
      for (const { thread, status } of groups.resolved) {
        list.appendChild(renderThreadRow(el, thread, status));
      }
    }
  }
}

function renderThreadRow(
  el: FeedbackWidgetEl,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
): HTMLElement {
  const row = document.createElement('div');
  row.className = `thread status-${status}`;
  if (el.activeThread === t.id) row.classList.add('active');

  const snippet = threadSnippet(t.anchor);
  const last = t.comments[t.comments.length - 1];
  row.innerHTML =
    '<div class="meta">' +
    '<span class="dot"></span>' +
    `<span class="author-name">${escape(t.createdBy.name)}</span>` +
    `<span class="time">${formatTime(last?.ts ?? 0)}</span>` +
    receipt(last, t, el) +
    '</div>' +
    `<div class="snippet">${escape(snippet)}</div>` +
    `<div class="last">${escape(last?.text ?? '')}</div>`;
  row.addEventListener('click', () => {
    const pos = el.threadPositions.get(t.id);
    if (pos?.el) pos.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.activeThread = t.id;
    showThreadPopoverForThread(el, t);
  });
  return row;
}

function showThreadPopoverForThread(el: FeedbackWidgetEl, t: Thread): void {
  if (t.anchor.kind === 'element') {
    const res = resolveElement(t.anchor, { root: document });
    if (res.ok) {
      const r = res.element.getBoundingClientRect();
      showThreadPopover(el, t, r.right, r.top);
      return;
    }
  }
  showThreadPopover(el, t, window.innerWidth / 2, 80);
}

export function showThreadPopover(el: FeedbackWidgetEl, t: Thread, cx: number, cy: number): void {
  const existing = el.shadow.querySelector('.thread-popover');
  existing?.remove();
  const pop = document.createElement('div');
  pop.className = 'thread-popover';
  // The screen's right edge: `innerWidth` is the page's, past it when the
  // page is wider than a phone.
  const vv = window.visualViewport;
  pop.style.left = `${Math.min(cx + 6, (vv ? vv.offsetLeft + vv.width : innerWidth) - 340)}px`;
  pop.style.top = `${Math.min(cy + 6, window.innerHeight - 240)}px`;
  const snippet = threadSnippet(t.anchor);
  const status = t.anchor.kind === 'orphan' ? 'orphan' : t.status;
  pop.innerHTML =
    '<header>' +
    `<span class="tag tag-${status}">${status}</span>` +
    '<button class="icon-btn close">×</button>' +
    '</header>' +
    `<div class="snippet">${escape(snippet)}</div>` +
    '<div class="comments"></div>' +
    '<div class="actions">' +
    `<textarea rows="2" placeholder="Reply as ${escape(el.user?.name ?? 'Anon')}…"></textarea>` +
    '<button class="primary submit">Reply</button>' +
    (status === 'resolved'
      ? '<button class="reopen">Reopen</button>'
      : status === 'open'
        ? '<button class="resolve">Resolve</button>'
        : '') +
    '</div>';
  const cList = pop.querySelector('.comments') as HTMLElement;
  for (const c of t.comments) {
    const row = document.createElement('div');
    row.className = 'comment';
    row.innerHTML =
      `<div class="author"><span class="swatch" style="background:${cssColor(c.author.color)}"></span>${escape(c.author.name)} <span class="time">${formatTime(c.ts)}</span>${receipt(c, t, el)}</div>` +
      `<div class="body">${escape(c.text)}</div>` +
      // A spoken comment keeps its clip and the words as heard.
      (c.voice
        ? `<div class="vnote"><button data-clip="${escape(c.voice.clip)}">▶ Play</button><details><summary>Raw words</summary>${escape(c.voice.raw)}</details></div>`
        : '');
    cList.appendChild(row);
  }
  el.shadow.appendChild(pop);
  pop.querySelector('.close')?.addEventListener('click', () => pop.remove());
  cList.addEventListener('click', (ev) => {
    const clip = (ev.target as Element).closest('[data-clip]')?.getAttribute('data-clip');
    if (clip) {
      void clipAudio(el, clip)
        .then((a) => a?.play())
        .catch(() => {});
    }
  });
  pop.querySelector('.submit')?.addEventListener('click', async () => {
    const ta = pop.querySelector('textarea') as HTMLTextAreaElement;
    const text = ta.value.trim();
    if (!text) return;
    // A rejected fetch (server unreachable) is a refused reply like any
    // other. Without the catch it left an unhandled rejection and a popover
    // still holding the words with nothing said about them — the same shape
    // as a reply never sent. The note stands until the reply goes.
    let posted = false;
    try {
      posted = await el.postReply(t.id, text);
    } catch {}
    if (!posted) {
      const note = composerNote(pop, 'Not sent — tap Reply to retry.');
      // Whatever they type next is not what failed, so the note goes with it.
      ta.addEventListener('input', () => note.remove(), { once: true });
      return;
    }
    pop.remove();
  });
  pop.querySelector('.resolve')?.addEventListener('click', async () => {
    await el.setStatus(t.id, 'resolved');
    pop.remove();
  });
  pop.querySelector('.reopen')?.addEventListener('click', async () => {
    await el.setStatus(t.id, 'open');
    pop.remove();
  });
}
