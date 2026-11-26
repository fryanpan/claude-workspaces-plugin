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
import { type DocAccessTracker, roleLabel, typingAllowed } from '../doc-access.ts';
import { initialEditMode } from '../edit-mode.ts';
import type { EditorHandle } from '../editor.ts';
import { setRoleReadingCrumb } from '../huddle-entry.ts';
import type { MountScope } from '../mount-scope.ts';
import { WRITE_CONTROL_ATTR, lockDocToReading } from '../signin/write-gate.ts';
import { isSuggesting, setSuggesting } from '../suggest-input.ts';
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
  /** The doc socket's access level (`doc-access.ts`), when it has one. */
  access?: DocAccessTracker | undefined;
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
  // ACCESS LEVEL — what the doc's own socket says this member may do. A
  //   `view` or `comment` member is signed in, so `canWrite` is true, and the
  //   server drops their typing anyway (`socket-write-gate.ts`). Locked while
  //   the socket says so, unlocked when a role change reconnects it as an
  //   editor; the label is the save-state chip's (`doc-save-state.ts`).
  // =========================================================================
  if (editable && opts.access) {
    const apply = (): void => {
      if (scope.disposed) return;
      const access = opts.access?.current() ?? null;
      const typing = typingAllowed(access);
      if (editor.editor.isEditable !== typing) editor.editor.setEditable(typing);
      document.body.classList.toggle('view-mode', !typing);
      if (!typing) {
        formatBar.classList.add('is-collapsed');
        toggleFormat.setAttribute('aria-pressed', 'false');
        // Proposals ride the same socket the server is dropping.
        const view = editor.editor.view;
        if (isSuggesting(view.state)) setSuggesting(view, { on: false });
      }
      lockWriteControls(typing ? null : roleLabel(access));
      // A view member cannot comment either, so the comment pill goes too
      // (styles.css, COMMENT PILL). A comment member keeps it.
      document.body.classList.toggle('role-view', !typing && access?.role === 'view');
      setRoleReadingCrumb(document, !typing);
    };
    apply();
    scope.onCleanup(opts.access.onChange(apply));
    scope.onCleanup(() => {
      lockWriteControls(null);
      document.body.classList.remove('role-view');
      setRoleReadingCrumb(document, false);
    });
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

/** What a write control said before a role locked it, to put back. */
const SAID = 'data-role-locked-title';
/** Set on a control that was already disabled when the role locked it. */
const WAS_OFF = 'data-role-locked-off';

/** Watches for write controls mounted while a role holds them locked. */
let lateControls: MutationObserver | null = null;

/**
 * Disable every marked write control with `why` as its title, or put them
 * back when `why` is null. Only what this function changed comes back: a
 * control another path had disabled stays disabled, and the sign-in lock
 * (`lockDocToReading`) is not this one's to undo. While locked, a control
 * mounted later is locked as it appears.
 */
function lockWriteControls(why: string | null): void {
  lateControls?.disconnect();
  lateControls = null;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(`[${WRITE_CONTROL_ATTR}]`)) {
    if (why !== null) {
      if (!btn.hasAttribute(SAID)) {
        btn.setAttribute(SAID, btn.title);
        if (btn.disabled) btn.setAttribute(WAS_OFF, '');
      }
      btn.disabled = true;
      btn.title = why;
    } else if (btn.hasAttribute(SAID)) {
      btn.title = btn.getAttribute(SAID) ?? '';
      btn.disabled = btn.hasAttribute(WAS_OFF);
      btn.removeAttribute(SAID);
      btn.removeAttribute(WAS_OFF);
    }
  }
  if (why === null || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver(() => {
    const unlocked = document.querySelector(`[${WRITE_CONTROL_ATTR}]:not([${SAID}])`);
    if (unlocked && lateControls === observer) lockWriteControls(why);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  lateControls = observer;
}
