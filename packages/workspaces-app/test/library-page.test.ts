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
import { type LibraryPage, createLibraryPage } from '../src/board/library-page.ts';
import { fakeHistory, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';

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
    { name: 'Tide gauge notes', at: NOW - 60_000, open: 'docs/tide-gauge.md' },
    ...rows('Saltmarsh plan', 3),
  ],
};

interface Driven {
  page: LibraryPage;
  root: HTMLElement;
  history: ReturnType<typeof fakeHistory>;
  sent: { path: string; method: string; body: unknown }[];
  navigated: string[];
}

function drive(
  opts: {
    payload?: LibraryPayload | null | (LibraryPayload | null)[];
    openAnswer?: { ok: boolean; status: number; data: Record<string, unknown> | null };
  } = {},
): Driven {
  document.body.innerHTML = '<div id="board-library"></div>';
  const root = document.getElementById('board-library') as HTMLElement;
  const history = fakeHistory();
  const sent: Driven['sent'] = [];
  const navigated: string[] = [];
  const page = createLibraryPage({
    root,
    workspaceId: WS,
    boardName: () => 'Kitchen rebuild',
    fetchJson: async <T>() => {
      if (opts.payload === undefined) return PAYLOAD as T;
      if (Array.isArray(opts.payload)) return (opts.payload.shift() ?? null) as T | null;
      return opts.payload as T | null;
    },
    send: async (path, method, body) => {
      sent.push({ path, method, body });
      return (
        opts.openAnswer ?? {
          ok: true,
          status: 200,
          data: { docId: 'library-x', href: `/workspaces/${WS}/docs/library-x` },
        }
      );
    },
    navigate: (href) => navigated.push(href),
    history,
    here: () => `https://board.test/workspaces/${WS}/library`,
    now: () => NOW,
  });
  return { page, root, history, sent, navigated };
}

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

  /**
   * Ten recent files, not five (Bryan, 2026-09-12). The files list is the one a
   * reader scans for the doc they were just in, and five ran out inside a day.
   * Meetings keep their five: the ask named files.
   */
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

  it('shows every file when there are fewer than ten, with no filler and no "See all"', async () => {
    const few: LibraryPayload = { ...PAYLOAD, files: rows('Saltmarsh plan', 9) };
    const { page, root } = drive({ payload: few });
    await page.open();
    const files = root.querySelectorAll('.library-tbl')[1] as Element;
    expect(names(files)).toEqual(few.files.map((r) => r.name));
    expect(files.querySelectorAll('.library-row')).toHaveLength(9);
    expect(files.querySelector('.library-empty')).toBeNull();
    expect(root.querySelector('.library-more[data-list=files]')).toBeNull();
  });

  /**
   * Two meetings of one title is the ordinary case, not a corner: every
   * huddle is named from the clock at the minute it opened. The page has to
   * separate them where the reader is — in the row.
   */
  it('separates two meetings of the same title, and leaves file rows alone', async () => {
    const twins: LibraryPayload = {
      project: { name: 'riverbend', path: '~/dev/riverbend' },
      meetings: [
        { name: 'Meeting notes', at: NOW, durationMs: 5 * 60_000, href: '/m/1' },
        { name: 'Meeting notes', at: NOW - 26 * HOUR, durationMs: 47 * 60_000, href: '/m/2' },
      ],
      files: [{ name: 'handbook.md', at: NOW - HOUR, href: '/f/1' }],
    };
    const { page, root } = drive({ payload: twins });
    await page.open();
    const [meetings, files] = [...root.querySelectorAll('.library-tbl')];
    const subs = [...(meetings as Element).querySelectorAll('.library-sub')].map(
      (n) => n.textContent,
    );
    expect(subs).toHaveLength(2);
    expect(subs[0]).not.toBe(subs[1]);
    expect(subs[0]).toContain('5 min');
    expect(subs[1]).toContain('47 min');
    // No second label on a file: its name already identifies it.
    expect((files as Element).querySelectorAll('.library-sub')).toHaveLength(0);
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

  it('names the clock in the header of each column', async () => {
    const { page, root } = drive();
    await page.open();
    const headers = [...root.querySelectorAll('.library-cols')].map((h) =>
      [...h.children].map((c) => c.textContent),
    );
    expect(headers).toEqual([
      ['Title', 'Held'],
      ['Name', 'File modified'],
    ]);
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
