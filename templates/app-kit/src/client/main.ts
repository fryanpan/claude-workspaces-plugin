/**
 * The one script every page loads: the Web Awesome components the pages
 * use, then whatever the page's `data-page` asks for.
 */
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { connectDoc } from './sync.ts';
import { bindTextarea } from './text-binding.ts';

const STATUS_TEXT = { connecting: 'Connecting…', synced: 'Live', offline: 'Offline, retrying…' };

function openDocForm(): void {
  const form = document.getElementById('open-doc') as HTMLFormElement | null;
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = String(new FormData(form).get('doc') ?? '').trim();
    if (name) location.assign(`/docs/${encodeURIComponent(name)}`);
  });
}

function openDoc(docId: string): void {
  const box = document.getElementById('body') as HTMLTextAreaElement;
  const status = document.getElementById('status') as HTMLElement;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const sync = connectDoc(`${scheme}://${location.host}/docs/${encodeURIComponent(docId)}/ws`);
  sync.onStatus((s) => {
    status.textContent = STATUS_TEXT[s];
  });
  void sync.synced.then(() => {
    bindTextarea(box, sync.doc.getText('body'));
    box.disabled = false;
  });
}

const { page, doc } = document.body.dataset;
if (page === 'home') openDocForm();
if (page === 'doc' && doc) openDoc(doc);
