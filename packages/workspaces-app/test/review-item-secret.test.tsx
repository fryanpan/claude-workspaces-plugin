/**
 * The card that asks for a secret, and the composer that is not on it.
 *
 * Bryan, 2026-09-11, on the mock: *"Build it but just refer to secrets. Not
 * keychain."* So the word a person reads is "Secret" — the badge, the button,
 * the answered line — and where the value is kept is the agent's business.
 *
 * Three properties are asserted here, and the absent composer is the one that
 * matters most: a value typed into a free-text box would travel the ordinary
 * answer path into the item, the feed and the agent's context, which is the
 * one thing this shape exists to prevent. Its absence is checked against a
 * control — an ordinary review item rendered by the same component, which
 * DOES have one — so "no composer" cannot pass by the card failing to render.
 *
 * All fixtures are synthetic: invented names, invented service names, and
 * placeholder values that are deliberately not token-shaped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewItem,
  type ReviewQueue,
  type ReviewThreadItem,
  reviewItemBadge,
  reviewQueue,
  reviewSecretsRequest,
} from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  type WalkthroughView,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';
import { WS } from './support/board-drive.ts';

const NOW = 1_700_000_000_000;
/** Placeholders. Nothing in this file may read as a real value. */
const FIRST_VALUE = 'not-a-real-value-1';
const SECOND_VALUE = 'not-a-real-value-2';

const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
];

/** A ticket-borne secret ask, as the review-items route ships it. */
function secretRow(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
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
    taskId: 'tk-1',
    reviewItemId: 'r-1',
    title: 'Post the nightly index to the Saltmarsh relay',
    ask: 'Paste the two relay values so the nightly post can run',
    askedBy: 'Riverbend Bot',
    since: NOW - 60_000,
    direct: true,
    askedAt: NOW - 60_000,
    ...over,
  } as unknown as ReviewThreadItem;
}

/** The control: an ordinary question, same shape of row. */
function questionRow(): ReviewThreadItem {
  return secretRow({
    review: { shape: 'review', headline: 'Green or blue?', detail: 'Which do we keep?' },
  } as Partial<ReviewThreadItem>);
}

function walk(over: Partial<WalkthroughHandlers> = {}): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(async () => true),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

let root: HTMLElement;
let dispose: (() => void) | null = null;

function mountWalk(
  queue: ReviewQueue,
  handlers: WalkthroughHandlers,
  patch: Partial<WalkthroughView> = {},
): void {
  dispose?.();
  walkthroughData.value = {
    queue,
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    handlers,
    secretsGate: 'open',
    ...patch,
  };
  dispose = mountWalkthroughIsland(root);
}

/** A repaint lands on the following microtask, not synchronously. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/home`);
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('the model: the name a person reads, and where the values go', () => {
  it('badges the item Secret, and says nothing about where it is kept', () => {
    const [item] = reviewQueue([], [secretRow()], NOW).items as ReviewItem[];
    const badge = reviewItemBadge(item as ReviewItem);
    expect(badge).toEqual({ label: 'Secret', tone: 'secret' });
    // The naming rule, as a test rather than as a comment.
    expect(JSON.stringify(badge).toLowerCase()).not.toContain('keychain');
    expect(JSON.stringify(badge).toLowerCase()).not.toContain('credential');
  });

  it('posts the values to the secrets door, not to the answer route', () => {
    const [item] = reviewQueue([], [secretRow()], NOW).items as ReviewItem[];
    const req = reviewSecretsRequest(item as ReviewItem, [
      { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
    ]);
    expect(req?.path).toContain('/review-items/r-1/secrets');
    expect(req?.path).not.toContain('/answer');
  });

  it('refuses to build a request for any other shape', () => {
    // The control for the assertion above: the same builder, one field of the
    // fixture changed, and it declines rather than posting a value at a card
    // that never asked for one.
    const [item] = reviewQueue([], [questionRow()], NOW).items as ReviewItem[];
    expect(
      reviewSecretsRequest(item as ReviewItem, [{ service: 'x', value: FIRST_VALUE }]),
    ).toBeNull();
  });
});

describe('the card, laid out', () => {
  // Read off the computed style with the real stylesheet installed, because
  // the bug this guards against is a CASCADE bug and no assertion about the
  // markup can see it: the form wears `.board-walk-answer` so it lands in the
  // answering slot, and that class is the reply box's — a row with the field
  // and a dark Send beside it. The secret form has to override it to a
  // column. The first version of the rule was written EARLIER in the file,
  // lost to the later rule at equal specificity, and rendered the fields as a
  // narrow right-hand column with half the card empty beside them, at 1180
  // and at 430 alike. Everything about the DOM was correct.
  let sheets: (() => void) | null = null;
  beforeEach(() => {
    setViewport(IPAD);
    sheets = installSheets('board.css', 'styles.css');
  });
  afterEach(() => {
    sheets?.();
    sheets = null;
  });

  it('stacks the fields down the card rather than beside the button', async () => {
    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    const form = root.querySelector<HTMLElement>('.board-walk-cred-form');
    const fields = root.querySelector<HTMLElement>('.board-walk-creds');
    if (!form || !fields) throw new Error('the secret form did not render');
    expect(styleOf(form).flexDirection).toBe('column');
    expect(styleOf(form).alignItems).toBe('stretch');
    // Positive control on the harness: a property the rule does set, read
    // back from the same computed style, so a `styleOf` that answered blanks
    // could not pass the two assertions above.
    expect(styleOf(fields).flexDirection).toBe('column');
  });
});

describe('the card', () => {
  it('draws one masked field per secret, named by label and service', async () => {
    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    const rows = Array.from(root.querySelectorAll('.board-walk-cred'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.querySelector('.board-walk-cred-label')?.textContent)).toEqual([
      'Relay account name',
      'Relay signing value',
    ]);
    expect(rows.map((r) => r.querySelector('.board-walk-cred-service')?.textContent)).toEqual([
      'saltmarsh-relay-account',
      'saltmarsh-relay-signer',
    ]);
    for (const input of Array.from(
      root.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'),
    )) {
      expect(input.type).toBe('password');
      // No manager offers to keep it: an offer to save is an offer to put the
      // value somewhere neither this page nor the store chose.
      expect(input.getAttribute('autocomplete')).toBe('off');
      expect(input.getAttribute('data-lpignore')).toBe('true');
      expect(input.hasAttribute('data-1p-ignore')).toBe(true);
    }
    expect(root.querySelector('.board-walk-cred-send')?.textContent).toBe('Save Secret');
  });

  it('has no free-text composer, where an ordinary item has one', async () => {
    // THE CONTROL FIRST, so "no composer" cannot pass by the card failing to
    // render at all: the same component, the same queue shape, an ordinary
    // review item — and a composer.
    mountWalk(reviewQueue([], [questionRow()], NOW), walk());
    await tick();
    expect(root.querySelectorAll('.board-walk-answer textarea').length).toBeGreaterThan(0);

    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    expect(root.querySelectorAll('.board-walk-answer textarea')).toHaveLength(0);
  });

  it('sends both values in one submission and keeps none of them afterwards', async () => {
    const onSaveSecrets = vi.fn(
      async (_item: ReviewItem, _values: ReadonlyArray<{ service: string; value: string }>) => true,
    );
    mountWalk(reviewQueue([], [secretRow()], NOW), walk({ onSaveSecrets }));
    await tick();
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'));
    inputs[0]!.value = FIRST_VALUE;
    inputs[1]!.value = SECOND_VALUE;
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();

    expect(onSaveSecrets).toHaveBeenCalledTimes(1);
    expect(onSaveSecrets.mock.calls[0]?.[1]).toEqual([
      { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
      { service: 'saltmarsh-relay-signer', value: SECOND_VALUE },
    ]);
    // Nothing is kept in the page: the boxes are empty and the values appear
    // nowhere in the card's markup. A composer's draft-survival is exactly the
    // behaviour a value must not have.
    expect(inputs.map((i) => i.value)).toEqual(['', '']);
    expect(root.innerHTML).not.toContain(FIRST_VALUE);
    expect(root.innerHTML).not.toContain(SECOND_VALUE);
  });

  it('sends nothing while a field is empty', async () => {
    const onSaveSecrets = vi.fn(
      async (_item: ReviewItem, _values: ReadonlyArray<{ service: string; value: string }>) => true,
    );
    mountWalk(reviewQueue([], [secretRow()], NOW), walk({ onSaveSecrets }));
    await tick();
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'));
    inputs[0]!.value = FIRST_VALUE;
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onSaveSecrets).not.toHaveBeenCalled();
    // …and the one value already typed is still there, because nothing was
    // sent: clearing here would lose work to a validation the reader can fix.
    expect(inputs[0]!.value).toBe(FIRST_VALUE);
  });

  it('shows a Regular User the fields with no way to fill them', async () => {
    mountWalk(reviewQueue([], [secretRow()], NOW), walk(), { secretsGate: 'not-owner' });
    await tick();
    // They still read WHAT is being asked for — a workspace is a shared view —
    // and there is nothing to type into.
    expect(root.querySelectorAll('.board-walk-cred.is-refused')).toHaveLength(2);
    expect(root.querySelectorAll('.board-walk-cred-input')).toHaveLength(0);
    expect(root.querySelector('.board-walk-cred-send')).toBeNull();
    expect(root.textContent).toContain('Only the Owner can answer this.');
  });

  it('tells the board owner reading from elsewhere where it can be done', async () => {
    // The case an independent review found: the door is `trusted-local`, so
    // an owner on a share hostname is refused in ADMISSION whatever their
    // role says. Offering them the form would be offering a control that can
    // never succeed — and telling them it is not theirs would be false.
    mountWalk(reviewQueue([], [secretRow()], NOW), walk(), { secretsGate: 'off-machine' });
    await tick();
    expect(root.querySelectorAll('.board-walk-cred-input')).toHaveLength(0);
    expect(root.querySelector('.board-walk-cred-send')).toBeNull();
    expect(root.textContent).toContain('answered on the machine the board runs on');
    // …and NOT the Regular User's sentence, which is the half a single
    // boolean got wrong.
    expect(root.textContent).not.toContain('Only the Owner can answer this.');
  });
});
