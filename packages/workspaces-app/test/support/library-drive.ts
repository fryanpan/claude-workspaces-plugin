/**
 * The Library page module, driven over fakes: one payload (or a sequence of
 * them), a canned answer to the open verb, and the navigations and history
 * entries the page makes. Shared by the suites that drive the page itself.
 *
 * All fixtures synthetic.
 */
import type { LibraryPayload } from '../../src/board/library-model.ts';
import { type LibraryPage, createLibraryPage } from '../../src/board/library-page.ts';
import { fakeHistory } from '../boot-harness.ts';

export interface DriveOptions {
  payload?: LibraryPayload | null | (LibraryPayload | null)[];
  openAnswer?: { ok: boolean; status: number; data: Record<string, unknown> | null };
  requestedOpen?: string;
}

export interface Driven {
  page: LibraryPage;
  root: HTMLElement;
  history: ReturnType<typeof fakeHistory>;
  sent: { path: string; method: string; body: unknown }[];
  navigated: string[];
}

export function driveLibrary(
  WS: string,
  PAYLOAD: LibraryPayload,
  NOW: number,
  opts: DriveOptions = {},
): Driven {
  document.body.innerHTML = '<div id="board-library"></div>';
  const root = document.getElementById('board-library') as HTMLElement;
  const history = fakeHistory();
  const sent: Driven['sent'] = [];
  const navigated: string[] = [];
  const page = createLibraryPage({
    root,
    workspaceId: WS,
    boardName: () => 'Kitchen rebuild',
    fetchJson: async <T>() => {
      if (opts.payload === undefined) return PAYLOAD as T;
      if (Array.isArray(opts.payload)) return (opts.payload.shift() ?? null) as T | null;
      return opts.payload as T | null;
    },
    send: async (path, method, body) => {
      sent.push({ path, method, body });
      return (
        opts.openAnswer ?? {
          ok: true,
          status: 200,
          data: { docId: 'library-x', href: `/workspaces/${WS}/docs/library-x` },
        }
      );
    },
    navigate: (href) => navigated.push(href),
    history,
    here: () => `https://board.test/workspaces/${WS}/library`,
    takeRequestedOpen: () => {
      const wanted = opts.requestedOpen ?? null;
      opts.requestedOpen = undefined;
      return wanted;
    },
    now: () => NOW,
  });
  return { page, root, history, sent, navigated };
}
