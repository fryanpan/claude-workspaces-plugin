/**
 * Where a frame that left its app door goes back to.
 *
 * A router with no base path takes the door's prefix off the frame's address,
 * and a reload or a faded pin then asks for that bare path. The server answers
 * it with a page that reports the address (`server/src/frame-host.ts`), and
 * the host page, the one party that knows which door it holds, puts it back.
 *
 * The address comes from inside the frame, so an app's own script can send
 * anything here. The answer is on the frame's origin and under this page's
 * door, or nothing: `..` is resolved before the check, so no spelling reaches
 * another attachment. A mock's page has no door, because a mock is one page.
 */
import { MOCK_FRAME_PARAM } from '@claude-workspaces/core/page-thread-link';

const APP_DOOR = /^\/workspaces\/[^/]+\/apps\/[^/]+\//;

/** The frame's address for `left` under the door of the page at `pagePath`,
 *  with the frame flag it needs, or null. `frameSrc` is the frame's own
 *  absolute address, which names its origin. */
export function backInDoor(frameSrc: string, pagePath: string, left: unknown): string | null {
  const door = APP_DOOR.exec(pagePath)?.[0];
  if (!door || typeof left !== 'string' || !left.startsWith('/')) return null;
  try {
    const { origin } = new URL(frameSrc);
    const u = new URL(door + left.replace(/^\/+/, ''), origin);
    if (u.origin !== origin || !u.pathname.startsWith(door)) return null;
    // As text: the app reads its query back byte for byte (`frameSrcFor`).
    const flagged = new RegExp(`[?&]${MOCK_FRAME_PARAM}=1(&|$)`).test(u.search);
    const search = flagged ? u.search : `${u.search}${u.search ? '&' : '?'}${MOCK_FRAME_PARAM}=1`;
    return `${u.origin}${u.pathname}${search}${u.hash}`;
  } catch {
    return null;
  }
}
