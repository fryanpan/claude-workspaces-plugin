/**
 * The secret ask everywhere that is NOT its own card.
 *
 * Its card is pinned twice over — `review-item-secret.test.tsx` for the Home
 * walkthrough, `task-detail-secret.test.tsx` for the task panel. What a UX
 * walk found afterwards was that the surfaces AROUND the card each told the
 * reader something different or nothing at all (2026-09-12):
 *
 *  - a save from the task panel confirmed nothing — the card simply vanished;
 *  - the same ask was badged grey on Home and amber on the two surfaces the
 *    reader reaches next, and Home is where Bryan lands first;
 *  - the ask was echoed into the comment history with a comment box under it
 *    and no line saying that a comment is the one place it cannot be answered;
 *  - on the iPad the Save sat below the fold.
 *
 * Reaching Save is no longer one of them. It was a sticky row here, asserted
 * as a computed `position`, until a second walk found the sticky row painting
 * itself over the fields it belongs to. What replaced it — the scroll
 * reserving the row's height — is a used-geometry property that only a real
 * browser can answer, so it is pinned in `secret-save-bar.test.ts` instead of
 * restated here as a declaration nobody can read a behaviour off.
 *
 * All fixtures are synthetic: invented names, invented service names, and
 * placeholder values that are deliberately not token-shaped.
 */
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board/board-actions.ts';
import type { BoardReviewItem } from '../src/board/board-model.ts';
import { initialBoardState } from '../src/board/board-projection.ts';
import { createBoardReviewController } from '../src/board/board-review-controller.ts';
import { reviewItemRow } from '../src/board/board-review-render.ts';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';
import { resetBoardServer, server } from './support/board-drive.ts';

const NOW = 1_700_000_000_000;
const FIRST_VALUE = 'not-a-real-value-1';
const SERVICES = ['saltmarsh-relay-account', 'saltmarsh-relay-signer'];

describe('what a reader is told after a hand-over lands', () => {
  /** The controller with the smallest surroundings that reach the POST. */
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

  const toast = (): string => document.getElementById('board-toast')?.textContent ?? '';

  function stage(): void {
    resetBoardServer();
    document.body.replaceChildren();
    const el = document.createElement('div');
    el.id = 'board-toast';
    document.body.append(el);
  }

  it('names the services it saved, and never a value', async () => {
    // The task panel confirmed nothing: a ticket-borne item's answered record
    // lives on a declaring comment and there is no comment, so the card just
    // went. Home settles the card into its answered stack; this line is what
    // both surfaces now say, because both go through the one POST.
    stage();
    // The workspace segment comes from the page's own address, which this
    // suite never sets, so the route is registered on the prefix every board
    // call shares and the ADDRESS is asserted off the recorded call below.
    server.on('/workspaces/', { saved: SERVICES });
    const ok = await controller().saveSecretsOnTaskItem(
      't-nightly',
      'r-secret',
      SERVICES.map((service) => ({ service, value: FIRST_VALUE })),
    );
    expect(ok).toBe(true);
    const post = server.calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/tasks/t-nightly/review-items/r-secret/secrets');
    expect(toast()).toBe(`Saved: ${SERVICES.join(', ')}`);
    // The one thing it must never carry.
    expect(toast()).not.toContain(FIRST_VALUE);
  });

  it('says nothing was recorded when the write is refused', async () => {
    // CONTROL for the case above: the same call against a door that refuses
    // says the opposite, so "Saved" is a report of what happened rather than
    // a line the card prints whatever the server did.
    stage();
    server.on('/workspaces/', { error: 'store-failed' }, 502);
    const ok = await controller().saveSecretsOnTaskItem(
      't-nightly',
      'r-secret',
      SERVICES.map((service) => ({ service, value: FIRST_VALUE })),
    );
    expect(ok).toBe(false);
    expect(toast()).toContain('nothing was recorded');
    expect(toast()).not.toContain(FIRST_VALUE);
  });
});

describe('the ask echoed into the comment history', () => {
  function row(over: Partial<BoardReviewItem['review']> = {}): HTMLLIElement {
    const item: BoardReviewItem = {
      id: 'r-secret',
      review: {
        shape: 'secret',
        headline: 'Paste the two relay values so the nightly post can run',
        detail: 'The nightly pass signs in to the Saltmarsh relay and posts the index.',
        ...over,
      },
      createdBy: 'Riverbend Bot',
      createdAt: NOW - 3_600_000,
    };
    return reviewItemRow(item, NOW);
  }

  it('says where it is answered, because the comment box is right underneath', () => {
    const li = row();
    expect(li.querySelector('.board-comment-review-note')?.textContent).toContain(
      'never in a comment',
    );
    // And it reads SECRET here too, at the weight the card gives it.
    expect(li.querySelector('.board-comment-review-k')?.textContent).toBe('Secret');
    expect(li.querySelector('.board-comment-review-k')?.classList.contains('is-secret')).toBe(true);
  });

  it('drops the line once there is nothing left to answer', () => {
    // CONTROLS, both directions. An ordinary ask never had the problem, and an
    // answered secret ask needs no instruction — so the line is about an open
    // secret ask rather than about every row this function draws.
    expect(row({ shape: 'review' }).querySelector('.board-comment-review-note')).toBeNull();
    const answered: BoardReviewItem = {
      id: 'r-secret',
      review: { shape: 'secret', headline: 'Paste the two relay values' },
      createdBy: 'Riverbend Bot',
      createdAt: NOW - 3_600_000,
      answer: { text: `Secrets saved: ${SERVICES.join(', ')}`, by: 'Board Owner', ts: NOW },
    };
    expect(reviewItemRow(answered, NOW).querySelector('.board-comment-review-note')).toBeNull();
  });
});

describe('the weight the badge carries, read off the page', () => {
  const chip = (cls: string): HTMLElement => {
    const el = document.createElement('span');
    el.className = cls;
    document.body.append(el);
    return el;
  };

  it('gives a secret ask a decision’s tone on Home, not the muted one', () => {
    setViewport(IPAD);
    const done = installSheets('board.css', 'styles.css');
    try {
      document.body.replaceChildren();
      const secret = styleOf(chip('board-walk-k board-walk-k-secret'));
      const decision = styleOf(chip('board-walk-k board-walk-k-decision'));
      const plain = styleOf(chip('board-walk-k'));
      // Home is where Bryan lands first, and it read grey there while the two
      // surfaces he reaches next read amber.
      expect(secret.color).toBe(decision.color);
      expect(secret.backgroundColor).toBe(decision.backgroundColor);
      // CONTROL: the bare chip is still the muted one, so the assertion above
      // is the secret rule applying rather than every chip having gone amber.
      expect(secret.color).not.toBe(plain.color);
    } finally {
      done();
    }
  });
});
