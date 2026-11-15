/**
 * The app's HTML. Every page links the shared theme, then the app's own
 * styles, then the one script; the script reads what to do from `data-*`
 * attributes on <body>.
 */
import type { Principal } from './collab/index.ts';

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

function shell(title: string, body: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/main.js"></script>
</head><body${attrs}><main class="app-page">${body}</main></body></html>`;
}

function header(appName: string, who: Principal): string {
  return `<header class="app-row">
<h1><a href="/">${esc(appName)}</a></h1>
<form method="post" action="/auth/sign-out" class="app-row">
<wa-avatar initials="${esc((who.name ?? who.id).slice(0, 1).toUpperCase())}" label="${esc(who.name ?? who.id)}"></wa-avatar>
<span>${esc(who.name ?? who.id)}</span>
<wa-button type="submit" size="small" appearance="outlined">Sign out</wa-button>
</form></header>`;
}

export function homePage(appName: string, who: Principal): string {
  return shell(
    appName,
    `${header(appName, who)}
<form class="app-row" id="open-doc">
<input name="doc" aria-label="Doc name" placeholder="Doc name, e.g. notes" pattern="[A-Za-z0-9_-]{1,128}" required>
<wa-button type="submit" variant="brand">Open</wa-button>
</form>`,
    { page: 'home' },
  );
}

export function docPage(appName: string, who: Principal, docId: string): string {
  return shell(
    `${docId} · ${appName}`,
    `${header(appName, who)}
<h2>${esc(docId)}</h2>
<p class="app-quiet" id="status" role="status">Connecting…</p>
<textarea id="body" aria-label="Doc text" rows="16" disabled></textarea>`,
    { page: 'doc', doc: docId },
  );
}
