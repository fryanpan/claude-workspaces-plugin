import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WIDGET_TAG,
  mountCommentButtons,
  wantsCommentButtons,
} from '../src/doc/doc-comment-buttons.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The doc page's corner buttons: one widget per mounted doc, pointed at that
 * doc, gone when the doc is, and never on a page opened as an embed. The
 * browser half — that the buttons draw in the corner — is
 * `doc-round-buttons-browser.test.ts`.
 */

afterEach(() => {
  for (const el of document.querySelectorAll(WIDGET_TAG)) el.remove();
});

const mount = (over: { search?: string; docId?: string; scope?: MountScope } = {}) => {
  const load = vi.fn(async () => undefined);
  const scope = over.scope ?? new MountScope();
  const el = mountCommentButtons({
    doc: document,
    workspaceId: 'w-1',
    docId: over.docId ?? 'd-riverbend',
    search: over.search ?? '',
    scope,
    load,
  });
  return { el, load, scope };
};

describe('the round comment buttons on a doc page', () => {
  it('puts one widget on the page for the doc on screen, in the board it was reached from', () => {
    const { el, load } = mount({ search: '?thread=t-1' });
    expect(document.querySelectorAll(WIDGET_TAG)).toHaveLength(1);
    expect(el?.getAttribute('doc-id')).toBe('d-riverbend');
    expect(el?.getAttribute('workspace-id')).toBe('w-1');
    expect(el?.getAttribute('identity-scope')).toBe('host');
    expect(load).toHaveBeenCalledWith(el);
  });

  it('takes the widget off when the doc is torn down', () => {
    const { scope } = mount();
    scope.dispose();
    expect(document.querySelector(WIDGET_TAG)).toBeNull();
  });

  it('replaces the last doc’s widget rather than adding a second corner', () => {
    mount({ docId: 'd-riverbend' });
    mount({ docId: 'd-saltmarsh' });
    const all = [...document.querySelectorAll(WIDGET_TAG)];
    expect(all.map((e) => e.getAttribute('doc-id'))).toEqual(['d-saltmarsh']);
  });

  it('mounts nothing on a page opened as an embed', () => {
    const { el, load } = mount({ search: '?cw-frame=1&cw-embed=1' });
    expect(el).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector(WIDGET_TAG)).toBeNull();
    expect(wantsCommentButtons('?cw-embed=1')).toBe(false);
    expect(wantsCommentButtons('?cw-embed=0')).toBe(true);
  });

  it('mounts nothing for a doc already navigated away from', () => {
    const scope = new MountScope();
    scope.dispose();
    const { el } = mount({ scope });
    expect(el).toBeNull();
    expect(document.querySelector(WIDGET_TAG)).toBeNull();
  });

  it('leaves the doc as it was when the widget chunk fails to load', async () => {
    const scope = new MountScope();
    const el = mountCommentButtons({
      doc: document,
      workspaceId: 'w-1',
      docId: 'd-riverbend',
      search: '',
      scope,
      load: () => Promise.reject(new Error('chunk')),
    });
    await Promise.resolve();
    expect(el?.isConnected).toBe(true);
  });
});
