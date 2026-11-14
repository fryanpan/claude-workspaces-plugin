/**
 * The Library's Starred list, driven: a reader stars and unstars an item
 * from its row's ⋯ menu, stars a folder and opens it from the list, a reader with no
 * name has no stars to flip, and a star made in another tab reaches an open
 * Library over the board's feed.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryPayload } from '../src/board/library-model.ts';
import { FakeEventSource, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';
import { driveLibrary } from './support/library-drive.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const doc = (n: number, folderId?: string) => ({
  name: `Riverbend note ${n}`,
  docId: `d-note-${n}`,
  at: NOW - n * HOUR,
  created: NOW - n * HOUR,
  href: `/workspaces/${WS}/docs/d-note-${n}`,
  ...(folderId ? { folderId } : {}),
});

const PAYLOAD: LibraryPayload = {
  project: { name: 'riverbend', path: '~/dev/riverbend' },
  meetings: [],
  files: [doc(1), doc(2), doc(3, 'f-tide')],
  folders: [
    { id: 'f-meet', name: 'Meetings', parentId: null, path: 'Meetings', meetings: true },
    { id: 'f-harbor', name: 'Harborlight', parentId: null, path: 'Harborlight' },
    { id: 'f-tide', name: 'Tide logs', parentId: 'f-harbor', path: 'Harborlight/Tide logs' },
  ],
};

const starredNames = (root: ParentNode) => {
  const head = root.querySelector('.lf-starred-head');
  const tbl = head?.nextElementSibling;
  return tbl ? [...tbl.querySelectorAll('.library-name')].map((n) => n.textContent) : null;
};
const createdRow = (root: ParentNode, name: string) =>
  [
    ...(root.querySelector('[data-lf-panel=created] > .library-tbl') as Element).querySelectorAll(
      '.library-row',
    ),
  ].find((r) => r.querySelector('.library-name')?.textContent === name) as HTMLElement;
/** Open a row's ⋯ menu and return its Star / Unstar item, or null. */
const starItem = async (row: Element) => {
  await click(row.querySelector('.lf-more') as HTMLElement);
  return document.querySelector<HTMLElement>('.lf-menu [data-lf-star]');
};
/** Star or unstar through a row's ⋯ menu. */
const flipStar = async (row: Element) => click((await starItem(row)) as HTMLElement);

describe('Starred', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stars an item from its ⋯ menu: it heads the page, and the menu then says Unstar', async () => {
    const { page, root, sent } = driveLibrary(WS, PAYLOAD, NOW, {
      recentTab: 'created',
      viewer: ALICE,
    });
    await page.open();
    expect(starredNames(root)).toBeNull();
    // The row carries no star of its own: the name gets that width.
    expect(root.querySelector('.library-row [data-lf-star]')).toBeNull();
    const before = [...createdRow(root, 'Riverbend note 2').children].map((c) => c.className);
    const star = (await starItem(createdRow(root, 'Riverbend note 2'))) as HTMLElement;
    expect(star.textContent).toBe('Star');
    await click(star);
    // Picking it closes the menu.
    expect(document.querySelector('.lf-menu')).toBeNull();
    expect(starredNames(root)).toEqual(['Riverbend note 2']);
    // Starred comes first on the page.
    expect(root.querySelector('.library-body h2')?.textContent).toBe('Starred');
    const after = createdRow(root, 'Riverbend note 2');
    expect([...after.children].map((c) => c.className)).toEqual(before);
    expect((await starItem(after))?.textContent).toBe('Unstar');
    expect(sent.filter((c) => c.path.endsWith('/library/stars'))).toEqual([
      {
        path: `/workspaces/${WS}/library/stars`,
        method: 'POST',
        body: { kind: 'doc', id: 'd-note-2', starred: true, author: ALICE },
      },
    ]);
  });

  it('unstars from the Starred list, and the list goes when it is empty', async () => {
    const starred = { ...PAYLOAD, starred: [{ kind: 'doc' as const, id: 'd-note-1', at: NOW }] };
    const { page, root, sent } = driveLibrary(WS, starred, NOW, {
      recentTab: 'created',
      viewer: ALICE,
    });
    await page.open();
    expect(starredNames(root)).toEqual(['Riverbend note 1']);
    const head = root.querySelector('.lf-starred-head') as Element;
    await flipStar(head.nextElementSibling?.querySelector('.library-row') as Element);
    expect(starredNames(root)).toBeNull();
    expect(sent.at(-1)?.body).toEqual({
      kind: 'doc',
      id: 'd-note-1',
      starred: false,
      author: ALICE,
    });
  });

  it('stars a folder, and the folder opens from the Starred list', async () => {
    const { page, root, sent } = driveLibrary(WS, PAYLOAD, NOW, {
      recentTab: 'created',
      viewer: ALICE,
    });
    await page.open();
    const harbor = [...root.querySelectorAll<HTMLElement>('.lf-tree [data-lf-folder]')].find(
      (r) => r.dataset.lfFolder === 'f-harbor',
    ) as HTMLElement;
    await flipStar(harbor);
    expect(sent.at(-1)?.body).toEqual({
      kind: 'folder',
      id: 'f-harbor',
      starred: true,
      author: ALICE,
    });
    expect(starredNames(root)).toEqual(['Harborlight']);
    // Starring did not open or close the folder in the tree.
    const treeRow = (id: string) =>
      [...root.querySelectorAll<HTMLElement>('.lf-tree [data-lf-folder]')].find(
        (r) => r.dataset.lfFolder === id,
      );
    expect(treeRow('f-harbor')?.getAttribute('aria-expanded')).toBe('false');
    await click(root.querySelector('[data-lf-reveal="f-harbor"]') as HTMLElement);
    expect(treeRow('f-harbor')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(treeRow('f-harbor'));
    // The starred folder's own ⋯ is the folder menu, where it is unstarred.
    const link = root.querySelector('.lf-starred-folder') as Element;
    expect((await starItem(link))?.textContent).toBe('Unstar');
    await click(document.querySelector('.lf-menu [data-lf-star]') as HTMLElement);
    expect(starredNames(root)).toBeNull();
  });

  it('opens a starred subfolder with the folder above it', async () => {
    const starred = { ...PAYLOAD, starred: [{ kind: 'folder' as const, id: 'f-tide', at: NOW }] };
    const { page, root } = driveLibrary(WS, starred, NOW, { recentTab: 'created', viewer: ALICE });
    await page.open();
    await click(root.querySelector('[data-lf-reveal="f-tide"]') as HTMLElement);
    const names = [...root.querySelectorAll('.lf-tree .library-name')].map((n) => n.textContent);
    expect(names).toContain('Tide logs');
    expect(names).toContain('Riverbend note 3');
  });

  it('puts a star back and says so when the server refuses it', async () => {
    const toasts: string[] = [];
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW, {
      recentTab: 'created',
      viewer: ALICE,
      toasts,
      openAnswer: { ok: false, status: 500, data: null },
    });
    await page.open();
    await flipStar(createdRow(root, 'Riverbend note 1'));
    await settle();
    expect(starredNames(root)).toBeNull();
    expect(toasts).toEqual(['Could not star that.']);
  });

  it('gives a reader with no name no Star item in the ⋯ menu', async () => {
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW, { recentTab: 'created' });
    await page.open();
    expect(await starItem(createdRow(root, 'Riverbend note 1'))).toBeNull();
    expect(document.querySelector('.lf-menu [data-lf-act="moveto"]')).not.toBeNull();
  });
});

describe('Starred on the booted board', () => {
  beforeEach(() => {
    resetBoardServer();
  });

  it('a star made in another tab reaches an open Library on the next frame', async () => {
    server.on(`/workspaces/${WS}/library/items`, PAYLOAD);
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/library` });
    await settle();
    const root = el('board-library');
    expect(starredNames(root)).toBeNull();
    server.on(`/workspaces/${WS}/library/items`, {
      ...PAYLOAD,
      starred: [{ kind: 'folder', id: 'f-harbor', at: NOW }],
    });
    const feed = [...FakeEventSource.opened]
      .reverse()
      .find((es) => es.url.endsWith(`/workspaces/${WS}/events:stream`));
    feed?.dispatchEvent(new Event('library.changed'));
    await settle();
    expect(starredNames(root)).toEqual(['Harborlight']);
  });
});
