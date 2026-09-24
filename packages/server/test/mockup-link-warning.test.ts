import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

// attach_mockup on one page of a built site: its root-relative links resolve
// against the workspaces host inside /workspaces/<ws>/mockups/<id>, and the
// reviewer's click lands on an error page. The bind warns, naming the links,
// and names the board's app when one already serves the site.

const LINKED = `<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body>
<a href="/projects/harborlight/">Harborlight</a>
<a href='/projects/riverbend/'>Riverbend</a>
<a href="//cdn.example.test/x">cdn</a>
<a href="https://example.test/">abs</a>
<a href="#top">top</a>
<form action="/search"><input name="q"></form>
</body></html>`;

const ASSETS_ONLY = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js"></script>
</head><body><img src="/assets/saltmarsh.png"><a href="details.html">Details</a></body></html>`;

interface BindBody {
  warning?: string;
  linkWarning?: { links: string[]; count: number; appUrl?: string };
}

describe('attach_mockup warns about root-relative page links', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mockup-link-warn-'));
    writeFileSync(join(dataDir, 'linked.html'), LINKED);
    writeFileSync(join(dataDir, 'assets-only.html'), ASSETS_ONLY);
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function post(ws: string, path: string, body: Record<string, unknown>) {
    const res = await fetch(`${base}/workspaces/${ws}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  }

  const bind = (ws: string, docId: string, file: string) =>
    post(ws, 'docs', {
      docId,
      type: 'mockup',
      sourceUrl: join(dataDir, file),
    }) as Promise<BindBody>;

  for (const withApp of [true, false]) {
    describe(withApp ? 'on a board with an app attached' : 'on a board with no app', () => {
      let ws = '';
      let appUrl: string | undefined;

      beforeAll(async () => {
        ws = await seedBoard(base, { name: withApp ? 'Harborlight site' : 'Riverbend site' });
        if (withApp) {
          // Nothing listens on port 9; an unreachable app is an ordinary
          // state to attach in, and the address is all this test needs.
          const app = (await post(ws, 'apps', {
            docId: 'harborlight-site',
            origin: 'http://127.0.0.1:9',
          })) as { reviewUrl?: string };
          appUrl = app.reviewUrl;
          expect(appUrl).toContain(`/workspaces/${ws}/apps/`);
        }
      });

      it('names the root-relative anchors and form action, and the count', async () => {
        const res = await bind(ws, 'linked-page', 'linked.html');
        expect(res.linkWarning?.links).toEqual([
          '/projects/harborlight/',
          '/projects/riverbend/',
          '/search',
        ]);
        expect(res.linkWarning?.count).toBe(3);
        expect(res.warning).toContain('/projects/harborlight/');
        if (withApp) {
          expect(res.linkWarning?.appUrl).toBe(appUrl);
          expect(res.warning).toContain(appUrl ?? 'missing app url');
        } else {
          expect(res.linkWarning?.appUrl).toBeUndefined();
          expect(res.warning).toContain('attach_app');
        }
      });

      it('gives no warning when the only root-relative URLs are assets', async () => {
        const res = await bind(ws, 'assets-page', 'assets-only.html');
        expect(res.warning).toBeUndefined();
        expect(res.linkWarning).toBeUndefined();
      });
    });
  }
});
