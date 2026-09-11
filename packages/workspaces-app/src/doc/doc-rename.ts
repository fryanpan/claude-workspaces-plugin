/**
 * Rename the doc from its own title in the topbar.
 *
 * A meeting's title is the clock it started at, and until now nothing on any
 * screen could change it — so a project's meetings list was a column of
 * timestamps a week later. The affordance is the title itself: click it, type,
 * press Enter. No button, no menu, no pencil beside it, because the thing a
 * person wants to change is the word they are already looking at (Bryan's
 * rule: affordances over explanatory text, essential first).
 *
 * What it does NOT do is edit the file. The title is the doc's name; a bound
 * doc keeps the path it is bound to, and every comment stays where it is.
 *
 * The crumb shows a SHORTENED label — a mobile basename, or a meeting's clock
 * with the kind word dropped — so editing starts from the FULL title rather
 * than from what is on screen. Committing what the crumb showed would rename
 * a doc to its own abbreviation, which is a rename nobody asked for and one
 * that cannot be told from a deliberate one afterwards.
 */

import { api } from '../doc-path.ts';

export interface DocRenameDeps {
  /** The `#doc-title` element, already rendering the label. */
  titleEl: HTMLElement;
  docId: string;
  /** Can this reader write? A share visitor gets no editor at all. */
  canWrite: boolean;
  /** The doc's full current title — read fresh at every click. */
  currentTitle: () => string;
  /** Called after the server accepts, so the crumb and the tab re-render. */
  onRenamed: (title: string) => void;
  /** Injected for the test; `fetch` in the browser. */
  send?: (url: string, title: string) => Promise<boolean>;
  /** Register a listener, so a per-document scope can take it away. */
  listen?: (target: EventTarget, type: string, handler: EventListener) => void;
}

/** The server's own ceiling, restated so the field can stop typing there. */
export const DOC_TITLE_MAX = 200;

async function putTitle(url: string, title: string): Promise<boolean> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return res.ok;
}

/**
 * Make the title editable in place. Returns a function that opens the editor,
 * so a caller with its own affordance (a Library row, later) can reuse it.
 */
export function wireDocRename(deps: DocRenameDeps): () => void {
  const { titleEl, docId, canWrite } = deps;
  const send = deps.send ?? putTitle;
  const listen = deps.listen ?? ((target, type, handler) => target.addEventListener(type, handler));
  let editing = false;

  const open = (): void => {
    if (!canWrite || editing) return;
    editing = true;
    const before = deps.currentTitle();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'doc-title-input';
    input.value = before;
    input.maxLength = DOC_TITLE_MAX;
    input.setAttribute('aria-label', 'Document title');
    const shown = titleEl.textContent ?? '';
    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    /** Put the crumb back exactly as it was, whatever ended the edit. */
    const restore = (label: string): void => {
      editing = false;
      input.remove();
      titleEl.textContent = label;
    };

    let closing = false;
    const commit = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      const next = input.value.trim().replace(/\s+/g, ' ');
      // Nothing typed, or nothing changed: the crumb goes back and no request
      // is made. A blank field is a cancel, not an instruction to clear the
      // name — the server refuses an empty title for the same reason.
      if (next === '' || next === before) {
        restore(shown);
        return;
      }
      restore(next);
      const ok = await send(api(`docs/${encodeURIComponent(docId)}/title`), next);
      // A refused rename puts the old label back rather than leaving the
      // screen claiming a name the server does not hold.
      if (!ok) titleEl.textContent = shown;
      else deps.onRenamed(next);
    };

    listen(input, 'keydown', ((ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closing = true;
        restore(shown);
      }
    }) as EventListener);
    // Clicking away commits, the way every inline field on this board does:
    // an edit abandoned by looking elsewhere is far more often finished than
    // regretted, and Escape is the undo for the other case.
    listen(input, 'blur', (() => void commit()) as EventListener);
  };

  if (canWrite) {
    titleEl.classList.add('doc-title-editable');
    titleEl.setAttribute('role', 'button');
    titleEl.tabIndex = 0;
    listen(titleEl, 'click', ((ev: MouseEvent) => {
      if (ev.target instanceof HTMLInputElement) return;
      open();
    }) as EventListener);
    listen(titleEl, 'keydown', ((ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    }) as EventListener);
  }
  return open;
}
