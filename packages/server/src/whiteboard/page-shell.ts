/**
 * The whiteboard page's HTML shell (`/workspaces/<ws>/whiteboards/<id>`).
 *
 * The doc page's own top bar (back to the board, the title, who is here,
 * `index.html` in workspaces-app) over one canvas that fills the rest of the
 * screen, with the board's nav beside them as on a mock page (`hostNav`),
 * which a share visitor does not get. The canvas, the bar's people and the chat with the lead are
 * `/app/whiteboard.js`, which loads Excalidraw lazily so the bar paints before
 * the canvas library arrives. The stylesheets are the chrome
 * every page shares, then this page's own, then the token layer last, the
 * order the other shells use.
 */
import { type AssetManifest, assetHref } from '@claude-workspaces/core/asset-manifest';
import { NAV_BAR_H, NAV_RAIL_W, hostNav } from '../board-host-nav.ts';
import { type BrowserSentryConfig, sentryHeadTags } from '../browser-sentry.ts';
import { escape } from '../shells.ts';

export interface WhiteboardShellInput {
  workspaceId: string;
  docId: string;
  title: string;
  /** A share visitor, admitted by the gate: no nav, as on a mock page. */
  visitor: boolean;
}

/** The nav, and the room `whiteboard.css` leaves for it. */
function pageNav(workspaceId: string): { head: string; body: string } {
  const { style, html } = hostNav(workspaceId);
  const room =
    `@media (min-width:1101px){:root{--wb-nav-left:${NAV_RAIL_W}px}}` +
    `@media (max-width:1100px){:root{--wb-nav-foot:calc(${NAV_BAR_H}px + env(safe-area-inset-bottom,0px))}}`;
  return { head: `\n    <style>${style}${room}</style>`, body: `\n    ${html}` };
}

export function renderWhiteboardShell(
  input: WhiteboardShellInput,
  sentry: BrowserSentryConfig | null,
  assets: AssetManifest = {},
): string {
  const sentryTags = sentryHeadTags(sentry, 'doc', assets);
  const sentryMeta = sentryTags ? `\n    ${sentryTags}` : '';
  const board = `/workspaces/${encodeURIComponent(input.workspaceId)}`;
  const nav = input.visitor ? { head: '', body: '' } : pageNav(input.workspaceId);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
    <title>${escape(input.title)} · Workspaces</title>
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#2e7dd7" />${sentryMeta}
    <link rel="stylesheet" href="${assetHref(assets, 'styles.css')}" />
    <link rel="stylesheet" href="/app/whiteboard/excalidraw.css" />
    <link rel="stylesheet" href="${assetHref(assets, 'whiteboard.css')}" />
    <link rel="stylesheet" href="${assetHref(assets, 'tokens.css')}" />${nav.head}
  </head>
  <body class="whiteboard-body" data-workspace-id="${escape(input.workspaceId)}" data-doc-id="${escape(input.docId)}">
    <header id="topbar">
      <div class="doc-crumb">
        <a class="back-link" href="${escape(board)}" title="Back to the board" aria-label="Back to the board">←</a>
        <span class="doc-path" dir="ltr" id="wb-title">${escape(input.title)}</span>
      </div>
      <div class="toolbar">
        <div id="doc-people" class="hidden"></div>
        <span class="wb-presence" id="wb-presence" aria-live="polite">Connecting…</span>
      </div>
    </header>
    <main class="wb-stage" id="wb-stage"><div class="wb-loading" id="wb-loading">Loading the canvas…</div></main>${nav.body}
    <script type="module" src="${assetHref(assets, 'whiteboard.js')}"></script>
  </body>
</html>`;
}
