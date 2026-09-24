import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftKey, writeDraft } from '../src/draft-store.ts';

/**
 * A comment half-typed waits out a reload in `sessionStorage`
 * (`draft-store.ts`): written as it is typed, gone once it is cancelled or
 * posted, and absent while a post is on its way, so a reload mid-post cannot
 * bring it back to be posted twice. The reload itself is driven in a real
 * browser by `draft-reload.test.ts`. All fixtures synthetic.
 */

/** The server's answer to the next post: held until the test says. */
let answer: (ok: boolean) => void = () => {};

async function importWidget() {
  (globalThis as unknown as { fetch: unknown }).fetch = (async () => {
    const ok = await new Promise<boolean>((r) => {
      answer = r;
    });
    return new Response(JSON.stringify(ok ? { ok: true } : { error: 'down' }), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  return import('../src/widget.ts');
}

async function waitFor(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const DOC = 'd-riverbend';
const stored = () => {
  const v = sessionStorage.getItem(draftKey('comment', DOC));
  return v ? (JSON.parse(v) as { t: string; o: boolean }) : null;
};

describe('a comment draft', () => {
  let alpha: HTMLElement;

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<main><p id="alpha">Riverbend opens at nine.</p></main>';
    alpha = document.getElementById('alpha') as HTMLElement;
  });
  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
  });

  async function composing(): Promise<{ root: ShadowRoot; ta: HTMLTextAreaElement }> {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: DOC, user: 'alice' });
    const root = el.shadowRoot as ShadowRoot;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    document.elementFromPoint = () => alpha;
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 10, clientY: 10, cancelable: true }),
    );
    const ta = root.querySelector('.composer textarea') as HTMLTextAreaElement;
    ta.value = 'Saltmarsh ferry should be first';
    ta.dispatchEvent(new Event('input'));
    return { root, ta };
  }

  it('is written as it is typed, and gone once cancelled', async () => {
    const { root } = await composing();
    expect(stored()).toMatchObject({ t: 'Saltmarsh ferry should be first', o: true });
    (root.querySelector('.composer .cancel') as HTMLButtonElement).click();
    expect(stored()).toBeNull();
  });

  it('is absent while it posts, back if the post fails, and gone once it lands', async () => {
    const { root, ta } = await composing();
    const submit = () => (root.querySelector('.composer .submit') as HTMLButtonElement).click();
    submit();
    expect(stored()).toBeNull();
    // Typing while it posts writes nothing either.
    ta.dispatchEvent(new Event('input'));
    expect(stored()).toBeNull();
    answer(false);
    await waitFor('the post to fail', () => stored() !== null);
    expect(stored()?.t).toBe('Saltmarsh ferry should be first');
    submit();
    expect(stored()).toBeNull();
    answer(true);
    await waitFor('the composer to close', () => root.querySelector('.composer') === null);
    expect(stored()).toBeNull();
  });

  it('opens again with its words when the page comes back', async () => {
    writeDraft(draftKey('comment', DOC), {
      t: 'Harborlight hours are wrong',
      a: createAnchor(alpha),
      o: true,
    });
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: DOC, user: 'alice' });
    const root = el.shadowRoot as ShadowRoot;
    await waitFor('the composer', () => root.querySelector('.composer') !== null);
    const ta = root.querySelector('.composer textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('Harborlight hours are wrong');
  });

  it("does not open another doc's draft", async () => {
    writeDraft(draftKey('comment', 'd-saltmarsh'), {
      t: 'Harborlight hours are wrong',
      a: createAnchor(alpha),
      o: true,
    });
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: DOC, user: 'alice' });
    await new Promise((r) => setTimeout(r, 20));
    expect((el.shadowRoot as ShadowRoot).querySelector('.composer')).toBeNull();
  });
});
