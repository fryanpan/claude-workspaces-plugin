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

  it("makes the ask's inline links tappable as the Home card does, and leaves javascript: as text", async () => {
    const detail =
      'Compare the [tide notes](/workspaces/w-harbor/docs/d-tide) with the ' +
      '[harbour table](https://example.org/tides), not [this](javascript:alert) ' +
      'or [that](//example.net/x).';
    mount({ meta: {}, linkedItems: [{ ...LINKED, review: { ...ASK, detail } }] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()?.click();
    const body = shadow()?.querySelector<HTMLElement>('.cw-round-body');
    const links = Array.from(body?.querySelectorAll('a') ?? []).map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
    }));
    // The card's renderer (`renderCommentMarkdown`) and its link rules: every
    // link opens in a new tab, and a protocol-relative address is an outside
    // link like any other http one.
    const outside = { target: '_blank', rel: 'noopener noreferrer' };
    expect(links).toEqual([
      {
        text: 'tide notes',
        href: `${location.origin}/workspaces/w-harbor/docs/d-tide`,
        ...outside,
      },
      { text: 'harbour table', href: 'https://example.org/tides', ...outside },
      { text: 'that', href: `${location.protocol}//example.net/x`, ...outside },
    ]);
    // The refused one reads exactly as written, and the link words read as prose.
    expect(body?.textContent).toBe(
      'Compare the tide notes with the harbour table, not [this](javascript:alert) or that.',
    );
  });

  it("renders the round's markdown as the Home card does: bold, a numbered list, a link", async () => {
    const detail =
      'The **north pier** window needs a decision.\n\n' +
      '1. **Ten minutes.** Matches the [tide notes](/workspaces/w-harbor/docs/d-tide).\n' +
      '2. **Fifteen minutes.** Gives the crew room.';
    mount({ meta: {}, linkedItems: [{ ...LINKED, review: { ...ASK, detail } }] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()?.click();
    const body = shadow()?.querySelector<HTMLElement>('.cw-round-body');
    expect(body?.querySelector('p strong')?.textContent).toBe('north pier');
    const items = Array.from(body?.querySelectorAll('ol > li') ?? []);
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'Ten minutes.',
      'Fifteen minutes.',
    ]);
    const link = items[0]?.querySelector('a');
    expect(link?.textContent).toBe('tide notes');
    expect(link?.getAttribute('href')).toContain('/workspaces/w-harbor/docs/d-tide');
    // Nothing of the markup is left for the reader to read past.
    expect(body?.textContent).not.toMatch(/\*\*|\]\(|^\s*1\./m);
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

  it("closes a run's output item with Mark read, through the ticket's withdraw route", async () => {
    const digest = {
      taskId: 't-digest',
      reviewItemId: 'r-digest',
      review: { review_type: 'question', headline: 'New in digests: riverbend-1008.md' },
      by: 'Claude Workspaces Scheduler',
      ts: T0,
      markRead: true,
    };
    const { posts } = mount({ meta: {}, linkedItems: [digest] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    const read = shadow()?.querySelector<HTMLButtonElement>('.doc-dock-read');
    expect(read?.textContent).toBe('Mark read');
    read?.click();
    await vi.waitFor(() => expect(bar()).toBeNull());
    expect(posts).toEqual([
      {
        path: '/workspaces/w-harbor/tasks/t-digest/review-items/r-digest/withdraw',
        body: { author: READER, reason: 'marked read' },
      },
    ]);
    expect(sheet()).toBeNull();
    expect(dockHeight()).toBe('');
  });

  it('keeps Mark read where it was, with the same words, when the server refuses it', async () => {
    const digest = { ...LINKED, markRead: true };
    const { posts } = mount({ meta: {}, linkedItems: [digest] }, { answerOk: false });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    shadow()?.querySelector<HTMLButtonElement>('.doc-dock-read')?.click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const read = shadow()?.querySelector<HTMLButtonElement>('.doc-dock-read');
    await vi.waitFor(() => expect(read?.disabled).toBe(false));
    expect(read?.textContent).toBe('Mark read');
    expect(bar()).not.toBeNull();
  });

  it('offers no Mark read on an ask that is not a run’s output, nor to a signed-out reader', async () => {
    mount({ meta: {}, linkedItems: [LINKED] });
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    expect(shadow()?.querySelector('.doc-dock-read')).toBeNull();
    for (const f of open.splice(0).reverse()) f();
    document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
    const { posts } = mount(
      { meta: {}, linkedItems: [{ ...LINKED, markRead: true }] },
      { canWrite: false },
    );
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    const read = shadow()?.querySelector<HTMLButtonElement>('.doc-dock-read');
    expect(read?.disabled).toBe(true);
    read?.click();
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
