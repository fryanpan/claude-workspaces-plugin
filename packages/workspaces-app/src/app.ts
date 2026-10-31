import type { User } from '@claude-workspaces/core';
import type { BootLocation, BootStorage, BootWindow } from './boot-env.ts';
import { type DocBootConnect, startDocBoot } from './doc-cache-boot.ts';
import {
  currentWorkspaceId,
  docIdFromPathOrNull,
  docSocketUrl,
  workspaceIdFromPath,
} from './doc-path.ts';
import { el } from './doc/chrome-dom.ts';
import { startDocLoadReport } from './doc/doc-load-report.ts';
import { wireDocSwitcher } from './doc/doc-switcher.ts';
import { openThreadId } from './doc/open-thread.ts';
import { paintProse } from './doc/prose-paint.ts';
import { ensureUserIdentity, sessionAnswerOf } from './identity-prompt.ts';
import { wireKeyboardInset } from './keyboard-inset.ts';
import type { MountContext } from './mount-context.ts';
import { registerOfflineWorker } from './offline-worker.ts';
import { startRedlineRequests } from './redline/redline-requests.ts';
import { navigateTo, remountCurrent, startRouter } from './router.ts';
import { fetchWriteAccess, installWriteGateNotice, showSignInBar } from './signin/write-gate.ts';
import { installStaleClientNotice } from './stale-client.ts';
import { registerMarkdownMount } from './surface-registry.ts';

/**
 * Everything the document editor's boot reaches outside its own module.
 *
 * The page passes the real globals at the bottom of this file; a test passes a
 * throwaway document, a synthetic address, a Map-backed store and a fake
 * socket. `mountMarkdown` (`doc/markdown-mount.ts`) is NOT part of this: it is a
 * per-document mount the router runs, and it keeps reading the ambient DOM it
 * renders into.
 */
export interface AppBootEnv {
  document: Document;
  location: BootLocation;
  localStorage: BootStorage;
  window: BootWindow;
  connect: DocBootConnect;
  /** For the docs' local copies; a test that passes none boots as before. */
  indexedDB?: IDBFactory;
  /** The offline service worker's registration (offline-worker.ts). */
  registerWorker?: () => void;
}

/**
 * One-time app bootstrap: the persistent shell (keyboard inset, doc-switcher)
 * plus the router. Everything document-specific is a per-doc mount the router
 * runs; navigation swaps mounts in place with no reload.
 *
 * Nothing here runs on import any more — the one call at the bottom of this
 * file starts the page. The destructure re-binds each injected thing to the
 * name it had as a global, so the sequence reads as it did and what changed is
 * only where those names come from.
 *
 * Returns the router's `stop()`. The page never calls it (it owns the tab for
 * its lifetime); a caller that is not a page must, or the mount stays live with
 * its debounced timers armed — see `app-boot.test.ts` for what that costs.
 */
export async function bootApp(env: AppBootEnv): Promise<() => void> {
  const { document, location, localStorage, window, connect } = env;

  // Before anything can write: a refused write raises a sign-in prompt
  // wherever it happened, rather than a "try again" this person can never
  // satisfy. See signin/write-gate.ts.
  installWriteGateNotice();
  wireKeyboardInset();
  wireDocSwitcher(document, window);
  (env.registerWorker ?? registerOfflineWorker)();
  const asParam = new URL(location.href).searchParams.get('as');
  // The session, the first doc's meta and its local copy, all at once.
  const { session, docs } = startDocBoot({
    pathname: location.pathname,
    indexedDB: env.indexedDB,
    storage: localStorage,
    connect,
    page: window,
    onCopyRefused: remountCurrent,
  });
  // May this browser write at all? Asked BEFORE the name prompt, because the
  // answer decides whether that prompt should be shown: where the server
  // requires a session, "what shall we call you?" is a modal that blocks boot
  // to collect a name the server will not accept, in place of the one
  // question this person actually has to answer.
  const writeAccess = await fetchWriteAccess(session);
  if (!writeAccess.canWrite) showSignInBar();
  // No session answer (offline, a failed route) asks no name: anonymous this
  // visit, and the next answered visit asks.
  const sessionUnknown = (await session) === null;
  // First arrival with no stored name shows the name prompt; this awaits the
  // user's answer (or skip) before anything connects, so awareness, comments,
  // and edits all carry the chosen identity from the first packet.
  const user: User = await ensureUserIdentity(
    asParam,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    {
      fetchSession: () => sessionAnswerOf(session),
      ...(writeAccess.canWrite && !sessionUnknown ? {} : { suppressNamePrompt: true }),
    },
  );
  // The redline's editable File view mounts the editor straight away: its
  // lens is already on screen, so there is no text to paint first.
  registerMarkdownMount(async (ctx) => (await loadMarkdownMount()).mountMarkdown(ctx));
  const reportLoad = startDocLoadReport(workspaceIdFromPath(location.pathname));
  // The chat with the board's lead, once per page rather than per doc: an open
  // chat stays open as the reader moves between the board's docs. Its own
  // chunk, after the boot, because it is never the page's content.
  const board = currentWorkspaceId();
  if (board) {
    void import('./lead-chat/lead-chat-mount.ts').then(({ mountLeadChat }) =>
      mountLeadChat({
        workspaceId: board,
        author: { id: user.id, name: user.name, kind: user.kind },
        getContext: () => {
          const docId = docIdFromPathOrNull(location.pathname);
          return docId ? { surface: 'doc', docId } : undefined;
        },
        openThread: openThreadId,
      }),
    );
  }
  // Who else is in the workspace, and following them (presence/). Joined
  // once the first doc is up, so its socket never stands in front of the
  // doc's own.
  let presence: import('./presence/page-presence.ts').PagePresence | null = null;
  let presenceJoining = false;
  const joinPresence = async (): Promise<void> => {
    if (!board || presenceJoining) return;
    presenceJoining = true;
    presence = await joinDocPagePresence(board, user, env);
    presence?.follower.refresh();
  };
  return startRouter({
    user,
    // The answer is already in hand — every mount gets it as a value rather
    // than asking again. A mount that re-asks is editable while it waits.
    canWrite: writeAccess.canWrite,
    fetchMeta: (docId) => docs.fetchMeta(docId),
    connectFor: (docId, docType) => {
      const board = workspaceIdFromPath(location.pathname + location.search);
      const client = docs.connect(docId, docType, docSocketUrl(location, docId, docType, board));
      installStaleClientNotice(client);
      return client;
    },
    mountFor: async (ctx) => {
      // A markdown doc's text is on screen at its first sync, before its
      // editor has loaded (mountMarkdownAfterPaint); every other surface
      // draws its content inside its mount.
      const paintsFirst = ctx.docType === 'markdown';
      if (paintsFirst) reportLoad(ctx);
      presence?.moveTo({ surface: 'doc', docId: ctx.docId });
      await mountSurface(ctx);
      if (!paintsFirst) reportLoad(ctx);
      // A follow that brought this doc here shows its spot now the doc is up.
      presence?.follower.refresh();
      void joinPresence();
      // The coach's card is owner-only and never the page's content, so it
      // loads after the surface rather than ahead of the doc's text.
      void import('./doc/doc-coach.ts').then(({ mountDocCoach }) => {
        if (!ctx.scope.disposed) mountDocCoach(ctx);
      });
    },
  });
}

/**
 * The doc page in the workspace's presence room. Its own chunk, like the lead
 * chat: it is never the page's content. A doc → doc follow swaps the mount in
 * place; any other page is a load.
 */
async function joinDocPagePresence(
  workspaceId: string,
  user: User,
  env: AppBootEnv,
): Promise<import('./presence/page-presence.ts').PagePresence | null> {
  const host = env.document.getElementById('doc-people');
  if (!host) return null;
  const [{ joinPagePresence }, docSpot, { showToast }] = await Promise.all([
    import('./presence/page-presence.ts'),
    import('./presence/doc-spot.ts'),
    import('./doc/chrome-dom.ts'),
  ]);
  const { location } = env;
  const docId = docIdFromPathOrNull(location.pathname);
  const presence = joinPagePresence({
    workspaceId,
    user,
    here: docId ? { surface: 'doc', docId } : { surface: 'board' },
    connect: (url) => env.connect(url),
    origin: location,
    host,
    address: () => location.pathname + location.search,
    go: (href) => (href.includes('/docs/') ? navigateTo(href) : location.assign(href)),
    show: docSpot.showDocSpot,
    storage: sessionStorage,
    inputTarget: env.window,
    notify: showToast,
  });
  docSpot.onDocSpotMove((spot) => {
    const current = docIdFromPathOrNull(location.pathname);
    if (current) presence.moveTo({ surface: 'doc', docId: current, ...spot });
  });
  return presence;
}

/** The markdown surface's chunk: the editor and everything mounted with it. */
const loadMarkdownMount = () => import('./doc/markdown-mount.ts');

/** A `.md` diff member → redline (code when the base is unavailable); other
 *  code/diff docs → CodeMirror; a folder's video or image → its own page;
 *  everything else → Tiptap.
 *
 *  Every surface is an `import()`. The entry used to hold all of them, 1.4 MB
 *  of which CodeMirror was 720 KB, and a reader downloaded and parsed it all
 *  before seeing a word of a markdown doc. */
async function mountSurface(ctx: MountContext): Promise<void> {
  if (ctx.docType === 'diff' && ctx.relPath.toLowerCase().endsWith('.md')) {
    // Sent before the chunk is fetched, so the two downloads overlap.
    const requests = startRedlineRequests(ctx);
    const { mountRedline } = await import('./redline/redline-app.ts');
    return mountRedline(ctx, requests);
  }
  if (ctx.docType === 'code') {
    const { isMediaDoc, mountMedia } = await import('./media/media-app.ts');
    if (isMediaDoc(ctx)) return mountMedia(ctx);
  }
  if (ctx.docType === 'code' || ctx.docType === 'diff') {
    const { mountCode } = await import('./code/code-app.ts');
    return mountCode(ctx);
  }
  return mountMarkdownAfterPaint(ctx);
}

/**
 * The markdown surface, text first: the synced prose is drawn as plain DOM
 * (doc/prose-paint.ts), and only then is the editor chunk fetched, so its
 * download and parse do not stand between the reader and the words. The
 * editor mounts on the painted root.
 *
 * A doc with no sync and no local copy (a first visit offline) paints
 * nothing; once its socket has closed the editor mounts anyway, empty, as it
 * always did.
 */
async function mountMarkdownAfterPaint(ctx: MountContext): Promise<void> {
  const { client, scope } = ctx;
  let editorLoading = false;
  await new Promise<void>((resolve) => {
    client.onReady(() => {
      if (!scope.disposed && !editorLoading) {
        paintProse({ docId: ctx.docId, ydoc: client.ydoc, parent: el('editor'), scope });
      }
      resolve();
    });
    client.onStatus((status) => {
      if (status === 'closed') resolve();
    });
  });
  if (scope.disposed) return;
  editorLoading = true;
  const { mountMarkdown } = await loadMarkdownMount();
  if (scope.disposed) return;
  return mountMarkdown(ctx);
}
