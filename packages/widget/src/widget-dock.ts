import {
  type ReviewOption,
  type ReviewPayload,
  type Thread,
  escapeHtml as escape,
  isReviewPayloadGated,
  listThreads,
  pendingDeclaration,
  reviewAnswered,
  reviewWithdrawn,
} from '@claude-workspaces/core';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The review-item DOCK — an ask, on the page it is about.
 *
 * A review item raised on a mockup used to live only on the ticket, so the
 * reader opened the mock, looked at it, and then had to leave for the Home
 * queue to say what they thought. The ask belongs where the thing is: this
 * puts it in a bar across the bottom of the page the item was raised on, and
 * lets it be answered there.
 *
 * Nothing new is fetched. The widget already syncs the doc's threads, and a
 * review item IS a payload on a comment (`Comment.review`), so the dock reads
 * the same CRDT the pins and the panel read. The answer goes back through the
 * route the doc page already uses — `POST …/threads/:id/answer` — for the
 * same reason: two doors onto "this item is answered" would be free to
 * disagree about what answered means.
 */

/** One standing ask, as the dock draws it. */
export interface DockItem {
  threadId: string;
  /** The comment carrying the declaration — an answer is stamped at this id. */
  commentId: string;
  review: ReviewPayload;
  /** Display name of whoever raised it. */
  by: string;
  ts: number;
  /** Somebody has answered; the bar reads as settled rather than waiting. */
  answered: boolean;
}

/**
 * One round of an ask — an earlier wording, or the words standing now.
 *
 * "Round 2 revises the standing item" is what `revisions` already records:
 * every revision pushes the PREVIOUS text onto the payload, so the rounds are
 * that list followed by the payload itself. Reading them here rather than
 * raising a second thread per round is the whole point — three threads about
 * one question is the duplication the queue exists to remove, and it loses
 * the reading that the earlier rounds are the same ask at an earlier moment.
 */
export interface DockRound {
  n: number;
  headline: string;
  detail?: string;
  options?: ReviewOption[];
  /** Absent on the round standing now — it has not been superseded. */
  at?: number;
  by?: string;
}

/**
 * The asks a page can dock, newest declaration first, open ones before
 * answered ones.
 *
 * Pure over threads so the membership rule is testable without a browser.
 * Three exclusions, each the same one the Home queue applies:
 *  - a HELD item is filed and off the reader's queue until its filer revises
 *    it; docking it would show the reader an ask its author is being told
 *    nobody can see,
 *  - a WITHDRAWN one was taken back,
 *  - a resolved thread's ask is retired (`pendingDeclaration` reads status).
 *
 * An ANSWERED item stays until its thread is resolved, which is what makes
 * the answer visible where it was given rather than only in the queue it left.
 */
export function dockItems(threads: Thread[]): DockItem[] {
  const items: DockItem[] = [];
  for (const t of threads) {
    if (t.status !== 'open') continue;
    // The standing ask, if there is one — the newest non-withdrawn
    // declaration, and null once it is answered.
    const open = pendingDeclaration(t);
    const declaring =
      open ??
      [...(t.comments ?? [])]
        .sort((a, b) => a.ts - b.ts)
        .reverse()
        .find((c) => c.review !== undefined && !reviewWithdrawn(c.review));
    if (!declaring?.review) continue;
    if (isReviewPayloadGated(declaring.review)) continue;
    // An OWNER-ONLY ask never docks. The widget is a guest on somebody else's
    // page: whoever can open that page sees this bar, and an owner-only item
    // is one the board itself will not show a member and will not let anyone
    // but the owner answer. Docking it would put the ask — and the affordance
    // for answering it — in front of exactly the readers the server refuses,
    // and the refusal would arrive as a failed POST rather than as a door
    // that was never there. The board's own queue makes the same call from
    // the same flag, so the two surfaces cannot disagree about who is asked.
    if (declaring.review.ownerOnly) continue;
    items.push({
      threadId: t.id,
      commentId: declaring.id,
      review: declaring.review,
      by: declaring.author.name,
      ts: declaring.ts,
      answered: reviewAnswered(declaring.review),
    });
  }
  return items.sort(
    (a, b) =>
      Number(a.answered) - Number(b.answered) ||
      b.ts - a.ts ||
      a.threadId.localeCompare(b.threadId),
  );
}

/** Every round of one ask, oldest first; the last is the one standing. */
export function dockRounds(review: ReviewPayload): DockRound[] {
  const rounds: DockRound[] = (review.revisions ?? []).map((r, i) => ({
    n: i + 1,
    headline: r.headline,
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
    ...(r.options !== undefined ? { options: r.options } : {}),
    at: r.at,
    by: r.by,
  }));
  rounds.push({
    n: rounds.length + 1,
    headline: review.headline,
    ...(review.detail !== undefined ? { detail: review.detail } : {}),
    ...(review.options !== undefined ? { options: review.options } : {}),
  });
  return rounds;
}

/** Which thread a URL asks to be opened on, if any — see `board-queue-open`. */
export function deepLinkThread(search: string): string | null {
  try {
    return new URLSearchParams(search).get('thread');
  } catch {
    return null;
  }
}

const CARET = '›';

function roundsHtml(rounds: DockRound[]): string {
  const now = rounds[rounds.length - 1];
  const earlier = rounds.slice(0, -1);
  const one = (r: DockRound): string =>
    `<div class="cw-round"><div class="cw-round-head"><b>Round ${r.n}</b>${
      r.by ? `<span>${escape(r.by)}</span>` : ''
    }</div><div class="cw-round-headline">${escape(r.headline)}</div>${
      r.detail ? `<p class="cw-round-body">${escape(r.detail)}</p>` : ''
    }</div>`;
  const history = earlier.length
    ? `<details class="cw-rounds-earlier"><summary>${
        earlier.length === 1 ? 'Round 1' : `Rounds 1–${earlier.length}`
      }</summary>${earlier.map(one).join('')}</details>`
    : '';
  // The standing round is never inside the <details>: it is the ask, and an
  // ask you have to expand to read is one nobody reads.
  return `${history}<div class="cw-round cw-round-now">${one(now)}</div>`;
}

function answerHtml(item: DockItem): string {
  if (item.answered) {
    const said = item.review.answerText ?? '';
    return `<div class="cw-modal-answered"><b>Answered</b>${
      said ? `<span>${escape(said)}</span>` : ''
    }</div>`;
  }
  const options = item.review.options ?? [];
  const choices = options.length
    ? `<div class="cw-answer-choices">${options
        .map(
          (o, i) =>
            `<button class="${i === 0 ? 'primary' : 'cancel'} cw-answer-opt" type="button" data-opt="${escape(
              o.id,
            )}" data-label="${escape(o.label)}">${escape(o.label)}</button>`,
        )
        .join('')}</div>`
    : '';
  return `<div class="cw-modal-answer">${choices}<textarea class="cw-answer-text" rows="2" placeholder="${
    options.length ? 'Add a reason (optional)' : 'Your answer'
  }"></textarea>${
    options.length
      ? ''
      : '<div class="cw-answer-actions"><button class="primary cw-answer-send" type="button">Answer</button></div>'
  }<div class="cw-answer-err" hidden></div></div>`;
}

/** Open the expanded item — the rounds, and the way to answer it. */
export function openDockItem(el: FeedbackWidgetEl, item: DockItem): void {
  el.shadow.querySelector('.cw-dock-scrim')?.remove();
  const scrim = document.createElement('div');
  scrim.className = 'cw-dock-scrim';
  scrim.innerHTML = `<div class="cw-modal" role="dialog" aria-modal="true">
      <div class="cw-modal-head"><span class="cw-modal-who">${escape(item.by)}</span>
      <button class="icon-btn cw-modal-close" type="button" aria-label="Close">×</button></div>
      <div class="cw-modal-scroll">${roundsHtml(dockRounds(item.review))}</div>
      ${answerHtml(item)}
    </div>`;
  el.shadow.appendChild(scrim);
  const close = (): void => scrim.remove();
  scrim.addEventListener('click', (ev) => {
    if (ev.target === scrim) close();
  });
  scrim.querySelector('.cw-modal-close')?.addEventListener('click', close);
  const err = scrim.querySelector('.cw-answer-err') as HTMLElement | null;
  const reason = (): string =>
    (scrim.querySelector('.cw-answer-text') as HTMLTextAreaElement | null)?.value.trim() ?? '';
  // One answer at a time. Nothing here is disabled on click, so a double tap
  // on a slow connection would answer the same item twice — and the second
  // answer would overwrite the first with whichever option landed last.
  let inFlight = false;
  const send = async (text: string, optionId?: string): Promise<void> => {
    if (inFlight || !text) return;
    inFlight = true;
    const ok = await el.postAnswer(item.threadId, item.commentId, text, optionId);
    inFlight = false;
    if (!ok) {
      if (err) {
        err.hidden = false;
        err.textContent = 'Couldn’t answer — try again.';
      }
      return;
    }
    close();
  };
  for (const b of Array.from(scrim.querySelectorAll('.cw-answer-opt'))) {
    b.addEventListener('click', () => {
      // The LABEL is the verbatim answer and `optionId` says which candidate
      // it came from — the route's contract, and the reason a typed answer
      // needs no id at all. A reason typed alongside rides with the words.
      const label = (b as HTMLElement).dataset.label ?? '';
      const why = reason();
      void send(why ? `${label} — ${why}` : label, (b as HTMLElement).dataset.opt);
    });
  }
  scrim.querySelector('.cw-answer-send')?.addEventListener('click', () => void send(reason()));
}

/**
 * Paint the dock. Called from the widget's one render loop.
 *
 * The bar is rebuilt only when what it says changes, so a host page that
 * mutates its DOM every frame does not restyle the dock every frame — and,
 * more importantly, does not steal a tap that landed mid-rebuild.
 */
export function renderDockInto(el: FeedbackWidgetEl): void {
  if (!el.client) return;
  const items = dockItems(listThreads(el.client.ydoc));
  const item = items[0];
  let bar = el.shadow.querySelector('.cw-dock') as HTMLElement | null;
  if (!item) {
    bar?.remove();
    el.style.setProperty('--cw-dock-h', '0px');
    return;
  }
  const rounds = dockRounds(item.review);
  const sig = [
    item.threadId,
    item.commentId,
    rounds.length,
    item.answered,
    item.review.headline,
  ].join(' ');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'cw-dock';
    el.shadow.appendChild(bar);
  }
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = `<button class="cw-dock-item" type="button">
        <span class="cw-dock-ic${item.answered ? ' cw-dock-ic-done' : ''}">${
          item.answered ? '✓' : '?'
        }</span>
        <span class="cw-dock-text">${escape(item.review.headline)}${
          item.answered ? ' <span class="cw-dock-said">· answered</span>' : ''
        }</span>
        ${rounds.length > 1 ? `<span class="cw-dock-round">Round ${rounds.length}</span>` : ''}
        <span class="cw-dock-caret" aria-hidden="true">${CARET}</span>
      </button>`;
    bar.querySelector('.cw-dock-item')?.addEventListener('click', () => openDockItem(el, item));
  }
  // Measured, never assumed — the FAB and the panel sit above whatever height
  // the bar actually takes at this width, and the headline wraps at 430.
  el.style.setProperty('--cw-dock-h', `${Math.round(bar.getBoundingClientRect().height)}px`);

  // The deep link, once. A Home-queue row for this item opens the MOCK with
  // `?thread=`, and landing on the page with the ask still shut would be the
  // "now go find it" the queue exists to remove.
  if (el.pendingDockThread) {
    const wanted = items.find((i) => i.threadId === el.pendingDockThread);
    if (wanted) {
      el.pendingDockThread = null;
      openDockItem(el, wanted);
    }
  }
}
