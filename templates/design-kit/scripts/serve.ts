#!/usr/bin/env bun
/**
 * Serve the built trial. A page is served under its theme's name:
 *
 *   /t/<theme>/review-list.html   the plain page
 *   /t/<theme>/tasks.html         the Preact page
 *   /t/<theme>/theme.css          dist/themes/<theme>.css
 *
 * The page files are the same bytes under every theme. Their relative
 * `theme.css` link resolves under the theme's prefix, so the URL picks the
 * theme file and the markup never does.
 *
 *   bun run serve [--port 8796]    port 0 (any free port) by default
 */
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { DIST, KIT_ROOT, themeNames } from './build.ts';

const PAGES = new Set(['review-list.html', 'tasks.html']);
const ASSETS = new Set(['kit.js', 'tasks.js', 'kit.css']);

/** Resolve a request path to a file on disk, or null for a 404. */
export function resolvePath(pathname: string, themes: readonly string[]): string | null {
  const theme = /^\/t\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(pathname);
  if (theme) {
    const [, name, file] = theme;
    if (!name || !file || !themes.includes(name)) return null;
    if (file === 'theme.css') return join(DIST, 'themes', `${name}.css`);
    if (PAGES.has(file)) return join(KIT_ROOT, 'pages', file);
    return null;
  }
  const asset = normalize(pathname).replace(/^\/+/, '');
  if (ASSETS.has(asset)) return join(DIST, asset);
  return null;
}

export function startServer(port = 0): ReturnType<typeof Bun.serve> {
  const themes = themeNames();
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      const file = resolvePath(new URL(req.url).pathname, themes);
      if (!file || !existsSync(file)) return new Response('not found', { status: 404 });
      // No caching: every measured load is a cold one.
      return new Response(Bun.file(file), { headers: { 'cache-control': 'no-store' } });
    },
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf('--port');
  const server = startServer(i > 0 ? Number(process.argv[i + 1]) : 0);
  console.log(`design-kit trial on http://127.0.0.1:${server.port}/t/workspaces/review-list.html`);
}
