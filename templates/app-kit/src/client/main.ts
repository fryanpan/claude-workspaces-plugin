/**
 * The one script every page loads: the Web Awesome components the pages
 * use, then whatever the page's `data-page` asks for.
 */
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { CollabRole } from '@claude-workspaces/app-kit/collab';
import { ROLE_TEXT, mayType } from '../role-text.ts';
import { type PresenceHandle, connectPresence } from './presence.ts';
import { type DocSync, connectDoc } from './sync.ts';
import { bindTextarea } from './text-binding.ts';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  synced: 'Live',
  offline: 'Offline, retrying…',
  closed: 'Closed. Reload to open it again.',
};

/** What the label says once the reader's role is gone. */
const NO_ROLE_TEXT = 'You no longer have access';

function openDocForm(): void {
  const form = document.getElementById('open-doc') as HTMLFormElement | null;
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = String(new FormData(form).get('doc') ?? '').trim();
    if (name) location.assign(`/docs/${encodeURIComponent(name)}`);
  });
}

/** Everyone else on the doc, as avatars beside the status line. Returns the
 *  presence handle, which also carries the reader's own role. */
function showPresence(base: string): PresenceHandle {
  const strip = document.getElementById('here') as HTMLElement;
  const presence = connectPresence(`${base}/presence`);
  presence.onChange((here) => {
    strip.replaceChildren(
      ...here.map((p) => {
        const avatar = document.createElement('wa-avatar');
        avatar.setAttribute('initials', p.name.slice(0, 1).toUpperCase());
        avatar.setAttribute('label', p.name);
        avatar.title = p.name;
        return avatar;
      }),
    );
  });
  return presence;
}

function openDoc(docId: string, firstRole: string): void {
  const box = document.getElementById('body') as HTMLTextAreaElement;
  const status = document.getElementById('status') as HTMLElement;
  const label = document.getElementById('role') as HTMLElement;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${scheme}://${location.host}/docs/${encodeURIComponent(docId)}`;
  let role: string | null = firstRole;
  let sync: DocSync | null = null;
  let unbind: (() => void) | null = null;

  /**
   * Open the doc socket on a fresh Y.Doc and bind the textarea to it. Called
   * again when the role narrows: the server dropped whatever this page typed
   * after the change, and a Y.Doc cannot forget it, so it would ride the next
   * sync up and land once the role was raised. A fresh doc holds only what the
   * server kept.
   */
  const open = (): void => {
    unbind?.();
    unbind = null;
    const old = sync;
    sync = null;
    old?.close();
    box.disabled = true;
    const mine = connectDoc(`${base}/ws`);
    sync = mine;
    mine.onStatus((s) => {
      if (sync === mine) status.textContent = STATUS_TEXT[s];
    });
    void mine.synced.then(() => {
      if (sync !== mine) return;
      unbind = bindTextarea(box, mine.doc.getText('body'));
      box.disabled = false;
    });
  };

  /** Close the doc socket and let go of the textarea, keeping its text. */
  const shut = (): void => {
    unbind?.();
    unbind = null;
    const old = sync;
    sync = null;
    old?.close();
    status.textContent = STATUS_TEXT.closed;
  };

  // A reader's edits would be dropped by the server; say so by not taking any.
  // Null is a role that is gone: nothing more is read or sent.
  const apply = (next: string | null): void => {
    const was = role;
    role = next;
    box.readOnly = next === null || !mayType(next);
    if (next === null) {
      label.textContent = NO_ROLE_TEXT;
      shut();
      return;
    }
    label.textContent = ROLE_TEXT[next as CollabRole] ?? ROLE_TEXT.view;
    if (was === null || (mayType(was) && !mayType(next))) open();
  };

  const presence = showPresence(base);
  presence.onRole((next) => {
    if (next !== role) apply(next);
  });
  label.textContent = ROLE_TEXT[firstRole as CollabRole] ?? ROLE_TEXT.view;
  box.readOnly = !mayType(firstRole);
  open();
}

const { page, doc, role } = document.body.dataset;
if (page === 'home') openDocForm();
if (page === 'doc' && doc) openDoc(doc, role ?? 'view');
