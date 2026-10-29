/**
 * "Archive this doc", from the doc's own More menu, and the way back.
 *
 * Archiving is soft (`archive_doc`): the doc leaves the board and keeps its
 * comments, and "Put it back" — on the toast, and on the bar the page shows
 * while it is archived — restores it. Archiving is a counted action, so a
 * sign-in older than ten minutes is asked to sign in again first
 * (`fresh-signin-client.ts`); putting it back never asks.
 *
 * Live: the server closes every editing socket on the doc with the reason
 * "doc archived", so a page open anywhere shows the bar within a frame of
 * the archive, whoever made it. The socket keeps reconnecting and is
 * refused while the doc is away; the first one that opens again means it was
 * put back, and the bar goes.
 */
import { type FeedbackClient, readDocMeta } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { api } from '../doc-path.ts';
import { type CountedRequest, resumeHeld, sendCounted } from '../fresh-signin-client.ts';
import type { MountScope } from '../mount-scope.ts';

/** The close reason `doc-store-workspaces.ts` tears an archived doc down with. */
export const ARCHIVED_CLOSE_REASON = 'doc archived';

export interface DocArchiveDeps {
  docId: string;
  client: Pick<FeedbackClient, 'ws' | 'onStatus'>;
  ydoc: Y.Doc;
  scope: Pick<MountScope, 'listen' | 'onCleanup'>;
  /** A reader who cannot write gets no Archive control. */
  canWrite: boolean;
  toast: (message: string, action?: { label: string; onAction: () => void }) => void;
  doc?: Document;
}

export function mountDocArchive(deps: DocArchiveDeps): void {
  const doc = deps.doc ?? document;
  const more = doc.getElementById('doc-more');
  const menu = doc.getElementById('more-menu');
  const item = doc.getElementById('menu-archive') as HTMLButtonElement | null;
  const bar = doc.getElementById('archived-bar');
  const undo = doc.getElementById('archived-undo');
  if (!more || !menu || !item || !bar || !undo) return;
  // The board in the page's own path, which is the board the routes check.
  const base = api(`docs/${encodeURIComponent(deps.docId)}`);
  const title = (): string => {
    const m = readDocMeta(deps.ydoc);
    return m.title || (m.relPath ?? m.sourceUrl)?.split('/').pop() || deps.docId;
  };
  // A member of a review is archived with its review, never alone.
  more.hidden = !deps.canWrite || Boolean(readDocMeta(deps.ydoc).setId);

  let archived = false;
  const render = (): void => {
    doc.body.classList.toggle('is-archived', archived);
    bar.hidden = !archived;
    item.disabled = archived;
    item.textContent = archived ? 'Archived' : 'Archive this doc';
  };
  const setMenu = (open: boolean): void => {
    if (open) {
      const r = more.getBoundingClientRect();
      menu.style.setProperty('--more-right', `${Math.max(8, window.innerWidth - r.right)}px`);
    }
    menu.classList.toggle('hidden', !open);
    menu.setAttribute('aria-hidden', String(!open));
    more.setAttribute('aria-expanded', String(open));
  };

  const unarchive = async (): Promise<void> => {
    // The canonical id, never the address's: the unarchive route resolves no
    // alias, because an archived doc has nothing for one to resolve against.
    const id = readDocMeta(deps.ydoc).docId || deps.docId;
    const res = await fetch(`${api(`docs/${encodeURIComponent(id)}`)}/unarchive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return deps.toast('Could not put it back');
    archived = false;
    render();
    deps.toast('Put back on the board');
  };
  const putItBack = { label: 'Put it back', onAction: () => void unarchive() };
  const answered = async (res: Response | null, name: string): Promise<void> => {
    if (res === null) return;
    if (!res.ok) return deps.toast('Could not archive this doc');
    archived = true;
    render();
    deps.toast(`Archived ${name}`, putItBack);
  };
  const request = (): CountedRequest => ({
    method: 'POST',
    url: `${base}/archive`,
    body: {},
    verb: 'Archive',
    gerund: 'Archiving',
    noun: 'archive',
    name: title(),
  });
  const freshDeps = { toast: (m: string) => deps.toast(m), doc };

  deps.scope.listen(more, 'click', (e) => {
    e.stopPropagation();
    setMenu(menu.classList.contains('hidden'));
  });
  deps.scope.listen(doc, 'click', (e) => {
    if (!menu.contains(e.target as Node)) setMenu(false);
  });
  deps.scope.listen(item, 'click', () => {
    setMenu(false);
    const req = request();
    void sendCounted(req, freshDeps).then((res) => answered(res, req.name));
  });
  deps.scope.listen(undo, 'click', () => void unarchive());

  // Live: whoever archives it, this page's socket is closed with the reason.
  const watch = (ws: WebSocket | undefined): void => {
    // A socket that cannot be listened to costs only the live bar; a throw
    // here would stop the rest of the doc's mount.
    if (typeof ws?.addEventListener !== 'function') return;
    ws.addEventListener('close', (e) => {
      if (e.reason !== ARCHIVED_CLOSE_REASON || archived) return;
      archived = true;
      render();
    });
  };
  watch(deps.client.ws);
  deps.client.onStatus((s) => {
    if (s !== 'open') return;
    watch(deps.client.ws);
    if (archived) {
      archived = false;
      render();
    }
  });
  deps.scope.onCleanup(() => {
    archived = false;
    render();
    setMenu(false);
  });
  render();

  // Back from "Sign in again": offer the archive this page held.
  void resumeHeld(freshDeps).then((held) => {
    if (held) void answered(held.response, held.request.name);
  });
}
