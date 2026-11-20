/**
 * The one script every page loads: the Web Awesome components the pages
 * use, then whatever the page's `data-page` asks for.
 */
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { connectPresence } from './presence.ts';
import { connectDoc } from './sync.ts';
import { bindTextarea } from './text-binding.ts';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  synced: 'Live',
  offline: 'Offline, retrying…',
  closed: 'Closed. Reload to open it again.',
};

function openDocForm(): void {
  const form = document.getElementById('open-doc') as HTMLFormElement | null;
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = String(new FormData(form).get('doc') ?? '').trim();
    if (name) location.assign(`/docs/${encodeURIComponent(name)}`);
  });
}

/** Everyone else on the doc, as avatars beside the status line. */
function showPresence(base: string): void {
  const strip = document.getElementById('here') as HTMLElement;
  connectPresence(`${base}/presence`).onChange((here) => {
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
}

function openDoc(docId: string, role: string): void {
  const box = document.getElementById('body') as HTMLTextAreaElement;
  const status = document.getElementById('status') as HTMLElement;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${scheme}://${location.host}/docs/${encodeURIComponent(docId)}`;
  showPresence(base);
  // A reader's edits would be dropped by the server; say so by not taking any.
  box.readOnly = role !== 'owner' && role !== 'edit';
  const sync = connectDoc(`${base}/ws`);
  sync.onStatus((s) => {
    status.textContent = STATUS_TEXT[s];
  });
  void sync.synced.then(() => {
    bindTextarea(box, sync.doc.getText('body'));
    box.disabled = false;
  });
}

const { page, doc, role } = document.body.dataset;
if (page === 'home') openDocForm();
if (page === 'doc' && doc) openDoc(doc, role ?? 'view');
