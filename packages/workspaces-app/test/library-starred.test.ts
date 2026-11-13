/**
 * The Library's Starred list, driven: a reader stars and unstars an item
 * from its row, stars a folder and opens it from the list, a reader with no
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
    ...(root.querySelector('.lf-created-head + .library-tbl') as Element).querySelectorAll(
      '.library-row',
    ),
  ].find((r) => r.querySelector('.library-name')?.textContent === name) as HTMLElement;

describe('Starred', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stars an item from its row: it heads the page, and the toggle keeps its place', async () => {
    const { page, root, sent } = driveLibrary(WS, PAYLOAD, NOW, { viewer: ALICE });
    await page.open();
    expect(starredNames(root)).toBeNull();
    const before = [...createdRow(root, 'Riverbend note 2').children].map((c) => c.className);
    const star = createdRow(root, 'Riverbend note 2').querySelector('.lf-star') as HTMLElement;
    expect(star.getAttribute('aria-pressed')).toBe('false');
    await click(star);
    expect(starredNames(root)).toEqual(['Riverbend note 2']);
    // Starred comes first on the page.
    expect(root.querySelector('.library-body h2')?.textContent).toBe('Starred');
    const after = createdRow(root, 'Riverbend note 2');
    expect(after.querySelector('.lf-star')?.getAttribute('aria-pressed')).toBe('true');
    // Same cells in the same order: the toggle flipped in place.
    expect([...after.children].map((c) => c.className)).toEqual(
      before.map((c) => (c === 'lf-star' ? 'lf-star is-on' : c)),
    );
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
    const { page, root, sent } = driveLibrary(WS, starred, NOW, { viewer: ALICE });
    await page.open();
    expect(starredNames(root)).toEqual(['Riverbend note 1']);
    const head = root.querySelector('.lf-starred-head') as Element;
    await click(head.nextElementSibling?.querySelector('.lf-star') as HTMLElement);
    expect(starredNames(root)).toBeNull();
    expect(sent.at(-1)?.body).toEqual({
      kind: 'doc',
      id: 'd-note-1',
      starred: false,
      author: ALICE,
    });
  });

  it('stars a folder, and the folder opens from the Starred list', async () => {
    const { page, root, sent } = driveLibrary(WS, PAYLOAD, NOW, { viewer: ALICE });
    await page.open();
    const harbor = [...root.querySelectorAll<HTMLElement>('.lf-tree [data-lf-folder]')].find(
      (r) => r.dataset.lfFolder === 'f-harbor',
    ) as HTMLElement;
    await click(harbor.querySelector('.lf-star') as HTMLElement);
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
  });

  it('opens a starred subfolder with the folder above it', async () => {
    const starred = { ...PAYLOAD, starred: [{ kind: 'folder' as const, id: 'f-tide', at: NOW }] };
    const { page, root } = driveLibrary(WS, starred, NOW, { viewer: ALICE });
    await page.open();
    await click(root.querySelector('[data-lf-reveal="f-tide"]') as HTMLElement);
    const names = [...root.querySelectorAll('.lf-tree .library-name')].map((n) => n.textContent);
    expect(names).toContain('Tide logs');
    expect(names).toContain('Riverbend note 3');
  });

  it('puts a star back and says so when the server refuses it', async () => {
    const toasts: string[] = [];
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW, {
      viewer: ALICE,
      toasts,
      openAnswer: { ok: false, status: 500, data: null },
    });
    await page.open();
    await click(createdRow(root, 'Riverbend note 1').querySelector('.lf-star') as HTMLElement);
    await settle();
    expect(starredNames(root)).toBeNull();
    expect(toasts).toEqual(['Could not star that.']);
  });

  it('gives a reader with no name no star to flip, in a square of the same size', async () => {
    const { page, root } = driveLibrary(WS, PAYLOAD, NOW);
    await page.open();
    expect(root.querySelector('.lf-star')).toBeNull();
    expect(createdRow(root, 'Riverbend note 1').querySelector('.lf-star-gap')).not.toBeNull();
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
