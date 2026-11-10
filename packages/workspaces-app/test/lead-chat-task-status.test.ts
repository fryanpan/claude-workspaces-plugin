/**
 * A task link in the lead chat shows its status with the board row's own
 * ring — `.board-status-mark-<status>`, before the link's words — rather
 * than the word pill threads use, which the chat's shadow root never styled
 * (it read "Paint the slipwayIn progress"). The real-browser twin, which
 * renders the chat and the board row side by side, is
 * `lead-chat-task-status-browser.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';
import { STATUS_MARK_STYLES } from '../src/lead-chat/lead-chat-styles.ts';
import { _resetLinkTitlesForTest, hydrateLinkTitles, primeLinkTitle } from '../src/link-titles.ts';
import { installSheets, styleOf } from './css-harness.ts';

const TASK_URL = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;

beforeEach(() => {
  _resetLinkTitlesForTest();
});

const linkIn = (html: string): HTMLAnchorElement => {
  const el = document.createElement('div');
  el.innerHTML = html;
  const a = el.querySelector('a');
  if (!a) throw new Error('no link drawn');
  return a;
};

describe('a task link drawn for the lead chat', () => {
  it('leads with the board’s ring when the status is already known', () => {
    primeLinkTitle(TASK_URL, 'Moor the Riverbend ferry', 'in-progress');
    const a = linkIn(renderCommentMarkdown(TASK_URL, { statusMarks: true }));
    const mark = a.firstElementChild;
    expect(mark?.className).toBe('board-status-mark board-status-mark-in-progress');
    expect(mark?.getAttribute('aria-label')).toBe('Task: In progress');
    expect(a.textContent).toBe('Moor the Riverbend ferry');
    expect(a.querySelector('.ws-status-chip')).toBeNull();
  });

  it('wears the barred ring for a row the board draws as blocked', () => {
    primeLinkTitle(TASK_URL, 'Moor the Riverbend ferry', 'todo', false, true);
    const mark = linkIn(renderCommentMarkdown(TASK_URL, { statusMarks: true })).firstElementChild;
    expect(mark?.className).toBe('board-status-mark board-status-mark-blocked');
    expect(mark?.getAttribute('aria-label')).toBe('Task: To do, blocked');
  });

  it('keeps the word pill everywhere else', () => {
    primeLinkTitle(TASK_URL, 'Moor the Riverbend ferry', 'in-progress');
    const a = linkIn(renderCommentMarkdown(TASK_URL));
    expect(a.querySelector('.board-status-mark')).toBeNull();
    expect(a.lastElementChild?.className).toBe('ws-status-chip ws-chip-in-progress');
  });

  it('gets the ring when the status lands after the link was drawn', async () => {
    const el = document.createElement('div');
    el.innerHTML = renderCommentMarkdown(`[the ferry](${TASK_URL})`, { statusMarks: true });
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          titles: { [TASK_URL]: 'Moor the Riverbend ferry' },
          statuses: { [TASK_URL]: 'done' },
        }),
        { status: 200 },
      );
    await hydrateLinkTitles(el, fetcher, 'mark');
    const a = el.querySelector('a');
    expect(a?.firstElementChild?.className).toBe('board-status-mark board-status-mark-done');
    expect(a?.textContent).toBe('the ferry');
    expect(el.querySelectorAll('.board-status-mark, .ws-status-chip')).toHaveLength(1);
  });
});

describe('the chat’s ring and the board’s ring', () => {
  let cleanup: () => void = () => {};
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  const PROPS = [
    'display',
    'width',
    'height',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-left-radius',
    'background-color',
  ] as const;
  const read = (el: Element): Record<string, string> =>
    Object.fromEntries(PROPS.map((p) => [p, styleOf(el).getPropertyValue(p)]));

  it('compute the same for every status', () => {
    cleanup = installSheets('styles.css', 'board.css');
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STATUS_MARK_STYLES;
    root.append(style);
    document.body.append(host);
    const seen = new Set<string>();
    for (const status of ['triage', 'todo', 'in-progress', 'done', 'blocked']) {
      const board = document.createElement('span');
      board.className = `board-status-mark board-status-mark-${status}`;
      document.body.append(board);
      const chat = document.createElement('span');
      chat.className = board.className;
      root.append(chat);
      // Positive control: the board's rule reaches its element at all.
      expect(styleOf(board).getPropertyValue('width'), status).toBe('18px');
      expect(read(chat), status).toEqual(read(board));
      seen.add(JSON.stringify(read(board)));
    }
    // The statuses differ from one another, or matching them proves nothing.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});
