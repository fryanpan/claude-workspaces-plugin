import { options, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDiscussion } from '../src/board/board-detail-render.ts';
import { Discussion } from '../src/board/detail-parts.tsx';
import { type ComposerEditorModule, setComposerEditorLoader } from '../src/md-composer.ts';

/**
 * The board's comment box, driven against a route that refuses.
 *
 * This is the surface the 15 September 2026 comment was left on. The box
 * already put the words back; what it never did was SAY anything, so the
 * reader's evidence was a box holding their sentence — indistinguishable
 * from one they had never pressed Comment on.
 */

options.debounceRendering = (cb: () => void) => cb();

const NOW = 1_700_000_000_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

const discussion: TaskDiscussion = { loading: false, threads: [] };

afterEach(() => {
  setComposerEditorLoader(null);
  document.body.innerHTML = '';
});

function mount(onComment: (text: string) => Promise<boolean>) {
  // The composer chunk never lands, so the plain textarea is the surface.
  setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
  const host = document.createElement('div');
  document.body.append(host);
  render(<Discussion rowId="t-1" discussion={discussion} onComment={onComment} now={NOW} />, host);
  const form = host.querySelector('form.board-comment-form') as HTMLFormElement;
  const ta = form.querySelector('textarea') as HTMLTextAreaElement;
  return {
    form,
    ta,
    submit: () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    notSent: () => form.querySelector<HTMLElement>('.not-sent'),
    retry: () => form.querySelector<HTMLButtonElement>('.not-sent-retry'),
  };
}

describe('a board comment the server refused', () => {
  it('keeps the words and says it was not sent', async () => {
    const box = mount(() => Promise.resolve(false));
    box.ta.value = 'Did this reach anyone?';
    box.submit();
    await flush();
    expect(box.ta.value).toBe('Did this reach anyone?');
    expect(box.notSent(), 'the box said nothing about the failure').not.toBeNull();
    expect(box.retry()?.textContent).toContain('Not sent');
  });

  it('says the same when the transport rejects outright', async () => {
    const box = mount(() => Promise.reject(new Error('offline')));
    box.ta.value = 'offline words';
    box.submit();
    await flush();
    expect(box.ta.value).toBe('offline words');
    expect(box.notSent()).not.toBeNull();
  });

  it('the retry sends the same words again', async () => {
    const sent: string[] = [];
    const box = mount((text) => {
      sent.push(text);
      return Promise.resolve(false);
    });
    box.ta.value = 'once more';
    box.submit();
    await flush();
    box.retry()?.click();
    await flush();
    expect(sent).toEqual(['once more', 'once more']);
  });

  it('a comment that lands leaves no "not sent" standing', async () => {
    let ok = false;
    const box = mount(() => Promise.resolve(ok));
    box.ta.value = 'first try';
    box.submit();
    await flush();
    expect(box.notSent(), 'positive control: the refusal was shown').not.toBeNull();
    ok = true;
    box.retry()?.click();
    await flush();
    expect(box.notSent()).toBeNull();
  });
});
