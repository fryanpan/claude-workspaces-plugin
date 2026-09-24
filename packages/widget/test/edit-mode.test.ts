import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { draftKey, writeDraft } from '../src/draft-store.ts';
import { mountEditMode as mountReal } from '../src/edit/edit-mode.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * Edit mode on a page: what a tap edits, what Send posts, what an undo gives
 * back, and the marks a send leaves — including after a reload, when the
 * page shows its original words and the send is still waiting on the agent.
 *
 * happy-dom lays nothing out, so every element reports a fixed box; the
 * marks are asserted by which nodes the layer holds, not where they sit. A
 * real browser drives the same path in `edit-mode-browser.test.ts`. All
 * fixtures synthetic.
 */

const BOX = { left: 100, top: 50, width: 300, height: 30, right: 400, bottom: 80, x: 100, y: 50 };

let fetchMock: ReturnType<typeof vi.fn>;

/** Every mode a test mounted, so each is left before the next test: a mode
 *  still on would handle the next page's clicks too. */
const mounted: Array<{ widget: FeedbackWidgetEl; toggle: () => void }> = [];
function mountEditMode(widget: FeedbackWidgetEl, button: HTMLButtonElement) {
  const mode = mountReal(widget, button);
  mounted.push({ widget, toggle: mode.toggle });
  return mode;
}

function page(ydoc = new Y.Doc()): { widget: FeedbackWidgetEl; button: HTMLButtonElement } {
  document.body.innerHTML =
    '<main><h1>Harborlight Projects</h1><p>Riverbend <b>opens</b> at nine.</p>' +
    '<a href="/elsewhere">Saltmarsh</a></main>';
  for (const el of document.querySelectorAll('main *')) {
    (el as HTMLElement).getBoundingClientRect = () => BOX as DOMRect;
  }
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  const fab = document.createElement('button');
  fab.className = 'fab';
  const button = document.createElement('button');
  button.className = 'fab-edit';
  shadow.append(fab, button);
  document.body.append(host);
  Object.assign(host, {
    shadow,
    client: { ydoc, onReady: () => {} },
    user: { id: 'u-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' },
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-harbor', docId: 'd-mock', user: null },
    currentContext: {},
    feedbackMode: false,
    authToken: null,
    signInToWrite: false,
    retryAfterSignIn: null,
    togglePanel: () => {},
  });
  return { widget: host as unknown as FeedbackWidgetEl, button };
}

const layer = () => document.querySelector('.cfw-edit-layer') as HTMLElement;
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const h1 = () => document.querySelector('h1') as HTMLElement;
const bannerOf = (w: FeedbackWidgetEl) => w.shadow.querySelector('.cw-edit-banner') as HTMLElement;

function type(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  sessionStorage.clear();
  fetchMock = vi.fn(async () =>
    Response.json({ thread: { id: 't-new', comments: [{ id: 'c1' }] } }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  for (const m of mounted.splice(0)) if (m.widget.classList.contains('cfw-edit-on')) m.toggle();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.head.querySelector('style[data-cfw-edit]')?.remove();
});

describe('edit mode', () => {
  it('edits the words a tap lands on, and sends the element, the words before and after', async () => {
    const { widget, button } = page();
    const mode = mountEditMode(widget, button);
    mode.toggle();
    expect(widget.classList.contains('cfw-edit-on')).toBe(true);
    expect(bannerOf(widget).textContent).toMatch(/text to edit it\./);

    h1().click();
    expect(h1().hasAttribute('contenteditable')).toBe(true);
    type(h1(), 'Harborlight Works');
    await frame();
    expect(bannerOf(widget).querySelector('.edit-count')?.textContent).toBe('1 edit');

    (bannerOf(widget).querySelector('.edit-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://host:8787/workspaces/w-harbor/docs/d-mock/threads');
    const body = JSON.parse(String(init.body));
    expect(body.pageEdits).toEqual([
      expect.objectContaining({
        selector: 'h1',
        before: 'Harborlight Projects',
        after: 'Harborlight Works',
      }),
    ]);
    expect(body.pageEdits[0].anchor.kind).toBe('element');
    expect(body.anchor).toEqual(body.pageEdits[0].anchor);
    expect(body.author.name).toBe('Alice');
    // Sent: the count is gone and the words stay as typed.
    await vi.waitFor(() =>
      expect((bannerOf(widget).querySelector('.edit-count') as HTMLElement).hidden).toBe(true),
    );
    expect(h1().textContent).toBe('Harborlight Works');
  });

  it('lets nothing on the page act while its words are being edited', () => {
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    const link = document.querySelector('a') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('gives an element its words and markup back on undo', async () => {
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    const p = document.querySelector('p') as HTMLElement;
    (p.querySelector('b') as HTMLElement).click();
    type(p, 'Riverbend opens at ten.');
    h1().click();
    await frame();
    const undo = layer().querySelector('.cfw-undo') as HTMLButtonElement;
    expect(undo).not.toBeNull();
    undo.click();
    expect(p.innerHTML).toBe('Riverbend <b>opens</b> at nine.');
    await frame();
    expect((bannerOf(widget).querySelector('.edit-count') as HTMLElement).hidden).toBe(true);
  });

  it('keeps the edits and says so when the server refuses them', async () => {
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    h1().click();
    type(h1(), 'Harborlight Works');
    (bannerOf(widget).querySelector('.edit-send') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(bannerOf(widget).querySelector('.edit-note')?.textContent).toBe(
        'Could not send. Your edits are kept.',
      ),
    );
    expect(bannerOf(widget).querySelector('.edit-count')?.textContent).toBe('1 edit');
    // A mode lives on past its test and would carry the unsent edit onto the
    // next page, as it carries one onto a mock's next round.
    h1().textContent = 'Harborlight Projects';
  });

  it('holds no draft while the send is on its way, so a reload cannot send it twice', async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    h1().click();
    type(h1(), 'Harborlight Works');
    const stored = () => sessionStorage.getItem(draftKey('edits', 'd-mock'));
    expect(stored()).not.toBeNull();
    (bannerOf(widget).querySelector('.edit-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The board has the thread and the page has not heard: a reload now
    // must find nothing to put back.
    const inFlight = stored();
    answer(Response.json({ thread: { id: 't-new' } }));
    expect(inFlight).toBeNull();
    await vi.waitFor(() =>
      expect((bannerOf(widget).querySelector('.edit-count') as HTMLElement).hidden).toBe(true),
    );
    expect(stored()).toBeNull();
  });

  it('writes the draft again when the send fails', async () => {
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    h1().click();
    type(h1(), 'Harborlight Works');
    (bannerOf(widget).querySelector('.edit-send') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(bannerOf(widget).querySelector('.edit-note')?.textContent).toBe(
        'Could not send. Your edits are kept.',
      ),
    );
    const kept = JSON.parse(sessionStorage.getItem(draftKey('edits', 'd-mock')) ?? '[]');
    expect(kept.map((e: { after: string }) => e.after)).toEqual(['Harborlight Works']);
    h1().textContent = 'Harborlight Projects';
  });

  it('leaves on Escape, and stops editing', () => {
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    h1().click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(widget.classList.contains('cfw-edit-on')).toBe(false);
    expect(bannerOf(widget)).toBeNull();
    expect(h1().hasAttribute('contenteditable')).toBe(false);
  });
});

describe('after a reload', () => {
  function sendOn(ydoc: Y.Doc, status: 'open' | 'resolved'): void {
    const t = new Y.Map<unknown>();
    const comments = new Y.Array<Y.Map<unknown>>();
    const c = new Y.Map<unknown>();
    c.set('text', '1 text edit on this page');
    c.set('pageEdits', [
      {
        anchor: createAnchor(h1()),
        selector: 'h1',
        before: 'Harborlight Projects',
        after: 'Harborlight Works',
      },
    ]);
    comments.push([c]);
    t.set('status', status);
    t.set('comments', comments);
    ydoc.getMap('threads').set('t1', t);
  }

  function unsent(before: string): void {
    const edit = { anchor: createAnchor(h1()), selector: 'h1', before, after: 'Harborlight Works' };
    writeDraft(draftKey('edits', 'd-mock'), [edit]);
  }

  it('puts back an edit the reload interrupted before it was sent', async () => {
    const { widget, button } = page();
    unsent('Harborlight Projects');
    mountEditMode(widget, button);
    await frame();
    expect(h1().textContent).toBe('Harborlight Works');
    h1().textContent = 'Harborlight Projects'; // as in the refused send above
  });

  it('leaves the words alone when the page no longer reads as the edit began', async () => {
    const { widget, button } = page();
    unsent('Harborlight Studios');
    mountEditMode(widget, button);
    await frame();
    expect(h1().textContent).toBe('Harborlight Projects');
  });

  it('keeps an edit whose element has not arrived yet, and puts it back when it does', async () => {
    const { widget, button } = page();
    const main = document.querySelector('main') as HTMLElement;
    const landing = () => {
      const h2 = document.createElement('h2');
      h2.textContent = 'Saltmarsh landing';
      h2.getBoundingClientRect = () => BOX as DOMRect;
      main.append(h2);
      return h2;
    };
    const late = landing();
    const edit = { anchor: createAnchor(late), selector: 'h2', before: 'Saltmarsh landing' };
    late.remove();
    writeDraft(draftKey('edits', 'd-mock'), [{ ...edit, after: 'Saltmarsh quay' }]);
    const mode = mountEditMode(widget, button);
    mode.toggle();
    // Typing elsewhere writes the draft again, and the waiting edit with it.
    h1().click();
    type(h1(), 'Harborlight Works');
    const kept = () => JSON.parse(sessionStorage.getItem(draftKey('edits', 'd-mock')) ?? '[]');
    expect(kept().map((e: { after: string }) => e.after)).toEqual([
      'Harborlight Works',
      'Saltmarsh quay',
    ]);
    const arrived = landing();
    await vi.waitFor(() => expect(arrived.textContent).toBe('Saltmarsh quay'));
    // Back as they were, so this mode carries nothing onto the next test's page.
    arrived.textContent = 'Saltmarsh landing';
    h1().textContent = 'Harborlight Projects';
  });

  it('asks before a reload only when the edits could not be written out', () => {
    const unload = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const { widget, button } = page();
    mountEditMode(widget, button).toggle();
    h1().click();
    type(h1(), 'Harborlight Works');
    expect(unload()).toBe(false);
    const full = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    type(h1(), 'Harborlight Studios');
    expect(unload()).toBe(true);
    full.mockRestore();
    h1().textContent = 'Harborlight Projects';
  });

  it('shows the original words with the waiting edit marked', async () => {
    const ydoc = new Y.Doc();
    const { widget, button } = page(ydoc);
    sendOn(ydoc, 'open');
    mountEditMode(widget, button);
    await frame();
    expect(h1().textContent).toBe('Harborlight Projects');
    const bars = layer().querySelectorAll('.cfw-edit-bar');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.classList.contains('applied')).toBe(false);
  });

  it('drops the mark once the agent has applied the edit', async () => {
    const ydoc = new Y.Doc();
    const { widget, button } = page(ydoc);
    sendOn(ydoc, 'open');
    const mode = mountEditMode(widget, button);
    // The agent changed the source and the page came back with its words.
    h1().textContent = 'Harborlight Works';
    await frame();
    expect(layer().querySelectorAll('.cfw-edit-bar')).toHaveLength(0);
    // Inside the mode the applied edit is shown, in green.
    mode.toggle();
    await frame();
    expect(layer().querySelector('.cfw-edit-bar.applied')).not.toBeNull();
  });
});
