/**
 * What a reader is told when the server refuses an answer on a review card.
 *
 * 30 Oct: the owner, signed in through Access hours earlier, tapped Approve on
 * an access card on their phone's Home and read "Posting the reply failed". The
 * server had refused with `confirm-required`, because approving an access
 * change asks for a sign-in from the last ten minutes, and the card's write
 * dropped that answer. These drive the controller's two answer verbs against
 * a fake server and read what the page then showed. All fixtures are
 * synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../src/board/board-actions.ts';
import type { PanelReviewItem } from '../src/board/board-detail-render.ts';
import { initialBoardState } from '../src/board/board-projection.ts';
import { createBoardReviewController } from '../src/board/board-review-controller.ts';
import type { ReviewItem } from '../src/board/board-review-model.ts';
import { boardRow, resetBoardServer, server } from './support/board-drive.ts';

const WS = 'w-harbor';
const CHANGE = {
  op: 'share-link' as const,
  workspaceId: WS,
  entries: ['ops@example.com'],
  link: { landing: { kind: 'doc', id: 'd-plan' } },
};
const LINE = 'Lets ops@example.com sign in, and mints a share link, opening on a doc (d-plan).';
const STALE = { error: 'confirm-required', window: 600, action: 'approve-access' };

function controller(): ReturnType<typeof createBoardReviewController> {
  const state: BoardState = initialBoardState({
    nav: 'home',
    task: null,
    goal: null,
    thread: null,
    item: null,
    archived: false,
  });
  return createBoardReviewController({
    author: { id: 'u-owner', name: 'Board Owner', kind: 'known', color: '#888888' },
    state,
    currentQueue: () => ({ items: [], blockers: [] }) as never,
    renderWalkthrough: () => {},
    loadReviewItems: async () => {},
    loadDiscussion: async () => {},
    openTaskThread: () => false,
  });
}

/** A ticket-borne card on Home; `access` makes it an access card. */
function homeItem(access?: typeof CHANGE): ReviewItem {
  return {
    key: 't-invite:r-1',
    kind: 'review',
    title: 'Invite the Riverbend ops team',
    ask: LINE,
    why: '',
    since: 0,
    thread: {
      kind: 'task-review',
      workspaceId: WS,
      taskId: 't-invite',
      reviewItemId: 'r-1',
      ...(access ? { access } : {}),
    },
  } as unknown as ReviewItem;
}

function panelItem(access?: typeof CHANGE): PanelReviewItem {
  return {
    id: 'r-1',
    source: 'task-review',
    shape: 'decision',
    reviewItemId: 'r-1',
    headline: LINE,
    since: 0,
    ...(access ? { access } : {}),
  } as PanelReviewItem;
}

const toast = (): string => document.getElementById('board-toast')?.textContent ?? '';
const prompt = (): string | null =>
  document.querySelector('.fresh-signin-prompt .identity-card h2')?.textContent ?? null;

beforeEach(() => {
  resetBoardServer();
  document.body.replaceChildren();
  const el = document.createElement('div');
  el.id = 'board-toast';
  document.body.append(el);
});

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('an access Approve whose sign-in is older than ten minutes', () => {
  it('asks "Confirm it\'s you" on the Home card instead of failing', async () => {
    server.on(`/workspaces/${WS}/tasks/t-invite/review-items/r-1/access`, STALE, 403);
    const pending = controller().replyToReviewItem(homeItem(CHANGE), 'Approve', 'o-approve');
    await vi.waitFor(() => expect(prompt()).toBe("Confirm it's you"));
    expect(toast()).not.toContain('Posting the reply failed');
    // The prompt names what would be approved.
    expect(document.querySelector('.fresh-signin-prompt b')?.textContent).toBe(LINE);
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('.fresh-signin-prompt button'),
    ].find((b) => b.textContent === 'Cancel');
    cancel?.click();
    expect(await pending).toBe(false);
    expect(toast()).toBe('Nothing changed');
  });

  it('asks on the task panel card too', async () => {
    server.on('/workspaces/', STALE, 403);
    const pending = controller().answerPanelThreadItem(
      boardRow('t-invite'),
      panelItem(CHANGE),
      'Approve',
      'o-approve',
    );
    await vi.waitFor(() => expect(prompt()).toBe("Confirm it's you"));
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('.fresh-signin-prompt button'),
    ].find((b) => b.textContent === 'Cancel');
    cancel?.click();
    expect(await pending).toBe(false);
  });

  it('posts the change the card showed and nothing the page made up', async () => {
    server.on(`/workspaces/${WS}/tasks/t-invite/review-items/r-1/access`, { decision: 'approve' });
    expect(await controller().replyToReviewItem(homeItem(CHANGE), 'Approve', 'o-approve')).toBe(
      'answered',
    );
    const post = server.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`/workspaces/${WS}/tasks/t-invite/review-items/r-1/access`);
    expect(post?.body).toEqual({ decision: 'approve', access: CHANGE });
    expect(prompt()).toBeNull();
  });
});

describe("a refused answer says the server's own words", () => {
  const refusal = {
    error: 'card-changed',
    message: 'the change on this card is not the one you were shown',
  };

  it('on a Home card', async () => {
    server.on('/workspaces/', refusal, 409);
    expect(await controller().replyToReviewItem(homeItem(), 'Yes', 'o-yes')).toBe(false);
    expect(toast()).toBe(refusal.message);
  });

  it('on a task panel card', async () => {
    server.on('/workspaces/', refusal, 409);
    expect(
      await controller().answerPanelThreadItem(boardRow('t-invite'), panelItem(), 'Yes', 'o-yes'),
    ).toBe(false);
    expect(toast()).toBe(refusal.message);
  });

  it('keeps the plain sentence when the server wrote none', async () => {
    server.on('/workspaces/', { error: 'not-found' }, 404);
    expect(await controller().replyToReviewItem(homeItem(), 'Yes', 'o-yes')).toBe(false);
    expect(toast()).toBe('Posting the reply failed — your text is still in the box');
  });
});
