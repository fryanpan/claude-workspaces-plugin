/**
 * A stand-in for a Vite dev server started with `base`, for the attached-app
 * tests: the Harborlight admin dashboard, a single-page app whose router
 * reads its basename from `import.meta.env.BASE_URL`.
 *
 * What it copies from Vite 6 is the part the board's proxy has to get right:
 * the base middleware (`baseMiddleware` in vite/dist/node). A request under
 * the base is served; `/` is redirected to the base; anything else is a 404
 * that names the base. So a proxy that strips the board's prefix before
 * asking gets a redirect loop or a 404, exactly as it would from Vite.
 *
 * The page is Vite's shape: every script is a module named by a
 * root-absolute path under the base, the client first, and the entry
 * imports a second module. Bound to a loopback port; fixtures are fictional.
 *
 * The base is set after the fixture starts, because that is the order an
 * agent works in: it attaches the port first, and the board answers the
 * prefix the dev server is then started under.
 */

export interface ViteFixture {
  origin: string;
  /** Every path the fixture was asked for, in order. */
  asked: string[];
  /** Start serving under `base`, as `vite --base <base>` does. */
  setBase(base: string): void;
  stop(): Promise<void>;
}

const JS = { 'content-type': 'text/javascript' };

export function startViteFixture(): ViteFixture {
  const asked: string[] = [];
  let base = '/';
  const page = () =>
    '<!doctype html><html><head><title>Harborlight admin</title>' +
    `<script type="module" src="${base}@vite/client"></script></head>` +
    '<body><div id="root"></div>' +
    `<script type="module" src="${base}src/main.ts"></script></body></html>`;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      asked.push(url.pathname);
      if (!url.pathname.startsWith(base)) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(null, { status: 302, headers: { location: `${base}${url.search}` } });
        }
        return new Response(
          `The server is configured with a public base URL of ${base} - did you mean to visit ${base}${url.pathname.slice(1)} instead?`,
          { status: 404, headers: { 'content-type': 'text/plain' } },
        );
      }
      const rest = url.pathname.slice(base.length);
      switch (rest) {
        case '':
        case 'index.html':
        // The router's own pages: the dev server answers index.html for them.
        case 'berths':
          return new Response(page(), { headers: { 'content-type': 'text/html' } });
        case '@vite/client':
          return new Response('export const hmr = "harborlight";', { headers: JS });
        case 'src/main.ts':
          return new Response(
            "import { routes } from './router.ts';\n" +
              "document.getElementById('root').textContent = routes.join(',');\n",
            { headers: JS },
          );
        case 'src/router.ts':
          return new Response(
            `export const basename = ${JSON.stringify(base)};\nexport const routes = ['berths', 'tides'];\n`,
            { headers: JS },
          );
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port ?? 0}`,
    asked,
    setBase(b) {
      base = b;
    },
    stop: () => server.stop(true),
  };
}
