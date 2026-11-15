/**
 * Which presence strip the board draws: today's, or the Web Awesome one on a
 * board the collab core serves (D1 step 10).
 *
 * The page learns the setting three ways, and they are the live path:
 *
 *   - at boot, from the board record it already reads
 *     (`GET /workspaces/<id>?format=json`, field `collabCore.active`);
 *   - when the owner flips it, from the page-only `collab-core.changed` frame
 *     on the board's event stream, which carries the new `active`;
 *   - after the stream was down, by reading the record again, because a
 *     transient frame missed in a gap is not replayed.
 *
 * `active` is the board's own setting AND the server-wide `CW_COLLAB_CORE`,
 * so a server started with the core off draws today's strip everywhere.
 *
 * Both strips read the same `presenceData` signal and take the same handlers,
 * so a switch keeps who is shown and who is followed; only the circles are
 * rebuilt. The Web Awesome strip is an `import()`, so a board on the current
 * code never fetches it, and a chunk that fails to load leaves today's strip
 * in place.
 */
import { COLLAB_CORE_CHANGED } from '@claude-workspaces/core/workspace-presence';
import { effect, signal } from '@preact/signals';
import { type PresenceHandlers, mountPresenceIsland } from './presence-island.tsx';

/** True while this board's sockets take the collab core. */
export const collabCoreActive = signal(false);

/** `collabCore.active` off a board record, or `active` off the frame. Anything
 *  else is false: today's strip is the safe reading. */
export function collabCoreOf(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as { collabCore?: { active?: unknown }; active?: unknown };
  if (b.collabCore && typeof b.collabCore === 'object') return b.collabCore.active === true;
  return b.active === true;
}

/** Read the board record again and apply what it says. A failed read changes
 *  nothing, so a blip never swaps the strip. */
export async function rereadCollabCore(
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await fetchImpl(`/workspaces/${encodeURIComponent(workspaceId)}?format=json`);
    if (!res.ok) return;
    collabCoreActive.value = collabCoreOf(await res.json());
  } catch {
    // Offline: the stream's own reconnect will ask again.
  }
}

/** Apply each `collab-core.changed` frame the board's stream carries. */
export function listenCollabCore(stream: EventTarget): void {
  stream.addEventListener(COLLAB_CORE_CHANGED, (ev) => {
    const data = (ev as MessageEvent).data;
    try {
      collabCoreActive.value = collabCoreOf(typeof data === 'string' ? JSON.parse(data) : data);
    } catch {
      // A frame we cannot read changes nothing.
    }
  });
}

type WaModule = {
  mountWaPresenceIsland: (host: HTMLElement, handlers: PresenceHandlers) => () => void;
  showWaToast?: (message: string) => void;
  removeWaToast?: () => void;
};

/** The Web Awesome toast while the Web Awesome strip is drawn, else null. */
let waToast: ((message: string) => void) | null = null;

/**
 * Show one of the strip's toasts — the follow notice or the "+N" names — in
 * the face the strip is drawn in: a `<wa-toast>` beside the Web Awesome strip,
 * `fallback` (the board's own toast) beside today's.
 */
export function stripToast(message: string, fallback: (message: string) => void): void {
  if (waToast) waToast(message);
  else fallback(message);
}
const loadWa = (): Promise<WaModule> => import('./presence-island-wa.tsx');

/**
 * The compact strip in `host`, today's or the Web Awesome one as
 * `collabCoreActive` says, switching in place when it changes.
 */
export function mountBoardPresence(
  host: HTMLElement,
  handlers: PresenceHandlers,
  load: () => Promise<WaModule> = loadWa,
): () => void {
  let drawn: 'classic' | 'wa' = 'classic';
  let dispose = mountPresenceIsland(host, handlers, { compact: true });
  // Bumped on every change, so a slow load that a later change overtook
  // does not swap in a strip nobody wants any more.
  let generation = 0;
  const stop = effect(() => {
    const want = collabCoreActive.value ? 'wa' : 'classic';
    const mine = ++generation;
    if (want === drawn) return;
    if (want === 'classic') {
      waToast = null;
      dispose();
      dispose = mountPresenceIsland(host, handlers, { compact: true });
      drawn = 'classic';
      return;
    }
    load().then(
      (m) => {
        if (mine !== generation) return;
        dispose();
        const unmount = m.mountWaPresenceIsland(host, handlers);
        dispose = () => {
          unmount();
          m.removeWaToast?.();
        };
        waToast = m.showWaToast ?? null;
        drawn = 'wa';
      },
      (err) => console.error('[presence] the Web Awesome strip did not load:', err),
    );
  });
  return () => {
    stop();
    generation++;
    waToast = null;
    dispose();
  };
}
