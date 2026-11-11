/**
 * A board link's status, drawn into the escaped-HTML string the comment
 * renderer builds (`comment-markdown.ts`): the word pill after the link's
 * words, or — for the lead chat — the board row's own ring before them
 * (`statusMarkEl` in `link-titles.ts` is the DOM twin). The status is server
 * data, not markup, so it is escaped into both the class and the words.
 */
import {
  REVIEW_MARK_WORDS,
  cachedLinkBlocked,
  cachedLinkNeedsReview,
  cachedLinkStatus,
  statusChipLabel,
  statusMarkWords,
} from './link-titles.ts';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The needs-review mark (`reviewMarkEl` is the DOM twin), after everything
 *  else the link carries. */
const REVIEW_MARK_HTML = `<span class="ws-review-mark" role="img" aria-label="${REVIEW_MARK_WORDS}" title="${REVIEW_MARK_WORDS}"></span>`;

/** `text` (already escaped) with the status of the row `url` names, if known,
 *  and the needs-review mark when its target waits on the reader. */
export function withLinkStatus(text: string, url: string, marks: boolean): string {
  const drawn = withStatus(text, url, marks);
  return cachedLinkNeedsReview(url) ? `${drawn}${REVIEW_MARK_HTML}` : drawn;
}

function withStatus(text: string, url: string, marks: boolean): string {
  const status = cachedLinkStatus(url);
  if (!status) return text;
  const s = escapeHtml(status);
  if (!marks) {
    return `${text}<span class="ws-status-chip ws-chip-${s}">${escapeHtml(statusChipLabel(status))}</span>`;
  }
  const blocked = cachedLinkBlocked(url);
  const words = escapeHtml(statusMarkWords(status, blocked));
  const state = blocked ? 'blocked' : s;
  return `<span class="board-status-mark board-status-mark-${state}" role="img" aria-label="Task: ${words}" title="${words}"></span>${text}`;
}
