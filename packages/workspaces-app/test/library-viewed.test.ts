/**
 * The Library's Recently Viewed list, driven: what the reader opened sits at
 * the top with how long ago, "Show more" opens the older views, and a view
 * made in another tab reaches an open Library over the board's feed.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryPayload } from '../src/board/library-model.ts';
import { FakeEventSource, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';
import { driveLibrary } from './support/library-drive.ts';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const files = Array.from({ length: 8 }, (_, i) => ({
  name: `Riverbend note ${i + 1}`,
  docId: `d-note-${i + 1}`,
  at: NOW - 10 * HOUR,
  created: NOW - (20 + i) * HOUR,
  href: `/workspaces/${WS}/docs/d-note-${i + 1}`,
}));

/** Eight files; the reader opened seven of them, newest first. */
const PAYLOAD: LibraryPayload = {
  project: { name: 'riverbend', path: '~/dev/riverbend' },
  meetings: [],
  files,
  viewed: [
    { docId: 'd-note-3', at: NOW - 2 * MIN },
    { docId: 'd-note-1', at: NOW - 40 * MIN },
    { docId: 'd-note-5', at: NOW - 3 * HOUR },
    { docId: 'd-note-2', at: NOW - 5 * HOUR },
    { docId: 'd-note-8', at: NOW - 6 * HOUR },
    { docId: 'd-note-4', at: NOW - 7 * HOUR },
    { docId: 'd-note-6', at: NOW - 8 * HOUR },
  ],
};

/** The Recently Viewed table: the one after its heading. */
const viewedTable = (root: ParentNode) =>
  root.querySelector('.lf-viewed-head + .library-tbl') as Element;
const viewedCells = (root: ParentNode) =>
  [...viewedTable(root).querySelectorAll('.library-list .library-row')].map((r) => [
    r.querySelector('.library-name')?.textContent,
    r.querySelector('.library-when')?.textContent,
  ]);

describe('Recently Viewed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('puts the latest view at the top, each row with how long ago it was opened', async () => {
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW);
    await page.open();
    expect(viewedTable(root).querySelector('.lf-colhead')?.textContent).toBe('Viewed');
    expect(viewedCells(root)).toEqual([
      ['Riverbend note 3', '2m ago'],
      ['Riverbend note 1', '40m ago'],
      ['Riverbend note 5', '3h ago'],
      ['Riverbend note 2', '5h ago'],
      ['Riverbend note 8', '6h ago'],
    ]);
  });

  it('"Show more" reveals the older views, and its heading row stays put', async () => {
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW);
    await page.open();
    const head = () => root.querySelector('.lf-viewed-head') as HTMLElement;
    const toggle = () => head().querySelector('[data-lf-viewmore]') as HTMLButtonElement;
    expect(toggle().textContent).toBe('Show more');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await click(toggle());
    expect(viewedCells(root).map((c) => c[0])).toEqual([
      'Riverbend note 3',
      'Riverbend note 1',
      'Riverbend note 5',
      'Riverbend note 2',
      'Riverbend note 8',
      'Riverbend note 4',
      'Riverbend note 6',
    ]);
    // Same row, same place in it, label swapped; focus stays on it.
    expect(toggle().textContent).toBe('Show less');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(head().firstElementChild?.textContent).toBe('Recently Viewed');
    expect(document.activeElement).toBe(toggle());
    await click(toggle());
    expect(viewedCells(root)).toHaveLength(5);
  });

  it('shows no toggle for five views or fewer, and says so when there are none', async () => {
    const few = driveLibrary(WS, { ...PAYLOAD, viewed: PAYLOAD.viewed?.slice(0, 5) }, NOW);
    await few.page.open();
    expect(few.root.querySelector('[data-lf-viewmore]')).toBeNull();
    const none = driveLibrary(WS, { ...PAYLOAD, viewed: undefined }, NOW);
    await none.page.open();
    expect(viewedTable(none.root).textContent).toContain('Nothing opened yet.');
  });
});

describe('Recently Viewed on the booted board', () => {
  beforeEach(() => {
    resetBoardServer();
  });

  const boardFeed = () => {
    const feed = [...FakeEventSource.opened]
      .reverse()
      .find((es) => es.url.endsWith(`/workspaces/${WS}/events:stream`));
    if (!feed) throw new Error('the board never opened its feed');
    return feed;
  };

  it('a view made in another tab reaches an open Library on the next frame', async () => {
    server.on(`/workspaces/${WS}/library/items`, { ...PAYLOAD, viewed: PAYLOAD.viewed?.slice(1) });
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/library` });
    await settle();
    const root = el('board-library');
    expect(viewedCells(root)[0]?.[0]).toBe('Riverbend note 1');
    // Another tab opened note 7; the server now lists it first.
    server.on(`/workspaces/${WS}/library/items`, {
      ...PAYLOAD,
      viewed: [{ docId: 'd-note-7', at: NOW }, ...(PAYLOAD.viewed ?? [])],
    });
    boardFeed().dispatchEvent(new Event('library.changed'));
    await settle();
    expect(viewedCells(root)[0]?.[0]).toBe('Riverbend note 7');
  });
});
