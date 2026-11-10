/**
 * The needs-review mark on a workspace link, in the three places a link is
 * drawn: a comment (the escaped-HTML renderer), a hydrated anchor (the DOM
 * pass), and doc prose (the editor's decoration). Also where following a
 * marked task link lands, and that a stale answer stays drawn while it is
 * asked again. Fixtures are synthetic; the repo is public.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewFocusOf } from '../src/board/board-url.ts';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';
import { followedLinkHref } from '../src/link-open.ts';
import {
  _resetLinkTitlesForTest,
  cachedLinkNeedsReview,
  fetchLinkInfos,
  hydrateLinkTitles,
  isLinkInfoStale,
  primeLinkTitle,
  reviewLandingHref,
  staleLinkReviewMarks,
} from '../src/link-titles.ts';
import { TaskLinkChips, refreshTaskLinkChips, taskLinkChipsKey } from '../src/task-link-chips.ts';

const TASK = `${location.origin}/workspaces/w-harbor?task=t-ferry`;
const PLAIN = `${location.origin}/workspaces/w-harbor?task=t-slipway`;
const MOCK = `${location.origin}/workspaces/w-harbor/mockups/m-ferry`;

/** A fetcher answering one fixed lookup, counting the calls. */
function answering(
  titles: Record<string, string>,
  statuses: Record<string, string>,
  needsReview: Record<string, boolean>,
) {
  const calls: string[][] = [];
  const fetcher = async (_path: string, init?: RequestInit) => {
    calls.push((JSON.parse(String(init?.body)) as { urls: string[] }).urls);
    return new Response(JSON.stringify({ titles, statuses, needsReview }), { status: 200 });
  };
  return { fetcher, calls };
}

function anchor(url: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `<a href="${url}" class="ws-link" data-ws-link="${url}" data-ws-pending="">${url}</a>`;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => _resetLinkTitlesForTest());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the mark on a hydrated anchor', () => {
  it('draws one mark after a waiting task’s chip, and none on a plain one', async () => {
    const waiting = anchor(TASK);
    const plain = anchor(PLAIN);
    const { fetcher } = answering(
      { [TASK]: 'Check the Riverbend timetable', [PLAIN]: 'Paint the Saltmarsh slipway' },
      { [TASK]: 'todo', [PLAIN]: 'todo' },
      { [TASK]: true },
    );
    await hydrateLinkTitles(document, fetcher);
    const a = waiting.querySelector('a');
    expect([...(a?.children ?? [])].map((c) => c.className)).toEqual([
      'ws-status-chip ws-chip-todo',
      'ws-review-mark',
    ]);
    expect(a?.querySelector('.ws-review-mark')?.getAttribute('aria-label')).toBe(
      'Waiting on your review',
    );
    expect(plain.querySelector('.ws-review-mark')).toBeNull();
    // Following the waiting task lands on its open items; the plain one opens as written.
    expect(a?.getAttribute('href')).toBe(`${TASK}&focus=review`);
    expect(plain.querySelector('a')?.getAttribute('href')).toBe(PLAIN);
  });

  it('marks a mock link with no status, and does not rewrite where it opens', async () => {
    const el = anchor(MOCK);
    const { fetcher } = answering({ [MOCK]: 'Ferry page' }, {}, { [MOCK]: true });
    await hydrateLinkTitles(document, fetcher);
    expect(el.querySelector('.ws-status-chip')).toBeNull();
    expect(el.querySelector('.ws-review-mark')).not.toBeNull();
    expect(el.querySelector('a')?.getAttribute('href')).toBe(MOCK);
  });

  it('drops the mark when the item is answered, keeping it drawn while it is asked again', async () => {
    const el = anchor(TASK);
    await hydrateLinkTitles(
      document,
      answering({ [TASK]: 'Check' }, { [TASK]: 'todo' }, { [TASK]: true }).fetcher,
    );
    staleLinkReviewMarks(document);
    // Stale, not forgotten: the old answer is still what draws.
    expect(isLinkInfoStale(TASK)).toBe(true);
    expect(cachedLinkNeedsReview(TASK)).toBe(true);
    expect(el.querySelector('.ws-review-mark')).not.toBeNull();
    const after = answering({ [TASK]: 'Check' }, { [TASK]: 'todo' }, {});
    await hydrateLinkTitles(document, after.fetcher);
    expect(after.calls).toEqual([[TASK]]);
    expect(el.querySelector('.ws-review-mark')).toBeNull();
    expect(el.querySelector('a')?.getAttribute('href')).toBe(TASK);
    expect(isLinkInfoStale(TASK)).toBe(false);
  });

  it('asks again for a link that went stale while its lookup was out', async () => {
    let release: (r: Response) => void = () => {};
    const slow = (_p: string, _i?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const first = fetchLinkInfos([MOCK], slow);
    primeLinkTitle(MOCK, 'Ferry page', null, false, false, true);
    staleLinkReviewMarks(null);
    release(
      new Response(JSON.stringify({ titles: { [MOCK]: 'Ferry page' }, needsReview: {} }), {
        status: 200,
      }),
    );
    await first;
    // The answer predates the change, so the link is still waiting to be asked.
    expect(isLinkInfoStale(MOCK)).toBe(true);
  });
});

describe('the mark in a rendered comment', () => {
  it('draws the mark and the landing address from the cache', () => {
    primeLinkTitle(TASK, 'Check the Riverbend timetable', 'todo', false, false, true);
    primeLinkTitle(PLAIN, 'Paint the Saltmarsh slipway', 'todo');
    const html = renderCommentMarkdown(`See ${TASK} and ${PLAIN}`);
    const el = document.createElement('div');
    el.innerHTML = html;
    const [waiting, plain] = [...el.querySelectorAll('a')];
    expect(waiting?.querySelector('.ws-review-mark')).not.toBeNull();
    expect(waiting?.getAttribute('href')).toBe(`${TASK}&focus=review`);
    expect(plain?.querySelector('.ws-review-mark')).toBeNull();
  });
});

describe('the mark in doc prose', () => {
  function specs(editor: Editor): string[] {
    const state = taskLinkChipsKey.getState(editor.state) as
      | { deco?: { find: () => Array<{ spec: { key?: string } }> } }
      | undefined;
    return (state?.deco?.find() ?? []).map((d) => d.spec.key ?? '');
  }

  it('hangs the mark after the chip, and takes it away on refresh once answered', () => {
    const rel = '/workspaces/w-harbor?task=t-ferry';
    primeLinkTitle(rel, 'Check the Riverbend timetable', 'todo', false, false, true);
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit.configure({ undoRedo: false }), TaskLinkChips],
      content: `<p><a href="${rel}">the timetable</a></p>`,
    });
    expect(specs(editor).sort()).toEqual([`${rel}|review`, `${rel}|todo`]);
    const marks = element.querySelectorAll('.ws-review-mark');
    expect(marks.length).toBe(1);
    // The chip comes first, so it never moves when the mark comes or goes.
    const chip = element.querySelector('.ws-status-chip');
    expect(chip?.compareDocumentPosition(marks[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    primeLinkTitle(rel, 'Check the Riverbend timetable', 'todo');
    refreshTaskLinkChips(editor.view);
    expect(specs(editor)).toEqual([`${rel}|todo`]);
    editor.destroy();
  });

  it('opens a waiting task at its review items, and anything else where it points', () => {
    primeLinkTitle(TASK, 'Check', 'todo', false, false, true);
    primeLinkTitle(MOCK, 'Ferry page', null, false, false, true);
    expect(followedLinkHref(TASK)).toBe(`${TASK}&focus=review`);
    expect(followedLinkHref(MOCK)).toBe(MOCK);
    expect(followedLinkHref(PLAIN)).toBe(PLAIN);
    expect(followedLinkHref('javascript:alert(1)')).toBeNull();
    // A root-relative link stays root-relative.
    const rel = '/workspaces/w-harbor?task=t-ferry';
    primeLinkTitle(rel, 'Check', 'todo', false, false, true);
    expect(reviewLandingHref(rel)).toBe('/workspaces/w-harbor?task=t-ferry&focus=review');
  });
});

describe('reviewFocusOf', () => {
  it('asks the panel to land only for the task the address opens', () => {
    expect(reviewFocusOf('?task=t-ferry&focus=review', 't-ferry')).toBe(true);
    expect(reviewFocusOf('?task=t-ferry&focus=review', 't-slipway')).toBe(false);
    expect(reviewFocusOf('?task=t-ferry', 't-ferry')).toBe(false);
  });

  it('keeps the arrival address after the board rewrites the bar, and answers once', async () => {
    const before = window.location.href;
    window.history.replaceState(null, '', '/workspaces/w-harbor?task=t-ferry&focus=review');
    vi.resetModules();
    const fresh = await import('../src/board/board-url.ts');
    // The board's own rewrite, before the panel mounts.
    window.history.replaceState(null, '', '/workspaces/w-harbor?task=t-ferry');
    expect(fresh.takeReviewFocus('t-slipway')).toBe(false);
    expect(fresh.takeReviewFocus('t-ferry')).toBe(true);
    // Closing and reopening the task opens it as usual.
    expect(fresh.takeReviewFocus('t-ferry')).toBe(false);
    window.history.replaceState(null, '', before);
  });
});
