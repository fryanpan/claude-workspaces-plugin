/**
 * ── A dev server as a board resource: attached by an agent, read by members ──
 *
 * Two addresses, one family:
 *
 *   POST /workspaces/<ws>/apps            attach a loopback dev server
 *   GET  /workspaces/<ws>/apps/<id>/<p>   the app's page or file at <p>
 *   POST /workspaces/<ws>/apps/<id>       ask the agent again to start it
 *
 * The last is the waiting page's "Ask again" (`app-waiting-page.ts`). It is
 * the bare address, with no slash after the id, because every address below
 * the slash is the app's own path and a verb there would shadow one.
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
 * already refused an app that is not on this board. The ask-again POST is
 * the one write a member may make here, admitted by the same case in the
 * host guard; it sends a fixed notice and `AppOutages.askAgain` holds it to
 * one per two minutes. So nothing here reads the visitor to decide access;
 * it is read once, to draw the host page's link back to the board.
 */
import type { DocMeta, DocType } from '@claude-workspaces/core';
import type { AppVoiceSeed } from '@claude-workspaces/core/app-voice';
import { assetHref } from '@claude-workspaces/core/asset-manifest';
import { EMBED_PARAM } from '@claude-workspaces/core/board-embeds';
import type { AppOutages } from '../app-outage.ts';
import {
  appPrefix,
  isHtmlResponse,
  parseLoopbackOrigin,
  relayedResponseHeaders,
  upstreamRequestHeaders,
  upstreamUrl,
} from '../app-proxy.ts';
import { withAppVoiceSeed } from '../app-voice/seed.ts';
import { APP_DOWN_HEADER, renderAppWaiting } from '../app-waiting-page.ts';
import type { BrowserSentryConfig } from '../browser-sentry.ts';
import { injectSentryHead } from '../browser-sentry.ts';
import type { DocStore } from '../doc-store.ts';
import type { FrameHost } from '../frame-host.ts';
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
import { loopbackFetch } from '../outbound-fetch.ts';
import { readAppAssetManifest, renderAppNotFound } from '../shells.ts';
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
  /** Who is told when an app's dev server stops answering (`app-outage.ts`). */
  appOutages: AppOutages;
  /** An agent's display name off the identity roster, when it has one. */
  agentName: (agentId: string) => string | undefined;
  /** The frame-only hostname (`frame-host.ts`), or null when not configured. */
  frameHost: FrameHost | null;
  /** The app voice socket's path and a fresh token for one doc (`app-voice/`). */
  appVoiceSeed: (workspaceId: string, docId: string) => AppVoiceSeed;
}

export interface AppRouteRequest {
  req: Request;
  url: URL;
  scope: WorkspaceScope | undefined;
  /** A share visitor, admitted above; read only to draw the host page's
   *  link back to the board, never to decide access. */
  visitor: boolean;
  /** Whether the frame served to this reader carries an app voice token
   *  (`app-voice/gate.ts`). */
  mayMintAppVoice: boolean;
}

/** `apps/<id>` and whatever follows it, off the scope's remainder. */
const APP_ADDRESS = /^apps\/([^/]+)(?:\/(.*))?$/;

/** How long an attach waits to learn whether the dev server answers. */
const PROBE_MS = 1500;

/**
 * The status "The app is not running" is served with. NOT 502: Cloudflare
 * replaces an origin's 502 or 504 with its own branded "Bad gateway" page
 * (developers.cloudflare.com/support/troubleshooting/http-status-codes/
 * cloudflare-5xx-errors/error-502-504/), and that is what the owner read
 * through the tunnel on 24 September while this server was up and answering.
 * An origin 503 reaches the visitor with the origin's own HTML — Cloudflare's
 * 503 page tells the two apart by whether the page names cloudflare (same
 * docs, error-503/) — and 503 is also the true statement: this server is
 * fine, the service behind it is temporarily unavailable.
 */
const APP_DOWN_STATUS = 503;

/** An attach's `producedBy`, kept only when it is a plain agent id. */
function producedByOf(v: unknown): { agentId: string } | undefined {
  const id = (v as { agentId?: unknown } | null | undefined)?.agentId;
  return typeof id === 'string' && /^[\w.:-]{1,128}$/.test(id) ? { agentId: id } : undefined;
}

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
  if (req.method === 'POST' && m[2] === undefined) return askAgain(ctx, m[1] ?? '');
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
  // A name already held by a doc stays that doc, as a create through the
  // docs route does (`doc-create-conflict.ts`). Turning a markdown doc into
  // an app would strand its content behind a proxy, and pointing an app at
  // another port would put the doc's comments on a page somebody else
  // serves. Attaching the same origin again is a no-op and passes.
  const held = docStore.peekMeta(name);
  const conflict = !held
    ? null
    : held.type !== 'app'
      ? 'type'
      : held.sourceUrl !== origin.origin
        ? 'source'
        : null;
  if (held && conflict) {
    return j(409, {
      error: 'doc_exists',
      docId: held.docId,
      conflict,
      message:
        conflict === 'type'
          ? `"${name}" is already a ${held.type ?? 'doc'}. Pick another name for the app.`
          : `"${name}" is already attached to ${held.sourceUrl ?? 'another origin'}. Pick another name for this origin.`,
    });
  }
  const producedBy = producedByOf(body?.producedBy);
  const created = docStore.createForCaller(name, {
    type: 'app',
    ...(typeof body?.title === 'string' ? { title: body.title } : {}),
    ...(typeof body?.owner === 'string' ? { owner: body.owner } : {}),
    // Who to tell when the dev server stops answering (`app-outage.ts`).
    ...(producedBy ? { producedBy } : {}),
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
    url: meta.reviewUrl,
    meta,
  });
}

/**
 * "Ask again" from the waiting page: a fresh notice for the outage in
 * progress. No body is read — the app, the agent and the words all come from
 * the records — so the only input is the doc id in the path.
 */
function askAgain(ctx: AppRoutesContext, rawId: string): Response {
  const { docStore, j } = ctx;
  const id = safeDecodeSegment(rawId);
  if (!ctx.isValidDocId(id)) return j(400, { error: 'bad docId' });
  const meta = docStore.peekMeta(docStore.resolveDocId(id));
  if (meta?.type !== 'app') return j(404, { error: 'app_not_found' });
  const asked = ctx.appOutages.askAgain(meta.docId);
  if (asked.ok) {
    return j(200, {
      askedAt: asked.askedAt,
      to: ctx.agentName(asked.to) ?? asked.to,
      addressedAs: asked.addressedAs,
    });
  }
  if (asked.reason === 'too_soon') {
    const r = j(429, { error: 'asked_recently', retryAt: asked.retryAt });
    r.headers.set(
      'retry-after',
      String(Math.max(1, Math.ceil((asked.retryAt - Date.now()) / 1000))),
    );
    return r;
  }
  return j(409, { error: asked.reason === 'nobody' ? 'nobody_to_ask' : 'app_answering' });
}

/** The page a reader gets while the app is down, uncached and marked. */
function waitingResponse(
  ctx: AppRoutesContext,
  workspaceId: string,
  meta: DocMeta,
  prefix: string,
): Response {
  const now = Date.now();
  // `failed` has just recorded the outage; the fallback is for the page, never
  // for a state that should exist.
  const outage = ctx.appOutages.outage(meta.docId) ?? { since: now, askedAt: now };
  const body = renderAppWaiting({
    app: meta.title || meta.docId,
    boardHref: `/workspaces/${encodeURIComponent(workspaceId)}`,
    askUrl: prefix.replace(/\/$/, ''),
    outage,
    ...(outage.to ? { askedName: ctx.agentName(outage.to) ?? outage.to } : {}),
    now,
  });
  return new Response(body, {
    status: APP_DOWN_STATUS,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The edge must not keep the error page once the app is back.
      'cache-control': 'no-store',
      [APP_DOWN_HEADER]: '1',
    },
  });
}

/** The app's origin was checked as loopback when it was attached. */
const attachedAppFetch = loopbackFetch('attached-app');

/** The most of the root page the link check reads. */
const PROBE_HTML_MAX = 2 * 1024 * 1024;

/** Does anything answer at the origin, and what HTML is its root page?
 *  Informational: a server not started yet is an ordinary state to attach
 *  in. `html` is null for anything but a 2xx HTML answer. */
async function probe(origin: string): Promise<{ reachable: boolean; html: string | null }> {
  let r: Response;
  try {
    r = await attachedAppFetch(`${origin}/`, {
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
    up = await attachedAppFetch(target, {
      method: req.method,
      headers: upstreamRequestHeaders(req.headers),
      redirect: 'manual',
      // A reader who closes the page closes the upstream request too, which
      // is what ends a proxied event stream rather than leaving it open.
      signal: req.signal,
    });
  } catch (err) {
    // A reader who closed the page aborts the fetch; that is not an outage.
    if (req.signal.aborted) return new Response(null, { status: APP_DOWN_STATUS });
    ctx.appOutages.failed({
      workspaceId,
      docId: meta.docId,
      ...(meta.title ? { title: meta.title } : {}),
      origin,
      prefix,
      reason: err instanceof Error ? err.message : String(err),
      ...(meta.producedBy?.agentId ? { attachedBy: meta.producedBy.agentId } : {}),
    });
    return waitingResponse(ctx, workspaceId, meta, prefix);
  }
  ctx.appOutages.answered(meta.docId);
  const headers = relayedResponseHeaders(up.headers, origin, prefix);

  if (req.method === 'GET' && isHtmlResponse(up.headers)) {
    const page = await up.text();
    const dest = req.headers.get('sec-fetch-dest');
    const onFrameHost = ctx.frameHost?.isFrameHost(req) === true;
    if (isMockFrameRequest(url)) {
      const voiced = withAppVoiceSeed(page, () =>
        rq.mayMintAppVoice ? ctx.appVoiceSeed(workspaceId, meta.docId) : null,
      );
      return frameResponse(ctx, voiced, url, workspaceId, meta, up.status, onFrameHost);
    }
    // A person opening the address gets the host page. A fetch of HTML from
    // inside the app (a partial, relayed through the host) gets the bytes.
    // Never on the frame hostname, which holds frames and is framed by the
    // board alone (`frame-host.ts`).
    if ((dest === null || dest === 'document') && !onFrameHost) {
      const assets = readAppAssetManifest(ctx.markdownAppDist);
      const host = injectSentryHead(
        renderMockHost({
          workspaceId,
          docId: meta.docId,
          html: page,
          url,
          items: [],
          visitor: rq.visitor,
          coachHref: assetHref(assets, 'coach.js'),
          frameOrigin: ctx.frameHost?.frameOriginFor(req, rq.visitor) ?? null,
        }),
        ctx.browserSentry,
        'mockup',
        assets,
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
  onFrameHost: boolean,
): Response {
  // A doc's board embed (`doc/board-embed-frames.ts`) is read-only, so it
  // gets the app's page without the comment widget's buttons over it.
  const withWidget =
    url.searchParams.get(EMBED_PARAM) === '1' ? page : injectWidget(page, meta.docId, workspaceId);
  const body = injectFrameScripts(withWidget, url, ctx.widgetDist, ctx.markdownAppDist);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy':
        onFrameHost && ctx.frameHost ? ctx.frameHost.frameCsp : MOCK_FRAME_CSP,
    },
  });
}
