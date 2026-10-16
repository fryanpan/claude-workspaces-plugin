/**
 * The whiteboard page's HTML shell (`/workspaces/<ws>/whiteboards/<id>`).
 *
 * A thin header (back to the board, the title, who is here) over one canvas
 * that fills the rest of the screen. The canvas and everything that draws on
 * it are `/app/whiteboard.js`, which loads Excalidraw lazily so the header
 * paints before the canvas library arrives. The stylesheets are the chrome
 * every page shares, then this page's own, then the token layer last, the
 * order the other shells use.
 */
import { type AssetManifest, assetHref } from '@claude-workspaces/core/asset-manifest';
import { type BrowserSentryConfig, sentryHeadTags } from '../browser-sentry.ts';
import { escape } from '../shells.ts';

export interface WhiteboardShellInput {
  workspaceId: string;
  docId: string;
  title: string;
}

export function renderWhiteboardShell(
  input: WhiteboardShellInput,
  sentry: BrowserSentryConfig | null,
  assets: AssetManifest = {},
): string {
  const sentryTags = sentryHeadTags(sentry, 'doc', assets);
  const sentryMeta = sentryTags ? `\n    ${sentryTags}` : '';
  const board = `/workspaces/${encodeURIComponent(input.workspaceId)}`;
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
    <link rel="stylesheet" href="${assetHref(assets, 'tokens.css')}" />
  </head>
  <body class="whiteboard-body" data-workspace-id="${escape(input.workspaceId)}" data-doc-id="${escape(input.docId)}">
    <header class="wb-bar">
      <a class="back-link" href="${escape(board)}" title="Back to the board" aria-label="Back to the board">←</a>
      <span class="wb-title" id="wb-title">${escape(input.title)}</span>
      <span class="wb-presence" id="wb-presence" aria-live="polite">Connecting…</span>
    </header>
    <main class="wb-stage" id="wb-stage"><div class="wb-loading" id="wb-loading">Loading the canvas…</div></main>
    <script type="module" src="${assetHref(assets, 'whiteboard.js')}"></script>
  </body>
</html>`;
}
