/**
 * Home's section for review items on other servers: what `home-remotes.ts`
 * pulled, drawn inside `#landing-review` so the page's live swap
 * (`landing-live.ts`) redraws it with the review bar.
 *
 * Text only. Every field a remote sent goes through `escapeHtml` and nothing
 * else: no markdown, no HTML, no autolinking. The one link is a row's `href`,
 * which `readHomeFeed` has already narrowed to a path on that server's own
 * boards, and it is escaped into the attribute as well.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { RemoteBoardView } from './home-remotes.ts';
import { agoText } from './landing-review.ts';

function renderRow(row: RemoteBoardView['rows'][number], now: number): string {
  const title = escapeHtml(row.title);
  const head = row.href
    ? `<a class="rr-title" href="${escapeHtml(row.href)}">${title}</a>`
    : `<span class="rr-title">${title}</span>`;
  const ask = row.ask ? `<span class="rr-ask">${escapeHtml(row.ask)}</span>` : '';
  const by = row.askedBy ? `${escapeHtml(row.askedBy)} · ` : '';
  return `<li class="rr">${head}${ask}<span class="rr-by">${by}${agoText(row.since, now)}</span></li>`;
}

function renderBoard(b: RemoteBoardView, now: number): string {
  const notes: string[] = [];
  if (b.reached === null) notes.push('Not read yet.');
  if (b.reached === false) {
    notes.push(b.rows.length > 0 ? 'Not reached; these are the last items read.' : 'Not reached.');
  }
  if (b.dropped > 0) notes.push(`${b.dropped} item${b.dropped === 1 ? '' : 's'} refused.`);
  if (b.linksRefused > 0) {
    notes.push(`${b.linksRefused} link${b.linksRefused === 1 ? '' : 's'} removed.`);
  }
  if (b.rows.length === 0 && notes.length === 0) return '';
  const rows = b.rows.length > 0 ? `<ul>${b.rows.map((r) => renderRow(r, now)).join('')}</ul>` : '';
  const note = notes.length > 0 ? `<p class="rb-note">${notes.join(' ')}</p>` : '';
  return `<section class="rb"><h3 class="rb-name">${escapeHtml(b.boardName)} <span class="qn">${b.rows.length}</span></h3>${note}${rows}</section>`;
}

/** The section, or nothing when no remote board has anything to show. */
export function renderRemoteReview(boards: readonly RemoteBoardView[], now = Date.now()): string {
  const parts = boards.map((b) => renderBoard(b, now)).filter((s) => s !== '');
  if (parts.length === 0) return '';
  return `<div class="remote-review"><h2 class="alltitle">On other servers</h2>${parts.join('')}</div>`;
}

export const LANDING_REMOTE_CSS = `
.remote-review{border:1px solid #d8dee4;border-radius:10px;padding:12px 14px;margin:0 0 18px}
.remote-review .rb{margin:8px 0 0}
.rb-name{font-size:13px;font-weight:600;color:#1b1f23;margin:0 0 4px}
.rb-note{color:#57606a;font-size:13px;margin:0 0 4px}
.remote-review ul{list-style:none;margin:0;padding:0}
.rr{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:1px solid #eaeef2;overflow-wrap:anywhere}
.rr-title{font-size:14px;font-weight:600;color:#1b1f23}
a.rr-title{color:#2e7dd7}
.rr-ask{font-size:13px;color:#1b1f23;white-space:pre-wrap}
.rr-by{font-size:12px;color:#8b95a1}
`;
