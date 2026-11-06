/**
 * ── An attached app's own websocket, through the board ──
 *
 *   GET /workspaces/<ws>/apps/<id>/<path>   with `Upgrade: websocket`
 *
 * A framework's reload channel lives on its dev server, at an address under
 * the app. Vite's client builds it from its own script's address and the
 * `base` it was started with, so an app started under the board's prefix
 * (`servesPrefix`) already names this path, with no setting of its own. The
 * frame has no reach to this server by itself (`mockup-frame.ts`): its socket
 * goes through the host page's relay, which allows this app's prefix alone.
 *
 * ── The same gate as the page ──
 *
 * A websocket is authorized once, at its upgrade, so everything that stands
 * in front of the page stands here, in the same order. `request-admission.ts`
 * has already run: the host guard reads an upgrade as the GET it is, so a
 * visitor refused the page never reaches this module. What the page gets from
 * the chain below the upgrade stream, this runs for itself:
 * `resolveWorkspaceScope`, the same call, and the same record lookup as
 * `serveApp`. The dev server's address comes from the record and the path
 * through `upstreamUrl`, so a socket reaches the origin the page reaches and
 * nothing else on this machine.
 *
 * A browser opens a socket from any page and CORS does not apply, so Origin is
 * checked here, and held to what a write is held to: the board's own origin,
 * exactly. The host page is the only page that has a reason to ask.
 *
 * ── Reading and speaking ──
 *
 * The socket runs both ways, and a frame sent to the dev server is a write
 * nobody's method gate sees. So whoever may read the app may open it, and
 * `appWriteRefusal`, the rule for a POST, decides whether their frames go
 * anywhere. A share-link visitor sees the app reload and speaks to nobody.
 * A reload channel works without those frames.
 */
import {
  APP_ADDRESS,
  type AppWriter,
  appWriteRefusal,
  offeredSubprotocols,
  upstreamBase,
  upstreamSocketUrl,
} from '../app-proxy.ts';
import { dialAppSocket } from '../app-socket-link.ts';
import type { DocStore } from '../doc-store.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import { resolveWorkspaceScope } from '../middleware/workspace-scope.ts';
import type { UpgradeData } from '../socket-handlers.ts';
import type { TaskStore } from '../tasks.ts';
import { safeDecodeSegment } from '../workspace-path.ts';

/** Past the slash: the bare address is a redirect, and no socket's. */
const APP_SOCKET_PATH = /^\/workspaces\/[^/]+\/apps\/[^/]+\//;

export interface AppSocketContext {
  server: { upgrade: (req: Request, options: AppSocketUpgrade) => boolean };
  docStore: DocStore;
  taskStore: TaskStore;
  isValidDocId: (id: string) => boolean;
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];
  policyFor: (req: Request) => OriginPolicy;
  j: (status: number, body: unknown) => Response;
}

interface AppSocketUpgrade {
  data: UpgradeData;
  headers?: Record<string, string>;
}

export interface AppSocketRequest {
  req: Request;
  url: URL;
  pathname: string;
  writer: AppWriter;
  /** Sign-in is required here and this browser proved nobody. */
  mustSignIn: boolean;
  /** What authorized this request, carried so a revocation can find it. */
  shareId: string | null;
  shareMember: string | null;
}

/** Is this an app's socket? The same address with no upgrade is its page,
 *  and a write with the header on it is still a write. */
export function isAppSocketRequest(req: Request, pathname: string): boolean {
  return (
    req.method === 'GET' &&
    req.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    APP_SOCKET_PATH.test(pathname)
  );
}

/** The refusal, or the connection: a `Response`, or `undefined` once upgraded. */
export function openAppSocket(
  ctx: AppSocketContext,
  rq: AppSocketRequest,
): Response | Promise<Response | undefined> {
  const { docStore, j } = ctx;
  const { req, url, pathname, writer } = rq;
  const scoped = resolveWorkspaceScope(
    {
      workspaceRecord: (id: string) => ctx.taskStore.getWorkspace(id),
      workspacesOfMember: ctx.workspacesOfMember,
      j,
    },
    { pathname, method: req.method, url },
  );
  if (scoped.kind === 'refused') return scoped.response;
  const m = scoped.kind === 'scope' ? scoped.scope.rest.match(APP_ADDRESS) : null;
  if (scoped.kind !== 'scope' || !m) return j(404, { error: 'not-found' });
  const { workspaceId } = scoped.scope;

  const origin = req.headers.get('origin');
  const boardOrigin = ctx.policyFor(req).requestOrigin;
  if (origin !== null && origin !== boardOrigin) return j(403, { error: 'origin_not_allowed' });

  const id = safeDecodeSegment(m[1] ?? '');
  if (!ctx.isValidDocId(id)) return j(400, { error: 'bad docId' });
  const meta = docStore.peekMeta(docStore.resolveDocId(id));
  const source = meta?.type === 'app' ? meta.sourceUrl : undefined;
  if (!meta || !source) return j(404, { error: 'app_not_found' });
  const target = upstreamSocketUrl(
    source,
    m[2] ?? '',
    url.search,
    upstreamBase(meta, workspaceId, meta.docId),
  );
  if (!target) return j(400, { error: 'path_outside_app' });

  const readOnly = rq.mustSignIn || appWriteRefusal({ writer, origin, boardOrigin }) !== null;
  const offered = offeredSubprotocols(req.headers.get('sec-websocket-protocol'));
  return dialAppSocket(target, offered).then((link) => {
    if (!link) return j(503, { error: 'app_not_running' });
    const upgraded = ctx.server.upgrade(req, {
      data: {
        docId: meta.docId,
        kind: 'app',
        appLink: link,
        ...(rq.shareId ? { shareId: rq.shareId } : {}),
        ...(rq.shareMember ? { shareMember: rq.shareMember } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      },
      ...(link.protocol ? { headers: { 'Sec-WebSocket-Protocol': link.protocol } } : {}),
    });
    if (upgraded) return undefined;
    link.abandon();
    return new Response('upgrade required', { status: 426 });
  });
}
