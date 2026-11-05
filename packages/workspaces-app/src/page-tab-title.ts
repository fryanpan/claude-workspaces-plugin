/**
 * The tab title of a page that shows one thing filed on a board: a doc, a
 * diff file, a folder file, a mock.
 *
 * Bryan, 4 Nov: "I want to make sure that every single page has a title that
 * starts with the workspace name". Several boards open at once are told
 * apart in Chrome's vertical tab bar only by the start of each title, so the
 * workspace's name leads and the page's own name follows
 * (`Harborlight · tides.md · Workspaces`).
 *
 * The page names its thing through `setPageTitle` whenever the name changes,
 * and the router names its board through `setPageWorkspace`. The workspace's
 * name stays current on its own: the board's stream announces a rename
 * (`workspace.renamed`), and a stream that dropped and came back reads the
 * name again, because a rename may have gone by while it was away.
 */
import { openBoardStream } from './board-stream.ts';
import { tabTitle } from './tab-title.ts';

export interface PageWorkspace {
  workspaceId: string;
  name: string;
}

interface Watch {
  workspaceId: string;
  close(): void;
}

let workspace: PageWorkspace | null = null;
let parts: Array<string | null | undefined> = [];
let watch: Watch | null = null;
/** Called on the page's other board events; the mock host re-reads its name. */
let onLibrary: (() => void) | null = null;

function apply(): void {
  document.title = tabTitle(workspace?.name, ...parts);
}

/** The workspace's current name, or null when it cannot be read. */
export async function readWorkspaceName(workspaceId: string): Promise<string | null> {
  try {
    const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}?format=json`);
    if (!res.ok) return null;
    const body = (await res.json()) as { workspace?: { name?: unknown } };
    return typeof body.workspace?.name === 'string' ? body.workspace.name : null;
  } catch {
    return null;
  }
}

function watchName(workspaceId: string): Watch {
  const es = openBoardStream(workspaceId);
  const rename = (name: string): void => {
    if (workspace?.workspaceId !== workspaceId || !name.trim()) return;
    workspace = { workspaceId, name };
    apply();
  };
  es.addEventListener('workspace.renamed', (ev) => {
    try {
      const e = JSON.parse((ev as MessageEvent).data) as { workspaceId?: string; name?: unknown };
      if ((e.workspaceId ?? workspaceId) === workspaceId && typeof e.name === 'string') {
        rename(e.name);
      }
    } catch {}
  });
  es.addEventListener('library.changed', () => onLibrary?.());
  let dropped = false;
  es.addEventListener('error', () => {
    dropped = true;
  });
  es.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    void readWorkspaceName(workspaceId).then((n) => n && rename(n));
    onLibrary?.();
  });
  return { workspaceId, close: () => es.close() };
}

/** The board this page's thing is filed on, or none. */
export function setPageWorkspace(next: PageWorkspace | null): void {
  if (watch && watch.workspaceId !== next?.workspaceId) {
    watch.close();
    watch = null;
  }
  workspace = next;
  if (next && !watch && typeof EventSource !== 'undefined') watch = watchName(next.workspaceId);
  apply();
}

/** The page's own name, after the workspace's: `tabTitle`'s parts. */
export function setPageTitle(...next: Array<string | null | undefined>): void {
  parts = next;
  apply();
}

/** What to run when the board says its list of things changed. */
export function onPageLibraryChanged(fn: (() => void) | null): void {
  onLibrary = fn;
}
