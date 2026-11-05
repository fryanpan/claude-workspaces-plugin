/**
 * The tab title of a mock's or a dev server's host page, kept current.
 *
 * The server writes the first one (`<workspace> · <doc> · Workspaces`, in
 * `mockup-frame.ts`); the host page has no app bundle and never reloads, so
 * this is what follows a rename after that. The workspace's name comes from
 * `page-tab-title.ts`, which hears `workspace.renamed` on the board's stream.
 * The doc's own title is re-read when the board says its Library changed,
 * the frame a rename sends: it names the list and not the doc, so the page
 * asks for the one title it shows.
 */
import { docJsonUrl } from './doc-path.ts';
import {
  onPageLibraryChanged,
  readWorkspaceName,
  setPageTitle,
  setPageWorkspace,
} from './page-tab-title.ts';

async function readDocTitle(workspaceId: string, docId: string): Promise<string | null> {
  try {
    const res = await fetch(docJsonUrl(docId, workspaceId));
    if (!res.ok) return null;
    const body = (await res.json()) as { meta?: { title?: unknown } };
    const t = body.meta?.title;
    return typeof t === 'string' && t.trim() ? t : null;
  } catch {
    return null;
  }
}

export async function followMockTabTitle(opts: {
  workspaceId: string;
  docId: string;
  /** The name the server titled the tab with: the doc's title or the mock's. */
  docTitle: string;
}): Promise<void> {
  let name = opts.docTitle;
  const workspace = await readWorkspaceName(opts.workspaceId);
  // Unread, the server's title stands: it already leads with the name.
  if (!workspace) return;
  setPageTitle(name);
  setPageWorkspace({ workspaceId: opts.workspaceId, name: workspace });
  onPageLibraryChanged(() => {
    void readDocTitle(opts.workspaceId, opts.docId).then((t) => {
      if (t === null || t === name) return;
      name = t;
      setPageTitle(t);
    });
  });
}
