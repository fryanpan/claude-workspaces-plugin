import type { ReviewPayload, User } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountDocFloats } from '../src/doc/doc-floats.ts';
import { DOCK_HEIGHT_VAR } from '../src/doc/linked-dock.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * A ticket's review item that links this doc, docked under the doc page and
 * answered there (doc/linked-dock.ts).
 *
 * Driven through `mountDocFloats`, the call the doc page makes, so a dock that
 * stopped being mounted fails here too. The record is the doc's JSON as the
 * server answers it; the answer request is injected so the test reads what
 * went over the wire, because "answered" is a fact on the server.
 *
 * happy-dom lays nothing out, so the bar's measured height reads 0 here; the
 * pixels are checked headless at 1180x820 and 430. What is asserted here is
 * that the variable is SET while an item is docked and GONE once it is not.
 *
 * Fixtures are fictional — Harborlight's tide notes.
 */

const T0 = 1_700_000_000_000;
const READER: User = { id: 'u-reader', name: 'Saltmarsh', kind: 'known', color: '#2e7dd7' };

const ASK: ReviewPayload = {
  shape: 'decision',
  headline: 'Round the pier window to ten or fifteen minutes?',
  detail: 'The tide notes propose ten.',
  options: [
    { id: 'o-ten', label: 'Ten minutes' },
    { id: 'o-fifteen', label: 'Fifteen minutes' },
  ],
};

const LINKED = { taskId: 't-tide', reviewItemId: 'r-window', review: ASK, by: 'Riverbend', ts: T0 };

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty(DOCK_HEIGHT_VAR);
});
beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-tide');
  document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
});

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

function mount(record: unknown, opts: { canWrite?: boolean; answerOk?: boolean } = {}) {
  const posts: Posted[] = [];
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  mountDocFloats({
    docId: 'd-tide',
    root: document.getElementById('editor') as HTMLElement,
    ydoc,
    user: READER,
    canWrite: opts.canWrite ?? true,
    scope,
    fetchJson: async () => record,
    postAnswer: async (path, body) => {
      posts.push({ path, body });
      return opts.answerOk ?? true;
    },
  });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { posts, scope };
}

const shadow = (): ShadowRoot | null =>
  document.querySelector<HTMLElement>('.doc-dock-host')?.shadowRoot ?? null;
const bar = (): HTMLElement | null => shadow()?.querySelector('.cw-dock-item') ?? null;
const sheet = (): HTMLElement | null => shadow()?.querySelector('.cw-dock-scrim') ?? null;
const dockHeight = (): string => document.documentElement.style.getPropertyValue(DOCK_HEIGHT_VAR);
const option = (label: string): HTMLButtonElement | undefined =>
  Array.from(shadow()?.querySelectorAll<HTMLButtonElement>('.cw-answer-opt') ?? []).find(
    (b) => b.textContent === label,
  );

describe('the doc dock', () => {
  it('shows the linked item in the bar and reserves its height', async () => {
    mount({ meta: {}, linkedItems: [LINKED] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    expect(bar()?.textContent).toContain(ASK.headline);
    expect(dockHeight()).toMatch(/^\d+px$/);
    // Collapsed: the options are not on the page until the reader asks.
    expect(sheet()).toBeNull();
  });

  it('opens the item on a tap, and an option answers it through the ticket route', async () => {
    const { posts } = mount({ meta: {}, linkedItems: [LINKED] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()?.click();
    expect(sheet()?.textContent).toContain(ASK.detail);
    const reason = shadow()?.querySelector<HTMLTextAreaElement>('.cw-answer-text');
    if (reason) reason.value = 'Crews read it at the gate';
    option('Fifteen minutes')?.click();

    await vi.waitFor(() => expect(bar()).toBeNull());
    expect(posts).toEqual([
      {
        path: '/workspaces/w-harbor/tasks/t-tide/review-items/r-window/answer',
        body: {
          author: READER,
          text: 'Fifteen minutes — Crews read it at the gate',
          answeredWith: 'o-fifteen',
        },
      },
    ]);
    // Answered: the bar, its sheet and its reserved height all go.
    expect(document.querySelector('.doc-dock-host')).toBeNull();
    expect(dockHeight()).toBe('');
  });

  it('keeps the bar and the sheet, and says so, when the server refuses the answer', async () => {
    const { posts } = mount({ meta: {}, linkedItems: [LINKED] }, { answerOk: false });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()?.click();
    option('Ten minutes')?.click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const err = shadow()?.querySelector<HTMLElement>('.cw-answer-err');
    await vi.waitFor(() => expect(err?.hidden).toBe(false));
    expect(sheet()).not.toBeNull();
    expect(bar()).not.toBeNull();
    expect(dockHeight()).toMatch(/^\d+px$/);
  });

  it('shows nothing new on a doc no open item links', async () => {
    const { scope } = mount({ meta: {} });
    // CONTROL: the record WAS read and handed to the floats, so the missing
    // dock is about the record, not a mount that never ran.
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#editor-pane .plan-float').length).toBe(2),
    );
    await Promise.resolve();
    expect(document.querySelector('.doc-dock-host')).toBeNull();
    expect(dockHeight()).toBe('');
    expect(scope.disposed).toBe(false);
  });

  it('lets a signed-out reader read the ask, and not answer it', async () => {
    const { posts } = mount({ meta: {}, linkedItems: [LINKED] }, { canWrite: false });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()?.click();
    expect(sheet()?.textContent).toContain(ASK.headline);
    const ten = option('Ten minutes');
    expect(ten?.disabled).toBe(true);
    ten?.click();
    await Promise.resolve();
    expect(posts).toEqual([]);
  });

  it('takes the bar and its height away when the doc is left', async () => {
    const { scope } = mount({ meta: {}, linkedItems: [LINKED] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    scope.dispose();
    expect(document.querySelector('.doc-dock-host')).toBeNull();
    expect(dockHeight()).toBe('');
  });
});
