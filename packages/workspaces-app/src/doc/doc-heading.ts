/**
 * A meeting's title, as the heading of its own page.
 *
 * A meeting used to be named only in the 13px top-bar crumb, and named after
 * the clock it started at. The title is now the first and largest thing in
 * the scroller, with when the doc was created and last changed under it in
 * muted type, and the crumb stays empty while this heading is on screen — the
 * page names the meeting once, and the bar takes the name over only once the
 * heading has scrolled away.
 *
 * **The heading is the rename affordance.** Tap it, type, press Enter — the
 * same `wireDocRename` the crumb uses, so a meeting has one editing gesture
 * wherever its name is shown.
 *
 * **"Meeting" is shown as a placeholder, not a name.** While the title is
 * still the default (`titleSource: 'default'`) it is muted; when the notes
 * name the meeting (`auto`) it darkens and settles in once. A doc from before
 * `titleSource` existed shows its stored title as an ordinary name.
 *
 * **The dates are the server's, not the file's.** Created is the doc record's
 * `createdAt`, which rides the synced meta. Modified is the doc read's
 * `lastActivityAt` at mount — the `.ydoc` mtime, which is deliberately not a
 * CRDT field — and moves forward on every change this page sees after that.
 */

import { type HuddleKind, defaultMeetingTitle, readDocMeta } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { wireDocRename } from './doc-rename.ts';

/** Is this doc a meeting — a huddle, or a calendar meeting's doc? The
 *  server's own test in `meeting-titler.ts`. */
export function isMeetingMeta(meta: { huddle?: boolean; alias?: string }): boolean {
  return meta.huddle === true || (meta.alias?.startsWith('meeting-') ?? false);
}

/** The body class that says the heading is on screen — the crumb reads it. */
export const HEADING_IN_VIEW_CLASS = 'doc-heading-in-view';

export interface DocHeadingDeps {
  /** `#editor`: the scroller, and the heading's parent. */
  editorMount: HTMLElement;
  ydoc: Y.Doc;
  docId: string;
  canWrite: boolean;
  /** The doc read's `lastActivityAt`, when it carried one. */
  lastActivityAt?: number;
  /** The kind the address resolved, for the placeholder before sync. */
  huddleKind?: HuddleKind;
  listen: (target: EventTarget, type: string, handler: EventListener) => void;
  onCleanup: (fn: () => void) => void;
  /** Injected for the test. */
  now?: () => number;
  send?: (url: string, title: string) => Promise<boolean>;
  observeInView?: (el: HTMLElement, root: HTMLElement, cb: (inView: boolean) => void) => () => void;
}

export interface DocHeadingHandle {
  el: HTMLElement;
  /** The doc has synced: paint it, and count later updates as edits. */
  onSynced(): void;
}

const dayFmt = (withYear: boolean) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * "Sat, Sep 12 · 12:41 PM", and "· Modified 3:05 PM" after it once the doc
 * has changed in a later minute. A modified day other than the created one
 * names its day; a year other than now's is written out.
 */
export function formatHeadingWhen(
  createdAt: number,
  modifiedAt: number | undefined,
  now: number,
): string {
  const created = new Date(createdAt);
  const thisYear = new Date(now).getFullYear();
  const day = (d: Date) => dayFmt(d.getFullYear() !== thisYear).format(d);
  const out = `${day(created)} · ${timeFmt.format(created)}`;
  if (modifiedAt === undefined || Math.floor(modifiedAt / 60_000) <= Math.floor(createdAt / 60_000))
    return out;
  const modified = new Date(modifiedAt);
  const when = sameDay(created, modified)
    ? timeFmt.format(modified)
    : `${day(modified)} · ${timeFmt.format(modified)}`;
  return `${out} · Modified ${when}`;
}

function defaultObserveInView(
  el: HTMLElement,
  root: HTMLElement,
  cb: (inView: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true);
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last) cb(last.isIntersecting);
    },
    { root },
  );
  io.observe(el);
  return () => io.disconnect();
}

export function mountDocHeading(deps: DocHeadingDeps): DocHeadingHandle {
  const { editorMount, ydoc } = deps;
  const now = deps.now ?? Date.now;
  const doc = editorMount.ownerDocument;

  const header = doc.createElement('header');
  header.className = 'doc-heading';
  const title = doc.createElement('h1');
  title.className = 'doc-heading-title';
  title.dir = 'auto';
  const when = doc.createElement('p');
  when.className = 'doc-heading-when';
  header.append(title, when);
  editorMount.prepend(header);

  let modifiedAt = deps.lastActivityAt;
  /** Was the title the placeholder at the last paint? A placeholder that
   *  becomes a name settles in once; a name that changes does not. */
  let wasPending: boolean | null = null;

  const currentTitle = (): string => {
    const m = readDocMeta(ydoc);
    return m.title || defaultMeetingTitle(m.huddleKind ?? deps.huddleKind);
  };

  const render = (): void => {
    const m = readDocMeta(ydoc);
    const synced = m.docId !== '';
    if (!title.hasAttribute('contenteditable')) {
      const next = synced ? currentTitle() : '';
      if (title.textContent !== next) title.textContent = next;
    }
    const pending = m.titleSource === 'default';
    title.classList.toggle('is-pending', pending);
    if (wasPending === true && !pending && m.titleSource === 'auto') {
      title.classList.remove('is-arriving');
      void title.offsetWidth;
      title.classList.add('is-arriving');
    }
    if (synced) wasPending = pending;
    when.textContent = synced ? formatHeadingWhen(m.createdAt, modifiedAt, now()) : '';
  };

  const meta = ydoc.getMap('meta');
  const onMeta = () => render();
  meta.observe(onMeta);
  deps.onCleanup(() => meta.unobserve(onMeta));

  // Modified moves with every change this page sees, painted once a minute
  // at most — the line shows minutes.
  const onUpdate = () => {
    const t = now();
    const shownMinute = modifiedAt === undefined ? -1 : Math.floor(modifiedAt / 60_000);
    modifiedAt = Math.max(modifiedAt ?? 0, t);
    if (Math.floor(t / 60_000) !== shownMinute) render();
  };
  deps.onCleanup(() => ydoc.off('update', onUpdate));

  const body = doc.body;
  const stopObserving = (deps.observeInView ?? defaultObserveInView)(
    header,
    editorMount,
    (inView) => body.classList.toggle(HEADING_IN_VIEW_CLASS, inView),
  );
  deps.onCleanup(() => {
    stopObserving();
    body.classList.remove(HEADING_IN_VIEW_CLASS);
    header.remove();
  });

  wireDocRename({
    titleEl: title,
    docId: deps.docId,
    canWrite: deps.canWrite,
    currentTitle,
    redrawLabel: render,
    // The words typed stay on screen: the synced meta still holds the old
    // title until the server's write comes back, and the observer above
    // repaints from it then.
    onRenamed: () => title.classList.remove('is-pending'),
    listen: deps.listen,
    ...(deps.send ? { send: deps.send } : {}),
  });

  render();
  let armed = false;
  return {
    el: header,
    onSynced: () => {
      // The first sync is the doc arriving, not the doc changing: from here
      // on, an update is an edit.
      if (!armed) {
        armed = true;
        ydoc.on('update', onUpdate);
      }
      render();
    },
  };
}

/**
 * The heading on a meeting doc, and nowhere else.
 *
 * A huddle is known from the address before the doc arrives, so its heading
 * mounts at once and the notes never jump down under it. A calendar meeting's
 * doc is only recognisable by its alias, which rides the synced meta, so its
 * heading mounts on the first sync.
 */
export function mountMeetingHeading(
  deps: Omit<DocHeadingDeps, 'onCleanup' | 'listen'> & {
    huddle: boolean;
    whenSynced: (cb: () => void) => void;
    scope: {
      listen: (target: EventTarget, type: string, handler: EventListener) => void;
      onCleanup: (fn: () => void) => void;
    };
  },
): void {
  const { huddle, whenSynced, scope, ...rest } = deps;
  const mount = () =>
    mountDocHeading({
      ...rest,
      listen: (target, type, handler) => scope.listen(target, type, handler),
      onCleanup: (fn) => scope.onCleanup(fn),
    });
  let heading = huddle ? mount() : undefined;
  whenSynced(() => {
    if (!heading && isMeetingMeta(readDocMeta(deps.ydoc))) heading = mount();
    heading?.onSynced();
  });
}
