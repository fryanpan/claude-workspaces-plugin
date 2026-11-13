/**
 * The Library's folder tree, driven over a fake of the folder routes: a
 * person makes a folder (and is told inline when the name is taken), files a
 * doc by its ⋯ menu, by the Move to… sheet's own "+ New folder" and by
 * dragging, finds meetings in Meetings, and undoes each change from its
 * toast. The last block boots the real board and proves a folder made
 * elsewhere reaches an open Library on the `library.changed` frame.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { libraryHref } from '../src/board/board-url.ts';
import type { LibraryFolder, LibraryPayload, LibraryRow } from '../src/board/library-model.ts';
import { createLibraryPage } from '../src/board/library-page.ts';
import { FakeEventSource, fakeHistory, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const MEETINGS: LibraryFolder = {
  id: 'meetings',
  name: 'Meetings',
  parentId: null,
  path: 'Meetings',
  meetings: true,
};

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

/**
 * The folder routes over one board's state, answering as the server does:
 * a refusal is `{ error, message }`, a success re-read shows the change.
 */
function fakeBoard() {
  const folders: LibraryFolder[] = [MEETINGS];
  const filed: Record<string, string | null> = { 'd-sync': 'meetings' };
  const archived = new Set<string>();
  let n = 0;
  const pathOf = (f: LibraryFolder): string => {
    const parent = folders.find((p) => p.id === f.parentId);
    return parent ? `${pathOf(parent)}/${f.name}` : f.name;
  };
  const live = () =>
    folders.filter((f) => !archived.has(f.id)).map((f) => ({ ...f, path: pathOf(f) }));
  const row = (name: string, docId: string, hoursAgo: number): LibraryRow => {
    const folderId = filed[docId];
    return {
      name,
      docId,
      at: NOW - hoursAgo * HOUR,
      href: `/workspaces/${WS}/docs/${docId}`,
      ...(folderId && !archived.has(folderId) ? { folderId } : {}),
    };
  };
  const payload = (): LibraryPayload => ({
    project: { name: 'riverbend', path: '~/dev/riverbend' },
    meetings: [row('Harborlight sync', 'd-sync', 2)],
    files: [row('Riverbend plan', 'd-plan', 1), row('Saltmarsh notes', 'd-notes', 3)],
    folders: live(),
  });
  const sent: Sent[] = [];
  const ok = (data: Record<string, unknown> = {}) => ({ ok: true, status: 200, data });
  const send = async (path: string, method: string, body: unknown) => {
    sent.push({ path, method, body });
    const rest = path.replace(`/workspaces/${WS}/library`, '');
    const b = (body ?? {}) as Record<string, unknown>;
    if (rest === '/folders' && method === 'POST') {
      const name = String(b.name);
      const parentId = (b.parentId as string | null) ?? null;
      if (
        live().some((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())
      )
        return {
          ok: false,
          status: 409,
          data: { error: 'duplicate-name', message: 'There is already a folder called that.' },
        };
      const folder = { id: `f-${++n}`, name, parentId, path: name };
      folders.push(folder);
      return ok({ folder });
    }
    const verb = /^\/folders\/([^/]+)\/(\w+)$/.exec(rest);
    if (verb) {
      const id = verb[1] as string;
      if (verb[2] === 'archive') archived.add(id);
      if (verb[2] === 'unarchive') archived.delete(id);
      const f = folders.find((x) => x.id === id);
      if (f && verb[2] === 'rename') f.name = String(b.name);
      if (f && verb[2] === 'move') f.parentId = (b.parentId as string | null) ?? null;
      return ok();
    }
    const doc = /^\/docs\/([^/]+)\/folder$/.exec(rest);
    if (doc) {
      filed[doc[1] as string] = (b.folderId as string | null) ?? null;
      return ok();
    }
    return { ok: false, status: 404, data: null };
  };
  return { payload, send, sent, folders, filed };
}

function drive() {
  document.body.innerHTML = '<div id="board-library"></div>';
  const root = document.getElementById('board-library') as HTMLElement;
  const board = fakeBoard();
  const toasts: { msg: string; run?: () => void }[] = [];
  const page = createLibraryPage({
    root,
    workspaceId: WS,
    boardName: () => 'Riverbend',
    fetchJson: async <T>() => board.payload() as T,
    send: board.send,
    navigate: () => {},
    history: fakeHistory(),
    here: (list, place) => libraryHref(`https://board.test/workspaces/${WS}/library`, list, place),
    now: () => NOW,
    toast: (msg, action) => toasts.push({ msg, run: action?.run }),
  });
  return { page, root, board, toasts };
}

const tree = (root: ParentNode) => root.querySelector('.lf-tree') as HTMLElement;
const folderRow = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLElement>('.lf-folder')].find(
    (r) => r.querySelector('.library-name')?.textContent === name,
  ) as HTMLElement;
const topFolders = (root: ParentNode) =>
  [...tree(root).querySelectorAll(':scope > .lf-folder .library-name')].map((n) => n.textContent);
/** The doc names inside an opened folder. */
const docsUnder = (root: ParentNode, name: string) =>
  [
    ...((folderRow(root, name).nextElementSibling as Element).querySelectorAll(
      ':scope > .lf-doc .library-name',
    ) ?? []),
  ].map((n) => n.textContent);
const typeName = async (root: ParentNode, value: string) => {
  const input = root.querySelector('.lf-name-input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await click(root.querySelector('[data-lf-save]') as HTMLElement);
};
const recentRow = (root: ParentNode, name: string) =>
  [
    ...(
      root.querySelector('.lf-created-head + .library-tbl') as Element
    ).querySelectorAll<HTMLElement>('.lf-doc'),
  ].find((r) => r.querySelector('.library-name')?.textContent === name) as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the folder tree', () => {
  it('starts with Meetings, where meetings land, and No folder holding the rest', async () => {
    const { page, root } = drive();
    await page.open();
    expect(topFolders(root)).toEqual(['Meetings', 'No folder']);
    expect(folderRow(root, 'Meetings').querySelector('.lf-landhint')?.textContent).toBe(
      'new meetings land here',
    );
    await click(folderRow(root, 'Meetings'));
    expect(docsUnder(root, 'Meetings')).toEqual(['Harborlight sync']);
    await click(folderRow(root, 'No folder'));
    expect(docsUnder(root, 'No folder')).toEqual(['Riverbend plan', 'Saltmarsh notes']);
  });

  it('makes a folder, says so with Undo, and Undo archives it', async () => {
    const { page, root, board, toasts } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    expect(document.activeElement).toBe(root.querySelector('.lf-name-input'));
    await typeName(root, 'Plans');
    expect(board.sent.at(-1)).toEqual({
      path: `/workspaces/${WS}/library/folders`,
      method: 'POST',
      body: { name: 'Plans', parentId: null },
    });
    expect(topFolders(root)).toEqual(['Meetings', 'Plans', 'No folder']);
    expect(toasts.at(-1)?.msg).toBe('Made folder “Plans”');

    toasts.at(-1)?.run?.();
    await settle();
    expect(board.sent.at(-1)).toMatchObject({
      path: `/workspaces/${WS}/library/folders/f-1/archive`,
    });
    expect(topFolders(root)).toEqual(['Meetings', 'No folder']);
  });

  it('refuses a name already used in the same place, inline, before any call', async () => {
    const { page, root, board } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    await typeName(root, 'Plans');
    const calls = board.sent.length;
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    await typeName(root, ' plans ');
    expect(root.querySelector('.lf-err')?.textContent).toBe(
      'There is already a folder called “Plans” in the top level.',
    );
    expect(board.sent).toHaveLength(calls);
    // CONTROL: a free name saves from the same input.
    await typeName(root, 'Research');
    expect(root.querySelector('.lf-err')).toBeNull();
    expect(topFolders(root)).toEqual(['Meetings', 'Plans', 'Research', 'No folder']);
  });

  it('files a doc by its ⋯ menu and the Move to… sheet, and Undo puts it back', async () => {
    const { page, root, board, toasts } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    await typeName(root, 'Plans');
    await click(recentRow(root, 'Riverbend plan').querySelector('.lf-more') as HTMLElement);
    await click(root.querySelector('[data-lf-act=moveto]') as HTMLElement);
    const sheet = root.querySelector('.lf-sheet') as HTMLElement;
    expect([...sheet.querySelectorAll('.lf-nm')].map((n) => n.textContent)).toEqual([
      'No folder (here now)',
      'Meetings',
      'Plans',
    ]);
    await click(sheet.querySelector('[data-lf-into="f-1"]') as HTMLElement);
    expect(board.sent.at(-1)).toEqual({
      path: `/workspaces/${WS}/library/docs/d-plan/folder`,
      method: 'PUT',
      body: { folderId: 'f-1' },
    });
    expect(root.querySelector('.lf-sheet')).toBeNull();
    expect(docsUnder(root, 'Plans')).toEqual(['Riverbend plan']);
    // Recent files names the folder a row is in.
    expect(recentRow(root, 'Riverbend plan').querySelector('.lf-folderlabel')?.textContent).toBe(
      'Plans',
    );
    expect(toasts.at(-1)?.msg).toBe('Moved “Riverbend plan” to Plans');

    toasts.at(-1)?.run?.();
    await settle();
    expect(board.sent.at(-1)?.body).toEqual({ folderId: null });
    expect(board.filed['d-plan']).toBeNull();
  });

  it('makes a folder from inside the Move to… sheet and puts the doc straight in it', async () => {
    const { page, root, board } = drive();
    await page.open();
    await click(recentRow(root, 'Saltmarsh notes').querySelector('.lf-more') as HTMLElement);
    await click(root.querySelector('[data-lf-act=moveto]') as HTMLElement);
    await click(root.querySelector('[data-lf-sheetnew]') as HTMLElement);
    await typeName(root, 'Research');
    expect(board.sent.slice(-2).map((s) => [s.method, s.body])).toEqual([
      ['POST', { name: 'Research', parentId: null }],
      ['PUT', { folderId: 'f-1' }],
    ]);
    expect(docsUnder(root, 'Research')).toEqual(['Saltmarsh notes']);
  });

  it('files a doc dragged onto a folder', async () => {
    const { page, root, board } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    await typeName(root, 'Plans');
    const drag = recentRow(root, 'Saltmarsh notes');
    drag.dispatchEvent(new Event('dragstart', { bubbles: true }));
    const target = folderRow(root, 'Plans');
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    // Taking the dragover is what lets the browser drop here.
    expect(over.defaultPrevented).toBe(true);
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await settle();
    expect(board.sent.at(-1)).toEqual({
      path: `/workspaces/${WS}/library/docs/d-notes/folder`,
      method: 'PUT',
      body: { folderId: 'f-1' },
    });
  });

  it('keeps Meetings in place: its menu cannot move or archive it, and says why', async () => {
    const { page, root } = drive();
    await page.open();
    await click(folderRow(root, 'Meetings').querySelector('.lf-more') as HTMLElement);
    const menu = root.querySelector('.lf-menu') as HTMLElement;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.lf-menu-item')].map((b) => [
      b.textContent,
      b.disabled,
    ]);
    expect(items).toEqual([
      ['New folder inside', false],
      ['Rename', false],
      ['Move to…', true],
      ['Archive', true],
    ]);
    expect(menu.querySelector('.lf-menu-note')?.textContent).toContain('cannot be archived');
  });

  it('archives a folder with Undo, and its docs show under No folder meanwhile', async () => {
    const { page, root, board, toasts } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-new]') as HTMLElement);
    await typeName(root, 'Plans');
    await board.send(`/workspaces/${WS}/library/docs/d-plan/folder`, 'PUT', { folderId: 'f-1' });
    await page.refresh();
    await click(folderRow(root, 'Plans').querySelector('.lf-more') as HTMLElement);
    await click(root.querySelector('[data-lf-act=archive]') as HTMLElement);
    expect(toasts.at(-1)?.msg).toBe('Archived “Plans”. Its 1 doc now show under No folder.');
    expect(topFolders(root)).toEqual(['Meetings', 'No folder']);
    await click(folderRow(root, 'No folder'));
    expect(docsUnder(root, 'No folder')).toContain('Riverbend plan');

    toasts.at(-1)?.run?.();
    await settle();
    expect(board.sent.at(-1)?.path).toBe(`/workspaces/${WS}/library/folders/f-1/unarchive`);
    expect(topFolders(root)).toEqual(['Meetings', 'Plans', 'No folder']);
  });
});

describe('the folder tree on the board', () => {
  const base: LibraryPayload = {
    project: { name: 'riverbend', path: '~/dev/riverbend' },
    meetings: [],
    files: [{ name: 'Riverbend plan', docId: 'd-plan', at: NOW, href: '/d/plan' }],
    folders: [MEETINGS],
  };
  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/library/items`, base);
  });

  it('shows a folder made elsewhere, and a doc filed in it, on the library.changed frame', async () => {
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/library` });
    await settle();
    const lib = el('board-library');
    expect(topFolders(lib)).toEqual(['Meetings', 'No folder']);
    server.on(`/workspaces/${WS}/library/items`, {
      ...base,
      files: [{ ...base.files[0], folderId: 'f-9' }],
      folders: [MEETINGS, { id: 'f-9', name: 'Saltmarsh', parentId: null, path: 'Saltmarsh' }],
    });
    const feed = [...FakeEventSource.opened]
      .reverse()
      .find((es) => es.url.endsWith(`/workspaces/${WS}/events:stream`));
    feed?.dispatchEvent(new Event('library.changed'));
    await settle();
    expect(topFolders(lib)).toEqual(['Meetings', 'Saltmarsh', 'No folder']);
    expect(folderRow(lib, 'Saltmarsh').querySelector('.lf-count')?.textContent).toBe('1');
  });
});
