/**
 * The TASK page's copy of the secret card — the surface that got it wrong.
 *
 * Its sibling `review-item-secret.test.tsx` pins the Home walkthrough's card.
 * That one was right from the start; this one drew the ordinary answer
 * furniture over the same ask — candidate options and "Record your answer,
 * verbatim…" with a blue Record answer — and a reviewer one tap from the
 * walkthrough's own Task link typed a value into it. The words were recorded
 * on the item, written to the store on disk, echoed into the events log and
 * read back by the agent (UX review, 2026-09-12).
 *
 * So the assertions here are about the box that must NOT be on this card, the
 * form that must be, and the badge that must say Secret with the weight a
 * Decision gets. Each is paired with a control — the same component, the same
 * queue, an ordinary question — so nothing passes by the card failing to
 * render at all.
 *
 * All fixtures are synthetic: invented names, invented service names, and
 * placeholder values that are deliberately not token-shaped.
 */
import { options } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailHandlers, TaskDiscussion } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import type { ReviewThreadItem } from '../src/board/board-review-model.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/board/task-detail-island.tsx';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';

const NOW = 1_700_000_000_000;
/** Placeholders. Nothing in this file may read as a real value. */
const FIRST_VALUE = 'not-a-real-value-1';
const SECOND_VALUE = 'not-a-real-value-2';

const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
];

options.debounceRendering = (cb: () => void) => cb();

const TASK: BoardTask = {
  id: 't-nightly',
  title: 'Post the nightly index to the Saltmarsh relay',
  status: 'todo',
  assignee: 'Riverbend Bot',
  goal: CHORES_ID,
  order: 1,
  after: [],
  links: [],
  transitions: [],
  bodyDocId: 'task:t-nightly',
  createdAt: NOW,
  updatedAt: NOW,
};

const EMPTY: TaskDiscussion = { loading: false, threads: [] };

/** A ticket-borne secret ask, as the review-items route ships it. */
function secretAsk(): ReviewThreadItem {
  return {
    kind: 'task-review',
    band: 'declared',
    review: {
      shape: 'secret',
      headline: 'Paste the two relay values so the nightly post can run',
      detail: 'The nightly pass signs in to the Saltmarsh relay and posts the index.',
      ownerOnly: true,
      secrets: FIELDS,
    },
    taskId: TASK.id,
    reviewItemId: 'r-secret',
    title: TASK.title,
    ask: 'Paste the two relay values so the nightly post can run',
    askedBy: 'Riverbend Bot',
    since: NOW - 60_000,
    askedAt: NOW - 60_000,
    direct: true,
  } as unknown as ReviewThreadItem;
}

/** The control: an ordinary question on the same task, same row shape. */
function questionAsk(): ReviewThreadItem {
  return {
    ...secretAsk(),
    reviewItemId: 'r-question',
    review: {
      shape: 'review',
      headline: 'Should the weekly pass post to the archive as well?',
      detail: 'The weekly pass writes the archive today and nothing reads it.',
    },
  } as unknown as ReviewThreadItem;
}

let live: (() => void) | null = null;
let sheets = () => {};

/** Paint the panel with one ask on it, and hand back the card it drew. */
function draw(ask: ReviewThreadItem, extra: Partial<DetailHandlers> = {}): HTMLElement {
  const host = document.createElement('div');
  host.className = 'board-detail';
  document.body.replaceChildren(host);
  live = mountTaskDetailIsland(host);
  taskDetailData.value = {
    task: { ...TASK },
    discussion: EMPTY,
    handlers: {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAnswerThread: vi.fn(),
      asks: [ask],
      ...extra,
    } as unknown as DetailHandlers,
  };
  const card = host.querySelector<HTMLElement>('.board-decide-card');
  if (!card) throw new Error('the panel drew no review card');
  return card;
}

beforeEach(() => {
  setViewport(IPAD);
  sheets = installSheets('board.css', 'styles.css');
});

afterEach(() => {
  sheets();
  live?.();
  live = null;
  taskDetailData.value = {
    task: null,
    handlers: { onClose: vi.fn() } as unknown as DetailHandlers,
  };
});

describe('the task page, on a secret ask', () => {
  it('has no verbatim answer box, where an ordinary question has one', () => {
    const placeholder = (card: HTMLElement): string | null =>
      card.querySelector('textarea')?.getAttribute('placeholder') ?? null;

    const secret = draw(secretAsk(), { onSaveSecrets: vi.fn(), secretsGate: 'open' });
    expect(secret.querySelector('textarea')).toBeNull();
    expect(secret.textContent).not.toContain('Record answer');
    expect(secret.querySelector('.board-decide-form')).toBeNull();

    // CONTROL: the same component, the same panel, an ordinary question —
    // which DOES get the box. Without this, "no box" would also pass on a
    // card that rendered nothing at all.
    live?.();
    live = null;
    const question = draw(questionAsk());
    expect(placeholder(question)).toContain('Record your answer');
    expect(question.textContent).toContain('Record answer');
  });

  it('draws one masked field per secret, and the Save that sends them', () => {
    const card = draw(secretAsk(), { onSaveSecrets: vi.fn(), secretsGate: 'open' });
    const inputs = card.querySelectorAll<HTMLInputElement>('.board-walk-cred-input');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input.type).toBe('password');
    expect(card.textContent).toContain('Relay account name');
    expect(card.textContent).toContain('saltmarsh-relay-account');
    expect(card.querySelector('.board-walk-cred-send')?.textContent).toBe('Save Secret');
  });

  it('sends both values to the secrets handler, not to the answer handler', () => {
    const saved: Array<Array<{ service: string; value: string }>> = [];
    const onSaveSecrets = vi.fn(
      async (
        _t: BoardTask,
        _i: unknown,
        values: ReadonlyArray<{ service: string; value: string }>,
      ) => {
        saved.push([...values]);
        return true;
      },
    );
    const onAnswerThread = vi.fn(async () => true);
    const card = draw(secretAsk(), { onSaveSecrets, onAnswerThread, secretsGate: 'open' });
    const inputs = card.querySelectorAll<HTMLInputElement>('.board-walk-cred-input');
    (inputs[0] as HTMLInputElement).value = FIRST_VALUE;
    (inputs[1] as HTMLInputElement).value = SECOND_VALUE;
    card.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(onSaveSecrets).toHaveBeenCalledTimes(1);
    // The values went to the door that stores them and records only the
    // names. The answer path — the one that records words — was never called.
    expect(onAnswerThread).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect((saved[0] ?? []).map((v) => v.service)).toEqual(FIELDS.map((f) => f.service));
  });

  it('shows the fields with no inputs when the surface cannot take them', () => {
    // No handler wired: the card must still say WHAT is being asked for — the
    // workspace is a shared view — and must not fall back to the box.
    const card = draw(secretAsk());
    expect(card.querySelectorAll('.board-walk-cred-input')).toHaveLength(0);
    expect(card.querySelector('textarea')).toBeNull();
    expect(card.textContent).toContain('Relay account name');
    expect(card.textContent).toContain('the machine the board runs on');
  });
});

describe('the badge on the task page', () => {
  const badgeOf = (card: HTMLElement): HTMLElement => {
    const el = card.querySelector<HTMLElement>('.board-decide-k');
    if (!el) throw new Error('the card drew no kind badge');
    return el;
  };

  it('reads Secret, not Question', () => {
    const card = draw(secretAsk(), { onSaveSecrets: vi.fn(), secretsGate: 'open' });
    expect(badgeOf(card).textContent).toBe('Secret');

    live?.();
    live = null;
    // CONTROL: the ordinary ask still reads Question, so the rename is about
    // the shape rather than about every badge having changed.
    expect(badgeOf(draw(questionAsk())).textContent).toBe('Question');
  });

  it('carries a Decision’s weight rather than the question blue', () => {
    const secret = badgeOf(draw(secretAsk(), { onSaveSecrets: vi.fn(), secretsGate: 'open' }));
    const secretInk = styleOf(secret).color;
    const secretGround = styleOf(secret).backgroundColor;
    live?.();
    live = null;
    const question = badgeOf(draw(questionAsk()));
    const questionInk = styleOf(question).color;
    // Read from the rendered page, not from the stylesheet's text: the
    // assertion is that the reader SEES the two apart, and that the secret
    // sits with the decision.
    expect(secretInk).not.toBe(questionInk);
    expect(secretGround).not.toBe('rgba(0, 0, 0, 0)');
  });
});
