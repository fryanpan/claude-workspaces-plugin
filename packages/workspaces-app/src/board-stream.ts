/**
 * One board stream per page, shared by every part of the page that listens.
 *
 * `/workspaces/<ws>/events:stream` carries the board's events. A doc page
 * or a mock's host page has more than one reader of it: the lead chat, and
 * the tab title that follows a rename. Over HTTP/1.1 a browser holds about
 * six connections per host across ALL of its tabs, and every SSE stream
 * holds one for as long as the page is open, so each extra reader would be
 * one more connection taken from every other tab on the board.
 *
 * Each caller gets its own handle, an `EventSource` in the shape it uses:
 * `addEventListener`, `removeEventListener` and `close`. Closing a handle
 * takes off only the listeners added through it; the stream closes when the
 * last handle does.
 */

type Open = (url: string) => EventSource;

interface Shared {
  es: EventSource;
  users: number;
}

const live = new Map<string, Shared>();

export function boardStreamUrl(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/events:stream`;
}

/** A handle on this page's stream for `workspaceId`, opened if none is. */
export function openBoardStream(
  workspaceId: string,
  open: Open = (u) => new EventSource(u),
): EventSource {
  const url = boardStreamUrl(workspaceId);
  let shared = live.get(url);
  // A stream the browser gave up on (CLOSED) is not shared again.
  if (!shared || shared.es.readyState === 2) {
    shared = { es: open(url), users: 0 };
    live.set(url, shared);
  }
  const mine = shared;
  mine.users++;
  const added: Array<[string, EventListenerOrEventListenerObject]> = [];
  let closed = false;
  const handle = {
    get readyState(): number {
      return closed ? 2 : mine.es.readyState;
    },
    url: mine.es.url,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
      if (closed) return;
      added.push([type, fn]);
      mine.es.addEventListener(type, fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
      mine.es.removeEventListener(type, fn);
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const [type, fn] of added) mine.es.removeEventListener(type, fn);
      mine.users--;
      if (mine.users > 0) return;
      mine.es.close();
      if (live.get(url) === mine) live.delete(url);
    },
  };
  return handle as unknown as EventSource;
}
