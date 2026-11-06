/**
 * The two requests a markdown diff's redline waits on, sent together and
 * before the redline's own chunk has loaded.
 *
 * The page cannot paint a redline without the file's base text (`/diff`), and
 * the editable surface also needs its companion doc opened
 * (`POST …/editable-file`). They used to run one after the other, and both
 * after the redline chunk had downloaded: a fresh diff page waited on three
 * trips in a row before it drew anything (measured locally: chunk to 280 ms,
 * `/diff` to 346 ms, the companion to 422 ms). Neither request needs the
 * other's answer, and neither needs the chunk, so this module is small and
 * stays in the entry: `app.ts` sends both the moment it knows the doc is a
 * markdown diff, and `mountRedline` awaits what is already on its way.
 *
 * The companion is asked for whenever the view could use it (redline or
 * file, a live working-tree diff with a set). A deleted member, which is
 * only known from the `/diff` answer, never uses it; the server answers that
 * open with a 404 and creates nothing.
 */
import { type FeedbackClient, connect } from '@claude-workspaces/core';
import { api, docSocketUrl } from '../doc-path.ts';
import type { MountContext } from '../mount-context.ts';
import { asBackgroundWrite } from '../signin/write-gate.ts';

export type RedlineViewMode = 'redline' | 'diff' | 'file';

const modeKey = (docId: string) => `cw-view-mode:${docId}`;

export function readViewMode(docId: string): RedlineViewMode {
  try {
    const v = localStorage.getItem(modeKey(docId));
    if (v === 'diff' || v === 'file' || v === 'redline') return v;
  } catch {
    // Private mode / storage disabled — fall through to the default.
  }
  return 'redline'; // markdown diffs open redlined
}

export function writeViewMode(docId: string, mode: RedlineViewMode): void {
  try {
    localStorage.setItem(modeKey(docId), mode);
  } catch {
    // Non-fatal: the toggle just won't persist across reloads.
  }
}

export interface DiffInfo {
  baseText: string | null;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  error?: string;
}

/** The server's answer to opening the companion: which doc to connect to. */
export interface OpenedCompanion {
  docId: string;
  meta?: { sourceUrl?: string };
}

export interface RedlineRequests {
  /** Null when the base text could not be read. */
  diff: Promise<DiffInfo | null>;
  /** Null when the view will not use a companion, or it could not be opened. */
  companion: Promise<OpenedCompanion | null>;
  /**
   * The companion's socket, connected the moment the open answers, so its
   * handshake runs while the redline chunk loads rather than after it. Null
   * when there is no companion. Whoever takes the requests owns it.
   */
  socket?: Promise<FeedbackClient | null>;
}

/** Opens a doc socket; core's `connect` outside tests. */
export type OpenSocket = (url: string) => FeedbackClient;

type RequestContext = Pick<MountContext, 'docId' | 'workspaceId' | 'relPath' | 'diffTarget'>;

/** Send both requests now. Neither rejects. */
export function startRedlineRequests(
  ctx: RequestContext,
  open: OpenSocket = connect,
): RedlineRequests {
  const mode = readViewMode(ctx.docId);
  const wantsCompanion = mode !== 'diff' && ctx.workspaceId !== '' && !ctx.diffTarget;
  const companion = wantsCompanion ? requestCompanion(ctx) : Promise.resolve(null);
  return {
    diff: fetchDiffInfo(ctx.docId),
    companion,
    socket: companion.then((o) => (o ? open(docSocketUrl(location, o.docId, 'markdown')) : null)),
  };
}

/**
 * The member a live diff's address names, or null when the address is not
 * one: `<review>-live:<path, / as ~>.md`. A working-tree review's id ends in
 * `-live` (`deriveDiffReviewId`), and only a working-tree member opens a
 * companion. A guess, so its requests are used only when the meta agrees.
 */
export function guessLiveMarkdownMember(docId: string): RequestContext | null {
  const cut = docId.indexOf(':');
  if (cut <= 0) return null;
  const setId = docId.slice(0, cut);
  const rest = docId.slice(cut + 1);
  if (!setId.endsWith('-live') || rest.includes(':') || !rest.toLowerCase().endsWith('.md')) {
    return null;
  }
  return { docId, workspaceId: setId, relPath: rest.replaceAll('~', '/'), diffTarget: '' };
}

let early: { ctx: RequestContext; requests: RedlineRequests } | null = null;

/**
 * Send a live markdown member's requests from its address, beside the meta
 * read, and fetch the redline chunk with them. Without this the page asked
 * for meta, then the companion, then loaded the chunk and only then opened
 * the companion's socket: four waits in a row before its sync could start.
 */
export function startEarlyRedline(docId: string | null, open: OpenSocket = connect): boolean {
  const ctx = docId ? guessLiveMarkdownMember(docId) : null;
  if (!ctx) return false;
  early = { ctx, requests: startRedlineRequests(ctx, open) };
  return true;
}

/** The requests for this mount: the early ones when they were for this very
 *  member, else new ones, with an unused early socket closed. */
export function redlineRequestsFor(
  ctx: RequestContext,
  open: OpenSocket = connect,
): RedlineRequests {
  const e = early;
  early = null;
  if (
    e &&
    e.ctx.docId === ctx.docId &&
    e.ctx.workspaceId === ctx.workspaceId &&
    e.ctx.relPath === ctx.relPath &&
    !ctx.diffTarget
  ) {
    return e.requests;
  }
  dropRedlineRequests(e?.requests);
  return startRedlineRequests(ctx, open);
}

/** Forget the early requests, when the first mount was not their member. */
export function dropEarlyRedline(): void {
  dropRedlineRequests(early?.requests);
  early = null;
}

/** `meta`, closing the early socket if it rejects: no mount will take it. */
export function dropEarlyRedlineOnFailure<T>(meta: Promise<T>): Promise<T> {
  return meta.catch((err: unknown) => {
    dropEarlyRedline();
    throw err;
  });
}

function dropRedlineRequests(requests: RedlineRequests | undefined): void {
  void requests?.socket?.then((client) => client?.close());
}

async function fetchDiffInfo(docId: string): Promise<DiffInfo | null> {
  try {
    const res = await fetch(api(`docs/${encodeURIComponent(docId)}/diff`));
    return res.ok ? ((await res.json()) as DiffInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Open (or reuse) the companion doc on the server.
 *
 * Marked as the app's own, because it IS: this fires at mount over a
 * document nobody has touched. Unmarked, a refusal raised the blocking
 * "Sign in to write here" modal on plain page load — verbatim the failure
 * the reading tracker's POST already taught us (see `asBackgroundWrite`).
 * The server no longer refuses this route, so the marker is the belt to
 * that braces: a 401 arriving for any other reason must still not
 * interrupt somebody who is only reading.
 */
export async function requestCompanion(
  ctx: Pick<MountContext, 'workspaceId' | 'relPath'>,
): Promise<OpenedCompanion | null> {
  try {
    const res = await asBackgroundWrite(() =>
      fetch(api(`attachments/${encodeURIComponent(ctx.workspaceId)}/editable-file`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: ctx.relPath }),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as OpenedCompanion;
  } catch {
    return null;
  }
}
