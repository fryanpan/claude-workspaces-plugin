/**
 * The whiteboard page's half of the app build: its own entry, and the
 * Excalidraw stylesheet and fonts it serves itself. Called from `build.ts`.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Build `/app/whiteboard.js` (served by the shell `whiteboard/page-shell.ts`
 * renders). Splitting is on: Excalidraw and the React it needs sit behind one
 * `import()`, so the header and the socket come up while the canvas
 * downloads. Returns the build's error logs, empty on success.
 */
export async function buildWhiteboard(opts: {
  pkgRoot: string;
  dist: string;
  define: Record<string, string>;
  minify: boolean;
}): Promise<readonly unknown[]> {
  const result = await Bun.build({
    entrypoints: [join(opts.pkgRoot, 'src', 'whiteboard', 'whiteboard-entry.ts')],
    outdir: opts.dist,
    target: 'browser',
    format: 'esm',
    splitting: true,
    sourcemap: 'external',
    define: { ...opts.define, 'process.env.NODE_ENV': JSON.stringify('production') },
    naming: { entry: 'whiteboard.js', chunk: '[name]-[hash].js', asset: '[name].[ext]' },
    minify: opts.minify,
  });
  return result.success ? [] : result.logs.length > 0 ? result.logs : ['unknown failure'];
}

/**
 * Excalidraw's stylesheet and the fonts it draws text in, served from here
 * (`EXCALIDRAW_ASSET_PATH`) rather than its CDN, plus the page's own
 * stylesheet. Xiaolai, its 12MB CJK face, is left out: a missing glyph falls
 * back to a system font.
 */
export function copyWhiteboardAssets(pkgRoot: string, dist: string): void {
  const excalidrawDist = dirname(
    createRequire(join(pkgRoot, 'package.json')).resolve('@excalidraw/excalidraw'),
  );
  mkdirSync(join(dist, 'whiteboard'), { recursive: true });
  cpSync(join(excalidrawDist, 'index.css'), join(dist, 'whiteboard', 'excalidraw.css'));
  cpSync(join(excalidrawDist, 'fonts'), join(dist, 'whiteboard', 'fonts'), {
    recursive: true,
    filter: (src) => !src.includes('Xiaolai'),
  });
  cpSync(join(pkgRoot, 'src', 'whiteboard.css'), join(dist, 'whiteboard.css'));
}
