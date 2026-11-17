/**
 * The Web Awesome theme file's half of the app build. Called from `build.ts`.
 */
import { join } from 'node:path';

/**
 * Build `/app/wa-theme.css` from `src/wa-theme.css`. Bundled rather than
 * copied, because its base theme is an `@import` out of node_modules and the
 * served file must stand alone. The board links it only on a board the collab
 * core serves (`presence-island-wa.tsx`). Returns the build's error logs,
 * empty on success.
 */
export async function buildWaTheme(pkgRoot: string, dist: string): Promise<readonly unknown[]> {
  const result = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'wa-theme.css')],
    outdir: dist,
    minify: true,
  });
  return result.success ? [] : result.logs;
}
