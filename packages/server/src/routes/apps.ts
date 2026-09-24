/**
 * ── A dev server as a board resource: attached by an agent, read by members ──
 *
 * Two addresses, one family:
 *
 *   POST /workspaces/<ws>/apps            attach a loopback dev server
 *   GET  /workspaces/<ws>/apps/<id>/<p>   the app's page or file at <p>
 *
 * The attach is an agent's act, like every other bind: a browser is refused
 * whatever its origin, and the origin must be loopback (`app-proxy.ts` has
 * the rule and why). It makes a doc of type `app` whose `sourceUrl` is the
 * origin, filed on the board, so the record persists the way a mock's does
 * and a restart keeps it.
 *
 * The read proxies `<origin>/<p>`. A document gets the mock's shape
 * (`mockup-frame.ts`): the address a person opens answers a host page
 * holding one sandboxed frame, and the frame (`?cw-frame=1`) is the app's
 * own HTML with the widget and the bridge written in, so the widget comments
 * on the app doc and the app runs with an opaque origin that cannot act as
 * the reader. Everything else passes through as bytes, streamed, so the dev
 * server's reload event stream reaches the page as it is written. Nothing
 * inside the page is rewritten: the site builds its links under the prefix.
 *
 * Access is decided above this module and nowhere in it. The host guard
 * admits a share or collab visitor to `apps/<id>/…` only for an app filed on
 * the board in the path, and GET only; the workspace-scope middleware has
 * already refused an app that is not on this board. So nothing here reads
 * the visitor.
 */
import type { DocMeta, DocType } from '@claude-workspaces/core';
import {
  appPrefix,
  isHtmlResponse,
  parseLoopbackOrigin,
  relayedResponseHeaders,
  upstreamRequestHeaders,
  upstreamUrl,
} from '../app-proxy.ts';
import type { BrowserSentryConfig } from '../browser-sentry.ts';
import { injectSentryHead } from '../browser-sentry.ts';
import type { DocStore } from '../doc-store.ts';
import { type WorkspaceScope, restIs } from '../middleware/workspace-scope.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import {
  MOCK_FRAME_CSP,
  MOCK_HOST_HEADERS,
  injectFrameScripts,
  isMockFrameRequest,
  renderMockHost,
} from '../mockup-frame.ts';
import { appLinkWarning, linksOutsidePrefix, rootRelativePageLinks } from '../mockup-page-links.ts';
import { injectWidget } from '../mockup-widget.ts';
import { readAppAssetManifest, renderAppNotFound, renderAppUnreachable } from '../shells.ts';
import { safeDecodeSegment } from '../workspace-path.ts';

/** What the app routes read. Every member is long-lived. */
export interface AppRoutesContext {
  docStore: DocStore;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  isValidDocId: (id: string) => boolean;
  fileUnderBoardWorkspace: (attachmentId: string, requested?: string) => string | undefined;
  withReviewUrl: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string };
  widgetDist: string | null;
  markdownAppDist: string | null;
  browserSentry: BrowserSentryConfig | null;
  /** This server's own port, which an app may not be bound to. */
  ownPort: () => number | undefined;
}

export interface AppRouteRequest {
  req: Request;
  url: URL;
  scope: WorkspaceScope | undefined;
}

/** `apps/<id>` and whatever follows it, off the scope's remainder. */
const APP_ADDRESS = /^apps\/([^/]+)(?:\/(.*))?$/;

/** How long an attach waits to learn whether the dev server answers. */
const PROBE_MS = 1500;

const html = (body: string, status: number): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** The app routes, or `undefined` when neither matched. */
export async function handleAppRoutes(
  ctx: AppRoutesContext,
  rq: AppRouteRequest,
): Promise<Response | undefined> {
  const { scope, req } = rq;
  if (restIs(scope, 'apps') && req.method === 'POST') return attachApp(ctx, rq, scope.workspaceId);
  const m = scope?.rest.match(APP_ADDRESS);
  if (!scope || !m) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return ctx.j(405, { error: 'method_not_allowed', allowed: ['GET', 'HEAD'] });
  }
  return serveApp(ctx, rq, scope.workspaceId, m[1] ?? '', m[2]);
}

async function attachApp(
  ctx: AppRoutesContext,
  rq: AppRouteRequest,
  workspaceId: string,
): Promise<Response> {
  const { docStore, j } = ctx;
  // A bind names something on this machine. Agents only, as every bind is.
  if (isBrowserRequest(rq.req.headers)) return j(403, browserCannotBindBody());
  const body = await ctx.safeJson(rq.req);
  const name = typeof body?.docId === 'string' ? body.docId : '';
  if (!ctx.isValidDocId(name)) return j(400, { error: 'bad docId' });
  const origin = parseLoopbackOrigin(body?.origin, ctx.ownPort());
  if (!origin.ok) return j(400, { error: 'origin_not_loopback', message: origin.error });
  // A name already held by a doc of another kind stays that doc. Turning a
  // markdown doc into an app would strand its content behind a proxy.
  const held = docStore.peekMeta(name);
  if (held && held.type !== 'app') {
    return j(409, {
      error: 'name_held_by_other_kind',
      message: `"${name}" is already a ${held.type} doc. Pick another name for the app.`,
    });
  }
  const created = docStore.createForCaller(name, {
    type: 'app',
    ...(typeof body?.title === 'string' ? { title: body.title } : {}),
    ...(typeof body?.owner === 'string' ? { owner: body.owner } : {}),
  });
  if (!created.ok) return j(400, { error: created.error });
  const docId = created.doc.docId;
  // The origin is set as a repoint rather than at creation: a creation that
  // carries a `sourceUrl` asks the repo registry which document that PATH
  // is, and an origin is not a path.
  docStore.getOrCreate(docId, { sourceUrl: origin.origin });
  ctx.fileUnderBoardWorkspace(docId, workspaceId);
  const root = await probe(origin.origin);
  const meta = ctx.withReviewUrl(docStore.get(docId)?.meta ?? created.doc.meta);
  const prefix = appPrefix(workspaceId, docId);
  // A dev server started without the board's base path writes links that
  // leave the mount. An unreachable app is not judged: there is no page yet.
  const escaping =
    root.html === null ? [] : linksOutsidePrefix(rootRelativePageLinks(root.html), prefix);
  const warning = appLinkWarning(escaping, prefix);
  return j(200, {
    ...(warning ? { warning: warning.message, linkWarning: warning } : {}),
    docId,
    prefix,
    origin: origin.origin,
    reachable: root.reachable,
    reviewUrl: meta.reviewUrl,
    meta,
  });
}

/** The most of the root page the link check reads. */
const PROBE_HTML_MAX = 2 * 1024 * 1024;

/** Does anything answer at the origin, and what HTML is its root page?
 *  Informational: a server not started yet is an ordinary state to attach
 *  in. `html` is null for anything but a 2xx HTML answer. */
async function probe(origin: string): Promise<{ reachable: boolean; html: string | null }> {
  let r: Response;
  try {
    r = await fetch(`${origin}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_MS),
    });
  } catch {
    return { reachable: false, html: null };
  }
  const length = Number(r.headers.get('content-length') ?? 0);
  if (!r.ok || !isHtmlResponse(r.headers) || length > PROBE_HTML_MAX) {
    await r.body?.cancel();
    return { reachable: true, html: null };
  }
  try {
    const html = await r.text();
    return { reachable: true, html: html.length > PROBE_HTML_MAX ? null : html };
  } catch {
    return { reachable: true, html: null };
  }
}

async function serveApp(
  ctx: AppRoutesContext,
  rq: AppRouteRequest,
  workspaceId: string,
  rawId: string,
  tail: string | undefined,
): Promise<Response> {
  const { docStore, j } = ctx;
  const { req, url } = rq;
  const id = safeDecodeSegment(rawId);
  if (!ctx.isValidDocId(id)) return j(400, { error: 'bad docId' });
  const canonical = docStore.resolveDocId(id);
  const meta: DocMeta | undefined = docStore.peekMeta(canonical);
  const origin = meta?.type === 'app' ? meta.sourceUrl : undefined;
  if (!meta || !origin) return html(renderAppNotFound(id), 404);
  const prefix = appPrefix(workspaceId, meta.docId);
  // `apps/<id>` with no slash: the app's relative links would resolve one
  // level up, outside it.
  if (tail === undefined) {
    return new Response(null, { status: 302, headers: { location: `${prefix}${url.search}` } });
  }
  const target = upstreamUrl(origin, tail, url.search);
  if (!target) return j(400, { error: 'path_outside_app' });

  let up: Response;
  try {
    up = await fetch(target, {
      method: req.method,
      headers: upstreamRequestHeaders(req.headers),
      redirect: 'manual',
      // A reader who closes the page closes the upstream request too, which
      // is what ends a proxied event stream rather than leaving it open.
      signal: req.signal,
    });
  } catch {
    return html(renderAppUnreachable(), 502);
  }
  const headers = relayedResponseHeaders(up.headers, origin, prefix);

  if (req.method === 'GET' && isHtmlResponse(up.headers)) {
    const page = await up.text();
    const dest = req.headers.get('sec-fetch-dest');
    if (isMockFrameRequest(url)) return frameResponse(ctx, page, url, workspaceId, meta, up.status);
    // A person opening the address gets the host page. A fetch of HTML from
    // inside the app (a partial, relayed through the host) gets the bytes.
    if (dest === null || dest === 'document') {
      const host = injectSentryHead(
        renderMockHost({ workspaceId, docId: meta.docId, html: page, url, items: [] }),
        ctx.browserSentry,
        'mockup',
        readAppAssetManifest(ctx.markdownAppDist),
      );
      return new Response(host, { status: up.status, headers: MOCK_HOST_HEADERS });
    }
    headers.set('content-security-policy', 'sandbox');
    return new Response(page, { status: up.status, headers });
  }
  // Bytes. Sandboxed all the same: an SVG or XML file opened by its address
  // is a document that runs its own script on this origin. A policy on a
  // script, a stylesheet or an event stream changes nothing about how it is
  // used as a subresource.
  headers.set('content-security-policy', 'sandbox');
  const empty = req.method === 'HEAD' || up.status === 204 || up.status === 304;
  return new Response(empty ? null : up.body, { status: up.status, headers });
}

/** The app's own page, as the frame holds it. */
function frameResponse(
  ctx: AppRoutesContext,
  page: string,
  url: URL,
  workspaceId: string,
  meta: DocMeta,
  status: number,
): Response {
  const withWidget = injectWidget(page, meta.docId, workspaceId);
  const body = injectFrameScripts(withWidget, url, ctx.widgetDist, ctx.markdownAppDist);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': MOCK_FRAME_CSP,
    },
  });
}
