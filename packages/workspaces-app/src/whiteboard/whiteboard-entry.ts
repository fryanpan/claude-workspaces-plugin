import { connect } from '@claude-workspaces/core';
/**
 * The whiteboard page (`/workspaces/<ws>/whiteboards/<id>`).
 *
 * Connects to the doc socket, announces who is here, and mounts the canvas
 * once the scene has synced. Excalidraw arrives through a dynamic import, so
 * the header paints and the socket opens while it downloads.
 *
 * The rules this page keeps:
 *  - It writes to the shared scene only when no gesture is in progress, so a
 *    half-drawn stroke never reaches anyone (`scene-sync.ts`).
 *  - A change from elsewhere never replaces what the person here is drawing
 *    or dragging; it lands when their gesture ends.
 *  - An agent shows up only where it points.
 */
import { allSceneElements, sceneMap } from '@claude-workspaces/core/whiteboard-scene';
import { docSocketUrl } from '../doc-path.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import type { CanvasHandle } from './canvas-island.ts';
import {
  commitLocal,
  inGesture,
  mergeForCanvas,
  presenceLine,
  presenceNames,
  protectedIds,
  remoteCursors,
} from './scene-sync.ts';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

/** The origin of this page's own writes, so its observer skips them. */
const LOCAL = { whiteboardPage: true };
/** How often a moving pointer is published, at most. */
const POINTER_MS = 50;

async function boot(): Promise<void> {
  const body = document.body;
  const workspaceId = body.dataset.workspaceId ?? '';
  const docId = body.dataset.docId ?? '';
  const stage = document.getElementById('wb-stage');
  const presence = document.getElementById('wb-presence');
  if (!docId || !stage) return;
  // Fonts come from this server, never a CDN.
  window.EXCALIDRAW_ASSET_PATH = '/app/whiteboard/';

  const user = await ensureUserIdentity(
    null,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    { suppressNamePrompt: true },
  );
  const client = connect(docSocketUrl(location, docId, 'whiteboard', workspaceId));
  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  const showPresence = () => {
    if (presence) {
      presence.textContent =
        client.status === 'open'
          ? presenceLine(presenceNames(awareness.getStates(), ydoc.clientID))
          : 'Reconnecting…';
    }
  };
  client.onStatus(showPresence);
  awareness.on('change', showPresence);

  const [{ mountCanvas }] = await Promise.all([
    import('./canvas-island.ts'),
    new Promise<void>((r) => client.onReady(r)),
  ]);
  document.getElementById('wb-loading')?.remove();
  const host = document.createElement('div');
  host.className = 'wb-canvas';
  stage.append(host);

  let canvas: CanvasHandle | null = null;
  // How many elements the canvas shows, on the body for anyone reading the
  // page from outside it (the headless test does).
  const noteCount = () => {
    const n = canvas?.elements().filter((e) => !(e as { isDeleted?: boolean }).isDeleted).length;
    body.dataset.elements = String(n ?? 0);
  };
  let pendingRemote = false;
  // A remote copy of an element the person here was still working on: it is
  // merged once their gesture ends, if it still wins then.
  let heldBack = false;

  const pullRemote = () => {
    pendingRemote = false;
    if (!canvas) return;
    const keep = protectedIds(canvas.gesture());
    heldBack = keep.size > 0;
    const merged = mergeForCanvas(canvas.elements(), allSceneElements(ydoc), keep);
    if (merged) canvas.show(merged);
    noteCount();
  };

  const onChange = () => {
    if (!canvas) return;
    if (inGesture(canvas.gesture())) return;
    commitLocal(ydoc, canvas.elements(), LOCAL);
    noteCount();
    // A remote change that waited for this gesture to end lands now.
    if (heldBack) pullRemote();
  };

  let lastPointer = 0;
  const onPointer = (p: { x: number; y: number }) => {
    const now = performance.now();
    if (now - lastPointer < POINTER_MS) return;
    lastPointer = now;
    awareness.setLocalStateField('pointer', { x: Math.round(p.x), y: Math.round(p.y) });
    room?.moveTo({ surface: 'whiteboard', docId, x: Math.round(p.x), y: Math.round(p.y) });
  };

  // The workspace's presence room: this person's pointer is their spot, and
  // a followed spot on this board scrolls the view to it (presence/).
  const room = workspaceId ? await joinRoom(workspaceId, docId, user, () => canvas) : null;

  canvas = await mountCanvas(host, {
    initial: allSceneElements(ydoc),
    onChange,
    onPointer,
  });

  sceneMap(ydoc).observe((_e, tr) => {
    if (tr.origin === LOCAL || pendingRemote) return;
    pendingRemote = true;
    // A timer, not requestAnimationFrame: a hidden tab never runs a frame,
    // and it must still be current when it is shown again.
    setTimeout(pullRemote, 0);
  });
  const drawCursors = () => canvas?.cursors(remoteCursors(awareness.getStates(), ydoc.clientID));
  awareness.on('change', drawCursors);
  drawCursors();
  showPresence();
  noteCount();
  body.dataset.whiteboardReady = '1';
  // A follow that brought this tab here shows its spot now the canvas is up.
  room?.follower.refresh();
}

/** Join the board's presence room from this whiteboard. */
async function joinRoom(
  workspaceId: string,
  docId: string,
  user: { id: string; name: string; color: string },
  canvas: () => CanvasHandle | null,
) {
  const host = document.getElementById('wb-people');
  if (!host) return null;
  const { joinPagePresence } = await import('../presence/page-presence.ts');
  return joinPagePresence({
    workspaceId,
    user,
    here: { surface: 'whiteboard', docId },
    connect: (url) => connect(url),
    origin: location,
    host,
    address: () => location.pathname + location.search,
    go: (href) => location.assign(href),
    show: (spot) => {
      if (spot.x !== undefined && spot.y !== undefined) canvas()?.centreOn(spot.x, spot.y);
    },
    storage: sessionStorage,
    inputTarget: window,
  });
}

void boot();
