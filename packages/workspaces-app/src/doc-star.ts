/**
 * The star in a doc page's top bar: the same star as the Library row's, for
 * the doc on screen (`board/library-starred.ts`, and the server's
 * `routes/workspace-library-views.ts`).
 *
 * It sits right after the doc's name, a fixed square whose outline fills when
 * pressed, so flipping it moves nothing in the bar. It reads the reader's
 * stars when it arrives and again on every `library.changed` frame of the
 * board's stream, so a star flipped in another tab shows here too.
 */
import { openBoardStream } from './board-stream.ts';

export interface DocStarDeps {
  workspaceId: string;
  author: { id: string; name: string; kind: string };
  /** Where the button goes: it is inserted right after this element. */
  after: HTMLElement;
  fetch?: typeof fetch;
  openStream?: (workspaceId: string) => Pick<EventSource, 'addEventListener'>;
}

export interface DocStar {
  /** Point the star at the doc now on screen. */
  show(docId: string): void;
}

const SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';

export function mountDocStar(deps: DocStarDeps): DocStar {
  const http = deps.fetch ?? fetch.bind(globalThis);
  const url = `/workspaces/${encodeURIComponent(deps.workspaceId)}/library/stars`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn doc-star';
  btn.innerHTML = SVG;
  btn.hidden = true;
  deps.after.after(btn);
  let docId: string | null = null;
  /** Ids the reader starred, as the server last said, plus a flip in flight. */
  let starred = new Set<string>();

  function paint(): void {
    const on = docId !== null && starred.has(docId);
    btn.hidden = docId === null;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Unstar this doc' : 'Star this doc');
    btn.title = on ? 'Starred' : 'Star';
  }

  async function load(): Promise<void> {
    try {
      const res = await http(`${url}?viewer=${encodeURIComponent(deps.author.id)}`);
      if (!res.ok) return;
      const body = (await res.json()) as { starred?: Array<{ kind: string; id: string }> };
      starred = new Set((body.starred ?? []).filter((s) => s.kind === 'doc').map((s) => s.id));
      paint();
    } catch {
      // Offline: keep what is showing; the next frame reads again.
    }
  }

  btn.addEventListener('click', async () => {
    if (!docId) return;
    const id = docId;
    const on = !starred.has(id);
    if (on) starred.add(id);
    else starred.delete(id);
    paint();
    const ok = await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'doc', id, starred: on, author: deps.author }),
    })
      .then(async (r) => r.ok && ((await r.json()) as { recorded?: boolean }).recorded !== false)
      .catch(() => false);
    if (ok) return;
    if (on) starred.delete(id);
    else starred.add(id);
    paint();
  });

  (deps.openStream ?? openBoardStream)(deps.workspaceId).addEventListener(
    'library.changed',
    () => void load(),
  );
  void load();

  return {
    show(id) {
      docId = id;
      paint();
    },
  };
}
