/**
 * "Where files live": the Library's last section, folded shut, naming where
 * each kind of doc lives and what is wrong or unset about each place.
 *
 * Markup only; `library-page.ts` shows it and wires the place buttons.
 */
import { escapeHtml } from '@claude-workspaces/core';
import {
  LIBRARY_KIND_NAMES,
  LIBRARY_NO_FOLDER,
  type LibraryPlace,
  type LibraryWhere,
} from './library-model.ts';

/** One location's line: where, and what is wrong or unset about it. */
function placeHtml(where: LibraryWhere, p: LibraryPlace | null, first: boolean): string {
  const noteText = p?.note ?? (first && where.unset ? LIBRARY_NO_FOLDER : undefined);
  const note = noteText
    ? `<span class="library-place-note${p?.stray ? ' is-stray' : ''}">${escapeHtml(noteText)}</span>`
    : '';
  if (!p) {
    return `<div class="library-row library-place is-empty"><span class="library-main"><span class="library-name">None yet</span></span>${note}</div>`;
  }
  const cls = p.folder ? 'library-name library-path' : 'library-name';
  return `<button type="button" class="library-row library-place" data-place="${escapeHtml(p.key)}"><span class="library-main"><span class="${cls}">${escapeHtml(p.label)}</span></span>${note}</button>`;
}

/**
 * "Where files live", closed by default and last on the page: the Library
 * opens on meetings and files as it always has, and location is there for
 * whoever asks (Bryan, mock v2).
 */
export function whereHtml(where: readonly LibraryWhere[], whereOpen: boolean): string {
  const kinds = where
    .map((w) => {
      const places = w.places.length
        ? w.places.map((p, i) => placeHtml(w, p, i === 0)).join('')
        : placeHtml(w, null, true);
      return `<div class="library-where-type"><span class="library-where-name">${LIBRARY_KIND_NAMES[w.kind]}</span><div class="library-where-places">${places}</div></div>`;
    })
    .join('');
  return `<details class="library-where-fold"${whereOpen ? ' open' : ''}><summary><h2>Where files live</h2></summary><div class="library-where"><div class="library-cols" aria-hidden="true"><span>Type</span><span>Location</span></div><div class="library-list">${kinds}</div></div></details>`;
}
