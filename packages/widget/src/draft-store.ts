/**
 * Where the reader's unsent words wait while the page reloads under them.
 *
 * A comment half-typed and words half-edited are the reader's, and the page
 * they sit on is often the agent's to reload: a dev server's live reload, a
 * reader's refresh after a round, the agent restarting its server. So both are
 * written to `sessionStorage` as they change and read back when the page comes
 * up again — the comment by the widget (`widget-picker.ts`), the edits by edit
 * mode (`edit/edit-mode.ts`). Sent or cancelled, the entry goes.
 *
 * Keyed by doc and by page (its whole address, fragment too), so one
 * page's draft never opens on another. Session, not local: a draft belongs
 * to the tab it was typed in, and a tab closed on purpose takes its drafts
 * with it.
 *
 * Inside a served mock's sandboxed frame there is no `sessionStorage` of the
 * browser's; the bridge's stand-in sends every key under `DRAFT_PREFIX` to the
 * page holding the frame, which keeps it for this doc (`mock-host.ts`), and on
 * load asks for them back. That answer arrives after the page has started, so
 * the bridge announces it with `DRAFTS_ARRIVED` and a reader of drafts listens
 * for it as well as reading at load.
 */

/** Every draft key starts with this; the bridge forwards only these. */
export const DRAFT_PREFIX = 'cfw:draft:';

/** Fired on the window when a frame's drafts arrive from the host. */
export const DRAFTS_ARRIVED = 'cw-drafts';

export function draftKey(kind: 'comment' | 'edits', docId: string): string {
  return `${DRAFT_PREFIX}${kind}:${docId}:${location.href}`;
}

export function readDraft<T>(key: string): T | null {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

/** `null` forgets it. False when storage threw or is full and kept nothing:
 *  the draft is still on screen, but will not survive a reload. */
export function writeDraft(key: string, value: unknown): boolean {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
