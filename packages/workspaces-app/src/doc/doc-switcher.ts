/**
 * Wire the topbar doc-switcher dropdown ONCE (shell-level, doc-independent).
 * The dropdown's CONTENTS are repopulated per navigation by the sidebar
 * renderers; only the open/close behaviour lives here.
 */
export function wireDocSwitcher(document: Document, window: EventTarget): void {
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;
  if (!docSwitcher || !docMenu) return;
  const close = () => {
    docMenu.classList.add('hidden');
    docMenu.setAttribute('aria-hidden', 'true');
    docSwitcher.setAttribute('aria-expanded', 'false');
  };
  docSwitcher.addEventListener('click', (ev) => {
    if (!document.body.classList.contains('has-set')) return;
    ev.stopPropagation();
    const isOpen = !docMenu.classList.contains('hidden');
    docMenu.classList.toggle('hidden', isOpen);
    docMenu.setAttribute('aria-hidden', String(isOpen));
    docSwitcher.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (ev) => {
    if (docMenu.classList.contains('hidden')) return;
    if (!docMenu.contains(ev.target as Node) && !docSwitcher.contains(ev.target as Node)) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !docMenu.classList.contains('hidden')) close();
  });
  // Auto-close on scroll. The dropdown overlays the doc, and on mobile the
  // user reaching the content is the strongest "I'm done with the nav" signal.
  const closeOnScroll = () => {
    if (!docMenu.classList.contains('hidden')) close();
  };
  document.getElementById('editor')?.addEventListener('scroll', closeOnScroll, { passive: true });
  window.addEventListener('scroll', closeOnScroll, { passive: true });
}
