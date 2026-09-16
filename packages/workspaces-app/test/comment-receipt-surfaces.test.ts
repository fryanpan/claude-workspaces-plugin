import type { Comment, Thread, User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commentRow } from '../src/board/board-discussion-render.ts';
import { ThreadPanel } from '../src/threads.ts';

/**
 * "Did anyone get that?", answered on every surface that draws a comment.
 *
 * Bryan approved the mark on a mock and added the condition this file exists
 * to hold: *"this should also work in every comment component in the whole
 * site."* So each surface gets its own case, driven through its own real
 * renderer. A shared helper with one test would pass while a surface that
 * never calls it shows nothing — which is the exact failure the instruction
 * was about.
 *
 * All fixtures are synthetic. The repo is public.
 */

const reader: User = { id: 'u-reader', name: 'Reader', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'u-agent', name: 'Harborlight', kind: 'known', color: '#b25e09' };

let ts = 1_700_000_000_000;
function comment(over: Partial<Comment> = {}): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: reader, text: 'anyone there?', ts, ...over };
}

function thread(comments: Comment[]): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: comments[0]?.author ?? reader,
    comments,
    ...{},
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

/** The doc surface's card, built through the panel that really builds it. */
function card(t: Thread, currentUser: User = reader): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser,
    onThreadClick: () => {},
    onReply: vi.fn(() => true),
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  panel.setThreads([t]);
  const el = panel.renderThread(t);
  container.appendChild(el);
  return el;
}

const marks = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>('.cw-receipt'));
const states = (el: HTMLElement): string[] => marks(el).map((m) => m.dataset.receipt ?? '');

describe('the review editor card', () => {
  it('marks the reader own opening comment sent, where its clock is', () => {
    const el = card(thread([comment()]));
    const head = el.querySelector('.thread-head');
    expect(head?.querySelector('.cw-receipt')?.getAttribute('data-receipt')).toBe('sent');
  });

  it('marks it received once the server says a session was handed it', () => {
    const el = card(thread([comment({ deliveredAt: ts + 50 })]));
    expect(states(el)).toContain('received');
    expect(el.querySelector('.cw-receipt')?.getAttribute('title')).toBe('Received');
  });

  it('draws nothing once the agent has replied', () => {
    const mine = comment({ deliveredAt: ts + 50 });
    const reply = comment({ author: agent, text: 'on it' });
    expect(marks(card(thread([mine, reply])))).toHaveLength(0);
  });

  it('draws nothing on a comment somebody else wrote', () => {
    const el = card(thread([comment({ author: agent, deliveredAt: ts + 50 })]));
    expect(marks(el)).toHaveLength(0);
  });

  it('marks a reply the reader wrote, in the history below the card', () => {
    const opening = comment({ author: agent, text: 'a question for you' });
    const mine = comment({ text: 'here is the answer', deliveredAt: ts + 50 });
    const el = card(thread([opening, mine]));
    const row = el.querySelector('.comments .comment');
    expect(row?.querySelector('.cw-receipt')?.getAttribute('data-receipt')).toBe('received');
  });
});

describe('the board discussion stream', () => {
  const NOW = ts + 10_000;
  const row = (over: Record<string, unknown> = {}) => ({
    threadId: 'th-1',
    comment: { id: 'bc-1', author: 'Reader', text: 'anyone there?', ts: NOW - 1000, ...over },
    siblings: [
      { id: 'bc-1', author: 'Reader', text: 'anyone there?', ts: NOW - 1000, ...over },
    ],
  });

  it('marks the reader own comment sent', () => {
    const li = commentRow(row(), undefined, NOW, 'Reader');
    expect(li.querySelector('.cw-receipt')?.getAttribute('data-receipt')).toBe('sent');
  });

  it('marks it received once it was handed to a session', () => {
    const li = commentRow(row({ deliveredAt: NOW - 500 }), undefined, NOW, 'Reader');
    expect(li.querySelector('.cw-receipt')?.getAttribute('data-receipt')).toBe('received');
  });

  it('draws nothing for a reader who did not write it', () => {
    const li = commentRow(row({ deliveredAt: NOW - 500 }), undefined, NOW, 'Somebody Else');
    expect(li.querySelector('.cw-receipt')).toBeNull();
  });

  it('draws nothing once somebody else replied on the same thread', () => {
    const base = row({ deliveredAt: NOW - 500 });
    const answered = {
      ...base,
      siblings: [
        ...base.siblings,
        { id: 'bc-2', author: 'Harborlight', text: 'on it', ts: NOW - 100 },
      ],
    };
    expect(commentRow(answered, undefined, NOW, 'Reader').querySelector('.cw-receipt')).toBeNull();
  });

  it('keeps the mark when the later comment is the reader own', () => {
    const base = row({ deliveredAt: NOW - 500 });
    const more = {
      ...base,
      siblings: [...base.siblings, { id: 'bc-3', author: 'Reader', text: 'and also', ts: NOW }],
    };
    expect(
      commentRow(more, undefined, NOW, 'Reader').querySelector('.cw-receipt')?.getAttribute(
        'data-receipt',
      ),
    ).toBe('received');
  });
});
