/**
 * Rename the doc from its own title in the topbar.
 *
 * A meeting's title is the clock it started at, and until now nothing on any
 * screen could change it — so a project's meetings list was a column of
 * timestamps a week later. The affordance is the title itself: click it, type,
 * press Enter. No button, no menu, no pencil beside it, because the thing a
 * person wants to change is the word they are already looking at.
 *
 * **This file is an adapter, not an editor.** The editing itself is
 * `wireWordsInPlace` — the same mechanism the board's task rows and goal
 * headings use, and the reason is Bryan's: one editing gesture across the
 * app. It was written as a second, hand-rolled editor first, and that copy
 * had every fault the shared one had already fixed: it swapped an `<input>`
 * in, so the text shifted as it opened, and the input sized itself rather
 * than taking the slot the words were already in. Making the element that
 * holds the words editable is what makes zero layout shift a property of the
 * DOM rather than a number two CSS rules have to keep agreeing on.
 *
 * What is left here is the three things the board does not need:
 *
 * - **The crumb is an abbreviation.** It drops "Meeting notes" ahead of the
 *   clock, and on a phone it is a basename. Editing has to start from the
 *   FULL title, or committing what the crumb showed renames the doc to its
 *   own abbreviation — a rename nobody asked for and one nothing afterwards
 *   can tell from a deliberate one.
 * - **The commit is a request, not a local write.** A refused rename puts
 *   the crumb back rather than leaving the screen claiming a name the server
 *   does not hold.
 * - **The element outlives the document.** `#doc-title` is one node in
 *   `index.html` and every doc mount re-wires it, so the listeners go
 *   through the caller's per-document scope.
 *
 * What it does NOT do is edit the file. The title is the doc's name; a bound
 * doc keeps the path it is bound to, and every comment stays where it is.
 */

import { caretOffsetIn, wireWordsInPlace } from '../board/inline-rename.ts';
import { api } from '../doc-path.ts';

export interface DocRenameDeps {
  /** The `#doc-title` element, already rendering the label. */
  titleEl: HTMLElement;
  docId: string;
  /** Can this reader write? A share visitor gets no editor at all. */
  canWrite: boolean;
  /** The doc's full current title — read fresh at every click. */
  currentTitle: () => string;
  /**
   * Repaint the crumb from what the doc currently says.
   *
   * Called when an edit ends without a rename, and when the server refuses
   * one: both leave the full title sitting in an element whose job is to show
   * an abbreviation of it.
   */
  redrawLabel: () => void;
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
 * Which way this label reads.
 *
 * `.doc-path` is `direction: rtl` so a long path truncates at its START and
 * keeps the file name on screen — the right call for a path, and wrong for
 * everything else: a bidi engine reorders the neutral runs in
 * "Meeting notes 2026-09-11 19:23" and puts the clock first, so the topbar
 * showed a meeting's name backwards and typing into it ran the wrong way.
 * A slash is what tells the two apart.
 */
export function labelDirection(label: string): 'ltr' | 'rtl' {
  return label.includes('/') ? 'rtl' : 'ltr';
}

/**
 * Make the title editable in place. Returns a function that opens the editor,
 * so a caller with its own affordance (a Library row, later) can reuse it.
 */
export function wireDocRename(deps: DocRenameDeps): () => void {
  const { titleEl, docId, canWrite } = deps;
  const send = deps.send ?? putTitle;
  const listen = deps.listen ?? ((target, type, handler) => target.addEventListener(type, handler));
  /**
   * Did this edit end by committing?
   *
   * `wireWordsInPlace` ends an edit by putting the text back, telling us it
   * is over, and only THEN calling commit — so the answer is not known yet
   * when we are told, and is known by the next microtask. A cancelled edit
   * leaves the full title in an element that shows an abbreviation, which is
   * the case this exists to repaint.
   */
  let committed = false;

  const save = async (next: string): Promise<void> => {
    const ok = await send(api(`docs/${encodeURIComponent(docId)}/title`), next);
    if (ok) deps.onRenamed(next);
    else deps.redrawLabel();
  };

  /**
   * Assigned below, and READ only from listeners — which is why the openers
   * can be registered before it exists, and why they must be.
   *
   * The board's rows get away with one element listening for the key that
   * opens an edit and another handling the keys inside it. Here they are the
   * same node, so both handlers see the same Enter, and `stopPropagation`
   * does nothing between two listeners on one element. The editor's handler
   * runs first and removes `contenteditable`; if the opener were registered
   * first-to-last after it, the very key that ended the edit would find
   * `isEditing()` false and start a new one — Enter would never exit.
   * Registering the opener FIRST makes it ask while the answer is still yes.
   * So the editor is built after them, and these two hold what they need of
   * it — read from listeners, which cannot run before the wiring below.
   */
  let editing = false;
  let begin: (caret?: number) => void = () => {};

  const open = (caret?: number): void => {
    if (!canWrite || editing) return;
    // Seed the editor with the whole title, and let the text decide which way
    // it reads now that it is no longer the crumb.
    const shown = titleEl.textContent ?? '';
    const full = deps.currentTitle();
    titleEl.textContent = full;
    titleEl.dir = labelDirection(full);
    // The click landed on a character of the ABBREVIATION. When that is a
    // tail of the full title — which is what dropping "Meeting notes" leaves
    // — the same character is that many places further along.
    const at =
      typeof caret === 'number' && shown !== full && full.endsWith(shown)
        ? caret + (full.length - shown.length)
        : caret;
    begin(at);
  };

  if (canWrite) {
    titleEl.classList.add('doc-title-editable');
    titleEl.tabIndex = 0;
    listen(titleEl, 'click', ((ev: MouseEvent) => {
      if (editing) return;
      open(caretOffsetIn(titleEl, ev.clientX, ev.clientY));
    }) as EventListener);
    listen(titleEl, 'keydown', ((ev: KeyboardEvent) => {
      if (ev.target !== titleEl || editing) return;
      if (ev.key !== 'Enter' && ev.key !== 'F2') return;
      ev.preventDefault();
      // Immediate, because the editor's own handler is on THIS element too.
      // Enter opens the edit here; without this the editor would then see the
      // same Enter, find the text unchanged, and close what just opened.
      ev.stopImmediatePropagation();
      open();
    }) as EventListener);
  }

  const words = wireWordsInPlace(
    titleEl,
    () => deps.currentTitle(),
    (next) => {
      committed = true;
      void save(next);
    },
    (isEditing) => {
      editing = isEditing;
      // The phone gives the crumb 112px of a 430px topbar, so a field inside
      // it is seven characters wide. This is what lets the stylesheet hand
      // the row over for the length of the edit.
      titleEl.ownerDocument.body.classList.toggle('doc-renaming', isEditing);
      if (isEditing) {
        committed = false;
        return;
      }
      queueMicrotask(() => {
        if (!committed) deps.redrawLabel();
      });
    },
    listen,
  );
  begin = words.begin;

  return () => open();
}
