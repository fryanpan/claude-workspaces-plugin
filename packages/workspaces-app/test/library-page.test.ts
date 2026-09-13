/**
 * The Library tab, driven: the front page, a full list and the way back, a
 * search, and the one tap that opens a doc. The first block drives the page
 * module over fakes; the second boots the real board on the Library address
 * and taps the nav, so the wiring between the two is exercised too.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryPayload, LibraryRow } from '../src/board/library-model.ts';
import { settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';
import { type DriveOptions, driveLibrary } from './support/library-drive.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const rows = (prefix: string, n: number, extra: Partial<LibraryRow> = {}): LibraryRow[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    at: NOW - i * HOUR,
    href: `/workspaces/${WS}/docs/${prefix.toLowerCase().replace(/ /g, '-')}-${i + 1}`,
    ...extra,
  }));

const PAYLOAD: LibraryPayload = {
  project: { name: 'riverbend', path: '~/dev/riverbend' },
  meetings: rows('Harborlight sync', 7),
  files: [
    { name: 'Tide gauge notes', at: NOW, open: 'docs/tide-gauge.md' },
    ...rows('Saltmarsh plan', 3),
  ],
};

const drive = (opts: DriveOptions = {}) => driveLibrary(WS, PAYLOAD, NOW, opts);

const names = (root: ParentNode) =>
  [...root.querySelectorAll('.library-name')].map((n) => n.textContent);

describe('the Library front page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the newest meetings and files, and a way to the rest', async () => {
    const { page, root } = drive();
    await page.open();
    expect(root.querySelector('.library-proj')?.textContent).toBe('riverbend');
    expect(root.querySelector('.library-repo')?.textContent).toBe('~/dev/riverbend');
    const [meetings, files] = [...root.querySelectorAll('.library-tbl')];
    expect(names(meetings as Element)).toEqual(PAYLOAD.meetings.slice(0, 5).map((r) => r.name));
    expect(names(files as Element)).toEqual(PAYLOAD.files.map((r) => r.name));
    // Seven meetings earn a "See all"; four files do not.
    expect([...root.querySelectorAll('.library-more')].map((b) => b.textContent)).toEqual([
      'See all meetings',
    ]);
    // A row is its title and how long ago — nothing else.
    // A row is what it is called, what tells it apart, and its one clock
    // reading — in two slots, so it stays one grid line at every width.
    const first = root.querySelector('.library-row') as HTMLElement;
    expect([...first.children].map((c) => c.className)).toEqual(['library-main', 'library-when']);
    expect(first.querySelector('.library-when')?.textContent).toBe('just now');
  });

  /** Ten recent files, not five; meetings keep their five (library-model.ts). */
  it('shows ten of fourteen files, newest first, and "See all files" for the rest', async () => {
    const many: LibraryPayload = { ...PAYLOAD, files: rows('Saltmarsh plan', 14) };
    const { page, root } = drive({ payload: many });
    await page.open();
    const [meetings, files] = [...root.querySelectorAll('.library-tbl')];
    expect(names(files as Element)).toEqual(many.files.slice(0, 10).map((r) => r.name));
    expect(names(meetings as Element)).toHaveLength(5);
    expect([...root.querySelectorAll('.library-more')].map((b) => b.textContent)).toEqual([
      'See all meetings',
      'See all files',
    ]);
    await click(root.querySelector('.library-more[data-list=files]') as HTMLElement);
    expect(names(root)).toHaveLength(14);
  });

  it.each([9, 10])('shows all %i files, with no filler and no "See all"', async (n) => {
    const few: LibraryPayload = { ...PAYLOAD, files: rows('Saltmarsh plan', n) };
    const { page, root } = drive({ payload: few });
    await page.open();
    const files = root.querySelectorAll('.library-tbl')[1] as Element;
    expect(names(files)).toEqual(few.files.map((r) => r.name));
    expect(files.querySelectorAll('.library-row')).toHaveLength(n);
    expect(files.querySelector('.library-empty')).toBeNull();
    expect(root.querySelector('.library-more[data-list=files]')).toBeNull();
  });

  /**
   * A generator's burst takes ONE line of the ten (Bryan, 2026-09-12: "Daily
   * digest creates 7 new files, interrupting workflow"). Twelve files — five
   * edits, a seven-file run written seconds apart, then more edits — must
   * still show every edit on the front page.
   */
  describe('a burst of files written together', () => {
    const edit = (name: string, hoursAgo: number): LibraryRow => ({
      name,
      at: NOW - hoursAgo * HOUR,
      open: `notes/${name}`,
      folder: 'notes',
    });
    const burstRows = Array.from({ length: 7 }, (_, i) => ({
      name: `2026-09-12-clip-${i + 1}.md`,
      at: NOW - 3 * HOUR - i * 4_000,
      open: `clippings/c${i}/2026-09-12-clip-${i + 1}.md`,
      folder: `clippings/c${i}`,
    }));
    const BURST: LibraryPayload = {
      project: { name: 'riverbend', path: '~/dev/riverbend' },
      meetings: [],
      files: [
        edit('trail-log.md', 1),
        edit('culvert-estimate.md', 2),
        edit('roundup.md', 2.9),
        ...burstRows,
        edit('field-guide.md', 5),
        edit('handbook.md', 6),
        edit('tide-gauge.md', 7),
      ],
    };
    const filesTable = (root: ParentNode) => root.querySelectorAll('.library-tbl')[1] as Element;
    const lines = (root: ParentNode) =>
      [...filesTable(root).querySelectorAll('.library-list > *')].map(
        (n) => n.querySelector('.library-name')?.textContent,
      );

    it('is one line of Recent files, so every edit around it stays on the front page', async () => {
      const { page, root } = drive({ payload: BURST });
      await page.open();
      expect(lines(root)).toEqual([
        'trail-log.md',
        'culvert-estimate.md',
        'roundup.md',
        '7 files in clippings',
        'field-guide.md',
        'handbook.md',
        'tide-gauge.md',
      ]);
      // Seven lines of ten: nothing is left over for "See all".
      expect(root.querySelector('.library-more[data-list=files]')).toBeNull();
      const head = filesTable(root).querySelector('.library-burst-head') as HTMLElement;
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(head.querySelector('.library-when')?.textContent).toBe('3h ago');
    });

    it('opens in place onto its files, each one a tap from its doc, and closes again', async () => {
      const { page, root, sent } = drive({ payload: BURST });
      await page.open();
      await click(filesTable(root).querySelector('.library-burst-head') as HTMLElement);
      const head = filesTable(root).querySelector('.library-burst-head') as HTMLElement;
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(head);
      const members = filesTable(root).querySelectorAll('.library-burst-rows .library-row');
      expect([...members].map((m) => m.querySelector('.library-name')?.textContent)).toEqual(
        burstRows.map((r) => r.name),
      );
      await click(members[0] as HTMLElement);
      expect(sent.map((s) => s.body)).toEqual([{ path: burstRows[0]?.open }]);
      await click(filesTable(root).querySelector('.library-burst-head') as HTMLElement);
      expect(filesTable(root).querySelector('.library-burst-rows')).toBeNull();
    });

    it('counts as one of the ten when deciding whether there is more to see', async () => {
      const more = Array.from({ length: 10 }, (_, i) => edit(`older-${i + 1}.md`, 10 + i));
      const { page, root } = drive({ payload: { ...BURST, files: [...BURST.files, ...more] } });
      await page.open();
      expect(lines(root)).toHaveLength(10);
      expect(lines(root).at(-1)).toBe('older-3.md');
      await click(root.querySelector('.library-more[data-list=files]') as HTMLElement);
      // The full list is every file, one row each: nothing a burst held is
      // further than "See all" away.
      expect(names(root)).toHaveLength(BURST.files.length + more.length);
      expect(root.querySelector('.library-burst-head')).toBeNull();
    });
  });

  /**
   * A meeting row is its title and one time on the right, like a file row
   * (Bryan, mock v2): no second date label and no duration.
   */
  it('gives a meeting row no second label, only its time on the right', async () => {
    const { page, root } = drive();
    await page.open();
    const meetings = root.querySelectorAll('.library-tbl')[0] as Element;
    expect(meetings.querySelectorAll('.library-sub')).toHaveLength(0);
    const row = meetings.querySelector('.library-row') as HTMLElement;
    expect([...row.children].map((c) => c.className)).toEqual(['library-main', 'library-when']);
    expect(row.querySelector('.library-main')?.textContent).toBe('Harborlight sync 1');
  });

  it('says so, rather than guessing, for a file with no readable clock', async () => {
    const noClock: LibraryPayload = {
      project: null,
      meetings: [],
      files: [{ name: 'gone.md', href: '/f/9' }],
    };
    const { page, root } = drive({ payload: noClock });
    await page.open();
    expect(root.querySelector('.library-when')?.textContent).toBe('—');
  });

  it('opens a full list, with its own history entry and a way back', async () => {
    const { page, root, history } = drive();
    await page.open();
    await click(root.querySelector('.library-more[data-list=meetings]') as HTMLElement);
    expect(root.querySelector('.library-all h2')?.textContent).toBe('All meetings');
    expect(names(root)).toHaveLength(7);
    expect(history.entries).toEqual([
      {
        kind: 'push',
        url: `https://board.test/workspaces/${WS}/library`,
        state: { libraryList: 'meetings' },
      },
    ]);
    // "← Library" steps back through that entry rather than stacking another.
    await click(root.querySelector('.library-back') as HTMLElement);
    expect(history.entries.at(-1)).toEqual({ kind: 'back' });
  });

  it('the way back shows the front page itself when no entry of ours is on the stack', async () => {
    const { page, root, history } = drive();
    await page.open();
    await click(root.querySelector('.library-more') as HTMLElement);
    // Something else rewrote the entry (the board's own address sync does), so
    // Back would leave the Library rather than return to its front page.
    history.replaceState(null, '', `https://board.test/workspaces/${WS}/library`);
    await click(root.querySelector('.library-back') as HTMLElement);
    expect(history.entries.some((e) => e.kind === 'back')).toBe(false);
    expect(root.querySelector('.library-all')).toBeNull();
    expect(root.querySelectorAll('.library-tbl')).toHaveLength(2);
  });

  it('opens a listed file in one tap: bind, then go to the page the server names', async () => {
    const { page, root, sent, navigated } = drive();
    await page.open();
    const row = root.querySelector('.library-row[data-open]') as HTMLElement;
    expect(row.textContent).toContain('Tide gauge notes');
    await click(row);
    expect(sent).toEqual([
      {
        path: `/workspaces/${WS}/library/open`,
        method: 'POST',
        body: { path: 'docs/tide-gauge.md' },
      },
    ]);
    expect(navigated).toEqual([`/workspaces/${WS}/docs/library-x`]);
  });

  it('says so when the file cannot be opened, and goes nowhere', async () => {
    const { page, root, navigated } = drive({
      openAnswer: { ok: false, status: 404, data: { error: 'not-listed' } },
    });
    await page.open();
    await click(root.querySelector('.library-row[data-open]') as HTMLElement);
    expect(navigated).toEqual([]);
    expect(root.querySelector('.library-error')?.textContent).toBe(
      'That file could not be opened.',
    );
  });

  it('opens the file its address asks for, once, the way a tap on its row would', async () => {
    const { page, sent, navigated } = drive({ requestedOpen: 'digests/ferry-roundup.md' });
    await page.open();
    expect(sent).toEqual([
      {
        path: `/workspaces/${WS}/library/open`,
        method: 'POST',
        body: { path: 'digests/ferry-roundup.md' },
      },
    ]);
    expect(navigated).toEqual([`/workspaces/${WS}/docs/library-x`]);
    // Coming back to the Library asks nothing: the request was taken.
    await page.open();
    expect(sent).toHaveLength(1);
  });

  it('keeps the refusal on screen when the requested file cannot be opened', async () => {
    const { page, root, navigated } = drive({
      requestedOpen: 'digests/gone.md',
      openAnswer: { ok: false, status: 404, data: { error: 'not-listed' } },
    });
    await page.open();
    expect(navigated).toEqual([]);
    expect(root.querySelector('.library-error')?.textContent).toBe(
      'That file could not be opened.',
    );
    expect(names(root)).toContain('Tide gauge notes');
  });

  it('a doc the board holds is a plain link to its page', async () => {
    const { page, root } = drive();
    await page.open();
    const link = root.querySelector('.library-row:not([data-open])') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/workspaces/${WS}/docs/harborlight-sync-1`);
  });

  it('searches both lists, marking the match, and Escape brings the front page back', async () => {
    const { page, root } = drive();
    await page.open();
    const box = root.querySelector('.library-search') as HTMLInputElement;
    expect(box.placeholder).toBe('Search riverbend');
    box.value = 'tide';
    box.dispatchEvent(new Event('input'));
    const hits = root.querySelectorAll('.library-results .library-row');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.querySelector('mark')?.textContent).toBe('Tide');
    expect(hits[0]?.querySelector('.library-hitpath')?.textContent).toBe('files');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(box.value).toBe('');
    expect(root.querySelectorAll('.library-tbl')).toHaveLength(2);
  });

  it('drops the list it can no longer vouch for when a reload fails', async () => {
    const { page, root } = drive({ payload: [PAYLOAD, null] });
    await page.open();
    expect(root.querySelectorAll('.library-row').length).toBeGreaterThan(0);
    await page.open();
    expect(root.querySelectorAll('.library-row')).toHaveLength(0);
    expect(root.querySelector('.library-empty')?.textContent).toBe('The library could not load.');
  });

  it('names the board and says so when the list cannot load', async () => {
    const { page, root } = drive({ payload: null });
    await page.open();
    expect(root.querySelector('.library-proj')?.textContent).toBe('Kitchen rebuild');
    expect(root.querySelector('.library-empty')?.textContent).toBe('The library could not load.');
  });
});

describe('the Library on the board', () => {
  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/library/items`, PAYLOAD);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const showing = (id: string) => !el(id).classList.contains('hidden');

  it('a Library address boots onto the Library, with the task list out of the way', async () => {
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/library` });
    await settle();
    expect(showing('board-library')).toBe(true);
    expect(showing('board')).toBe(false);
    expect(el('board-quick').classList.contains('board-hidden-by-view')).toBe(true);
    expect(el('board-library').querySelector('.library-proj')?.textContent).toBe('riverbend');
    expect(document.querySelector('[data-nav=library]')?.textContent?.trim()).toBe('Library');
  });

  it('an address naming a file opens it, and drops the ask from the address', async () => {
    server.on(`/workspaces/${WS}/library/open`, {
      docId: 'library-y',
      href: `/workspaces/${WS}/docs/library-y`,
    });
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/library?open=${encodeURIComponent('digests/ferry-roundup.md')}`,
    });
    await settle();
    const posts = server.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/library/open'),
    );
    expect(posts.map((c) => c.body)).toEqual([{ path: 'digests/ferry-roundup.md' }]);
    expect(board.location.navigations).toEqual([`/workspaces/${WS}/docs/library-y`]);
    expect(board.history.url()).toBe(`/workspaces/${WS}/library`);
  });

  it('the nav item goes to the Library and back to Tasks, each with an address', async () => {
    const board = await bootTestBoard();
    expect(showing('board-library')).toBe(false);
    await click(document.querySelector('[data-nav=library]') as HTMLElement);
    await settle();
    expect(showing('board-library')).toBe(true);
    expect(board.history.url()).toBe(`/workspaces/${WS}/library`);
    expect(names(el('board-library'))).toContain('Tide gauge notes');
    await click(document.querySelector('[data-nav=tasks]') as HTMLElement);
    expect(showing('board-library')).toBe(false);
    expect(showing('board')).toBe(true);
  });
});
