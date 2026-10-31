/**
 * A lead's push through its board server (`git-push/pusher.ts`).
 *
 *   POST /workspaces/<board>/git/push?repo=<owner/name>&branch=<name>[&task=<taskId>]
 *        body: a git bundle, e.g. `git bundle create - origin/main..my-branch`
 *   GET  /workspaces/<board>/git/pushes/<id>
 *
 * The same request serves a walled lead on the Mac and the `lead` user on a
 * project machine: both reach the server through their board's own socket
 * (`board-sockets.ts`), which names the board. From a lead's shell:
 *
 *   git bundle create - origin/main..my-branch | curl -sS --unix-socket "$CW_BOARD_SOCKET" \
 *     --data-binary @- "http://board/workspaces/$CW_WORKSPACE_ID/git/push?repo=o/n&branch=my-branch"
 *
 * Who may call: a request on THIS board's own socket, and nothing else. The
 * socket is what names the board. Loopback TCP is refused too: on the Mac
 * every session can reach it, so it would let any session push for any board
 * by naming it. A browser, a share or collab visitor, the edge and another
 * board's socket are refused before the body is read. The socket path is in
 * `middleware/lead-scope.ts`, so the socket door lets it through and no
 * member's scope gains it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import type { FeatureRequest } from '../feature-module.ts';
import { isBranchName, isRepoName } from '../git-push/policy.ts';
import type { GitPusher } from '../git-push/pusher.ts';

export interface GitPushRoutesContext {
  pusher: GitPusher;
  boardExists: (boardId: string) => boolean;
  /** The board whose socket the request arrived on, or null for TCP. */
  boardOfSocket: (req: Request) => string | null;
  j: (status: number, body: unknown) => Response;
}

/** The most a bundle may weigh. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const PUSH_PATH = /^\/workspaces\/([A-Za-z0-9_-]{1,64})\/git\/push$/;
const STATUS_PATH = /^\/workspaces\/([A-Za-z0-9_-]{1,64})\/git\/pushes\/([a-f0-9]{24})$/;

export async function handleGitPushRoutes(
  ctx: GitPushRoutesContext,
  rq: FeatureRequest,
): Promise<Response | null> {
  const { req, pathname } = rq;
  const push = PUSH_PATH.exec(pathname);
  const status = push ? null : STATUS_PATH.exec(pathname);
  if (!push && !status) return null;
  const boardId = (push ?? status)?.[1] ?? '';
  const method = req.method.toUpperCase();
  if ((push && method !== 'POST') || (status && method !== 'GET')) {
    return ctx.j(405, { error: 'method-not-allowed' });
  }
  const caller = callerOf(ctx, req, boardId);
  if (!caller.ok) return ctx.j(403, { error: caller.error, message: caller.message });
  if (!ctx.boardExists(boardId)) return ctx.j(404, { error: 'not-found' });

  if (status) {
    const record = ctx.pusher.get(boardId, status[2] ?? '');
    return record ? ctx.j(200, record) : ctx.j(404, { error: 'not-found' });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get('repo') ?? '';
  const branch = url.searchParams.get('branch') ?? '';
  const task = url.searchParams.get('task');
  if (!isRepoName(repo)) return ctx.j(400, { error: 'repo must be owner/name' });
  if (!isBranchName(branch))
    return ctx.j(400, { error: 'branch is not a branch name git accepts' });
  if (task !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(task)) {
    return ctx.j(400, { error: 'task must be a task id' });
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BUNDLE_BYTES) return ctx.j(413, { error: 'bundle-too-large' });

  const id = randomBytes(12).toString('hex');
  const path = ctx.pusher.bundlePath(id);
  let kept = false;
  try {
    const size = await saveBody(req, path);
    if (size === 'too-large') return ctx.j(413, { error: 'bundle-too-large' });
    if (size === 0) return ctx.j(400, { error: 'the body must be a git bundle' });
    const out = await ctx.pusher.submit({
      id,
      boardId,
      repo,
      branch,
      ...(task ? { taskId: task } : {}),
      requestedBy: requesterLabel(req, caller.who),
    });
    kept = true;
    return ctx.j(out.status, out.record);
  } finally {
    // The pusher owns the bundle once `submit` answers; before that, a
    // refusal or a throw leaves nothing behind. Transient, so a hard delete.
    if (!kept) rmSync(path, { force: true });
  }
}

/**
 * Write the body to `path` (mode 600) as it arrives, stopping at the cap,
 * so a chunked body with no length is never buffered whole first.
 */
async function saveBody(req: Request, path: string): Promise<number | 'too-large'> {
  const fd = openSync(path, 'w', 0o600);
  let size = 0;
  try {
    if (!req.body) return 0;
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return size;
      size += value.byteLength;
      if (size > MAX_BUNDLE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      writeSync(fd, value);
    }
  } finally {
    closeSync(fd);
  }
}

type Caller = { ok: true; who: string } | { ok: false; error: string; message: string };

function callerOf(ctx: GitPushRoutesContext, req: Request, boardId: string): Caller {
  const socketBoard = ctx.boardOfSocket(req);
  if (socketBoard === null) {
    return {
      ok: false,
      error: 'push-socket-only',
      message: "a push is asked over the board's own socket, which is what names the board",
    };
  }
  return socketBoard === boardId
    ? { ok: true, who: `the lead of ${boardId}` }
    : { ok: false, error: 'other-board', message: "a board's socket pushes for that board only" };
}

/** The caller's own name for itself, as plain text, shown on the approval item. */
function requesterLabel(req: Request, fallback: string): string {
  const named = (req.headers.get('x-cw-agent-name') ?? '').trim();
  return /^[A-Za-z0-9 ._-]{1,60}$/.test(named) ? named : fallback;
}
