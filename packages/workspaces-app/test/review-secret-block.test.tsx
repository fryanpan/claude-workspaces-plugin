/**
 * A value revealed on one secret ask does not come up revealed on the next.
 *
 * The walkthrough and the task panel both draw `ReviewSecretBlock` in the same
 * slot for whichever ask is current, so moving from one secret ask to another
 * re-renders the same component with new props. Unkeyed, Preact reuses the
 * form instance — and with it the set of fields the reader unmasked, and the
 * text still in the boxes. Leaving the form has to leave nothing on screen.
 *
 * The control is the same re-render with the SAME ask: the reveal survives
 * it, which is what says the test can see reuse at all.
 */
import { options, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewSecretBlock } from '../src/board/review-secret-form.tsx';

options.debounceRendering = (cb: () => void) => cb();

const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
];
const PLACEHOLDER = 'harborlight-fake-0000';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const draw = (itemKey: string): void =>
  render(
    <ReviewSecretBlock
      fields={FIELDS}
      itemKey={itemKey}
      gate="open"
      onSave={() => Promise.resolve(true)}
    />,
    root,
  );

const masks = (): string[] =>
  Array.from(root.querySelectorAll('.board-walk-cred-input')).map((f) =>
    f.classList.contains('is-shown') ? 'shown' : 'masked',
  );
const boxes = (): HTMLTextAreaElement[] =>
  Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));

/** Type into the first box and reveal it, the way a reader checks a paste. */
function revealFirst(): void {
  const first = boxes()[0] as HTMLTextAreaElement;
  first.value = PLACEHOLDER;
  first.dispatchEvent(new Event('input', { bubbles: true }));
  (root.querySelector('.board-walk-cred-eye') as HTMLButtonElement).click();
}

describe('leaving a secret form', () => {
  it('CONTROL: re-drawing the same ask keeps what the reader revealed', () => {
    draw('t-one:r-first');
    revealFirst();
    expect(masks()).toEqual(['shown', 'masked']);
    draw('t-one:r-first');
    expect(masks()).toEqual(['shown', 'masked']);
  });

  it('draws the next ask masked and empty', () => {
    draw('t-one:r-first');
    revealFirst();
    expect(masks()).toEqual(['shown', 'masked']);
    draw('t-one:r-second');
    expect(masks()).toEqual(['masked', 'masked']);
    expect(boxes().map((b) => b.value === '')).toEqual([true, true]);
  });

  it('draws the form masked again after it was closed and reopened', () => {
    draw('t-one:r-first');
    revealFirst();
    render(null, root);
    draw('t-one:r-first');
    expect(masks()).toEqual(['masked', 'masked']);
  });
});
