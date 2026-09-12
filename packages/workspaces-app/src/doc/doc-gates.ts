/**
 * The last phase of a markdown document's boot: what this browser is allowed
 * to do with the surface.
 *
 * Two things in one place because between them they settle one question. The
 * format bar's own collapse toggle and its hotkey; and the editability of the
 * document, which is no longer a mode anybody switches — a doc opens ready to
 * write for a browser the server will accept, and opens read-only, with
 * nothing offering to change that, for one it will not.
 *
 * Synchronous, and last in the mount, because it speaks for the whole
 * surface: `canWrite` arrived on the MountContext, so nothing here waits on a
 * network answer and nothing is editable in the meantime.
 */
import { initialEditMode } from '../edit-mode.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { lockDocToReading } from '../signin/write-gate.ts';
import { applyWidthPref, wireFormatBar } from './editor-toolbar.ts';

/** The chrome this phase speaks for. */
export interface DocGateElements {
  formatBar: HTMLElement;
  toggleFormat: HTMLButtonElement;
}

export interface DocGatesOptions {
  editor: EditorHandle;
  scope: MountScope;
  els: DocGateElements;
  canWrite: boolean;
}

export function wireDocGates(opts: DocGatesOptions): void {
  const { editor, scope, els, canWrite } = opts;
  const { formatBar, toggleFormat } = els;

  // =========================================================================
  // FORMATTING TOOLBAR — collapsed by default. Aa button toggles it.
  // =========================================================================
  scope.listen(toggleFormat, 'click', () => {
    const collapsed = formatBar.classList.toggle('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', String(!collapsed));
  });
  applyWidthPref();
  wireFormatBar(editor, scope);

  // =========================================================================
  // EDITABILITY — the server's answer, applied once.
  //   `canWrite` is what main() already awaited, so the first `setEditable`
  //   of this mount is already the right one. There is no window in which the
  //   document is live and the answer is outstanding.
  // =========================================================================
  const editable = initialEditMode(canWrite) === 'edit';
  editor.editor.setEditable(editable);
  document.body.classList.toggle('view-mode', !editable);
  if (!editable) {
    // Formatting commands are no-ops on a surface that takes nothing, so the
    // bar starts collapsed and `body.view-mode` hides its toggle.
    formatBar.classList.add('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', 'false');
    // The crumb ("Editing:" → "Reading:") and the save-state chip are
    // `lockDocToReading`'s — the redline and code surfaces call it too, which
    // is what keeps the three from drifting apart.
    lockDocToReading({});
  }

  // =========================================================================
  // HOTKEYS — ⌘M / Escape are wired by the shared chrome; only the
  // markdown-specific format-bar hotkey lives here.
  // =========================================================================
  scope.listen(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.shiftKey && ke.key.toLowerCase() === 'f') {
      ke.preventDefault();
      toggleFormat.click();
    }
  });
}
