/**
 * The two always-in-view floats a plan document carries: Approve (the plan
 * gate) and Review.
 *
 * One module because they are one row and one condition. Both mount only on
 * an ordinary markdown doc — never a diff member's companion view — both hang
 * off the same `meta` map for the transition no event stream carries, and the
 * order they mount in IS the order they read in: plan, then review. Splitting
 * them would leave that ordering as an accident of two call sites.
 */
import type { User } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { docJsonUrl } from '../doc-path.ts';
import type { LeadBanner } from '../lead-banner.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountPlanGate } from '../plan-gate.ts';
import { mountReviewFloat } from '../review-float.ts';
import { createDocRecordReader, takeDocRecord } from './doc-record.ts';

export interface DocFloatsOptions {
  docId: string;
  /** The `#editor` element the floats dock inside. */
  root: HTMLElement;
  ydoc: Y.Doc;
  user: User;
  canWrite: boolean;
  scope: MountScope;
  /** The lead-presence stream, on a huddle doc — so both receipts can say
   *  "no lead attached" off the same answer. Absent everywhere else. */
  watchLeadPresence?: LeadBanner['watch'];
  /** Runs its callback once the doc's first sync has landed — at once if it
   *  already has. A stamp that moved before the floats were watching the map
   *  is caught here. Absent in tests that drive the map by hand. */
  whenSynced?: (cb: () => void) => void;
  /** Injected so a test counts the doc-record reads without a server. */
  fetchJson?: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

export function mountDocFloats(opts: DocFloatsOptions): void {
  const { docId, root, ydoc, user, canWrite, scope, watchLeadPresence } = opts;

  // One read of the doc record for both floats, seeded by the router's
  // (doc/doc-record.ts). Five identical reads per open is what this replaced.
  const url = docJsonUrl(docId);
  const record = createDocRecordReader(url, opts.fetchJson ?? defaultFetchJson, takeDocRecord(url));

  // `setPlanState` writes planState into this map on the server, so observing
  // it is how the floats hear that the plan landed — no event stream carries
  // that transition. One observer for both floats, and it wakes them only when
  // a stamp they render moved: the initial sync and every `contentRevision`
  // bump fire the map too, and each used to cost both floats a read.
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
    ...(watchLeadPresence ? { watchLeadPresence } : {}),
  });
  scope.onCleanup(() => planGate.destroy());

  // The Review float docks beside Make Plan (mounted AFTER it, so the row
  // reads plan, then review). Its receipt clears when the ask thread is
  // resolved, and threads live in this doc's own Yjs map — so the map is
  // what it watches, and a resolve from anywhere flips the face with no
  // fetch.
  const reviewFloat = mountReviewFloat({
    docId,
    root,
    user,
    canWrite,
    record,
    watchDocMeta,
    threadOpen: (threadId) => {
      const t = ydoc.getMap('threads').get(threadId) as { get(key: string): unknown } | undefined;
      if (!t) return undefined;
      return t.get('status') !== 'resolved';
    },
    watchThreads: (onChange) => {
      const threads = ydoc.getMap('threads');
      threads.observeDeep(onChange);
      return () => threads.unobserveDeep(onChange);
    },
    ...(watchLeadPresence ? { watchLeadPresence } : {}),
  });
  scope.onCleanup(() => reviewFloat.destroy());
}
