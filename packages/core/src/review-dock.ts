import type { ReviewOption, ReviewPayload } from './review-item-types.ts';
import {
  isReviewPayloadGated,
  pendingDeclaration,
  reviewAnswered,
  reviewWithdrawn,
} from './review-item.ts';
import type { Thread } from './types.ts';
import { escapeHtml as escape } from './ui-shared.ts';

/**
 * The review-item DOCK — an ask, in a bar across the bottom of the page it is
 * about, answerable there.
 *
 * Two pages draw it: the widget on a served mock (`widget-dock.ts`) and the
 * doc page (`workspaces-app/src/doc/linked-dock.ts`), which loads no widget.
 * The rules for which asks dock, the markup, and the sheet's behaviour live
 * here so the two draw one dock rather than two that drift. Each page keeps
 * what is its own: where the items come from, the shadow root they mount in,
 * and the request an answer makes.
 *
 * No `document` is touched here. The markup is strings, and the one wiring
 * function works on the element its caller made.
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
  /**
   * Set on an ask filed on a TICKET that links this page, rather than raised
   * in the page's own threads. `threadId` then holds the item's
   * `reviewItemId`, and the answer goes to the ticket's own answer route.
   */
  taskId?: string;
}

/**
 * A ticket item that links a page, as the server hands it out — in a mock's
 * HTML (`mockup-linked-items.ts`) or on a doc's JSON record (`linkedItems`).
 */
export interface LinkedDockItem {
  taskId: string;
  reviewItemId: string;
  review: ReviewPayload;
  by: string;
  ts: number;
}

/** The server's list as dock items. Anything that is not a list is none. */
export function linkedDockItems(list: unknown): DockItem[] {
  if (!Array.isArray(list)) return [];
  return (list as LinkedDockItem[]).map((i) => ({
    threadId: i.reviewItemId,
    commentId: '',
    review: i.review,
    by: i.by,
    ts: i.ts,
    answered: false,
    taskId: i.taskId,
  }));
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
export function dockItems(threads: Thread[], linked: DockItem[] = []): DockItem[] {
  // A linked ticket item has already passed the Home queue's membership on
  // the server; the owner-only rule below is still the dock's own to apply.
  const items = linked.filter((i) => !i.review.ownerOnly);
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

/** The bar's contents: the ask's headline, a round chip once revised, a caret. */
export function dockBarHtml(item: DockItem): string {
  const rounds = dockRounds(item.review).length;
  return `<button class="cw-dock-item" type="button">
        <span class="cw-dock-ic${item.answered ? ' cw-dock-ic-done' : ''}">${
          item.answered ? '✓' : '?'
        }</span>
        <span class="cw-dock-text">${escape(item.review.headline)}${
          item.answered ? ' <span class="cw-dock-said">· answered</span>' : ''
        }</span>
        ${rounds > 1 ? `<span class="cw-dock-round">Round ${rounds}</span>` : ''}
        <span class="cw-dock-caret" aria-hidden="true">›</span>
      </button>`;
}

/** The expanded item — the rounds, and the way to answer it — for the inside
 *  of a `.cw-dock-scrim`. */
export function dockSheetHtml(item: DockItem): string {
  return `<div class="cw-modal" role="dialog" aria-modal="true">
      <div class="cw-modal-head"><span class="cw-modal-who">${escape(item.by)}</span>
      <button class="icon-btn cw-modal-close" type="button" aria-label="Close">×</button></div>
      <div class="cw-modal-scroll">${roundsHtml(dockRounds(item.review))}</div>
      ${answerHtml(item)}
    </div>`;
}

const INLINE_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

/**
 * Where an inline link in an ask may go, or null for one the dock leaves as
 * text: a same-origin path or query, or an http(s) URL. Anything carrying
 * another scheme (`javascript:`, `data:`), a protocol-relative `//host`, or a
 * control character a browser would strip before reading the scheme is none.
 */
export function dockLinkHref(url: string): string | null {
  if ([...url].some((c) => c < ' ' || c === '\u007f')) return null;
  if (/^https?:\/\/[^/]/i.test(url)) return url;
  if (/^[/?#]/.test(url) && !url.startsWith('//')) return url;
  return null;
}

/**
 * Turn `[text](url)` in an element's text into links — text nodes and anchors,
 * never markup, so nothing in an ask's words is parsed as HTML. A board link
 * opens at the top level (the widget's page may be framed); an outside one in
 * a new tab.
 */
function linkInto(el: Element): void {
  const text = el.textContent ?? '';
  const doc = el.ownerDocument;
  const parts: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE_LINK)) {
    const href = dockLinkHref(m[2] ?? '');
    if (!href) continue;
    parts.push(doc.createTextNode(text.slice(at, m.index)));
    const a = doc.createElement('a');
    a.textContent = m[1] ?? '';
    a.href = href;
    a.target = href.startsWith('http') ? '_blank' : '_top';
    if (a.target === '_blank') a.rel = 'noopener noreferrer';
    parts.push(a);
    at = (m.index ?? 0) + m[0].length;
  }
  if (!parts.length) return;
  parts.push(doc.createTextNode(text.slice(at)));
  el.replaceChildren(...parts);
}

/**
 * Make an open sheet work: render the ask's inline links, close on the scrim
 * or ×, answer on an option or the send button, and say so when the answer
 * was refused.
 *
 * `send` makes the page's own request and says whether it landed; the sheet
 * closes and `onAnswered` runs only then, so a refused answer leaves the
 * reader's choice and reason where they were.
 */
export function wireDockSheet(
  scrim: HTMLElement,
  opts: { send: (text: string, optionId?: string) => Promise<boolean>; onAnswered: () => void },
): void {
  for (const body of Array.from(scrim.querySelectorAll('.cw-round-body'))) linkInto(body);
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
    const ok = await opts.send(text, optionId).catch(() => false);
    inFlight = false;
    if (!ok) {
      if (err) {
        err.hidden = false;
        err.textContent = 'Couldn’t answer — try again.';
      }
      return;
    }
    close();
    opts.onAnswered();
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
