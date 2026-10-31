/**
 * The markdown surface's mount: everything a markdown doc needs once its text
 * is on screen — the Tiptap editor, the review chrome, the margin, the
 * agent's cursor, the gates.
 *
 * It is its own chunk, loaded by `app.ts` with an `import()` after the doc's
 * text is painted (`doc/prose-paint.ts`). It used to be the doc page's entry,
 * and every byte of it — ProseMirror, Yjs bindings — was
 * downloaded and parsed before a reader saw a word.
 */
import { browserDeviceEnv, syncDeviceContext } from '../device-context.ts';
import { wireEditViewport } from '../edit-viewport.ts';
import { type EditorHandle, createEditor } from '../editor.ts';
import type { MountContext } from '../mount-context.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { type ReviewChrome, mountReviewChrome } from '../review-chrome.ts';
import { navigateTo } from '../router.ts';
import { wireAgentFocus } from './agent-focus.ts';
import { el, showToast } from './chrome-dom.ts';
import { wireThreadRangeClicks } from './chrome-panels.ts';
import { marginComposerSlot } from './composer-slot.ts';
import { mountDocArchive } from './doc-archive.ts';
import { type CommentPillHandle, mountCommentPill } from './doc-comment-pill.ts';
import { mountDocFloats } from './doc-floats.ts';
import { wireDocGates } from './doc-gates.ts';
import { mountMeetingHeading } from './doc-heading.ts';
import { mountDocMargin } from './doc-margin.ts';
import { mountPointerPillLayer } from './doc-pointer-pill.ts';
import { mountDocPreview } from './doc-preview.ts';
import { wireDocReady } from './doc-ready.ts';
import { mountDocSaveState } from './doc-save-state.ts';
import { mountDocSetNav } from './doc-set-nav.ts';
import { mountDocSpeakerMenu } from './doc-speaker-menu.ts';
import { createNotesLinkRefs } from './notes-link-refs.ts';

/** Per-document mount for the markdown (Tiptap) surface.
 *
 *  What is left here is the ORDER, and only the order: connect, editor,
 *  chrome, margin, floats, selection affordances, navigation, gates. Each
 *  phase is a module under `doc/` that takes an explicit context, so this
 *  function reads as the sequence a document boots in rather than as the
 *  sum of everything a document does.
 *
 *  Two things stay here on purpose. The forward refs — `chrome`, `pill`,
 *  `editViewport` — because the editor's callbacks can fire during the first
 *  Yjs application, before the phase that owns them has run. And the reads of
 *  the ADDRESS (`?huddle=`, `?thread=`), because the address is what this
 *  mount was opened at; the modules act on what it says.
 *
 *  Every listener is bound to `ctx.scope`; the router disposes the scope on
 *  navigation, which tears down the editor, chrome, listeners, and (via the
 *  router) the client. */
export async function mountMarkdown(ctx: MountContext): Promise<void> {
  const { docId, client, user, scope } = ctx;
  // Which docId the sidebar marks active — differs from `docId` only for the
  // editable File view of a .md diff member (see MountContext.navDocId).
  const navDocId = ctx.navDocId ?? docId;
  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  // The thread panel / composer / thread-view / drawer elements are owned
  // by the shared review chrome; only the markdown-specific elements are here.
  const editorMount = el<HTMLElement>('editor');
  const composer = el<HTMLElement>('composer');
  const commentPill = el<HTMLButtonElement>('comment-pill');
  // The pill's markup says "Add comment" because that is all it ever did, and
  // on a huddle doc that is now all it leads to as well. It was relabelled
  // "Turn this line into work" here while a range selection grew a pill
  // offering Research and Create Task (see doc/doc-pointer-pill.ts); those
  // went on 2026-09-04, so the label goes with them rather than promising a
  // menu of work that no longer opens.
  const huddle = ctx.huddle === true;
  const formatBar = el<HTMLElement>('format-bar');
  const toggleFormat = el<HTMLButtonElement>('toggle-format');
  /**
   * Whether the server will accept writes from this browser.
   *
   * The one flag that decides whether this document mounts editable, and the
   * one the chrome that describes what this surface IS reads. Declared this
   * high because the save-state chip reads it, and that renders long before
   * the gates are wired.
   *
   * The server's answer, carried in on the MountContext — not a hopeful
   * `true` narrowed later. It used to start `true` and be corrected one
   * round trip after the mount, and everything this flag guards was open
   * for the length of that trip.
   */
  const canWrite = ctx.canWrite;

  // Forward ref: the chrome is mounted right after the editor, but editor
  // callbacks can fire during initial Yjs application — guard until set.
  // biome-ignore lint/style/useConst: assigned after createEditor so its callbacks can close over it
  let chrome: ReviewChrome | undefined;
  // Same forward-ref shape as `chrome`: the editor's selection callback fires
  // during the first Yjs application, before the pill phase has run.
  // biome-ignore lint/style/useConst: assigned in the selection-affordance phase below
  let pill: CommentPillHandle | undefined;
  // Same shape again: the chrome's selection callback can fire before the
  // viewport is wired.
  // biome-ignore lint/style/useConst: assigned once the viewport is wired below
  let editViewport: ReturnType<typeof wireEditViewport> | undefined;
  // Which rows this doc is linked from, and the two writes that change it.
  // Read once the document has synced (`wireDocReady`) — before that the
  // notes are not on screen and there is nothing to draw a control beside.
  const notesLinkRefs = createNotesLinkRefs(docId);
  // Workspace members (folder binds, diff File views — ctx spreads through
  // mountEditableFileView) get in-app navigation for relative sibling links,
  // in the prose and in a `^[…]` note's caption alike (doc/footnote-notes.ts).
  const docLink = ctx.workspaceId
    ? { workspaceId: ctx.workspaceId, relPath: ctx.relPath, navigate: navigateTo }
    : undefined;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => pill?.refreshSelection(),
    onUpdate: () => chrome?.redrawThreads(),
    user: { name: user.name, color: user.color },
    docLink,
    imageDocId: docId,
    notesLinks: {
      docId,
      linkedTasks: () => notesLinkRefs.linked(),
      link: (taskId) => notesLinkRefs.link(taskId),
      unlink: (taskId) => notesLinkRefs.unlink(taskId),
      onChanged: () => notesLinkRefs.refresh(),
    },
  });
  // Editor teardown runs before the client closes (LIFO — client.close was
  // registered first by the router), so the y-prosemirror binding detaches
  // before its ydoc is destroyed.
  scope.onCleanup(() => editor.destroy());

  chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface: editor,
    whenSynced: (cb) => client.onReady(cb),
    scope,
    canWrite,
    labelHint: ctx.sourceUrl || ctx.relPath || undefined,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The pill controller's cached selection covers iOS blurring the editor
    // between the pill appearing and being tapped. `currentSelection` already
    // encodes a resolved range (from PM in edit mode, or from the raw DOM
    // selection in view mode) — don't also require a non-empty PM selection,
    // which is always empty in view mode even with a live DOM selection and
    // would wrongly block iOS long-press commenting.
    getSelection: () => pill?.currentSelection() ?? editor.getSelectionRel(),
    onComposerOpened: () => pill?.onComposerOpened(),
    onPosted: () => {
      // Drop focus so no caret blinks in the doc after posting.
      editor.editor.commands.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    hidePill: () => pill?.hide(),
    followCaret: () => editViewport?.follow(),
    // The composer opens in the balloon margin, level with the words it is
    // about, whenever that margin is on screen (doc/composer-slot.ts). The
    // column is mounted just below this call, so it is looked up per open
    // rather than captured here.
    placeComposer: () => marginComposerSlot({ editor, editorMount, composer }),
    // The markdown surface mounts the balloon margin unconditionally below.
    hasBalloonMargin: true,
  });
  const reviewChrome = chrome;

  // Everything that reports on comments the reader is not looking at: the
  // balloon margin, the doc-level suggestions badge, and the off-screen
  // comment hints — one loop, redrawn together on every editor transaction.
  const margin = mountDocMargin({
    docId,
    ydoc,
    scope,
    editor,
    editorMount,
    chrome: reviewChrome,
    docLink,
  });

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // The #editor element is the scroll container on the markdown surface.
  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));
  void syncDeviceContext(browserDeviceEnv(localStorage), { mayAsk: false });

  // The two always-in-view floats — Approve (the plan gate) and Review. A
  // review of somebody's branch, or a companion doc under `navDocId`, is not
  // a plan a person approves.
  if (ctx.docType === 'markdown' && ctx.navDocId === undefined) {
    // A meeting's title as its page's heading, with its dates under it.
    mountMeetingHeading({
      ...ctx,
      editorMount,
      ydoc,
      huddle,
      whenSynced: (cb) => client.onReady(cb),
      scope,
    });
    mountDocFloats({
      docId,
      root: editorMount,
      ydoc,
      user,
      canWrite,
      scope,
      whenSynced: (cb) => client.onReady(cb),
    });
    // The agent's cursor (`agent-focus.ts`).
    wireAgentFocus({ editor, presence: awareness, scroller: editorMount, scope });
  }

  mountDocSpeakerMenu({
    docId,
    editor,
    scope,
    canWrite: () => canWrite,
  });

  // Editing under an on-screen keyboard: the meeting strip gives its grid row
  // back while a phone-width editor has focus, and the caret is kept above
  // whatever the keyboard is covering. See edit-viewport.ts for both rules.
  editViewport = wireEditViewport({
    roots: () => [editorMount, composer],
    scroller: () => editorMount,
    strip: () => document.getElementById('meeting-strip'),
    caretRect: () => {
      const view = editor.editor.view;
      // View mode never focuses the editor; there is no caret to follow and
      // no keyboard that could be covering one.
      // The doc's own caret only: a reply box in an inline card is inside
      // view.dom too, and measuring the doc's selection for it left the box
      // under the keyboard. Null falls back to the focused box itself.
      if (document.activeElement !== view.dom) return null;
      try {
        const c = view.coordsAtPos(view.state.selection.head);
        return { top: c.top, bottom: c.bottom };
      } catch {
        // A head position that has not been rendered yet (a fresh mount, a
        // remote edit mid-frame) throws rather than returning coordinates.
        return null;
      }
    },
    listen: (t, type, h, o) => scope.listen(t, type, h, o),
    onCleanup: (fn) => scope.onCleanup(fn),
  });

  // ---- Selection affordances ----
  // Two modules, wired in the order they depend on each other: the pointer
  // pill a huddle doc grows over a range (doc-pointer-pill), and the round
  // comment pill that owns the cached selection it reads (doc-comment-pill).
  const pointer = mountPointerPillLayer({
    huddle,
    editor,
    editorMount,
    scope,
    getSelection: () => pill?.currentSelection() ?? null,
    hideAll: () => pill?.hide(),
    openComposer: () => reviewChrome.openComposer(),
  });
  pill = mountCommentPill({
    huddle,
    editor,
    editorMount,
    composer,
    commentPill,
    scope,
    pointer,
    openComposer: () => reviewChrome.openComposer(),
    follow: () => editViewport?.follow(),
  });

  // Tap-on-highlight in the editor → focus the thread.
  //   • A visible balloon for it → scroll the balloon into view.
  //   • Mobile: full-screen thread view (Notion pattern — gives the
  //     conversation space without the doc competing for it).
  //   • Desktop: open the side drawer and highlight the thread.
  wireThreadRangeClicks({
    editorMount,
    chrome: reviewChrome,
    surface: editor,
    scope,
    revealBalloon: (id) => margin.revealThreadBalloon(id),
  });

  // The sidebar and topbar dropdown for the set this doc belongs to — a diff
  // review, a bound folder, or a legacy hand-grouped set.
  const setNav = mountDocSetNav({ docId, navDocId, ydoc, scope });

  // `?thread=<id>` — arrive AT the comment, not at the document that contains
  // it. The board's review queue links here, and "it drops me on the doc and I
  // scroll looking for it" is the thing that link exists to remove. Read from
  // the address here, like the huddle flag above, and run once on the first
  // sync: threads don't exist before the ydoc arrives, and re-revealing on
  // every later sync would yank the reader back mid-read.
  function revealLinkedThread(): void {
    const wanted = new URLSearchParams(location.search).get('thread');
    if (!wanted) return;
    // Only when it's really there — a stale link leaves the reader on the doc
    // rather than pulsing at nothing, and SAYS so: threads all ride the ydoc
    // that just synced, so absent now is gone (resolved away, or a stale
    // paste), not still loading. A silent nothing reads as a broken link.
    if (!reviewChrome.collectThreads().some((t) => t.id === wanted)) {
      showToast('That comment thread is gone from this doc — the link may be outdated.');
      return;
    }
    reviewChrome.revealThread(wanted);
  }

  // What every meta tick redraws, and what only the first sync may do.
  wireDocReady({
    client,
    ydoc,
    scope,
    chrome: reviewChrome,
    editor,
    workspaceId: ctx.workspaceId,
    notesLinkRefs,
    renderSetNav: () => setNav.render(),
    onFirstSync: revealLinkedThread,
  });

  // The #save-state chip, and the app preview pane beside the editor.
  mountDocSaveState({ client, ydoc, canWrite, scope });
  mountDocArchive({ docId, client, ydoc, scope, canWrite, toast: showToast });
  mountDocPreview({ docId, ydoc, scope });

  // Last, because it speaks for the whole surface: the format bar, and whether
  // this browser may write at all, which alone decides if the doc mounts editable.
  wireDocGates({ editor, scope, els: { formatBar, toggleFormat }, canWrite });
}
