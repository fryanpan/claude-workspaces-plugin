import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { draftKey, writeDraft } from '../src/draft-store.ts';
import { hasOpenEdits, mountEditLoader } from '../src/edit/edit-button.ts';

/**
 * The pencil, and the fetch of edit mode behind it.
 *
 * happy-dom cannot load a script, so the `<script>` the loader appends is
 * caught on its way into `<head>` and the test plays the network, as
 * `voice-loader.test.ts` does. All fixtures synthetic.
 */

const SRC = 'http://host:8787/widget/edit.js';

function page(ydoc?: Y.Doc): HTMLElement {
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const cls of ['fab-list', 'fab']) {
    const b = document.createElement('button');
    b.className = cls;
    shadow.append(b);
  }
  document.body.append(host);
  const ready: Array<() => void> = [];
  Object.assign(host, {
    shadow,
    opts: { docId: 'd-harbor' },
    client: ydoc ? { ydoc, onReady: (cb: () => void) => ready.push(cb) } : null,
    fireReady: () => {
      for (const cb of ready) cb();
    },
  });
  return host;
}

let scripts: HTMLScriptElement[] = [];

beforeEach(() => {
  sessionStorage.clear();
  scripts = [];
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const n of nodes) if (n instanceof HTMLScriptElement) scripts.push(n);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  window.cwEdit = undefined;
  document.body.innerHTML = '';
});

function chunk() {
  const toggle = vi.fn();
  const mountEditMode = vi.fn(() => ({ toggle }));
  return { toggle, mountEditMode };
}

const openSend = (ydoc: Y.Doc, status: string): void => {
  const t = new Y.Map<unknown>();
  const comments = new Y.Array<Y.Map<unknown>>();
  const c = new Y.Map<unknown>();
  c.set('text', 'one edit');
  c.set('pageEdits', [{ selector: 'h1', before: 'a', after: 'b' }]);
  comments.push([c]);
  t.set('status', status);
  t.set('comments', comments);
  ydoc.getMap('threads').set('t1', t);
};

describe('the pencil', () => {
  it('stands in the stack and fetches nothing until it is tapped', () => {
    const host = page();
    const button = mountEditLoader(document, SRC) as HTMLButtonElement;
    expect(button.isConnected).toBe(true);
    expect((host as unknown as { shadow: ShadowRoot }).shadow.contains(button)).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Edit the words on this page');
    expect(scripts).toHaveLength(0);
    expect(mountEditLoader(document, SRC), 'a second mount hands back the first').toBe(button);
  });

  it('fetches edit mode once on the first tap, and enters it when it arrives', async () => {
    const host = page();
    const button = mountEditLoader(document, SRC) as HTMLButtonElement;
    button.click();
    button.click();
    expect(scripts).toHaveLength(1);
    const c = chunk();
    window.cwEdit = c as unknown as NonNullable<typeof window.cwEdit>;
    scripts[0]?.onload?.(new Event('load'));
    await vi.waitFor(() => expect(c.toggle).toHaveBeenCalled());
    expect(c.mountEditMode).toHaveBeenCalledWith(host, button);
    expect(c.mountEditMode).toHaveBeenCalledTimes(1);
  });

  it('loads edit mode at load, without entering it, when an edit is waiting', async () => {
    const ydoc = new Y.Doc();
    openSend(ydoc, 'open');
    const host = page(ydoc);
    mountEditLoader(document, SRC);
    expect(scripts).toHaveLength(0);
    (host as unknown as { fireReady: () => void }).fireReady();
    expect(scripts).toHaveLength(1);
    const c = chunk();
    window.cwEdit = c as unknown as NonNullable<typeof window.cwEdit>;
    scripts[0]?.onload?.(new Event('load'));
    await vi.waitFor(() => expect(c.mountEditMode).toHaveBeenCalledTimes(1));
    expect(c.toggle).not.toHaveBeenCalled();
  });

  it('loads edit mode at load when this tab holds edits a reload interrupted', () => {
    page(new Y.Doc());
    writeDraft(draftKey('edits', 'd-harbor'), [{ anchor: {}, before: 'a', after: 'b' }]);
    mountEditLoader(document, SRC);
    expect(scripts).toHaveLength(1);
  });

  it('loads nothing for unsent edits kept for another doc', () => {
    page(new Y.Doc());
    writeDraft(draftKey('edits', 'd-riverbend'), [{ anchor: {}, before: 'a', after: 'b' }]);
    mountEditLoader(document, SRC);
    expect(scripts).toHaveLength(0);
  });

  it('loads nothing for a page whose sends are all applied', () => {
    const ydoc = new Y.Doc();
    openSend(ydoc, 'resolved');
    const host = page(ydoc);
    mountEditLoader(document, SRC);
    (host as unknown as { fireReady: () => void }).fireReady();
    expect(scripts).toHaveLength(0);
  });
});

describe('hasOpenEdits', () => {
  it('counts only an open thread whose first comment carries edits', () => {
    expect(hasOpenEdits({ a: { status: 'open', comments: [{ text: 'x' }] } })).toBe(false);
    expect(hasOpenEdits({ a: { status: 'open', comments: [{ pageEdits: [{}] }] } })).toBe(true);
    expect(hasOpenEdits({ a: null })).toBe(false);
  });
});
