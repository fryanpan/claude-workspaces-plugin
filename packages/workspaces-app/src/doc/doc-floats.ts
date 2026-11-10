/**
 * The always-in-view float a plan document carries — Approve (the plan gate)
 * — and the linked-item dock under the page, which reads the same record.
 *
 * Both mount only on an ordinary markdown doc, never a diff member's
 * companion view. Meeting-notes and plan docs used to carry two more floats,
 * Make Plan and Review; Bryan removed them on 2026-11-09 ("They're really
 * confusing"). A person asks for a plan or a review in a comment, like any
 * other doc.
 */
import type { User } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { docJsonUrl } from '../doc-path.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountPlanGate } from '../plan-gate.ts';
import { createDocRecordReader, takeDocRecord } from './doc-record.ts';
import { type LinkedDockOptions, mountLinkedDock } from './linked-dock.ts';

export interface DocFloatsOptions {
  docId: string;
  /** The `#editor` element the floats dock inside. */
  root: HTMLElement;
  ydoc: Y.Doc;
  user: User;
  canWrite: boolean;
  scope: MountScope;
  /** Runs its callback once the doc's first sync has landed — at once if it
   *  already has. A stamp that moved before the floats were watching the map
   *  is caught here. Absent in tests that drive the map by hand. */
  whenSynced?: (cb: () => void) => void;
  /** Injected so a test counts the doc-record reads without a server. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** The linked-item dock's answer request, injected by a test. */
  postAnswer?: LinkedDockOptions['post'];
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

export function mountDocFloats(opts: DocFloatsOptions): void {
  const { docId, root, ydoc, user, canWrite, scope } = opts;

  // One read of the doc record for the float and the dock, seeded by the router's
  // (doc/doc-record.ts). Five identical reads per open is what this replaced.
  const url = docJsonUrl(docId);
  const record = createDocRecordReader(url, opts.fetchJson ?? defaultFetchJson, takeDocRecord(url));

  // `setPlanState` writes planState into this map on the server, so observing
  // it is how the float hears that the plan landed — no event stream carries
  // that transition. It wakes the float only when a stamp it renders moved:
  // the initial sync and every `contentRevision` bump fire the map too, and
  // each used to cost a read.
  const meta = ydoc.getMap('meta');
  const metaListeners = new Set<() => void>();
  const onMeta = () => {
    if (!record.noteStamps((key) => meta.get(key))) return;
    for (const fn of [...metaListeners]) fn();
  };
  meta.observe(onMeta);
  scope.onCleanup(() => meta.unobserve(onMeta));
  opts.whenSynced?.(() => {
    if (!scope.disposed) onMeta();
  });
  const watchDocMeta = (onChange: () => void) => {
    metaListeners.add(onChange);
    return () => metaListeners.delete(onChange);
  };

  const planGate = mountPlanGate({
    docId,
    root,
    user,
    canWrite,
    record,
    watchDocMeta,
  });
  scope.onCleanup(() => planGate.destroy());

  // A ticket's ask that links this doc, in a bar under the page. Off the same
  // record read, so it costs the open no request of its own.
  mountLinkedDock({
    record,
    user,
    canWrite,
    scope,
    ...(opts.postAnswer ? { post: opts.postAnswer } : {}),
  });
}
