/**
 * What a review card tells the reader about the item's history with the
 * quality gate — driven through the two real surfaces that draw it.
 *
 * The reader could not previously tell a question that passed first time from
 * one that took three rounds, so the hold count is drawn. Whether the gate
 * reached a verdict or ran out of holds and gave up is NOT (Bryan,
 * 2026-09-16) — the reader judges the words in front of them, and the cases
 * below hold that boundary from both sides: the count renders, and an item
 * admitted on the last-hold rule is word-for-word indistinguishable from one
 * the gate held the same number of times and then passed.
 *
 * Driven rather than asserted about: the gate note reaches the card through
 * the queue model, and "the walkthrough renders the field the server sends"
 * is the wiring, not a property of the component alone. The cascade half is
 * read as a computed value off the real stylesheets, per the testing
 * standards — happy-dom does no layout, so nothing here measures a pixel.
 *
 * All fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailHandlers } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { type ReviewThreadItem, reviewQueue } from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import { attach, installSheets, setViewport, styleOf } from './css-harness.ts';
import { renderTaskDetail } from './support/task-detail.ts';

const WS = 'w-tideline';
const NOW = 1_700_000_000_000;

function walkHandlers(): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
}

/** A ticket-borne review item as the server ships it, with whatever the gate
 *  did to it. */
function item(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  return {
    kind: 'task-review',
    docId: 'task:t-ledger',
    threadId: '',
    taskId: 't-ledger',
    reviewItemId: 'r-window',
    workspaceId: WS,
    title: 'Move the last reader across',
    ask: 'Hold the old path open another week?',
    askedBy: 'Ledger Keeper',
    since: NOW - 60_000,
    band: 'declared',
    review: { shape: 'review', headline: 'Hold the old path open another week?' },
    ...over,
  } as ReviewThreadItem;
}

let dispose: (() => void) | null = null;
/** The walkthrough card for one item, on screen. */
function card(row: ReviewThreadItem, tasks: BoardTask[] = []): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  dispose?.();
  walkthroughData.value = {
    queue: reviewQueue(tasks, [row], NOW),
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    handlers: walkHandlers(),
    secretsGate: 'open',
  };
  dispose = mountWalkthroughIsland(container);
  const el = container.querySelector('.board-walk-card');
  expect(el, 'the walkthrough drew no card').not.toBeNull();
  return el as HTMLElement;
}

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.replaceChildren();
});

describe('the walkthrough card says what the gate did', () => {
  it('says nothing at all about an item the gate simply passed', () => {
    const el = card(item());
    expect(el.querySelector('.board-walk-gate')).toBeNull();
    expect(el.querySelector('.board-walk-gate-note')).toBeNull();
  });

  it('counts the holds an item went through, in words', () => {
    const el = card(item({ gate: { holds: 3 } }));
    expect(el.querySelector('.board-walk-gate')?.textContent).toContain('Held three times');
  });

  it('tells the reader nothing about the gate having given up on an item', () => {
    const gaveUp = card(item({ gate: { holds: 2, admitted: 'holds' } }));
    // The count is the whole point of the line and still renders.
    expect(gaveUp.querySelector('.board-walk-gate')?.textContent).toContain('Held twice');
    // No badge, and no clause anywhere on the card, about who judged what.
    expect(gaveUp.querySelector('.board-walk-k-unjudged')).toBeNull();
    const spoken = (gaveUp.textContent ?? '').toLowerCase();
    expect(spoken).not.toContain('unjudged');
    expect(spoken).not.toContain('verdict');
    // And not merely quieter: read WORD FOR WORD against a card the gate held
    // twice and then passed, so the absence of a claim is not itself the
    // signal the badge used to be. Captured before the next mount, which
    // tears this one down.
    const gaveUpText = gaveUp.textContent;
    const passedText = card(item({ gate: { holds: 2 } })).textContent;
    expect(gaveUpText).toBe(passedText);
  });

  it("shows the filer's own note, quoted and attributed, when that is how it got through", () => {
    const note = 'The log gives a range across five runs, not a single figure.';
    const el = card(item({ gate: { holds: 1, admitted: 'less-specific', lessSpecific: note } }));
    const block = el.querySelector('.board-walk-gate-note');
    expect(block?.textContent).toContain(note);
    expect(block?.querySelector('.board-walk-gate-note-who')?.textContent).toBe(
      'Ledger Keeper says',
    );
    // Somebody read the source and said what it supports, so the line points
    // at the note rather than leaving the reader to find it.
    expect(el.querySelector('.board-walk-gate')?.textContent).toContain('note below');
  });
});

describe('the task panel’s own decide card says the same thing', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
  };
  const handlers = () =>
    ({
      workspaceId: WS,
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onOpenDoc: vi.fn(),
      onOpenTask: vi.fn(),
    }) as unknown as DetailHandlers;

  it('shows the hold count, and no verdict badge, when the gate stopped holding it', async () => {
    const decision: BoardTask = {
      id: 't-rebuild',
      title: 'Rebuild now?',
      status: 'todo',
      assignee: 'human',
      needs: 'decision',
      body: 'Rebuild the index now, or wait for the nightly run?',
      goal: CHORES_ID,
      order: 1,
      after: [],
      links: [],
      transitions: [],
      bodyDocId: 'task:t-rebuild',
      createdAt: NOW - 60_000,
      updatedAt: NOW,
      decisionGate: { holds: 2, admitted: 'holds' },
    } as unknown as BoardTask;
    const container = document.createElement('div');
    document.body.append(container);
    renderTaskDetail(container, decision, handlers());
    await settle();
    // Positive control: the panel really drew the decide card.
    expect(container.querySelector('.board-decide-card')).not.toBeNull();
    expect(container.querySelector('.board-decide-gate')?.textContent).toContain('Held twice');
    // The panel drew the walkthrough's treatment, which is now no badge at
    // all — checked here too because these two cards have drifted before.
    expect(container.querySelector('.board-decide-k-unjudged')).toBeNull();
    expect(
      (container.querySelector('.board-decide-card')?.textContent ?? '').toLowerCase(),
    ).not.toContain('unjudged');
  });
});

describe('the gate note reads as a quiet line, at both sizes', () => {
  let cleanup = () => {};
  beforeEach(() => {
    cleanup = installSheets('board.css', 'styles.css');
  });
  afterEach(() => {
    cleanup();
  });

  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 430, height: 820 },
  ]) {
    it(`is quieter than the card body at ${viewport.width}px`, () => {
      setViewport(viewport);
      const el = attach('board-walk-card');
      const gate = attach('board-walk-gate', { tag: 'p', parent: el });
      const body = attach('board-walk-body', { parent: el });
      const gateSize = Number.parseFloat(styleOf(gate).fontSize);
      expect(gateSize).toBeGreaterThan(0);
      expect(gateSize).toBeLessThan(Number.parseFloat(styleOf(body).fontSize));
      // A filer's note can be one long unbroken string; the card must not
      // widen to fit it at 430px.
      const quote = attach('board-walk-gate-note', { tag: 'blockquote', parent: el });
      expect(styleOf(quote).overflowWrap).toBe('anywhere');
    });
  }

  it('has no warning treatment left for an unjudged chip to reach for', () => {
    setViewport({ width: 1180, height: 820 });
    const head = attach('board-walk-card-head');
    // The badge is gone from the markup; this is the other half — the amber
    // rule it used to reach for is gone from the stylesheet too, so a chip
    // that named the old class again would draw as a plain one rather than
    // silently coming back looking like a warning.
    const unjudged = attach('board-walk-k board-walk-k-unjudged', { tag: 'span', parent: head });
    const plain = attach('board-walk-k', { tag: 'span', parent: head });
    // The control: the cascade IS live here — a decision chip still differs.
    const decision = attach('board-walk-k board-walk-k-decision', { tag: 'span', parent: head });
    expect(styleOf(decision).backgroundColor).not.toBe(styleOf(plain).backgroundColor);
    expect(styleOf(unjudged).backgroundColor).toBe(styleOf(plain).backgroundColor);
  });
});
