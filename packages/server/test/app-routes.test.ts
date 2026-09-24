/**
 * An agent attaches a loopback dev server to a board, and the board serves
 * it under `/workspaces/<ws>/apps/<id>/` in the mock's host-and-frame shape.
 *
 * Driven through the real route table against a fixture dev server
 * (`app-dev-server-fixture.ts`). Who may read the app is the access suite's
 * question (`app-access.test.ts`); these requests are the owner's, from
 * loopback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOCK_FRAME_CSP } from '../src/mockup-frame.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };

describe('attaching and serving a dev server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let ws = '';
  let app = '';
  let prefix = '';

  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const send = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL(), ...extra },
      body: JSON.stringify(body),
    });
  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { ...LOCAL(), ...extra }, redirect: 'manual' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-routes-'));
    dev = startDevServer();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await send('/workspaces', { name: 'Harborlight events', author: AGENT });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await send(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: `${dev.origin}/`,
      title: 'Harborlight site',
    });
    expect(attached.status, await attached.clone().text()).toBe(200);
    const body = (await attached.json()) as {
      docId: string;
      prefix: string;
      origin: string;
      reachable: boolean;
    };
    app = body.docId;
    prefix = body.prefix;
    expect(body.origin).toBe(dev.origin);
    expect(body.reachable).toBe(true);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('the attach verb', () => {
    it('answers a minted doc id and the prefix the site builds under', async () => {
      expect(app).toMatch(/^d-/);
      expect(prefix).toBe(`/workspaces/${ws}/apps/${app}/`);
      const board = (await (await get(`/workspaces/${ws}?format=json`)).json()) as {
        workspace: { docIds: string[] };
      };
      expect(board.workspace.docIds).toContain(app);
    });

    it('refuses an origin that is not loopback, naming the rule', async () => {
      for (const origin of [
        'http://example.com:80',
        'https://127.0.0.1:4000',
        'http://10.1.2.3:4000',
      ]) {
        const r = await send(`/workspaces/${ws}/apps`, { docId: 'elsewhere', origin });
        expect(r.status).toBe(400);
        const body = (await r.json()) as { error: string; message: string };
        expect(body.error).toBe('origin_not_loopback');
        expect(body.message).toContain('http://127.0.0.1:<port>');
      }
    });

    it("refuses this server's own port", async () => {
      const r = await send(`/workspaces/${ws}/apps`, {
        docId: 'itself',
        origin: `http://127.0.0.1:${handle.port}`,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('origin_not_loopback');
    });

    it('refuses a browser, whatever it sends', async () => {
      const r = await send(
        `/workspaces/${ws}/apps`,
        { docId: 'from-a-page', origin: dev.origin },
        { origin: base, 'sec-fetch-site': 'same-origin' },
      );
      expect(r.ok).toBe(false);
      const docs = (await (await get(`/workspaces/${ws}/docs`)).json()) as {
        docs: Array<{ alias?: string }>;
      };
      expect(docs.docs.some((d) => d.alias === 'from-a-page')).toBe(false);
    });

    it('will not turn a doc of another kind into an app', async () => {
      const file = join(dataDir, 'notes.md');
      writeFileSync(file, '# Notes\n');
      const doc = await send(`/workspaces/${ws}/docs`, {
        docId: 'riverbend-notes',
        type: 'markdown',
        sourceUrl: file,
      });
      expect(doc.status).toBe(200);
      const r = await send(`/workspaces/${ws}/apps`, {
        docId: 'riverbend-notes',
        origin: dev.origin,
      });
      expect(r.status).toBe(409);
    });

    it('sends an app made through the generic docs route to the apps route', async () => {
      const r = await send(`/workspaces/${ws}/docs`, {
        docId: 'sideways',
        type: 'app',
        sourceUrl: dev.origin,
      });
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('/apps');
    });

    it('re-attaching the same name repoints the same doc', async () => {
      const other = startDevServer();
      try {
        const again = await send(`/workspaces/${ws}/apps`, {
          docId: 'harborlight-site',
          origin: other.origin,
        });
        expect(again.status).toBe(200);
        const body = (await again.json()) as { docId: string; origin: string };
        expect(body.docId).toBe(app);
        expect(body.origin).toBe(other.origin);
      } finally {
        const back = await send(`/workspaces/${ws}/apps`, {
          docId: 'harborlight-site',
          origin: dev.origin,
        });
        expect(back.status).toBe(200);
        await other.stop();
      }
    });
  });

  describe('the proxy', () => {
    it('answers the address a person opens with the host page, not the app', async () => {
      const r = await get(`${prefix}?v=1`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      const html = await r.text();
      expect(html).toContain('data-src="?v=1&amp;cw-frame=1"');
      expect(html).toContain('/widget/mock-host.js');
      expect(html).not.toContain('<h1 id="title">');
      expect(r.headers.get('set-cookie')).toBeNull();
    });

    it("answers the frame with the app's page, sandboxed, with the widget on the app doc", async () => {
      const r = await get(`${prefix}?cw-frame=1`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe(MOCK_FRAME_CSP);
      expect(r.headers.get('x-frame-options')).toBeNull();
      expect(r.headers.get('set-cookie')).toBeNull();
      const html = await r.text();
      expect(html).toContain('<h1 id="title">Harborlight events</h1>');
      expect(html).toContain('claude-feedback-widget');
      expect(html).toContain(app);
      // The page's own link is left as the site wrote it.
      expect(html).toContain('href="site.css"');
    });

    it('relays a file with its headers, minus the hop-by-hop ones', async () => {
      const r = await get(`${prefix}site.css`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('h1{color:#036}');
      expect(r.headers.get('content-type')).toBe('text/css');
      expect(r.headers.get('x-dev-kept')).toBe('keep me');
      expect(r.headers.get('x-dev-hop')).toBeNull();
      expect(r.headers.get('content-security-policy')).toBe('sandbox');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it("never hands the dev server the reader's cookie or identity", async () => {
      const r = await get(`${prefix}echo?q=1&cw-frame=1`, {
        cookie: 'cw_session=abc',
        'cf-access-jwt-assertion': 'jwt',
        accept: 'application/json',
      });
      const seen = (await r.json()) as { headers: Record<string, string>; search: string };
      expect(seen.headers.cookie).toBeUndefined();
      expect(seen.headers['cf-access-jwt-assertion']).toBeUndefined();
      expect(seen.headers.accept).toBe('application/json');
      expect(seen.search).toBe('?q=1');
      // The dev server is addressed as itself, not as the board.
      expect(seen.headers.host).toBe(`127.0.0.1:${dev.port}`);
    });

    it("keeps the page's query on the frame and passes it upstream unchanged", async () => {
      // A fragment never leaves the browser; the host page's script adds it.
      const host = await (await get(`${prefix}?a=1&b=2#map`)).text();
      expect(host).toContain('data-src="?a=1&amp;b=2&amp;cw-frame=1"');
      const r = await get(`${prefix}echo?a=1&b=2&cw-frame=1`);
      expect(((await r.json()) as { search: string }).search).toBe('?a=1&b=2');
    });

    it('reaches the same path with a doubled slash after the prefix', async () => {
      const r = await get(`${prefix}/site.css`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('h1{color:#036}');
    });

    it('gives an HTML fetch from inside the app its bytes, not a host page', async () => {
      const r = await get(`${prefix}partial`, { 'sec-fetch-dest': 'empty' });
      expect(await r.text()).toBe('<li>Riverbend walk</li>');
      expect(r.headers.get('content-security-policy')).toBe('sandbox');
    });

    it('keeps a redirect inside the prefix', async () => {
      const r = await get(`${prefix}about`);
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(`${prefix}about/`);
    });

    it('sends the bare app address to its trailing-slash form', async () => {
      const r = await get(`/workspaces/${ws}/apps/${app}?v=2`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`${prefix}?v=2`);
    });

    it('refuses a path that would leave the app, and a write', async () => {
      // A dot segment is folded by the URL parser before any route sees it,
      // so it names another address and never reaches the dev server.
      const climbed = await get(`${prefix}%2e%2e/echo`);
      expect(climbed.status).toBe(404);
      expect(await climbed.text()).not.toContain('headers');
      expect((await get(`${prefix}%2F%2Fevil.example/`)).status).toBe(400);
      const put = await fetch(`${base}${prefix}echo`, { method: 'POST', headers: LOCAL() });
      expect(put.status).toBe(405);
    });

    it("404s another board's app under this board's path", async () => {
      const made = await send('/workspaces', { name: 'Riverbend walks', author: AGENT });
      const other = ((await made.json()) as { workspace: { id: string } }).workspace.id;
      const attached = await send(`/workspaces/${other}/apps`, {
        docId: 'riverbend-site',
        origin: dev.origin,
      });
      const theirs = ((await attached.json()) as { docId: string }).docId;
      expect((await get(`/workspaces/${other}/apps/${theirs}/site.css`)).status).toBe(200);
      const borrowed = await get(`/workspaces/${ws}/apps/${theirs}/site.css`);
      expect(borrowed.status).toBe(404);
      expect(await borrowed.text()).not.toContain('#036');
    });

    it('404s an id that is not an app', async () => {
      expect((await get(`/workspaces/${ws}/apps/d-none/`)).status).toBe(404);
    });

    it('streams the reload event stream as it is written', async () => {
      const ctl = new AbortController();
      const r = await fetch(`${base}${prefix}__reload`, {
        headers: { ...LOCAL(), accept: 'text/event-stream', 'accept-encoding': 'gzip' },
        signal: ctl.signal,
      });
      expect(r.headers.get('content-type')).toBe('text/event-stream');
      // A stream: no length to wait for, and nothing that buffers to compress.
      expect(r.headers.get('content-length')).toBeNull();
      expect(r.headers.get('content-encoding')).toBeNull();
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}`);
          text += dec.decode(value);
        }
      };
      await readUntil(': open');
      dev.reload();
      await readUntil('event: reload');
      ctl.abort();
      await waitFor(() => dev.openStreams() === 0, {
        describe: 'the upstream stream closed after the reader left',
      });
    });
  });

  it('503s when nothing answers at the origin', async () => {
    const gone = startDevServer();
    const origin = gone.origin;
    await gone.stop();
    const r = await send(`/workspaces/${ws}/apps`, { docId: 'stopped-site', origin });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { prefix: string; reachable: boolean };
    expect(body.reachable).toBe(false);
    expect((await get(body.prefix)).status).toBe(503);
  });

  it('keeps the attachment across a restart', async () => {
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const r = await get(`${prefix}site.css`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('h1{color:#036}');
  });
});
