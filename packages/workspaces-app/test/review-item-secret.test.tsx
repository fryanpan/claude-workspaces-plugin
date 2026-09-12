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

  it('draws each field as a bordered box, and Save at the 44px floor', async () => {
    // Both found by a fresh-eyes pass: the field was drawn with a top rule
    // and nothing else, so an empty one had no border and no placeholder and
    // read as a gap under a label; and Save was 40px against a 44px floor.
    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    const box = root.querySelector<HTMLElement>('.board-walk-cred-box');
    const save = root.querySelector<HTMLElement>('.board-walk-cred-send');
    if (!box || !save) throw new Error('the secret form did not render');
    for (const side of [
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
    ] as const) {
      expect(styleOf(box)[side]).toBe('1px');
    }
    expect(styleOf(save).minHeight).toBe('44px');
    // Control on the harness: an element the sheet does not select, read
    // through the same function, comes back with no border at all — so the
    // four readings above are of this rule rather than of something `styleOf`
    // answers for everything.
    const bare = document.createElement('div');
    document.body.append(bare);
    expect(styleOf(bare).borderTopWidth).not.toBe('1px');
    bare.remove();
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
    for (const field of Array.from(
      root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'),
    )) {
      // A TEXTAREA, so a pasted key keeps its line breaks — a browser `input`
      // strips them out of a paste before any script can see them. Masked by
      // class rather than by `type`, which a textarea has no equivalent of.
      expect(field.tagName).toBe('TEXTAREA');
      expect(field.classList.contains('is-masked')).toBe(true);
      // No manager offers to keep it: an offer to save is an offer to put the
      // value somewhere neither this page nor the store chose.
      expect(field.getAttribute('autocomplete')).toBe('off');
      expect(field.getAttribute('data-lpignore')).toBe('true');
      expect(field.hasAttribute('data-1p-ignore')).toBe(true);
    }
    expect(root.querySelector('.board-walk-cred-send')?.textContent).toBe('Save Secret');
  });

  it('has no free-text composer, where an ordinary item has one', async () => {
    // THE CONTROL FIRST, so "no composer" cannot pass by the card failing to
    // render at all: the same component, the same queue shape, an ordinary
    // review item — and a composer.
    // The secret card has textareas of its OWN now — that is what makes a
    // multi-line value typeable — so the selector excludes its form. What
    // must not exist is the FREE-TEXT box, whose words are recorded on the
    // item and read back by the agent.
    const composers = () =>
      root.querySelectorAll('.board-walk-answer:not(.board-walk-cred-form) textarea');
    mountWalk(reviewQueue([], [questionRow()], NOW), walk());
    await tick();
    expect(composers().length).toBeGreaterThan(0);

    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    expect(composers()).toHaveLength(0);
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

  it('sends the reader to the field that is EMPTY, and names it', async () => {
    // The bug a fresh-eyes pass found: Save did nothing visible. The focus
    // hop asked for `.board-walk-cred-input[value=""]`, and an input carries
    // no `value` ATTRIBUTE unless somebody wrote one — so the selector matched
    // nothing, focus fell back to the FIRST field (already filled), and there
    // was no message at all.
    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'));
    inputs[0]!.value = FIRST_VALUE;
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(document.activeElement).toBe(inputs[1]!);
    expect(root.querySelector('.board-walk-cred-miss')?.textContent).toContain(
      'Relay signing value',
    );
    // And it names ONE field — the one they are being sent to — rather than
    // listing what is wrong.
    expect(root.querySelector('.board-walk-cred-miss')?.textContent).not.toContain(
      'Relay account name',
    );

    // Typing in that field takes the line away again, so a stale complaint
    // cannot sit under a filled box.
    inputs[1]!.value = SECOND_VALUE;
    inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(root.querySelector('.board-walk-cred-miss')).toBeNull();
  });

  it('keeps what was typed when the save FAILS', async () => {
    // A refusal used to empty both boxes, which on a phone means retyping
    // both values from whatever the reader got them out of.
    const onSaveSecrets = vi.fn(async () => false);
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
    expect(inputs.map((i) => i.value)).toEqual([FIRST_VALUE, SECOND_VALUE]);
    // The values live in the nodes the reader typed them into and nowhere
    // else — not in the card's markup, where a repaint could carry them.
    expect(root.innerHTML).not.toContain(FIRST_VALUE);
    expect(root.innerHTML).not.toContain(SECOND_VALUE);
    // CONTROL: the same submission against a save that SUCCEEDS does clear
    // them, so the assertion above is about the failure and not about the
    // clear never happening.
    mountWalk(
      reviewQueue([], [secretRow()], NOW),
      walk({ onSaveSecrets: vi.fn(async () => true) }),
    );
    await tick();
    const second = Array.from(root.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'));
    second[0]!.value = FIRST_VALUE;
    second[1]!.value = SECOND_VALUE;
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(second.map((i) => i.value)).toEqual(['', '']);
  });

  it('reveals one field at a time, and starts masked', async () => {
    mountWalk(reviewQueue([], [secretRow()], NOW), walk());
    await tick();
    // Masking is `-webkit-text-security`, which a textarea needs because it
    // has no `type="password"`. jsdom reports nothing for that property, so
    // what is read here is the class the component put on the node — the
    // engine's own rendering of it is the browser's job, and the eye is the
    // control that tells the reader which state they are in either way.
    const masks = () =>
      Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input')).map((f) =>
        f.classList.contains('is-shown') ? 'shown' : 'masked',
      );
    const eyes = Array.from(root.querySelectorAll<HTMLButtonElement>('.board-walk-cred-eye'));
    const typed = Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));
    expect(masks()).toEqual(['masked', 'masked']);
    typed[0]!.value = FIRST_VALUE;
    eyes[0]!.click();
    await tick();
    expect(masks()).toEqual(['shown', 'masked']);
    // The value survives the toggle: the node is the same one, not a
    // re-created field that would have dropped what was typed.
    expect(
      Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'))[0]!.value,
    ).toBe(FIRST_VALUE);
    eyes[0]!.click();
    await tick();
    expect(masks()).toEqual(['masked', 'masked']);
  });

  it('keeps every line of a multi-line value, and sends them whole', async () => {
    // The blocker the UX walk found (2026-09-12): a three-line paste — an SSH
    // key, a service-account file — was silently joined into one line and the
    // item said "Secrets saved". The field was a browser `input`, which
    // strips line breaks out of a paste before any script can see them, so
    // the server's own newline refusal never had anything to refuse.
    const saved: Array<Array<{ service: string; value: string }>> = [];
    const onSaveSecrets = vi.fn(
      async (_item: unknown, values: ReadonlyArray<{ service: string; value: string }>) => {
        saved.push([...values]);
        return true;
      },
    );
    mountWalk(reviewQueue([], [secretRow()], NOW), walk({ onSaveSecrets }));
    await tick();
    const fields = Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));
    const threeLines = 'aaa-not-real-1\nbbb-not-real-2\nccc-not-real-3';
    fields[0]!.value = threeLines;
    fields[1]!.value = SECOND_VALUE;
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    const sent = saved[0] ?? [];
    expect(sent[0]?.value).toBe(threeLines);
    expect(sent[0]?.value.split('\n')).toHaveLength(3);
    // CONTROL: the second field, a one-line value, travels unchanged — so the
    // assertion above is about the line breaks surviving rather than about
    // every value arriving mangled in some new way.
    expect(sent[1]?.value).toBe(SECOND_VALUE);
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
