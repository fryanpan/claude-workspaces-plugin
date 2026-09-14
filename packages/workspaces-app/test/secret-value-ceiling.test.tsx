/**
 * A secret too long for the store is refused on the card, and a save that
 * fails says which field.
 *
 * On 2026-09-14 a reader saved two keys through one secret ask and was told
 * only "Saving failed". The store had cut the first key and never written the
 * second. The server now stores a key of any real length and refuses one past
 * its ceiling before the first write; this file pins the two things the reader
 * sees of that — the card refusing before a request, next to the box to fix,
 * and the toast naming the field when the store itself fails.
 *
 * Placeholders throughout, deliberately not token-shaped; the repo is public.
 */
import { SECRET_VALUE_MAX_CHARS } from '@claude-workspaces/core/secret-name';
import { options, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../src/board/board-actions.ts';
import { initialBoardState } from '../src/board/board-projection.ts';
import { createBoardReviewController } from '../src/board/board-review-controller.ts';
import { ReviewSecretBlock } from '../src/board/review-secret-form.tsx';
import { resetBoardServer, server } from './support/board-drive.ts';

options.debounceRendering = (cb: () => void) => cb();

const FIELDS = [
  { label: 'Relay account name', service: 'saltmarsh-relay-account' },
  { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
];
const PLACEHOLDER = 'not-a-real-value-1';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the card refuses a value too long to store', () => {
  function draw(onSave: (values: Array<{ service: string; value: string }>) => Promise<boolean>) {
    render(
      <ReviewSecretBlock fields={FIELDS} itemKey="t-one:r-first" gate="open" onSave={onSave} />,
      root,
    );
    return Array.from(root.querySelectorAll<HTMLTextAreaElement>('.board-walk-cred-input'));
  }
  const submit = () =>
    root
      .querySelector('form.board-walk-cred-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  it('names the field, sends the reader to it, and sends nothing', async () => {
    const onSave = vi.fn(async () => true);
    const boxes = draw(onSave);
    boxes[0]!.value = PLACEHOLDER;
    boxes[1]!.value = 'n'.repeat(SECRET_VALUE_MAX_CHARS + 1);
    submit();
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    const said = root.querySelector('.board-walk-cred-miss')?.textContent ?? '';
    expect(said).toContain('Relay signing value');
    expect(said).toContain('too long');
    expect(said).toContain(String(SECRET_VALUE_MAX_CHARS));
    // It names the ceiling, never what was typed or how long it was.
    expect(said).not.toContain(String(SECRET_VALUE_MAX_CHARS + 1));
    expect(document.activeElement).toBe(boxes[1]!);
    // Nothing typed is lost to a refusal the reader can fix.
    expect(boxes[0]!.value).toBe(PLACEHOLDER);

    // Shortening that box takes the complaint away.
    boxes[1]!.value = PLACEHOLDER;
    boxes[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(root.querySelector('.board-walk-cred-miss')).toBeNull();
  });

  it('CONTROL: a value exactly at the ceiling is sent', async () => {
    const onSave = vi.fn(async () => true);
    const boxes = draw(onSave);
    boxes[0]!.value = PLACEHOLDER;
    boxes[1]!.value = 'n'.repeat(SECRET_VALUE_MAX_CHARS);
    submit();
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.board-walk-cred-miss')).toBeNull();
  });
});

describe('a save the store refuses names the field', () => {
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

  it("shows the server's sentence, which says which field did and did not save", async () => {
    resetBoardServer();
    const toastEl = document.createElement('div');
    toastEl.id = 'board-toast';
    document.body.append(toastEl);
    const message =
      'saltmarsh-relay-signer could not be stored (saltmarsh-relay-account did). The ask is still open — try again.';
    server.on(
      '/workspaces/',
      {
        error: 'store-failed',
        service: 'saltmarsh-relay-signer',
        saved: ['saltmarsh-relay-account'],
        message,
      },
      502,
    );
    const ok = await controller().saveSecretsOnTaskItem(
      't-nightly',
      'r-secret',
      FIELDS.map((f) => ({ service: f.service, value: PLACEHOLDER })),
    );
    expect(ok).toBe(false);
    expect(toastEl.textContent).toBe(message);
    expect(toastEl.textContent).not.toContain(PLACEHOLDER);
    toastEl.remove();
  });
});
