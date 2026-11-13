/**
 * The folder tree's menus and its Move to… sheet, as markup: what
 * `library-tree.ts` paints into its overlay. Pure, so the tree module keeps
 * its state and events and this keeps the strings.
 */
import { escapeHtml } from '@claude-workspaces/core';
import { childFolders, isUnder } from './library-folders-model.ts';
import type { LibraryFolder, LibraryRow } from './library-model.ts';

const SV = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  folder: SV(
    '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  ),
  meet: SV(
    '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  ),
  doc: SV('<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4"/>'),
  tray: SV(
    '<path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.5 5.5h13l2 8v5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-5z"/>',
  ),
};

type At = { x: number; y: number };
const at = (p: At) => `left:${p.x}px;top:${p.y}px`;
const SCRIM = '<div class="lf-scrim is-clear" data-lf-close></div>';

/** A doc's ⋯ menu: open it, or move it. */
export function docMenuHtml(p: At, row: LibraryRow | undefined): string {
  const open = row?.href
    ? `<a class="lf-menu-item" href="${escapeHtml(row.href)}" role="menuitem">Open</a>`
    : '<button type="button" class="lf-menu-item" data-lf-act="open" role="menuitem">Open</button>';
  return `${SCRIM}<div class="lf-menu" style="${at(p)}" role="menu">${open}<button type="button" class="lf-menu-item" data-lf-act="moveto" role="menuitem">Move to…</button></div>`;
}

/** A folder's ⋯ menu. Meetings cannot be moved or archived, and says why. */
export function folderMenuHtml(p: At, f: LibraryFolder | undefined): string {
  const fixed = f?.meetings ? ' disabled' : '';
  const note = f?.meetings
    ? '<div class="lf-menu-note">New meetings land in this folder, so it stays at the top and cannot be archived.</div>'
    : '';
  const item = (act: string, text: string, extra = '') =>
    `<button type="button" class="lf-menu-item" data-lf-act="${act}" role="menuitem"${extra}>${text}</button>`;
  return `${SCRIM}<div class="lf-menu" style="${at(p)}" role="menu">${item('new', 'New folder inside')}${item('rename', 'Rename')}${item('moveto', 'Move to…', fixed)}${item('archive', 'Archive', fixed)}${note}</div>`;
}

export interface SheetArgs {
  folders: readonly LibraryFolder[];
  isDoc: boolean;
  /** The folder being moved, which cannot go into itself or below itself. */
  movingFolder: string | null;
  /** Where the item is now (null: no folder, or the top level). */
  here: string | null;
  title: string;
  /** The new-folder input row while one is being named, else null. */
  making: string | null;
}

/** The Move to… sheet: every place the item may go, and its own "+ New folder". */
export function sheetHtml(a: SheetArgs): string {
  const blocked = (f: LibraryFolder) =>
    a.movingFolder !== null &&
    (f.id === a.movingFolder || isUnder(a.folders, f.id, a.movingFolder));
  const option = (id: string | null, label: string, icon: string, depth: number) => {
    const now = a.here === id;
    return `<button type="button" class="lf-sheet-row" data-lf-into="${id ?? ''}" style="padding-left:${8 + depth * 18}px"${now ? ' disabled' : ''}><span class="lf-ico">${icon}</span><span class="lf-nm">${escapeHtml(label)}${now ? ' (here now)' : ''}</span></button>`;
  };
  const tree = (parentId: string | null, depth: number): string =>
    childFolders(a.folders, parentId)
      .filter((f) => !blocked(f))
      .map(
        (f) =>
          option(f.id, f.name, f.meetings ? ICON.meet : ICON.folder, depth) + tree(f.id, depth + 1),
      )
      .join('');
  const making =
    a.making ?? '<button type="button" class="lf-newfolder" data-lf-sheetnew>+ New folder</button>';
  const top = option(null, a.isDoc ? 'No folder' : 'Top level', ICON.tray, 0);
  return `<div class="lf-scrim" data-lf-close></div><div class="lf-sheet" role="dialog" aria-label="Move to folder"><h3>Move to…</h3><p>${escapeHtml(a.title)}</p>${top}${tree(null, 0)}${making}<button type="button" class="lf-cancel" data-lf-close>Cancel</button></div>`;
}

/** What a sheet or a drag is moving: a doc, by its row key, or a folder. */
export type Moving = { kind: 'doc'; key: string } | { kind: 'folder'; id: string };

/**
 * Dragging a doc row (`data-lf-doc`) or a folder (`data-lf-dragfolder`) onto
 * a drop target (`data-lf-drop`, empty for "No folder") calls `drop`.
 * Delegated from `root`, so a repaint never rewires it.
 */
export function wireDrag(
  root: HTMLElement,
  drop: (m: Moving, target: string | null) => void,
): void {
  let dragging: Moving | null = null;
  const dropTarget = (ev: Event) => (ev.target as Element).closest<HTMLElement>('[data-lf-drop]');
  root.addEventListener('dragstart', (ev) => {
    const t = ev.target as HTMLElement;
    const doc = t.closest<HTMLElement>('[data-lf-doc]');
    const folder = t.closest<HTMLElement>('[data-lf-dragfolder]');
    if (doc) dragging = { kind: 'doc', key: `d:${doc.dataset.lfDoc}` };
    else if (folder) dragging = { kind: 'folder', id: folder.dataset.lfDragfolder ?? '' };
    else return;
    ev.dataTransfer?.setData('text/plain', JSON.stringify(dragging));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragover', (ev) => {
    const at = dropTarget(ev);
    if (!at || !dragging) return;
    ev.preventDefault();
    at.classList.add('lf-drop');
  });
  root.addEventListener('dragleave', (ev) => dropTarget(ev)?.classList.remove('lf-drop'));
  root.addEventListener('drop', (ev) => {
    const at = dropTarget(ev);
    const m = dragging;
    dragging = null;
    if (!at || !m) return;
    ev.preventDefault();
    at.classList.remove('lf-drop');
    drop(m, at.dataset.lfDrop || null);
  });
  root.addEventListener('dragend', () => {
    dragging = null;
  });
}

/** A folder name being typed, with its Save, Cancel and any refusal. */
export function inputHtml(e: { value: string; error: string }, placeholder: string): string {
  const err = e.error ? `<span class="lf-err" role="alert">${escapeHtml(e.error)}</span>` : '';
  return `<div class="lf-input-row"><span class="lf-ico">${ICON.folder}</span><input type="text" class="lf-name-input" placeholder="${placeholder}" aria-label="${placeholder}" maxlength="80" value="${escapeHtml(e.value)}"><button type="button" class="lf-newfolder" data-lf-save>Save</button><button type="button" class="lf-newfolder" data-lf-cancel>Cancel</button>${err}</div>`;
}

/** Where a 220px menu `height` tall opens under `btn`, kept on screen. */
export function menuSpot(btn: HTMLElement, height: number): At {
  const r = btn.getBoundingClientRect();
  const width = 220;
  return {
    x: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - height)),
  };
}

/** One folder's row in the tree: caret, name, count, star toggle and ⋯. */
export function folderRowHtml(
  f: LibraryFolder,
  open: boolean,
  count: number,
  star: string,
): string {
  const hint = f.meetings ? '<span class="lf-landhint">new meetings land here</span>' : '';
  const drag = f.meetings ? '' : ` draggable="true" data-lf-dragfolder="${escapeHtml(f.id)}"`;
  return `<div class="library-row lf-row lf-folder${f.meetings ? ' lf-meet' : ''}" role="treeitem" tabindex="0" aria-expanded="${open}" data-lf-folder="${escapeHtml(f.id)}" data-lf-drop="${escapeHtml(f.id)}"${drag}><span class="library-main"><span class="library-caret" aria-hidden="true"></span><span class="lf-ico">${f.meetings ? ICON.meet : ICON.folder}</span><span class="library-name">${escapeHtml(f.name)}</span><span class="lf-count">${count}</span>${hint}</span><span class="library-when"></span>${star}<button type="button" class="lf-more" data-lf-foldermenu="${escapeHtml(f.id)}" aria-label="More for folder ${escapeHtml(f.name)}">⋯</button></div>`;
}
