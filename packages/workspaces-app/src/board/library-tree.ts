/**
 * The Library's folder tree: folders, the docs filed in each, and a "No
 * folder" group, with every change a person makes to them — a new folder,
 * rename, move, archive, filing a doc by its ⋯ menu or by dragging it onto a
 * folder — each answered by a toast carrying Undo (layout A of the folders
 * mock).
 *
 * A component so layout B (the tree in the left nav) can reuse it. It owns
 * its state and paints `html()` for its host plus an overlay of its own for
 * menus and the Move to… sheet; events are delegated from the host's root.
 * Each ⋯ menu carries the reader's Star / Unstar item (`library-starred.ts`).
 *
 * Every write is one call to the folder routes
 * (`packages/server/src/routes/workspace-library-folders.ts`), then the host's
 * re-read; `library.changed` does the same for another tab or an agent.
 */
import { escapeHtml } from '@claude-workspaces/core';
import {
  boardDocRows,
  childFolders,
  countIn,
  docsIn,
  folderNameProblem,
} from './library-folders-model.ts';
import type { LibraryFolder, LibraryPayload, LibraryRow, LibrarySort } from './library-model.ts';
import { libraryWhenColumn } from './library-model.ts';
import { type LibraryStars, folderLinkHtml } from './library-starred.ts';
import {
  ICON,
  type Moving,
  docMenuHtml,
  folderMenuHtml,
  folderRowHtml,
  inputHtml,
  menuSpot,
  sheetHtml,
  wireDrag,
} from './library-tree-parts.ts';

export interface LibraryTreeDeps {
  /** The host's root: events are delegated from here, and the overlay lives in it. */
  root: HTMLElement;
  workspaceId: string;
  send: (
    path: string,
    method: string,
    body: unknown,
  ) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }>;
  /** The board's one-line report, with an optional Undo. */
  toast: (msg: string, action?: { label: string; run: () => void; ms?: number }) => void;
  /** Re-read the Library and repaint. */
  refresh: () => Promise<void>;
  /** Repaint from what is already held, after a change to the tree's own state. */
  rerender: () => void;
  /** Bind a project file nobody has opened yet, answering its new doc id. */
  bind: (path: string) => Promise<string | null>;
  now: () => number;
  /** The reader's stars: each row's toggle reads and flips them. */
  stars: LibraryStars;
}

export interface LibraryTree {
  /** Take a fresh payload. Called first on every host render, so the rows
   *  the host paints name the folders this payload holds. */
  load(payload: LibraryPayload, sort: LibrarySort): void;
  /** The tree, under its heading, for the host to place. */
  html(): string;
  /** One file row with its ⋯ menu, for the host's own lists. */
  rowHtml(row: LibraryRow, opts: { clock: LibrarySort; showFolder?: boolean }): string;
  /** Called by the host after each repaint: focus a name being typed. */
  afterRender(): void;
  /** A starred folder's row for the Starred list; '' once it is gone. */
  folderLinkHtml(id: string): string;
  /** Open a folder in the tree, with every folder above it, and go to it. */
  reveal(id: string): void;
}

/** The "No folder" group's key in `expanded`. */
const NONE = '__none';

type Edit =
  | { kind: 'new'; where: 'tree' | 'sheet'; parentId: string | null; value: string; error: string }
  | { kind: 'rename'; id: string; value: string; error: string };
type Menu = { kind: 'folder'; id: string } | { kind: 'doc'; key: string };

export function createLibraryTree(deps: LibraryTreeDeps): LibraryTree {
  const { root } = deps;
  const base = `/workspaces/${encodeURIComponent(deps.workspaceId)}/library`;
  const overlay = document.createElement('div');
  overlay.className = 'lf-overlay';
  root.append(overlay);

  let folders: LibraryFolder[] = [];
  let rows: LibraryRow[] = [];
  /** Every row a ⋯ menu can name, by its key. */
  const byKey = new Map<string, LibraryRow>();
  let sort: LibrarySort = 'modified';
  const expanded = new Set<string>();
  let edit: Edit | null = null;
  let focusEdit = false;
  let menu: (Menu & { x: number; y: number }) | null = null;
  let moving: Moving | null = null;

  const keyOf = (row: LibraryRow): string | null =>
    row.docId ? `d:${row.docId}` : row.open ? `o:${row.open}` : null;
  const folderById = (id: string | null) => folders.find((f) => f.id === id);
  const nameOf = (id: string | null) =>
    id === null ? 'No folder' : (folderById(id)?.name ?? 'that folder');

  // ── Rows ──────────────────────────────────────────────────────────────
  function rowHtml(row: LibraryRow, opts: { clock: LibrarySort; showFolder?: boolean }): string {
    const key = keyOf(row);
    if (key) byKey.set(key, row);
    const target = row.href
      ? `href="${escapeHtml(row.href)}"`
      : `href="#" data-open="${escapeHtml(row.open ?? '')}"`;
    const f = folderById(row.folderId ?? null);
    const label = opts.showFolder
      ? `<span class="lf-folderlabel">${f ? `${f.meetings ? ICON.meet : ICON.folder}${escapeHtml(f.name)}` : ''}</span>`
      : '';
    const more = key
      ? `<button type="button" class="lf-more" data-lf-docmenu="${escapeHtml(key)}" aria-label="More for ${escapeHtml(row.name)}">⋯</button>`
      : '<span class="lf-more-gap" aria-hidden="true"></span>';
    const drag = row.docId ? ` draggable="true" data-lf-doc="${escapeHtml(row.docId)}"` : '';
    return `<div class="library-row lf-row lf-doc"${drag}><a class="library-main" ${target} title="${escapeHtml(row.name)}"><span class="lf-ico">${ICON.doc}</span><span class="library-name">${escapeHtml(row.name)}</span>${label}</a><span class="library-when">${escapeHtml(libraryWhenColumn(row, deps.now(), opts.clock))}</span>${more}</div>`;
  }

  function folderHtml(f: LibraryFolder): string {
    if (edit?.kind === 'rename' && edit.id === f.id) return inputHtml(edit, 'Folder name');
    const open = expanded.has(f.id);
    const row = folderRowHtml(f, open, countIn(folders, rows, f.id));
    if (!open) return row;
    const inner = levelHtml(f.id);
    return `${row}<div class="lf-children" role="group">${inner || '<div class="lf-empty-hint">Empty. Drag a doc here, or use ⋯ › Move to….</div>'}</div>`;
  }

  /** One level: a folder being made here, the folders, then the docs. */
  function levelHtml(parentId: string | null): string {
    const making =
      edit?.kind === 'new' && edit.where === 'tree' && edit.parentId === parentId
        ? inputHtml(edit, 'New folder name')
        : '';
    const sub = childFolders(folders, parentId).map(folderHtml).join('');
    const docs =
      parentId === null
        ? ''
        : docsIn(rows, parentId, sort)
            .map((r) => rowHtml(r, { clock: sort }))
            .join('');
    return making + sub + docs;
  }

  function noneHtml(): string {
    const loose = docsIn(rows, null, sort);
    const open = expanded.has(NONE);
    const row = `<div class="library-row lf-row lf-folder lf-none" role="treeitem" tabindex="0" aria-expanded="${open}" data-lf-folder="${NONE}" data-lf-drop=""><span class="library-main"><span class="library-caret" aria-hidden="true"></span><span class="lf-ico">${ICON.tray}</span><span class="library-name">No folder</span><span class="lf-count">${loose.length}</span></span><span class="library-when"></span><span class="lf-more-gap" aria-hidden="true"></span></div>`;
    if (!open) return row;
    const inner = loose.map((r) => rowHtml(r, { clock: sort })).join('');
    return `${row}<div class="lf-children" role="group">${inner || '<div class="lf-empty-hint">Every doc is in a folder.</div>'}</div>`;
  }

  function load(payload: LibraryPayload, clock: LibrarySort): void {
    // A repaint rebuilds the name being typed; keep the reader's caret in it.
    if (document.activeElement?.classList.contains('lf-name-input')) focusEdit = true;
    folders = payload.folders ?? [];
    rows = boardDocRows(payload);
    sort = clock;
    for (const r of [...payload.meetings, ...payload.files]) {
      const key = keyOf(r);
      if (key) byKey.set(key, r);
    }
    // A change elsewhere can take away the folder a menu or edit names.
    if (menu?.kind === 'folder' && !folderById(menu.id)) menu = null;
    if (edit?.kind === 'rename' && !folderById(edit.id)) edit = null;
    paintOverlay();
  }

  function html(): string {
    return `<div class="lf-section-head"><h2>Folders</h2><button type="button" class="lf-newfolder" data-lf-new>New folder</button></div><div class="library-tbl lf-tbl"><div class="library-list lf-tree" role="tree" aria-label="Folders">${levelHtml(null)}${noneHtml()}</div></div>`;
  }

  // ── Overlay: the ⋯ menus and the Move to… sheet ──────────────────────
  function paintOverlay(): void {
    let h = '';
    if (menu) {
      const pos = { x: menu.x, y: menu.y };
      h +=
        menu.kind === 'doc'
          ? docMenuHtml(
              pos,
              byKey.get(menu.key),
              deps.stars.menuItemHtml('doc', byKey.get(menu.key)?.docId),
            )
          : folderMenuHtml(pos, folderById(menu.id), deps.stars.menuItemHtml('folder', menu.id));
    }
    if (moving) {
      const m = moving;
      const row = m.kind === 'doc' ? byKey.get(m.key) : undefined;
      const f = m.kind === 'folder' ? folderById(m.id) : undefined;
      h += sheetHtml({
        folders,
        isDoc: m.kind === 'doc',
        movingFolder: m.kind === 'folder' ? m.id : null,
        here: m.kind === 'doc' ? (row?.folderId ?? null) : (f?.parentId ?? null),
        title: m.kind === 'doc' ? (row?.name ?? '') : `Folder: ${f?.name ?? ''}`,
        making:
          edit?.kind === 'new' && edit.where === 'sheet'
            ? inputHtml(edit, 'New folder name')
            : null,
      });
    }
    overlay.innerHTML = h;
  }

  // ── Writes ────────────────────────────────────────────────────────────
  /** One call to a folder route; a refusal's sentence, or null on success. */
  async function call(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ error: string | null; data: Record<string, unknown> | null }> {
    const res = await deps.send(`${base}${path}`, method, body ?? {});
    if (res.ok) return { error: null, data: res.data };
    const message = res.data?.message;
    return {
      error: typeof message === 'string' ? message : 'That change could not be saved.',
      data: res.data,
    };
  }

  /** Report a change with its way back, then re-read. */
  async function done(msg: string, undo: (() => Promise<unknown>) | null): Promise<void> {
    deps.toast(
      msg,
      undo
        ? {
            label: 'Undo',
            ms: 10_000,
            run: () => {
              void undo().then(() => {
                deps.toast('Undone');
                return deps.refresh();
              });
            },
          }
        : undefined,
    );
    await deps.refresh();
  }

  const fileDoc = (docId: string, folderId: string | null) =>
    call(`/docs/${encodeURIComponent(docId)}/folder`, 'PUT', { folderId });
  const folderVerb = (id: string, verb: string, body?: unknown) =>
    call(`/folders/${encodeURIComponent(id)}/${verb}`, 'POST', body);

  async function moveInto(m: Moving, target: string | null): Promise<void> {
    if (m.kind === 'folder') {
      const f = folderById(m.id);
      if (!f || f.parentId === target) return;
      const from = f.parentId;
      const res = await folderVerb(m.id, 'move', { parentId: target });
      if (res.error) return deps.toast(res.error);
      if (target) expanded.add(target);
      return done(
        `Moved folder “${f.name}” into ${target ? nameOf(target) : 'the top level'}`,
        () => folderVerb(m.id, 'move', { parentId: from }),
      );
    }
    const row = byKey.get(m.key);
    if (!row || (row.folderId ?? null) === target) return;
    const from = row.folderId ?? null;
    const docId = row.docId ?? (row.open ? await deps.bind(row.open) : null);
    if (!docId) return deps.toast('That file could not be filed.');
    const res = await fileDoc(docId, target);
    if (res.error) return deps.toast(res.error);
    if (target) expanded.add(target);
    return done(`Moved “${row.name}” to ${nameOf(target)}`, () => fileDoc(docId, from));
  }

  async function commitEdit(): Promise<void> {
    if (!edit) return;
    const e = edit;
    const parentId = e.kind === 'new' ? e.parentId : (folderById(e.id)?.parentId ?? null);
    const problem = folderNameProblem(
      folders,
      parentId,
      e.value,
      e.kind === 'rename' ? e.id : undefined,
    );
    if (problem) {
      e.error = problem;
      focusEdit = true;
      return repaint();
    }
    const name = e.value.trim().replace(/\s+/g, ' ');
    if (e.kind === 'rename') {
      const old = folderById(e.id)?.name ?? '';
      const res = await folderVerb(e.id, 'rename', { name });
      if (res.error) return showEditError(e, res.error);
      edit = null;
      return done(`Renamed “${old}” to “${name}”`, () => folderVerb(e.id, 'rename', { name: old }));
    }
    const res = await call('/folders', 'POST', { name, parentId });
    if (res.error) return showEditError(e, res.error);
    const id = (res.data?.folder as { id?: string } | undefined)?.id ?? '';
    edit = null;
    expanded.add(id);
    if (parentId) expanded.add(parentId);
    if (e.where === 'sheet' && moving) {
      // Made from the Move to… sheet: the item goes straight into it, and
      // that move's toast carries the Undo.
      const m = moving;
      moving = null;
      paintOverlay();
      return moveInto(m, id);
    }
    return done(`Made folder “${name}”${parentId ? ` in ${nameOf(parentId)}` : ''}`, () =>
      folderVerb(id, 'archive'),
    );
  }

  function showEditError(e: Edit, message: string): void {
    e.error = message;
    focusEdit = true;
    repaint();
  }

  async function archive(id: string): Promise<void> {
    const f = folderById(id);
    if (!f || f.meetings) return;
    const n = countIn(folders, rows, id);
    const res = await folderVerb(id, 'archive');
    if (res.error) return deps.toast(res.error);
    const docs = n === 1 ? '1 doc' : `${n} docs`;
    return done(`Archived “${f.name}”. Its ${docs} now show under No folder.`, () =>
      folderVerb(id, 'unarchive'),
    );
  }

  function repaint(): void {
    deps.rerender();
    paintOverlay();
    focusName();
  }

  function focusName(): void {
    if (!focusEdit) return;
    const input = root.querySelector<HTMLInputElement>('.lf-name-input');
    if (!input) return;
    focusEdit = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function startNew(where: 'tree' | 'sheet', parentId: string | null): void {
    edit = { kind: 'new', where, parentId, value: '', error: '' };
    if (parentId) expanded.add(parentId);
    focusEdit = true;
    repaint();
  }

  function openMenu(btn: HTMLElement, m: Menu): void {
    menu = { ...m, ...menuSpot(btn, m.kind === 'doc' ? 160 : 310) };
    paintOverlay();
  }

  // ── Events, delegated from the host's root ────────────────────────────
  root.addEventListener('click', (ev) => {
    const t = ev.target as Element;
    const star = t.closest<HTMLElement>('[data-lf-star]');
    const kind = star?.dataset.lfStar === 'folder' ? 'folder' : 'doc';
    if (star) {
      menu = null;
      paintOverlay();
      return void deps.stars.toggle(kind, star.dataset.lfStarId ?? '');
    }
    const reveal = t.closest<HTMLElement>('[data-lf-reveal]');
    if (reveal) return revealFolder(reveal.dataset.lfReveal ?? '');
    if (t.closest('[data-lf-save]')) return void commitEdit();
    if (t.closest('[data-lf-cancel]')) {
      edit = null;
      return repaint();
    }
    if (t.closest('.lf-input-row')) return;
    if (t.closest('[data-lf-close]')) {
      menu = null;
      if (moving) {
        moving = null;
        if (edit?.kind === 'new' && edit.where === 'sheet') edit = null;
      }
      return paintOverlay();
    }
    if (t.closest('[data-lf-new]')) return startNew('tree', null);
    if (t.closest('[data-lf-sheetnew]')) {
      edit = { kind: 'new', where: 'sheet', parentId: null, value: '', error: '' };
      focusEdit = true;
      paintOverlay();
      return focusName();
    }
    const into = t.closest<HTMLElement>('[data-lf-into]');
    if (into && moving) {
      const m = moving;
      moving = null;
      paintOverlay();
      return void moveInto(m, into.dataset.lfInto || null);
    }
    const act = t.closest<HTMLElement>('[data-lf-act]');
    if (act && menu) {
      const m = menu;
      menu = null;
      paintOverlay();
      const what = act.dataset.lfAct;
      if (m.kind === 'doc') {
        if (what === 'moveto') moving = { kind: 'doc', key: m.key };
        else if (what === 'open') {
          const open = byKey.get(m.key)?.open;
          root.querySelector<HTMLElement>(`[data-open="${CSS.escape(open ?? '')}"]`)?.click();
        }
        return paintOverlay();
      }
      if (what === 'new') return startNew('tree', m.id);
      if (what === 'rename') {
        edit = { kind: 'rename', id: m.id, value: folderById(m.id)?.name ?? '', error: '' };
        focusEdit = true;
        return repaint();
      }
      if (what === 'moveto') {
        moving = { kind: 'folder', id: m.id };
        return paintOverlay();
      }
      if (what === 'archive') return void archive(m.id);
      return;
    }
    const docMenu = t.closest<HTMLElement>('[data-lf-docmenu]');
    if (docMenu) {
      ev.preventDefault();
      return openMenu(docMenu, { kind: 'doc', key: docMenu.dataset.lfDocmenu ?? '' });
    }
    const folderMenu = t.closest<HTMLElement>('[data-lf-foldermenu]');
    if (folderMenu)
      return openMenu(folderMenu, { kind: 'folder', id: folderMenu.dataset.lfFoldermenu ?? '' });
    const folder = t.closest<HTMLElement>('[data-lf-folder]');
    if (folder) toggle(folder.dataset.lfFolder ?? '');
  });

  function revealFolder(id: string): void {
    for (let f = folderById(id); f; f = folderById(f.parentId)) expanded.add(f.id);
    deps.rerender();
    focusFolder(id)?.scrollIntoView?.({ block: 'start' });
  }

  function toggle(id: string): void {
    if (!expanded.delete(id)) expanded.add(id);
    deps.rerender();
    focusFolder(id);
  }

  /** Focus a folder's row in the tree, answering it. */
  function focusFolder(id: string): HTMLElement | undefined {
    const rowEls = root.querySelectorAll<HTMLElement>('.lf-tree [data-lf-folder]');
    const row = [...rowEls].find((r) => r.dataset.lfFolder === id);
    row?.focus();
    return row;
  }

  root.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.classList.contains('lf-name-input')) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commitEdit();
      } else if (ev.key === 'Escape') {
        edit = null;
        repaint();
      }
      return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && t.dataset.lfFolder !== undefined) {
      ev.preventDefault();
      toggle(t.dataset.lfFolder);
    }
  });

  root.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.classList.contains('lf-name-input') && edit) {
      edit.value = t.value;
      edit.error = '';
    }
  });

  // Dragging a doc (or a folder) onto a folder files it there.
  wireDrag(root, (m, target) => void moveInto(m, target));

  return {
    load,
    html,
    rowHtml,
    afterRender: focusName,
    folderLinkHtml: (id) => {
      const f = folderById(id);
      return f ? folderLinkHtml(f, countIn(folders, rows, f.id)) : '';
    },
    reveal: revealFolder,
  };
}
