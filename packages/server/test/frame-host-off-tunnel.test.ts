/**
 * The frame hostname off the tunnel (`request-admission.ts`, kind `frame`):
 * a ticket or a cookie admits this machine only. Before, a LAN or tailnet
 * caller holding one was admitted, with the external-access switch not
 * applying off the tunnel. The rest of the frame hostname is
 * `frame-host.test.ts`.
 *
 * Fixtures are fictional: a harbour's tide table.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';

/**
 * Off the tunnel the frame hostname answers this machine alone, ticket or
 * not. The server binds every interface, as prod does, so a request can
 * arrive from this machine's own LAN address: the peer a LAN or tailnet
 * caller would be.
 */
describe('the frame hostname off the tunnel, from another address', () => {
  it('refuses a ticket and a cookie that this machine is let in with', async () => {
    const lan = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((i) => i.family === 'IPv4' && !i.internal)?.address;
    if (lan === undefined) {
      // Stated, not silently skipped: this machine cannot host the scenario.
      expect(lan).toBeUndefined();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'frame-host-lan-'));
    const probe = createServer({ port: 0, dataDir: dir });
    const port = probe.port;
    await probe.stop();
    const server = createServer({
      port,
      hostname: '::',
      dataDir: dir,
      frameOrigin: `http://frames.localhost:${port}`,
      frameBoardHosts: ['127.0.0.1'],
      accessOnlyBrowserHosts: false,
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      const make = async (path: string, body: unknown) =>
        (await (
          await fetch(`${at}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json()) as Record<string, unknown>;
      const board = (
        (await make('/workspaces', {
          name: 'Tide table',
          author: { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' },
        })) as { workspace: { id: string } }
      ).workspace.id;
      const file = join(dir, 'tides.html');
      writeFileSync(file, '<!doctype html><html><body><h1>Saltmarsh tides</h1></body></html>');
      const doc = String(
        (
          await make(`/workspaces/${board}/docs`, {
            docId: 'tides',
            type: 'mockup',
            sourceUrl: file,
          })
        ).docId,
      );
      await make(`/workspaces/${board}/docs:attach`, { docId: doc });
      const hostPage = async () => {
        const html = await (await fetch(`${at}/workspaces/${board}/mockups/${doc}`)).text();
        return new URL(/data-src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '');
      };
      const frames = { host: `frames.localhost:${port}`, 'sec-fetch-dest': 'iframe' };
      const frame = `/workspaces/${board}/mockups/${doc}?cw-frame=1`;
      const from = (origin: string, path: string, headers: Record<string, string> = {}) =>
        fetch(`${origin}${path}`, { headers: { ...frames, ...headers }, redirect: 'manual' });

      // CONTROL: from this machine the ticket trades for a cookie that holds the frame.
      const src = await hostPage();
      const traded = await from(at, `${src.pathname}${src.search}`);
      expect(traded.status).toBe(303);
      const cookie = (traded.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect((await from(at, frame, { cookie })).status).toBe(200);

      const other = `http://${lan}:${port}`;
      const held = await from(other, frame, { cookie });
      expect(held.status).toBe(403);
      expect(((await held.json()) as { error: string }).error).toBe('unknown_host');
      const fresh = await hostPage();
      const redeemed = await from(other, `${fresh.pathname}${fresh.search}`);
      expect(redeemed.status).toBe(403);
      expect(redeemed.headers.get('set-cookie')).toBeNull();
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
